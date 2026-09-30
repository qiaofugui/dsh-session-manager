/**
 * Deletion pipeline: turn a reviewed plan into durable, audited state changes.
 *
 * Ordering is deliberate. Files are removed first, because that is the
 * irreversible step and a failure there leaves the registry untouched, so a
 * retry starts from the same state. Registry bookkeeping then runs best-effort
 * and is *always* attempted, even for an id whose artifacts are already gone, so
 * a retry cleans up whatever a partially failed first attempt left behind.
 *
 * @module dsh-session-manager/lib/delete
 */
import { appendAudit, auditPath } from './audit.js';
import { REASONS, buildDeletePlan, decide } from './plan.js';
import { removeArtifacts } from './scanner.js';

/** Ids currently being deleted, so two tabs cannot interleave one session. */
const inFlight = new Set();

/**
 * Read an optional Host service without importing its package.
 * @param ctx - any Cordis context.
 * @param key - the service name.
 * @returns the service, or `undefined` when this composition has no such service.
 */
export function service(ctx, key) {
  try {
    return ctx?.get?.(key);
  } catch {
    return undefined;
  }
}

/** @returns the registry-global archive set as a `Set`, or an empty one. */
export function archivedIdSet(ctx) {
  const ids = service(ctx, 'workspaceRegistry')?.archivedSessionIds;
  return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
}

