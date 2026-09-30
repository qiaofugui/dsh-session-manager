/**
 * Deletion policy — pure, synchronous and dependency-free (apart from the path-segment
 * validator, which itself touches nothing). No `node:fs`, no `node:path`, no Cordis `ctx`.
 *
 * The point of this module is that the *reason* a session may not be deleted is decided in
 * exactly one place, with a fixed precedence, so `list`, `delete` and the UI can never
 * disagree:
 *
 *   invalid-id  >  current  >  disabled  >  running  >  live  >  protected  >  not-archived
 *
 * `current` therefore outranks `live`, `protected` outranks `not-archived`, and a live session
 * that is also unarchived reports `live` (the more actionable reason).
 */

import { isValidSessionId } from './encoder.js';

/**
 * Exact reason codes of SPEC.md §4.3. Frozen: the client matches on these strings.
 */
export const REASONS = Object.freeze({
  INVALID_ID: 'invalid-id',
  NOT_FOUND: 'not-found',
  NOT_ARCHIVED: 'not-archived',
  LIVE: 'live',
  RUNNING: 'running',
  PROTECTED: 'protected',
  CURRENT: 'current',
  OVER_BATCH: 'over-batch',
  DISABLED: 'disabled',
  DRY_RUN: 'dry-run',
});

/** Fallback batch ceiling when the caller passes no usable `maxBatch`. */
const FALLBACK_MAX_BATCH = 200;

/**
 * Membership test that accepts a `Set`, an array, or nothing at all.
 *
 * @param {unknown} container candidate id collection.
 * @param {string} id id to look for.
 * @returns {boolean|undefined} `undefined` when no collection was supplied.
 */
function lookupId(container, id) {
  if (container instanceof Set) return container.has(id);
  if (Array.isArray(container)) return container.includes(id);
  return undefined;
}

/** Normalise a view object without throwing on hostile input. */
function normalizeView(view) {
  return view && typeof view === 'object' ? view : {};
}

/**
 * Decide whether one item may be deleted, and if not, why.
 *
 * @param {object|null|undefined} item an item as produced by `listArtifacts` (or anything with `id`).
 * @param {object} [view] policy view.
 * @param {Set<string>|string[]} [view.archivedIds] archived session ids.
 * @param {Set<string>|string[]} [view.liveIds] ids with a live session object.
 * @param {Set<string>|string[]} [view.runningIds] ids whose agent is actively running.
 * @param {Set<string>|string[]} [view.protectedIds] ids that must never be deleted.
 * @param {string} [view.currentSessionId] the session issuing the request.
 * @param {boolean} [view.allowDeleteUnarchived] allow deleting sessions outside the archive.
 * @param {boolean} [view.allowDeleteLive] allow deleting live/running sessions.
 * @param {boolean} [view.enabled] master switch; `false` disables all deletions.
 * @returns {{ deletable: boolean, skipReason: string|null }} never `deletable: true` with a reason.
 */
export function decide(item, view) {
  const policy = normalizeView(view);
  if (!item || typeof item !== 'object') return { deletable: false, skipReason: REASONS.NOT_FOUND };

  const id = item.id;
  if (!isValidSessionId(id)) return { deletable: false, skipReason: REASONS.INVALID_ID };

  const currentSessionId = typeof policy.currentSessionId === 'string' ? policy.currentSessionId : '';
  const current = currentSessionId !== '' ? currentSessionId === id : item.current === true;
  if (current) return { deletable: false, skipReason: REASONS.CURRENT };

  if (policy.enabled === false) return { deletable: false, skipReason: REASONS.DISABLED };

  const running = lookupId(policy.runningIds, id) ?? item.running === true;
  const live = running || (lookupId(policy.liveIds, id) ?? item.live === true);
  if (live && policy.allowDeleteLive !== true) {
    return { deletable: false, skipReason: running ? REASONS.RUNNING : REASONS.LIVE };
  }

  const protectedId = lookupId(policy.protectedIds, id) ?? false;
  if (protectedId) return { deletable: false, skipReason: REASONS.PROTECTED };

  const archived = lookupId(policy.archivedIds, id) ?? item.archived === true;
  if (!archived && policy.allowDeleteUnarchived !== true) {
    return { deletable: false, skipReason: REASONS.NOT_ARCHIVED };
  }

  return { deletable: true, skipReason: null };
}

/**
 * Turn a requested id list into an ordered, de-duplicated delete plan.
 *
 * Request order is preserved. `config.dryRun` is *not* applied here — the caller
 * (`lib/delete.js`) short-circuits it so a dry run still reports a full plan.
 *
 * @param {unknown} ids requested ids, in request order.
 * @param {Array<object>|Map<string, object>} items known items.
 * @param {object} [view] policy view; see {@link decide}.
 * @param {object} [config] normalised config (`maxBatch`, `enabled`).
 * @returns {{ accepted: object[], skipped: Array<{id: string, reason: string}>, totalBytes: number, overBatch: string[] }}
 */
export function buildDeletePlan(ids, items, view, config) {
  const policy = normalizeView(view);
  const settings = config && typeof config === 'object' ? config : {};
  const requested = Array.isArray(ids) ? ids : [];

  /** @type {Map<string, object>} */
  const byId = new Map();
  if (items instanceof Map) {
    for (const [key, value] of items) {
      const id = typeof key === 'string' ? key : value && typeof value === 'object' ? value.id : undefined;
      if (typeof id === 'string' && value && typeof value === 'object') byId.set(id, value);
    }
  } else if (Array.isArray(items)) {
    for (const value of items) {
      if (value && typeof value === 'object' && typeof value.id === 'string') byId.set(value.id, value);
    }
  }

  const maxBatch =
    Number.isInteger(settings.maxBatch) && settings.maxBatch > 0 ? settings.maxBatch : FALLBACK_MAX_BATCH;
  const disabled = settings.enabled === false || policy.enabled === false;

  const accepted = [];
  /** @type {Array<{id: string, reason: string}>} */
  const skipped = [];
  /** @type {string[]} */
  const overBatch = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
    if (seen.has(id)) continue;
    seen.add(id);

    if (!isValidSessionId(id)) {
      skipped.push({ id, reason: REASONS.INVALID_ID });
      continue;
    }
    if (disabled) {
      skipped.push({ id, reason: REASONS.DISABLED });
      continue;
    }
    const item = byId.get(id);
    if (item === undefined) {
      skipped.push({ id, reason: REASONS.NOT_FOUND });
      continue;
    }
    const verdict = decide(item, policy);
    if (!verdict.deletable) {
      skipped.push({ id, reason: verdict.skipReason ?? REASONS.NOT_ARCHIVED });
      continue;
    }
    if (accepted.length >= maxBatch) {
      skipped.push({ id, reason: REASONS.OVER_BATCH });
      overBatch.push(id);
      continue;
    }
    accepted.push(item);
    totalBytes += Number(item.bytes) > 0 ? Number(item.bytes) : 0;
  }

  return { accepted, skipped, totalBytes, overBatch };
}
