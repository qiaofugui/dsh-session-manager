/**
 * The single operation dispatcher both HTTP adapters call.
 *
 * Keeping the adapters dumb (parse → dispatch → serialize) is what makes the
 * authenticated `/api` route and the raw fallback route behave identically, and
 * what lets the whole operation surface be unit-tested without a socket.
 *
 * Every handler returns `{ status, body }` and never throws: a transport must be
 * able to answer with a diagnostic even when the Host is in an unexpected state.
 *
 * @module dsh-session-manager/lib/ops
 */
import { auditPath, readAuditTail } from './audit.js';
import { PLUGIN_NAME, PLUGIN_VERSION, publicConfig } from './config.js';
import {
  archivedIdSet,
  buildView,
  cleanupResidue,
  deleteSessions,
  pinnedIdSet,
  planDelete,
  processSessionId,
  releaseSessions,
  service,
} from './delete.js';
import { decodeSegment, isValidSessionId } from './encoder.js';
import { REASONS, decide } from './plan.js';
import { listArtifacts, resolveRoots } from './scanner.js';

/** Operations that mutate durable state and therefore require a POST. */
export const DESTRUCTIVE_OPS = Object.freeze(['delete', 'release', 'restore']);
/**
 * Every operation this plugin answers.
 *
 * There is deliberately no `archive`: the plugin manages sessions the user has
 * already archived in the official client, and never archives on their behalf.
 */
export const OPS = Object.freeze(['status', 'list', 'delete', 'release', 'restore']);

/**
 * Run one operation.
 * @param ctx - Host context.
 * @param config - normalized config.
 * @param op - one of {@link OPS}.
 * @param payload - the parsed request body (or query-derived object).
 * @returns `{ status, body }`; `body` is always JSON-serializable.
 */
export async function dispatch(ctx, config, op, payload) {
  const request = payload !== null && typeof payload === 'object' ? payload : {};
  try {
    switch (op) {
      case 'status':
        return { status: 200, body: await statusPayload(ctx, config) };
      case 'list':
        return { status: 200, body: await listPayload(ctx, config, request) };
      case 'delete':
        return await deletePayload(ctx, config, request);
      case 'release':
        return await releasePayload(ctx, config, request);
      case 'restore':
        return await restorerPayload(ctx, config, request);
      default:
        return {
          status: 400,
          body: { ok: false, error: 'unknown-op', op: typeof op === 'string' ? op : null, supported: [...OPS] },
        };
    }
  } catch (error) {
    return { status: 500, body: { ok: false, error: 'internal', message: describe(error) } };
  }
}

/** Capability report plus roots and counts, for the settings diagnostics view. */
async function statusPayload(ctx, config) {
  const roots = resolveRoots(ctx, config);
  const scan = await listArtifacts(roots, scanOptions(ctx, config));
  const archive = archivedIdSet(ctx);
  let bytes = 0;
  for (const item of scan.items) if (Number.isFinite(item.bytes)) bytes += item.bytes;
  return {
    ok: true,
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    capabilities: {
      authenticatedRoute: hasFetchRoutes(ctx),
      rawRoute: hasRawRoutes(ctx),
      workspaceRegistry: service(ctx, 'workspaceRegistry') !== undefined,
      projectionCache: roots.cacheLayout !== 'absent',
      purgeProjectionCache: config.purgeProjectionCache === true && roots.cacheLayout === 'per-record',
      purgeCacheLayout: roots.cacheLayout,
      liveDetection: service(ctx, 'sessions') !== undefined || service(ctx, 'agents') !== undefined,
      releaseLive: config.releaseLive === true,
      canRelease: config.releaseLive === true && service(ctx, 'sessions') !== undefined,
      auditLog: true,
      canDeleteLive: config.allowDeleteLive === true,
      canDeleteUnarchived: config.allowDeleteUnarchived === true,
    },
    config: publicConfig(config),
    roots: {
      home: roots.home,
      persistence: roots.persistence,
      storages: roots.storages,
      cache: roots.cache,
      audit: auditPath(roots, config),
      manager: roots.manager,
    },
    counts: { items: scan.items.length, archived: archive.size, bytes },
    warnings: scan.warnings ?? [],
  };
}