/** @returns the archive set in archive order, or `[]` when the registry is absent. */
export function archivedIds(ctx) {
  const ids = service(ctx, 'workspaceRegistry')?.archivedSessionIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

/** @returns the pin set as a `Set`, or an empty one. */
export function pinnedIdSet(ctx) {
  const ids = service(ctx, 'workspaceRegistry')?.pinnedSessionIds;
  return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
}

/** @returns the session id this Host process was started for, if any. */
export function processSessionId() {
  const value = process.env?.DSH_SESSION_ID;
  return typeof value === 'string' && value.length > 0 ? value : '';
}

/**
 * Observe live/running state for every candidate id.
 *
 * Both probes are individually guarded: a composition may expose `sessions`
 * without `agents`, or a future version may change `status`'s vocabulary, and a
 * probe failure must degrade to "not live" rather than fail the request.
 *
 * @param ctx - Host context.
 * @param config - normalized config.
 * @param items - scanned artifacts (their ids are the probe set).
 * @param archiveIds - registry archive ids (all of them are probed too).
 * @param currentSessionId - the page's open session id, when it reported one.
 * @returns the `view` object `decide` and `buildDeletePlan` consume.
 */
export function buildView(ctx, config, items, archiveIds, currentSessionId) {
  const liveIds = new Set();
  const runningIds = new Set();
  const sessions = service(ctx, 'sessions');
  const agents = service(ctx, 'agents');
  const candidates = new Set(archiveIds);
  for (const item of items) if (typeof item?.id === 'string') candidates.add(item.id);

  for (const id of candidates) {
    try {
      if (sessions?.get?.(id) !== undefined) liveIds.add(id);
    } catch {
      /* an unavailable live-session probe is treated as not live */
    }
    try {
      if (agents?.get?.(id)?.status === 'running') {
        runningIds.add(id);
        liveIds.add(id);
      }
    } catch {
      /* an unavailable agent probe is treated as not running */
    }
  }

  const reported = typeof currentSessionId === 'string' && currentSessionId.length > 0 ? currentSessionId : '';
  // `allowDeleteArchived: false` is expressed as policy protection rather than a
  // new reason code, so the whole guard stays in the one policy module.
  const protectedIds = new Set(Array.isArray(config.protectedSessionIds) ? config.protectedSessionIds : []);
  if (config.allowDeleteArchived === false) for (const id of archiveIds) protectedIds.add(id);
  return {
    archivedIds: new Set(archiveIds),
    liveIds,
    runningIds,
    protectedIds,
    currentSessionId: reported.length > 0 ? reported : processSessionId(),
    allowDeleteUnarchived: config.allowDeleteUnarchived === true,
    allowDeleteLive: config.allowDeleteLive === true,
    enabled: config.enabled !== false,
  };
}

/**
 * Build the plan for one delete request.
 * @returns `{ plan, view, items }` where `plan` carries `accepted`/`skipped`.
 */
export function planDelete({ ctx, config, items, ids, currentSessionId }) {
  const archiveIds = archivedIds(ctx);
  const view = buildView(ctx, config, items, archiveIds, currentSessionId);
  return { plan: buildDeletePlan(ids, items, view, config), view };
}

/**
 * Execute an accepted plan.
 * @returns `{ results, freedBytes }`; `results` preserves plan order.
 */
export async function deleteSessions({ ctx, config, roots, plan, actor, stopActivity }) {
  const results = [];
  let freedBytes = 0;
  for (const item of plan.accepted) {
    const result = await deleteOne({ ctx, config, roots, item, actor, stopActivity });
    results.push(result);
    if (Number.isFinite(result.freedBytes)) freedBytes += result.freedBytes;
  }
  return { results, freedBytes };
}

/** Delete one session's artifacts and accounting, with per-step failure capture. */
async function deleteOne({ ctx, config, roots, item, actor, stopActivity }) {
  const id = item.id;
  if (inFlight.has(id)) {
    return {
      id,
      ok: false,
      freedBytes: 0,
      removed: {},
      failed: { delete: 'another delete for this session is already running' },
      error: 'concurrent',
    };
  }
  inFlight.add(id);
  const removed = {};
  const failed = {};
  const warnings = [];
  let freedBytes = 0;
  let error = null;

  try {
    if (stopActivity === true) {
      try {
        await service(ctx, 'workspaceRegistry')?.stopSessionActivity?.(id);
        removed.stopActivity = true;
      } catch (stopError) {
        failed.stopActivity = describe(stopError);
      }
    }

    try {
      const artifacts = await removeArtifacts(item, {
        pruneEmptyProjects: config.pruneEmptyProjects === true,
        purgeProjectionCache: config.purgeProjectionCache === true,
      });
      Object.assign(removed, artifacts?.removed ?? {});
      Object.assign(failed, artifacts?.failed ?? {});
      freedBytes = Number.isFinite(artifacts?.freedBytes) ? artifacts.freedBytes : 0;
      // `removed.files` is a *count*, so "nothing at all was removed" is tested
      // by every flag being false/zero rather than by an undefined one.
      const removedSomething =
        removed.dir === true ||
        removed.cache === true ||
        removed.extra === true ||
        removed.projectDir === true ||
        (typeof removed.files === 'number' && removed.files > 0);
      if (!removedSomething) warnings.push('no-artifacts-removed');
    } catch (removeError) {
      failed.delete = describe(removeError);
    }

    // Always attempt the bookkeeping, even after a partial file failure: the
    // archive set and workspace membership must not point at a dead session.
    try {
      await cleanupRegistry(ctx, id, removed, failed);
    } catch (registryError) {
      failed.registry = describe(registryError);
    }

    try {
      ctx.emit('api-session/removed', id);
      removed.notified = true;
    } catch (emitError) {
      failed.notify = describe(emitError);
    }

    if (failed.delete !== undefined) error = 'files';
    else if (Object.keys(failed).length > 0) error = 'partial';
  } catch (unexpected) {
    error = 'unexpected';
    failed.unexpected = describe(unexpected);
  } finally {
    inFlight.delete(id);
  }

  const ok = error === null;
  await appendAudit(auditPath(roots, config), {
    at: new Date().toISOString(),
    action: 'delete',
    id,
    project: typeof item.project === 'string' ? item.project : '',
    dir: typeof item.dir === 'string' ? item.dir : '',
    freedBytes,
    removed,
    failed,
    warnings,
    actor: typeof actor === 'string' ? actor : 'unknown',
  });
  return { id, ok, freedBytes, removed, failed, warnings, error };
}

/**
 * Drop one id from the registry-global archive/pin sets and from every
 * workspace's accounting.
 *
 * `unarchiveSession`/`unpinSession` are no-ops for an id they do not hold, so
 * calling them unconditionally is both cheap and race-tolerant. Each write is
 * guarded separately: one failing workspace must not stop the others.
 *
 * @param ctx - Host context.
 * @param id - the session id to detach.
 * @param removed - mutated with one flag per completed step.
 * @param failed - mutated with one message per failed step.
 */
export async function cleanupRegistry(ctx, id, removed = {}, failed = {}) {
  const registry = service(ctx, 'workspaceRegistry');
  if (registry === undefined || registry === null) {
    failed.registry = 'workspace-registry-unavailable';
    return { removed, failed };
  }

  for (const [key, method] of [
    ['archive', 'unarchiveSession'],
    ['pin', 'unpinSession'],
  ]) {
    const call = registry[method];
    if (typeof call !== 'function') continue;
    try {
      await call.call(registry, id);
      removed[key] = true;
    } catch (error) {
      failed[key] = describe(error);
    }
  }

  let workspaces = [];
  try {
    const listed = typeof registry.list === 'function' ? registry.list() : [];
    workspaces = Array.isArray(listed) ? listed : await listed;
  } catch (error) {
    failed.membership = describe(error);
    return { removed, failed };
  }
  if (!Array.isArray(workspaces)) return { removed, failed };

  for (const workspace of workspaces) {
    const ids = workspace?.sessionIds;
    if (!Array.isArray(ids) || !ids.includes(id)) continue;
    if (typeof workspace.detachSession !== 'function') continue;
    try {
      await workspace.detachSession(id);
      removed.membership = true;
    } catch (error) {
      failed.membership = describe(error);
    }
  }
  return { removed, failed };
}

/**
 * Clean up registry accounting for an id whose artifacts are already gone.
 *
 * This is what makes a retry after a partial failure work even though the
 * session is no longer on disk (and therefore no longer `accepted` by
 * {@link decide}).
 *
 * @returns a per-id result shaped like a normal delete result.
 */
export async function cleanupResidue({ ctx, config, roots, ids, actor }) {
  const results = [];
  for (const id of ids) {
    const removed = {};
    const failed = {};
    await cleanupRegistry(ctx, id, removed, failed);
    try {
      ctx.emit('api-session/removed', id);
      removed.notified = true;
    } catch (error) {
      failed.notify = describe(error);
    }
    const changed = Object.keys(removed).length > 0;
    const ok = Object.keys(failed).length === 0 || changed;
    await appendAudit(auditPath(roots, config), {
      at: new Date().toISOString(),
      action: 'cleanup-residue',
      id,
      freedBytes: 0,
      removed,
      failed,
      actor: typeof actor === 'string' ? actor : 'unknown',
    });
    results.push({ id, ok, freedBytes: 0, removed, failed, warnings: [], error: ok ? null : 'residue' });
  }
  return { results, freedBytes: 0 };
}

/** Re-export so callers that only need a decision do not import the plan module. */
export { REASONS, decide };

/** Render an unknown thrown value as a short message. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
