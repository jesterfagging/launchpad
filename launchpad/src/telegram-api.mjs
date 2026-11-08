import { setTimeout as delay } from 'node:timers/promises';

export const TELEGRAM_PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

export class TelegramApiError extends Error {
  constructor(code, retryAfter = 0) {
    super(code === 401 ? 'Telegram rejected the bot token.' : code === 409 ? 'Another poller or webhook is using this bot token.' : code === 429 ? 'Telegram rate limit.' : 'Telegram request failed.');
    this.code = code; this.retryAfter = Math.min(3600, Math.max(0, Number(retryAfter) || 0));
  }
}
export class TelegramApi {
  constructor(token, fetcher = globalThis.fetch) {
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token || '')) throw new Error('Enter the complete bot token from BotFather.');
    this.token = token; this.fetcher = fetcher;
  }
  async call(method, body = {}, signal) {
    if (!/^[A-Za-z]+$/.test(method)) throw new Error('Invalid Telegram method.');
    const multipart = body instanceof FormData;
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', ...(multipart ? {} : { headers: { 'content-type': 'application/json' } }), body: multipart ? body : JSON.stringify(body), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 35000 : 10000)]) : AbortSignal.timeout(method === 'getUpdates' ? 35000 : 10000),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new TelegramApiError(data.error_code || response.status, data.parameters?.retry_after);
      return data.result;
    } catch (error) { if (error instanceof TelegramApiError) throw error; throw new TelegramApiError(0); }
  }
  async setProfilePhoto(bytes, signal) {
    // InputProfilePhotoStatic requires a newly uploaded JPG, not a URL/file_id.
    if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > TELEGRAM_PROFILE_PHOTO_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('Choose a JPG bot profile image smaller than 2 MB.');
    const form = new FormData();
    form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://profile_photo' }));
    form.set('profile_photo', new Blob([bytes], { type: 'image/jpeg' }), 'profile.jpg');
    return this.call('setMyProfilePhoto', form, signal);
  }
  async document(fileId, maxBytes = 262144) {
    const file = await this.call('getFile', { file_id: fileId });
    if (!Number.isSafeInteger(file.file_size) || file.file_size > maxBytes || !/^[\w/-]+\.json$/.test(file.file_path || '') || file.file_path.includes('..')) throw new Error('Choose a Launchpad JSON preset smaller than 256 KB.');
    try {
      const response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw new Error(); chunks.push(chunk); }
      return Buffer.concat(chunks).toString('utf8');
    } catch { throw new Error('Preset download failed or exceeded 256 KB.'); }
  }
}

// Trading and inbound commands never wait for notification delivery.
// Separate chat queues avoid a blocked/limited chat holding up everyone else.
export class TelegramOutbox {
  constructor(api) { this.api = api; this.chats = new Map(); this.closed = false; this.globalNext = 0; this.timer = setInterval(() => this.tick(), 100); this.timer.unref(); }
  send(chat, text, keyboard, { notification = false, urgent = false, replaceQueue = false } = {}) {
    if (this.closed) return;
    let queue = this.chats.get(chat);
    if (!queue) this.chats.set(chat, queue = { items: [], next: 0, busy: false });
    if (replaceQueue) queue.items.length = 0;
    if (queue.items.length >= 16) {
      const disposable = queue.items.findIndex(item => item.notification);
      if (disposable >= 0) queue.items.splice(disposable, 1); else if (notification) return; else queue.items.shift();
    }
    queue.items[urgent ? 'unshift' : 'push']({ notification, attempts: 0, body: { chat_id: Number(chat), text: text.slice(0, 3900), protect_content: true, link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) } });
  }
  tick() {
    if (this.closed || Date.now() < this.globalNext) return;
    for (const [chat, queue] of this.chats) {
      if (!queue.items.length && !queue.busy) { this.chats.delete(chat); continue; }
      if (!queue.items.length || queue.busy || Date.now() < queue.next) continue;
      const item = queue.items.shift(); queue.busy = true; this.globalNext = Date.now() + 100;
      // Round-robin service: a busy early registrant cannot starve later chats.
      this.chats.delete(chat); this.chats.set(chat, queue);
      this.api.call('sendMessage', item.body).catch(error => {
        if (error.code === 429) { this.globalNext = Math.max(this.globalNext, Date.now() + (error.retryAfter || 2) * 1000); queue.next = this.globalNext; }
        if (error.code !== 403 && ++item.attempts < 3) queue.items.unshift(item);
      }).finally(() => { queue.busy = false; queue.next = Math.max(queue.next, Date.now() + 1000); });
      break;
    }
  }
  close() { this.closed = true; clearInterval(this.timer); this.chats.clear(); }
}

export async function pollTelegram(api, hostStore, bot, signal, log = console.log) {
  const state = await hostStore.read('updates', { offset: 0 });
  let offset = state.offset, failures = 0;
  while (!signal.aborted) {
    let updates;
    try {
      updates = await api.call('getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message', 'callback_query'] }, signal);
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      if ([401, 409].includes(error.code)) throw error;
      if (!failures++) log('Telegram connection interrupted; retrying. Existing trading sessions continue.');
      await delay(Math.min(30000, (error.retryAfter || Math.min(10, failures * 2)) * 1000), null, { signal }).catch(() => {}); continue;
    }
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      // Commit before side effects. A restart cannot replay an old Start request.
      offset = update.update_id + 1;
      await hostStore.write('updates', { offset });
      bot.dispatch(update);
    }
  }
}
