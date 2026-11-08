// AI Agent mode readiness check for operators. Reads the host environment (or
// an env file given as the first argument), verifies the policy hash, opens a
// throwaway copy of the ledger schema, and optionally pings the providers with
// read-only requests that cost nothing. It never launches an agent, never
// signs, and prints no secret values. Run with:
//   node scripts/check-agent-readiness.mjs [/etc/launchpad.env] [--providers]
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfig } from '../src/agent/service.mjs';
import { AGENT_POLICY_HASH, dailyBudgetUsd, modelCallWorstCaseUsd, runReservationUsd, pricePerMillionMicro } from '../src/agent/policy.mjs';
import { AGENT_POLICY_V1, AGENT_RATE_CARD_V1, formatUsdMicro, canonicalJson } from '../public/agent-catalog.mjs';
import { openAgentDatabase } from '../src/agent/db.mjs';
import { ModelRegistry, providerCredits } from '../src/agent/openrouter.mjs';
import { listRunningSessions } from '../src/agent/browserbase.mjs';
import { domainAllowed } from '../src/agent/egress.mjs';

const args = process.argv.slice(2), envFile = args.find(arg => !arg.startsWith('--')), providers = args.includes('--providers');
let env = { ...process.env };
if (envFile) { for (const line of readFileSync(envFile, 'utf8').split('\n')) { const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (match && !line.trim().startsWith('#')) env[match[1]] = match[2].replace(/^["']|["']$/g, ''); } }
let failed = 0;
const check = (condition, message) => { if (!condition) { failed++; console.error('FAIL ' + message); } else console.log('ok   ' + message); };
const note = message => console.log('     ' + message);

const config = agentConfig(env);
console.log(`AI Agent readiness (${envFile || 'process environment'})`);
check(config.enabled, 'LAUNCHPAD_AGENTS_ENABLED=1 (master switch)' + (config.enabled ? '' : ' - every agent route answers 503 until this is set'));
note(config.dryRun ? 'dry run is ON: mock model, no browsing, no financial actions, no settlement' : 'dry run is OFF: real providers will be called once the database flags are enabled');
check(config.models.length > 0 && config.models.includes(config.defaultModel), `model allowlist ${config.models.join(', ')} with default ${config.defaultModel || '(none)'}`);
check(config.dryRun || !!config.openrouterKey, 'LAUNCHPAD_AGENTS_OPENROUTER_KEY present (required outside dry run)');
check(config.dryRun || (!!config.browserbaseKey && !!config.browserbaseProject), 'LAUNCHPAD_AGENTS_BROWSERBASE_KEY and LAUNCHPAD_AGENTS_BROWSERBASE_PROJECT present (required for browsing outside dry run)');
check(config.domainAllowlist.length > 0, `vetted domain allowlist has ${config.domainAllowlist.length} entries` + (config.domainAllowlist.length ? '' : ' - browsing stays off until domains are vetted'));
for (const domain of config.domainAllowlist) check(/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/.test(domain), `domain "${domain}" is a plain public host name`);
check(!config.domainAllowlist.some(domain => domainAllowed('localhost', [domain]) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain)), 'no local or IP-literal entries in the allowlist');
check(!!config.operatorWallet || config.dryRun, 'LAUNCHPAD_AGENTS_OPERATOR_WALLET set (needed for USDC reimbursements)');
check(config.globalDailyUsd > 0n, `platform daily provider ceiling ${formatUsdMicro(config.globalDailyUsd)}`);
check(config.rateCard.version === AGENT_RATE_CARD_V1.version || typeof config.rateCard.version === 'string', `rate card ${config.rateCard.version} (model markup ${config.rateCard.modelMarkupBps} bps)`);

const hash = AGENT_POLICY_HASH;
check(/^[a-f0-9]{64}$/.test(hash) && canonicalJson(AGENT_POLICY_V1).length > 0, `policy ${AGENT_POLICY_V1.version} hash ${hash}`);
const pricing = { promptMicroPerMillion: pricePerMillionMicro('0.0000001'), completionMicroPerMillion: pricePerMillionMicro('0.0000005') };
note(`worst case per model call at $0.10/$0.50 per million tokens: ${formatUsdMicro(modelCallWorstCaseUsd({ promptTokens: AGENT_POLICY_V1.run.maxPromptTokens, maxOutputTokens: AGENT_POLICY_V1.run.maxOutputTokens, pricing }))}; run reservation ${formatUsdMicro(runReservationUsd({ pricing }))}; daily cap at $10 opening ${formatUsdMicro(dailyBudgetUsd(10000000n))}`);

const dir = mkdtempSync(join(tmpdir(), 'launchpad-agents-check-'));
try { const db = await openAgentDatabase(join(dir, 'agents.sqlite')); check(db.integrity(), `ledger schema migrates on this Node (${process.version}, SQLite ${db.sqliteVersion?.() || 'bundled'}) and passes integrity_check`); db.close(); }
catch (error) { check(false, 'ledger schema could not be created: ' + error.message); }
finally { rmSync(dir, { recursive: true, force: true }); }

if (providers && !config.dryRun) {
  if (config.openrouterKey) {
    try { const credits = await providerCredits({ apiKey: config.openrouterKey }); check(true, `OpenRouter key accepted; remaining credit ${formatUsdMicro(credits.remainingUsd || 0n)}`); }
    catch (error) { check(false, 'OpenRouter credit check failed: ' + error.message); }
    try {
      // v71.27: the default allowlist spans ten providers, so an id the live catalog does not carry is a note, not a failure;
      // the launch page offers only available models. The default model and at least one model must be available.
      const registry = new ModelRegistry({ apiKey: config.openrouterKey, allowlist: config.models }); await registry.refresh({ force: true }); const catalog = registry.catalog();
      for (const model of catalog) if (model.available) note(`model ${model.id} (${model.providerName || model.provider}, ${model.tag}) priced at $${model.promptUsdPerMillion}/M in, $${model.completionUsdPerMillion}/M out, tools`); else note(`model ${model.id} not offered: ${model.unavailableReason || 'unavailable'}`);
      const available = catalog.filter(model => model.available);
      check(available.length > 0, `${available.length} of ${catalog.length} allowlisted models available from the live catalog`);
      check(available.some(model => model.id === config.defaultModel), `default model ${config.defaultModel} is available`);
    }
    catch (error) { check(false, 'OpenRouter model catalog failed: ' + error.message); }
  }
  if (config.browserbaseKey && config.browserbaseProject) {
    try { const sessions = await listRunningSessions({ apiKey: config.browserbaseKey }); check(true, `Browserbase key accepted; ${sessions.length} running session(s)`); }
    catch (error) { check(false, 'Browserbase check failed: ' + error.message); }
  }
} else if (providers) note('provider checks skipped in dry run');
else note('add --providers to ping OpenRouter and Browserbase with read-only requests');

console.log(failed ? `AI Agent readiness: ${failed} problem(s).` : 'AI Agent readiness: all checks passed.');
process.exitCode = failed ? 1 : 0;