/** Disk view of every session artifact, decorated with deletability. */
async function listPayload(ctx, config, payload) {
  const roots = resolveRoots(ctx, config);
  const scan = await listArtifacts(roots, scanOptions(ctx, config));
  const archive = archiveIdsOf(ctx);
  const currentSessionId = typeof payload.currentSessionId === 'string' ? payload.currentSessionId : '';
  const view = buildView(ctx, config, scan.items, archive, currentSessionId);
  const items = decorate(scan.items, view, config);
  const query = typeof payload.query === 'string' ? payload.query.trim().toLowerCase() : '';
  const filtered = query.length === 0 ? items : items.filter((item) => matches(item, query));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    archivedIds: archive,
    items: filtered,
    total: items.length,
    warnings: scan.warnings ?? [],
  };
}

/** Plan and execute (or preview) one delete request. */
async function deletePayload(ctx, config, payload) {
  const { kept: ids, rejected } = splitIds(payload.ids);
  if (ids.length === 0 && rejected.length === 0) return { status: 400, body: { ok: false, error: 'no-ids' } };
  const rejectedSkips = rejected.map((id) => ({ id, reason: REASONS.INVALID_ID }));
  const roots = resolveRoots(ctx, config);
  const scan = await listArtifacts(roots, scanOptions(ctx, config));
  const archive = archiveIdsOf(ctx);
  const currentSessionId = typeof payload.currentSessionId === 'string' ? payload.currentSessionId : '';
  const view = buildView(ctx, config, scan.items, archive, currentSessionId);
  const { plan } = planDelete({ ctx, config, items: decorate(scan.items, view, config), ids, currentSessionId });

  const dryRun = config.dryRun === true || payload.dryRun === true;
  const dryRunSkips = dryRun
    ? plan.accepted.map((item) => ({ id: item.id, reason: REASONS.DRY_RUN }))
    : [];
  const skipped = [...rejectedSkips, ...plan.skipped, ...dryRunSkips];
  const requested = ids.length + rejected.length;

  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        requested,
        deleted: [],
        skipped,
        failedIds: [],
        freedBytes: Number.isFinite(plan.totalBytes) ? plan.totalBytes : 0,
        results: plan.accepted.map((item) => ({
          id: item.id,
          ok: true,
          dryRun: true,
          freedBytes: Number.isFinite(item.bytes) ? item.bytes : 0,
          removed: {},
          failed: {},
          warnings: [],
          error: null,
        })),
        auditLog: auditPath(roots, config),
      },
    };
  }

  const actor = typeof payload.actor === 'string' && payload.actor.length > 0 ? payload.actor : 'web-ui';
  const { results, freedBytes } = await deleteSessions({
    ctx,
    config,
    roots,
    plan,
    actor,
    stopActivity: payload.stopActivity === true,
  });

  // A session whose log is already gone can still be referenced by the archive
  // set or a workspace: clean that residue and upgrade its report, so a retry
  // after a partial failure converges instead of reporting a permanent skip.
  const residueIds = plan.skipped
    .filter((entry) => entry.reason === REASONS.NOT_FOUND && hasResidue(ctx, entry.id))
    .map((entry) => entry.id);
  let residueResults = [];
  if (residueIds.length > 0) {
    const residue = await cleanupResidue({ ctx, config, roots, ids: residueIds, actor });
    residueResults = residue.results;
  }
  const residueSet = new Set(residueIds);
  const finalSkipped = skipped.filter((entry) => !(residueSet.has(entry.id) && entry.reason === REASONS.NOT_FOUND));
  const finalResults = [...results, ...residueResults];

  return {
    status: 200,
    body: {
      ok: true,
      dryRun: false,
      requested,
      deleted: finalResults.filter((entry) => entry.ok === true).map((entry) => entry.id),
      skipped: finalSkipped,
      failedIds: finalResults.filter((entry) => entry.ok !== true).map((entry) => entry.id),
      freedBytes,
      results: finalResults,
      auditLog: auditPath(roots, config),
    },
  };
}

