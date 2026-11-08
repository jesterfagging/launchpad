// What a launchpad offers (LAUNCHPAD_PRODUCT=tenant): every launch path asks here before it prepares anything, so a venue,
// a launch mode or transfer hooks the launchpad's owner did not pick are refused by the server whatever the browser
// sends. Paycheck is never offered on a launchpad (its split names the engine's own buy-and-burn). On any other
// product every call returns at once.
import { tenantConfig } from './config.mjs';
import { VENUES, modeById, START_VENUES, startTier } from '../../public/tenant-catalog.mjs';

const refuse = message => { throw Object.assign(new Error(message), { statusCode: 403, code: 'TENANT_OPTION_OFF' }); };
const venueLabel = venue => VENUES.find(row => row.id === venue)?.label || 'this venue';
const OTHER_MODES = Object.freeze({ paycheck: 'Paycheck', gotchi: 'Gotchi', agent: 'AI Agent' });
const modeLabel = mode => modeById(mode)?.label || OTHER_MODES[mode] || 'These';

/** The launch mode a normalised Raydium launch input was created with (launchInput folds Gotchi, Paycheck and AI Agent). */
export function raydiumMode(input) { return input?.gotchiId ? 'gotchi' : input?.paycheck ? 'paycheck' : input?.agentRequest || input?.agent ? 'agent' : String(input?.feeMode || ''); }

export function requireTenantLaunch({ venue, mode, hooks = false, start } = {}, env = process.env) {
  const config = tenantConfig(env);
  // Off a launchpad the engine's curves are its own: the $20K start only (Raydium administrators keep their own range).
  if (!config) { if (start !== undefined && start !== '20k') refuse('This start is not offered here.'); return; }
  if (!config.venues.includes(venue)) refuse(`${config.name} does not launch on ${venueLabel(venue)}. Pick another venue.`);
  if (mode === 'paycheck' || !config.modes.includes(mode)) refuse(`${modeLabel(mode)} launches are not offered on ${config.name}. Pick another launch option.`);
  if (hooks && !config.hooks) refuse(`Transfer hook rules are not offered on ${config.name}.`);
  if (start !== undefined && START_VENUES.includes(venue) && !(config.starts[venue] || []).includes(start)) refuse(`${config.name} does not offer the ${startTier(start)?.label || 'chosen'} on ${venueLabel(venue)}. Pick ${(config.starts[venue] || []).map(id => startTier(id)?.label).join(' or ')}.`);
}
/** The starts a venue offers here: a launchpad's choice, or the engine's $20K start anywhere else. */
export function allowedStarts(venue, env = process.env) { const config = tenantConfig(env); return config ? [...(config.starts[venue] || [])] : ['20k']; }
