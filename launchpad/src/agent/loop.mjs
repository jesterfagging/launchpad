// The bounded model/tool loop of one AI Agent run. Pure orchestration with
// injected adapters (model call, browser factory, core tool executor) so the
// same code runs inside the isolated worker process, in dry-run mode and in
// tests. Before every external request the worst-case cost of that request is
// checked against the remaining reservation; unknown outcomes keep their
// reservation as disputed cost.
import { validateArguments, DATA_TOOLS, BROWSER_TOOLS, PROPOSAL_TOOLS, INFLUENCER_TOOLS } from './tools.mjs';
import { systemPrompt, taskPrompt, boundMessages, estimateTokens } from './prompt.mjs';
import { tokensCostUsd } from './policy.mjs';

const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const describeError = error => error?.code === 'AGENT_EGRESS' ? 'blocked: ' + error.message : error?.code === 'AGENT_BUDGET' ? 'budget: ' + error.message : clip(error?.message || 'Tool failed.', 200);

export async function runAgentLoop({ job, model, browserFactory = null, callTool, onUsage = async () => {}, onEvent = async () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { budget, pricing, rateCard } = job, startedAt = now(), deadline = startedAt + budget.maxSeconds * 1000;
  let remaining = BigInt(budget.reservedUsd), spent = 0n, disputed = 0n, modelCalls = 0, toolCalls = 0, browser = null, browserCharged = false;
  const providerRequests = [], summaryParts = [], toolLog = [];
  const browserAvailable = !!browserFactory && job.capabilities.includes('browser') && job.approvedDomains.length > 0;
  const browserWorst = browserAvailable ? BigInt(Math.ceil(budget.browserMaxSeconds / 60)) * BigInt(rateCard.browserMinuteUsd) + BigInt(rateCard.browserSessionOverheadUsd) : 0n;
  const messages = [
    { role: 'system', content: systemPrompt({ agent: job.agent, policy: job.policy, capabilities: job.capabilities, remaining: { modelCalls: budget.maxModelCalls, toolCalls: budget.maxToolCalls, seconds: budget.maxSeconds, usd: '$' + (Number(budget.reservedUsd) / 1e6).toFixed(4) }, approvedDomains: job.approvedDomains, rateCardVersion: rateCard.version }) },
    { role: 'user', content: taskPrompt({ ...job.context, now: startedAt }) },
  ];
  const chargeBrowser = async () => { if (!browser || browserCharged) return; browserCharged = true; const charge = BigInt(Math.max(1, Math.ceil(browser.seconds / 60))) * BigInt(rateCard.browserMinuteUsd) + BigInt(rateCard.browserSessionOverheadUsd); spent += charge; remaining -= charge; await onUsage({ provider: 'browserbase', requestId: `browser:${job.id}`, kind: 'browser', costUsd: charge.toString(), estimatedUsd: charge.toString(), state: 'resolved', detail: `${browser.actions} actions, ${browser.seconds}s` }); };
  const finish = async (summary, error = null, errorCode = '') => {
    try { await browser?.close(); } catch { /* Released by orphan cleanup if needed. */ }
    await chargeBrowser();
    return { summary: clip(summary || summaryParts.join(' ') || 'The run ended without a summary.', 1000), error: error ? clip(error, 300) : '', errorCode, usage: { spentUsd: spent.toString(), disputedUsd: disputed.toString(), modelCalls, toolCalls, browserActions: browser?.actions || 0, browserSeconds: browser?.seconds || 0, providerRequests }, tools: toolLog };
  };
  const tools = job.tools;
  for (;;) {
    if (now() >= deadline) return finish(null, 'The run reached its time limit.', 'run-timeout');
    if (modelCalls >= budget.maxModelCalls) return finish(null, '', 'model-call-limit');
    const bounded = boundMessages(messages, budget.maxPromptTokens), promptTokens = Math.min(budget.maxPromptTokens, bounded.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')) + 8, 0));
    const callWorst = tokensCostUsd(promptTokens, pricing.promptMicroPerMillion) + tokensCostUsd(budget.maxOutputTokens, pricing.completionMicroPerMillion) + BigInt(pricing.requestUsd || 0);
    const held = (!browser && browserAvailable ? browserWorst : 0n);
    if (remaining - held < callWorst) return finish(null, 'The reserved operating credit cannot cover another model call.', 'reservation-exhausted');
    const controller = new AbortController(), timeLeft = Math.max(1000, deadline - now()), timer = setTimeout(() => controller.abort(), Math.min(45000, timeLeft));
    let response;
    try { modelCalls++; response = await model({ messages: bounded, tools, maxTokens: budget.maxOutputTokens, signal: controller.signal }); }
    catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError' || error?.code === 'AGENT_PROVIDER_TIMEOUT') { disputed += callWorst; remaining -= callWorst; providerRequests.push({ provider: 'openrouter', requestId: `unknown:${job.id}:${modelCalls}`, state: 'unknown' }); await onUsage({ provider: 'openrouter', requestId: `unknown:${job.id}:${modelCalls}`, kind: 'model', model: job.agent.model, costUsd: '0', estimatedUsd: callWorst.toString(), state: 'unknown', detail: 'Timed out or stream broken; reservation retained until billing is reconciled.' }); return finish(null, 'The model request timed out; its cost is retained until the provider confirms billing.', 'provider-timeout'); }
      return finish(null, error?.message || 'The model request failed.', error?.code === 'AGENT_PROVIDER_FUNDS' ? 'provider-funds' : error?.code === 'AGENT_PROVIDER_RATE_LIMITED' ? 'provider-rate-limited' : 'provider-error');
    }
    clearTimeout(timer);
    const usage = response.usage || {}, estimated = tokensCostUsd(usage.promptTokens || promptTokens, pricing.promptMicroPerMillion) + tokensCostUsd(usage.completionTokens || budget.maxOutputTokens, pricing.completionMicroPerMillion) + BigInt(pricing.requestUsd || 0);
    const reported = usage.costUsd !== null && usage.costUsd !== undefined ? BigInt(usage.costUsd) : null, cost = reported ?? estimated;
    spent += cost; remaining -= cost;
    providerRequests.push({ provider: 'openrouter', requestId: response.id || `local:${job.id}:${modelCalls}`, state: reported !== null ? 'resolved' : 'estimated' });
    await onUsage({ provider: 'openrouter', requestId: response.id || `local:${job.id}:${modelCalls}`, kind: 'model', model: response.model || job.agent.model, promptTokens: usage.promptTokens || 0, completionTokens: usage.completionTokens || 0, costUsd: cost.toString(), estimatedUsd: estimated.toString(), state: reported !== null ? 'resolved' : 'estimated' });
    const message = response.message || {}; messages.push({ role: 'assistant', content: message.content || '', ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.slice(0, 1) } : {}) });
    const call = message.tool_calls?.[0];
    if (!call) return finish(message.content || '');
    if (typeof message.content === 'string' && message.content.trim()) summaryParts.push(clip(message.content.trim(), 300));
    if (toolCalls >= budget.maxToolCalls) { messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'Tool budget used up. Reply with your final summary.' }) }); continue; }
    toolCalls++;
    const name = call.function?.name, validated = validateArguments(name, call.function?.arguments ?? '{}');
    let result;
    if (!validated.ok) result = { error: validated.error };
    else if (BROWSER_TOOLS.includes(name)) {
      if (!browserAvailable) result = { error: 'Browsing is unavailable this run.' };
      else { try { browser ||= browserFactory(); if (name === 'browser_open') result = await browser.open(validated.value.url); else if (name === 'browser_read') result = await browser.read(); else if (name === 'browser_follow_link') result = await browser.follow(validated.value.link); else result = await browser.scroll(); await onEvent({ kind: 'browse', title: `Browsed ${result?.url || ''}`.trim(), body: clip(result?.title || '', 160), data: { url: result?.url || '', blocked: result?.blocked || 0 } }); } catch (error) { result = { error: describeError(error) }; if (error?.code === 'AGENT_BUDGET') { try { await browser?.close(); } catch { /* ignore */ } } } }
    } else if (DATA_TOOLS.includes(name) || PROPOSAL_TOOLS.includes(name) || INFLUENCER_TOOLS.includes(name)) { try { result = await callTool(name, validated.value); } catch (error) { result = { error: describeError(error) }; } }
    else result = { error: 'Unknown tool.' };
    toolLog.push({ name, ok: !result?.error, at: now() });
    messages.push({ role: 'tool', tool_call_id: call.id, content: clip(JSON.stringify(result ?? null), 12000) });
    if (now() >= deadline) return finish(null, 'The run reached its time limit.', 'run-timeout');
    await sleep(0);
  }
}
/** Deterministic dry-run model: exercises the tool loop without a provider. Every output is labelled. */
export function dryRunModel({ steps = ['get_own_market', 'recall_memory', 'save_note', 'publish_update'] } = {}) {
  let index = 0;
  return async ({ messages }) => {
    const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')), 0);
    const usage = { promptTokens, completionTokens: 60, costUsd: null };
    if (index < steps.length) {
      const name = steps[index++], args = name === 'recall_memory' ? { query: 'market volume' } : name === 'save_note' ? { title: '[dry run] Market check', body: 'Dry-run note: no provider was called. Market snapshot was read from the platform.' } : name === 'publish_update' ? { title: '[dry run] Status', body: 'This is a mock update produced in dry-run mode. No model, browser or provider credit was used.' } : {};
      return { id: `dry-${Date.now()}-${index}`, model: 'dry-run', message: { role: 'assistant', content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, usage, finishReason: 'tool_calls' };
    }
    return { id: `dry-${Date.now()}-final`, model: 'dry-run', message: { role: 'assistant', content: '[dry run] Completed a mock research pass: read the market snapshot, recalled notes, saved one note and published one labelled update.' }, usage, finishReason: 'stop' };
  };
}