/**
 * Free the in-memory copy of one or more sessions, deleting nothing.
 *
 * This is the escape hatch from the `live`/`running` deletion refusal: release
 * the session (stop its turn and drop it from the store), keep the log on disk,
 * and only then decide whether to delete it. Nothing on disk is touched, so
 * `released` says what happened in memory and the audit trail keeps the reason.
 *
 * Only **archived** sessions are actionable at all — this plugin manages what the
 * user archived in the official client and never archives on their behalf, so an
 * unarchived id is refused with `not-archived` exactly as a delete would be.
 *
 * @param ctx - Host context.
 * @param config - normalized config.
 * @param payload - request body.
 * @returns `{ status, body }`.
 */
async function releasePayload(ctx, config, payload) {
  // One flag governs both spellings of "touch live sessions": the automatic
  // release inside `delete` and this explicit operation.
  if (config.releaseLive === false) {
    return { status: 403, body: { ok: false, error: 'release-disabled', released: [] } };
  }
  if (service(ctx, 'sessions') === undefined) {
    return { status: 503, body: { ok: false, error: 'sessions-unavailable', released: [] } };
  }

  const { kept: ids, rejected } = splitIds(payload.ids);
  if (ids.length === 0 && rejected.length === 0) return { status: 400, body: { ok: false, error: 'no-ids' } };
  const roots = resolveRoots(ctx, config);
  const currentSessionId =
    typeof payload.currentSessionId === 'string' && payload.currentSessionId.length > 0
      ? payload.currentSessionId
      : processSessionId();

  const skipped = rejected.map((id) => ({ id, reason: REASONS.INVALID_ID }));
  const releaseable = [];
  for (const id of ids) {
    if (currentSessionId.length > 0 && currentSessionId === id) skipped.push({ id, reason: REASONS.CURRENT });
    else if (!archiveIdsOf(ctx).includes(id)) skipped.push({ id, reason: REASONS.NOT_ARCHIVED });
    else releaseable.push(id);
  }

  const dryRun = config.dryRun === true || payload.dryRun === true;
  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        requested: ids.length + rejected.length,
        wouldRelease: releaseable,
        released: [],
        skipped,
        failedIds: [],
        results: [],
        auditLog: auditPath(roots, config),
      },
    };
  }

  const actor = typeof payload.actor === 'string' && payload.actor.length > 0 ? payload.actor : 'web-ui';
  const { results } = await releaseSessions({ ctx, config, roots, ids: releaseable, actor });
  return {
    status: 200,
    body: {
      ok: true,
      dryRun: false,
      requested: ids.length + rejected.length,
      wouldRelease: [],
      released: results.filter((entry) => entry.ok === true).map((entry) => entry.id),
      skipped,
      failedIds: results.filter((entry) => entry.ok !== true).map((entry) => entry.id),
      results,
      auditLog: auditPath(roots, config),
    },
  };
}

/** Unarchive a batch; the registry owns the durable write. */
async function restorerPayload(ctx, config, payload) {
  const registry = service(ctx, 'workspaceRegistry');
  if (registry === undefined || registry === null) {
    return { status: 503, body: { ok: false, error: 'workspace-registry-unavailable', archived: false } };
  }
  const { kept: ids, rejected } = splitIds(payload.ids);
  if (ids.length === 0 && rejected.length === 0) return { status: 400, body: { ok: false, error: 'no-ids' } };
  const results = rejected.map((id) => ({ id, ok: false, error: 'invalid-id' }));
  for (const id of ids) {
    try {
      if (typeof registry.unarchiveSession !== 'function') throw new Error('unarchiveSession is unavailable on this Harness version');
      await registry.unarchiveSession(id);
      results.push({ id, ok: true, error: null });
    } catch (error) {
      results.push({ id, ok: false, error: describe(error) });
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      archived: false,
      results,
      failedIds: results.filter((entry) => entry.ok !== true).map((entry) => entry.id),
    },
  };
}

