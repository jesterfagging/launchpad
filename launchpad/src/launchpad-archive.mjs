import { isCurrentLaunch } from '../public/launchpad-model.mjs';

const stoppedStates = new Set(['draft', 'error', 'failed', 'stopping']);
const createdKinds = new Set(['create', 'launch-all']);
const safeTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;

// This is list organization only. The worker always reads the complete book,
// including archived requests, so receipt checks and setup recovery continue.
export function launchArchiveView(launch) {
  const manuallyArchived = launch.listArchive?.archived === true;
  const hidden = launch.moderation?.hidden === true;
  const current = isCurrentLaunch(launch.input);
  const listArchived = manuallyArchived || hidden || !current;
  const operations = Array.isArray(launch.operations) ? launch.operations : [];
  const recovering = !!launch.recovery && launch.recovery.status !== 'not-needed';
  let archiveReason = '';
  if (!current) archiveReason = 'This earlier launch is already in Archived tokens.';
  else if (hidden) archiveReason = 'This coin is hidden. An administrator can restore its visibility.';
  else if (manuallyArchived) archiveReason = 'This request is in Archived tokens. Any setup recovery continues there.';
  else if (launch.curve || operations.some(op => createdKinds.has(op.kind) && op.state === 'confirmed')) archiveReason = 'This token was created. Live tokens can be hidden by an administrator.';
  else if (!recovering && (operations.some(op => ['pending', 'awaiting_signature'].includes(op.state)) || !stoppedStates.has(launch.state))) archiveReason = 'Wait for this launch to stop or begin setup recovery before archiving it.';
  return {
    listArchived, manuallyArchived, hidden,
    canArchive: !listArchived && !archiveReason,
    canRestore: manuallyArchived && current && !hidden,
    archiveReason,
    archiveAt: safeTime(manuallyArchived ? launch.listArchive?.at : hidden ? launch.moderation?.at : null),
  };
}

// A request that stopped before its token existed, with no transaction pending or
// awaiting a signature and no setup recovery: it holds no live coin and no open
// operation. (Its keys and history still stay in the book.)
export function stoppedBeforeToken(launch) {
  const operations = Array.isArray(launch?.operations) ? launch.operations : [];
  if (!launch || launch.curve || operations.some(op => createdKinds.has(op?.kind) && op.state === 'confirmed')) return false;
  if (launch.recovery && launch.recovery.status !== 'not-needed') return false;
  if (operations.some(op => ['pending', 'awaiting_signature'].includes(op?.state))) return false;
  return ['draft', 'error', 'failed'].includes(launch.state);
}

// Caller must hold the owner's launch lock and recheck its actor immediately
// before invoking this helper. The public projection never exposes this audit.
export function setLaunchArchive(launch, { archived, actorId, at }) {
  if (typeof archived !== 'boolean') throw Object.assign(new Error('Choose whether to archive or restore this request.'), { statusCode: 400 });
  const view = launchArchiveView(launch);
  if (!archived && (view.hidden || !isCurrentLaunch(launch.input))) throw Object.assign(new Error(view.archiveReason), { statusCode: 409 });
  if (view.manuallyArchived === archived) return false;
  if (archived ? !view.canArchive : !view.canRestore) throw Object.assign(new Error(view.archiveReason || 'Refresh this request before changing its archive status.'), { statusCode: 409 });
  const event = { archived, actorId, at };
  launch.listArchive = event;
  launch.listArchiveHistory = [...(launch.listArchiveHistory || []), event];
  return true;
}
