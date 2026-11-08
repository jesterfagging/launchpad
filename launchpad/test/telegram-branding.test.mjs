import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramApi, TelegramApiError, TELEGRAM_PROFILE_PHOTO_MAX_BYTES } from '../src/telegram-api.mjs';
import { applyTelegramBranding, DEFAULT_TELEGRAM_PROFILE_PHOTO, TELEGRAM_PROFILE, telegramBrandingOptions } from '../src/telegram-branding.mjs';

const token = '123456789:abcdefghijklmnopqrstuvwxyz123456789';
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
function harness() {
  const state = new Map(), calls = [];
  const hostStore = { read: async (key, fallback) => structuredClone(state.get(key) ?? fallback), write: async (key, value) => state.set(key, structuredClone(value)) };
  const api = { call: async (method, body) => { calls.push({ method, body }); return true; }, setProfilePhoto: async bytes => { calls.push({ method: 'setMyProfilePhoto', bytes: Buffer.from(bytes) }); return true; } };
  return { state, calls, hostStore, api, botId: 123456789 };
}

test('Launchpad profile sets the current bot name, descriptions and bundled JPG once', async () => {
  const h = harness();
  h.state.set('host', { token, botId: h.botId, allowedUsers: '7001' });
  const first = await applyTelegramBranding(h);
  assert.deepEqual(first, { complete: true, updated: 4, failed: 0 });
  assert.deepEqual(h.calls.slice(0, 3), [
    { method: 'setMyName', body: { name: 'Launchpad', language_code: '' } },
    { method: 'setMyDescription', body: { description: TELEGRAM_PROFILE.description, language_code: '' } },
    { method: 'setMyShortDescription', body: { short_description: TELEGRAM_PROFILE.short_description, language_code: '' } },
  ]);
  assert.ok(TELEGRAM_PROFILE.name.length <= 64 && TELEGRAM_PROFILE.description.length <= 512 && TELEGRAM_PROFILE.short_description.length <= 120);
  assert.deepEqual(h.calls.at(-1).bytes, await readFile(DEFAULT_TELEGRAM_PROFILE_PHOTO));
  assert.equal(h.state.get('branding').complete, true);
  assert.deepEqual(h.state.get('host'), { token, botId: h.botId, allowedUsers: '7001' });
  assert.deepEqual(await applyTelegramBranding(h), { complete: true, updated: 0, failed: 0 });
  assert.equal(h.calls.length, 4);
  assert.deepEqual([...h.state.keys()], ['host', 'branding']);
});

test('partial profile failures remain incomplete and retry only unconfirmed operations', async () => {
  const h = harness(); let attempts = 0;
  h.api.setProfilePhoto = async () => { attempts++; if (attempts === 1) throw new TelegramApiError(429, 1); return true; };
  assert.deepEqual(await applyTelegramBranding(h), { complete: false, updated: 3, failed: 1 });
  assert.equal(h.state.get('branding').complete, false);
  assert.equal(h.state.get('branding').confirmed.setMyProfilePhoto, undefined);
  assert.deepEqual(await applyTelegramBranding(h), { complete: true, updated: 1, failed: 0 });
  assert.equal(h.calls.length, 3);
  assert.equal(attempts, 2);
  const anotherBot = await applyTelegramBranding({ ...h, botId: h.botId + 1 });
  assert.equal(anotherBot.updated, 4, 'a checkpoint cannot be reused for another bot');
});

test('false API success, invalid images and interrupted updates cannot mark branding complete', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-telegram-brand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(), path = join(root, 'invalid.jpg');
  await writeFile(path, Buffer.from('not an image'));
  h.api.call = async method => { h.calls.push({ method }); return false; };
  assert.deepEqual(await applyTelegramBranding({ ...h, profilePhoto: path }), { complete: false, updated: 0, failed: 4 });
  assert.equal(h.state.get('branding').complete, false);
  assert.deepEqual(h.state.get('branding').confirmed, {});
  assert.ok(h.calls.every(x => x.method !== 'setMyProfilePhoto'));
  const aborted = new AbortController(); aborted.abort();
  h.calls.length = 0;
  const interrupted = await applyTelegramBranding({ ...h, signal: aborted.signal });
  assert.equal(interrupted.complete, false);
  assert.equal(h.calls.length, 0);
});

test('an explicit changed local avatar invalidates only its checkpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-telegram-avatar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(), path = join(root, 'custom.jpg');
  await applyTelegramBranding(h);
  await writeFile(path, jpg);
  const next = await applyTelegramBranding({ ...h, profilePhoto: path });
  assert.deepEqual(next, { complete: true, updated: 1, failed: 0 });
  assert.equal(h.calls.length, 5);
  assert.deepEqual(h.calls.at(-1).bytes, jpg);
});

test('branding opt-out performs no reads or API calls and the settings choose the profile photo', async () => {
  assert.equal(telegramBrandingOptions({}).profilePhoto, DEFAULT_TELEGRAM_PROFILE_PHOTO);
  assert.equal(telegramBrandingOptions({ LAUNCHPAD_TELEGRAM_BRANDING: '0' }).enabled, false);
  assert.equal(telegramBrandingOptions({ LAUNCHPAD_TELEGRAM_BRANDING: 'false' }).enabled, false);
  assert.equal(telegramBrandingOptions({ LAUNCHPAD_TELEGRAM_PROFILE_PHOTO: '/tmp/logo.jpg' }).profilePhoto, '/tmp/logo.jpg');
  assert.deepEqual(await applyTelegramBranding({ enabled: false }), { skipped: true, complete: false, updated: 0, failed: 0 });
});

test('profile upload uses the exact Bot API multipart contract and never follows redirects', async () => {
  let request;
  const api = new TelegramApi(token, async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => ({ ok: true, result: true }) }; });
  assert.equal(await api.setProfilePhoto(jpg), true);
  assert.equal(request.url, `https://api.telegram.org/bot${token}/setMyProfilePhoto`);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers, undefined, 'fetch must create the multipart boundary');
  assert.deepEqual(JSON.parse(request.body.get('photo')), { type: 'static', photo: 'attach://profile_photo' });
  assert.deepEqual([...request.body.keys()], ['photo', 'profile_photo']);
  const photo = request.body.get('profile_photo');
  assert.equal(photo.name, 'profile.jpg');
  assert.equal(photo.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpg);
  await assert.rejects(api.setProfilePhoto(Buffer.from('not JPG')), /JPG/);
  await assert.rejects(api.setProfilePhoto(Buffer.alloc(TELEGRAM_PROFILE_PHOTO_MAX_BYTES + 1)), /JPG/);
  const failing = new TelegramApi(token, async () => { throw new Error(`failure at ${token}`); });
  await assert.rejects(failing.setProfilePhoto(jpg), error => error instanceof TelegramApiError && !error.message.includes(token));
});