/** Newest audit records, for the settings diagnostics view. */
export async function auditTail(ctx, config, limit) {
  const roots = resolveRoots(ctx, config);
  return readAuditTail(auditPath(roots, config), Number.isFinite(limit) ? limit : 30);
}

/** Scan options shared by every operation. */
function scanOptions(ctx, config) {
  return {
    archivedIds: archiveIdsOf(ctx),
    pinnedIds: [...pinnedIdSet(ctx)],
    cascadeRoots: Array.isArray(config.cascadeRoots) ? config.cascadeRoots : [],
    purgeProjectionCache: config.purgeProjectionCache === true,
  };
}

/**
 * Stamp live/running/current/archived, the deletion verdict and whether the row
 * can be *released* onto scanned items, so `list` and `delete` can never
 * disagree about why a session may not be deleted, and the panel can offer the
 * release action exactly where it applies.
 *
 * `releasable` is archived-only: the plugin never archives, so an unarchived
 * session is not this panel's business even when it is still in memory.
 */
function decorate(items, view, config) {
  return items.map((item) => {
    const live = view.liveIds.has(item.id);
    const running = view.runningIds.has(item.id);
    const current = view.currentSessionId.length > 0 && view.currentSessionId === item.id;
    const archived = view.archivedIds.has(item.id);
    const decorated = { ...item, live, running, current, archived };
    const verdict = decide(decorated, view);
    const releasable = archived && (live || running) && !current && config?.releaseLive !== false;
    return { ...decorated, deletable: verdict.deletable, skipReason: verdict.skipReason, releasable };
  });
}

/** Case-insensitive substring match over the fields the panel can search. */
function matches(item, query) {
  for (const value of [item.id, item.project, item.dir, item.path, item.cacheFile]) {
    if (typeof value === 'string' && value.toLowerCase().includes(query)) return true;
  }
  return false;
}

/** Normalize a request's `ids` field; unknown entries are dropped, not coerced. */
function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Partition a requested id list into the ids this plugin will act on and the
 * ones it refuses outright.
 *
 * A syntactically valid segment can still *decode* to a traversal token
 * (`~002E~002E`), so the decoded form is checked too. This is defense in depth
 * ahead of the scanner's containment assertions, not a replacement for them.
 */
function splitIds(value) {
  const ids = normalizeIds(value);
  const kept = [];
  const rejected = [];
  for (const id of ids) {
    if (isValidSessionId(id) === true && !isTraversal(id)) kept.push(id);
    else rejected.push(id);
  }
  return { ids, kept, rejected };
}

/** @returns whether an id (raw or decoded) could address a parent directory. */
function isTraversal(id) {
  if (id === '.' || id === '..') return true;
  let decoded = id;
  try {
    decoded = decodeSegment(id);
  } catch {
    return true;
  }
  if (decoded === '.' || decoded === '..') return true;
  return decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0');
}

/** @returns whether an id is still referenced by the archive set, a pin, or a workspace. */
function hasResidue(ctx, id) {
  if (archivedIdSet(ctx).has(id)) return true;
  if (pinnedIdSet(ctx).has(id)) return true;
  try {
    const listed = service(ctx, 'workspaceRegistry')?.list?.();
    const workspaces = Array.isArray(listed) ? listed : [];
    return workspaces.some((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(id));
  } catch {
    return false;
  }
}

/** Archive ids in archive order, tolerating a composition without the registry. */
function archiveIdsOf(ctx) {
  const ids = service(ctx, 'workspaceRegistry')?.archivedSessionIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

/** @returns whether the authenticated exact-route surface is mounted here. */
export function hasFetchRoutes(ctx) {
  return typeof service(ctx, 'connection')?.fetch?.register === 'function';
}

/** @returns whether the raw Web Server surface is mounted here. */
export function hasRawRoutes(ctx) {
  return typeof service(ctx, 'webServer')?.register === 'function';
}

/** Render an unknown thrown value as a short message. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
