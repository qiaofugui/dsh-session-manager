/**
 * Filesystem discovery and removal for session artifacts.
 *
 * This is the ONLY module in the plugin that touches the filesystem. Everything here is
 * deliberately defensive: DSH's on-disk layout has more than one generation (project dirs,
 * `_no-cwd`, per-session directories, and the obsolete flat-file layout), the session
 * directory may be renamed by a future DSH release, and every listing races with a live
 * harness writing to the same tree. A listing therefore collects *warnings* instead of
 * throwing, and a removal collects *per-step failures* instead of throwing.
 *
 * Layouts that are understood (all of them are seen in the wild):
 *
 *   a) `<root>/--<projectKey>--/<encodedId>/<generation files...>`   (current)
 *   a') `<root>/_no-cwd/<encodedId>/<generation files...>`           (no cwd recorded)
 *   b) `<root>/<encodedId>/<generation files...>`                     (flat directory)
 *   c) `<root>/<projectDir>/<encodedId>.jsonl[.zst|.zstd]`            (legacy flat file)
 *   c') `<root>/<encodedId>.jsonl[.zst|.zstd]`                        (legacy flat file, root)
 */

import { existsSync } from 'node:fs';
import { lstat, readdir, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeSegment, encodeSegment, isValidSessionId } from './encoder.js';

/** Generation-file suffixes accepted for the legacy flat-file layout. */
const LEGACY_SUFFIXES = ['', '.zst', '.zstd'];

/** How deep the projection-cache walk goes below the cache root (`<root>/<unit>/<table>/<key>.json`). */
const CACHE_WALK_MAX_DEPTH = 3;

/** Upper bound on cache entries indexed, so a pathological tree cannot stall a listing. */
const CACHE_INDEX_MAX_ENTRIES = 20000;

/** Longest session id accepted anywhere in this module. */
const MAX_SESSION_ID_LENGTH = 200;

/** Narrow an unknown value to a non-empty string, else `''`. */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** `true` when an fs error simply means "not there". */
function isMissing(error) {
  return Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Reduce an unknown error to a message string. */
function errText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

/** Build a set of ids from a `Set`, an array, or nothing. */
function idSet(value) {
  const out = new Set();
  if (value instanceof Set) {
    for (const entry of value) if (typeof entry === 'string') out.add(entry);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === 'string') out.add(entry);
  }
  return out;
}

/** Case-aware path equality (Windows filesystems are case-insensitive). */
function isSamePath(left, right) {
  if (left === '' || right === '') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `readdir` that reports instead of throwing. */
async function readDirEntries(dir) {
  try {
    return { entries: await readdir(dir, { withFileTypes: true }), error: null };
  } catch (error) {
    return { entries: [], error };
  }
}

/**
 * The session id a directory name encodes, or `null`.
 *
 * @param {string} name one directory name.
 * @returns {string|null} the decoded id when it is a usable session id.
 */
function sessionIdFor(name) {
  const id = decodeSegment(name);
  if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH) return null;
  return isValidSessionId(id) ? id : null;
}

/**
 * The session id a legacy flat generation file names, or `null`.
 *
 * The stem is the text before the first `.jsonl`; the remainder must be one of the known
 * compression suffixes.
 *
 * @param {string} fileName one file name.
 * @returns {string|null} the decoded id when the file is a session artifact.
 */
function legacyFileId(fileName) {
  const marker = fileName.indexOf('.jsonl');
  if (marker <= 0) return null;
  const rest = fileName.slice(marker + '.jsonl'.length);
  if (!LEGACY_SUFFIXES.includes(rest)) return null;
  return sessionIdFor(fileName.slice(0, marker));
}

/**
 * Absolute-path containment test, immune to the sibling-prefix trap
 * (`C:\a\bb` is NOT inside `C:\a\b`). The root itself counts as inside.
 *
 * @param {string} root the containing directory.
 * @param {string} target the candidate path.
 * @returns {boolean} true when `target` is `root` or nested under it.
 */
export function assertInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  if (root === '' || target === '') return false;
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  if (relative === '..' || relative.startsWith('..' + path.sep)) return false;
  return true;
}

/**
 * Total byte size of a directory tree, tolerant of races.
 *
 * Each entry is sized inside its own `try`/`catch`, so a file that disappears mid-walk is
 * skipped rather than aborting the walk. Symlinks are never followed (neither into nor out of
 * the tree), so a link cannot inflate the accounting or escape the root.
 *
 * @param {string} dir directory to measure.
 * @returns {Promise<number>} summed size of regular files; `0` when unreadable.
 */
export async function sizeOfDir(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    const listing = await readDirEntries(current);
    if (listing.error) continue;
    for (const entry of listing.entries) {
      const target = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          pending.push(target);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        total += info.size;
      } catch {
        /* raced away between readdir and lstat: not our problem */
      }
    }
  }
  return total;
}

/** Size of a file or directory, best-effort (`0` when it cannot be measured). */
async function sizeOfPath(target) {
  try {
    const info = await lstat(target);
    if (info.isDirectory()) return await sizeOfDir(target);
    if (info.isSymbolicLink()) return 0;
    return info.size;
  } catch {
    return 0;
  }
}

/**
 * Resolve the storage roots the plugin operates on.
 *
 * `ctx` is optional so the module stays usable from tests and from a plain script:
 * `ctx.get('dshHomePath')` (a `(...segments) => string` factory) wins, then `$DSH_HOME`,
 * then `<homedir>/.dsh`.
 *
 * @param {object|undefined} ctx Cordis context (feature-detected).
 * @param {object|undefined} config normalised config.
 * @returns {{home: string, persistence: string, storages: string, cache: string, cacheLayout: 'per-record'|'single-legacy'|'absent', audit: string, manager: string}}
 */
export function resolveRoots(ctx, config) {
  const home = resolveHome(ctx);
  const persistence = resolvePersistence(ctx, home);
  const storages = path.join(home, 'storages');
  const cache = path.join(storages, 'session_projcache', 'sessions');
  const cacheLayout = detectCacheLayout(storages);
  const configuredManager = config && typeof config.managerDir === 'string' ? config.managerDir.trim() : '';
  const manager = configuredManager !== '' ? path.resolve(configuredManager) : path.join(home, 'session-manager');
  const configuredAudit = config && typeof config.auditLog === 'string' ? config.auditLog.trim() : '';
  const audit = configuredAudit !== '' ? path.resolve(configuredAudit) : path.join(manager, 'deleted.jsonl');
  return { home, persistence, storages, cache, cacheLayout, audit, manager };
}

/** Read a service off a Cordis context without ever throwing. */
function readService(ctx, key) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

/** Resolve the DSH home directory. */
function resolveHome(ctx) {
  const factory = readService(ctx, 'dshHomePath');
  try {
    if (typeof factory === 'function') {
      const produced = factory();
      if (typeof produced === 'string' && produced.trim() !== '') return path.resolve(produced);
    } else if (typeof factory === 'string' && factory.trim() !== '') {
      return path.resolve(factory);
    }
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = str(process.env.DSH_HOME).trim();
  if (fromEnv !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/** Resolve the session persistence root, preferring the live service. */
function resolvePersistence(ctx, home) {
  const service = readService(ctx, 'sessionPersistence');
  const root = service && typeof service.root === 'string' ? service.root.trim() : '';
  if (root !== '') return path.resolve(root);
  return path.join(home, 'sessions');
}

/** Detect which projection-cache generation is on disk. */
function detectCacheLayout(storages) {
  try {
    if (existsSync(path.join(storages, 'session_projcache', 'sessions'))) return 'per-record';
    if (existsSync(path.join(storages, 'session_projcache.json'))) return 'single-legacy';
  } catch {
    /* an unreadable storages root is simply "absent" */
  }
  return 'absent';
}

/** Internal accumulator for one session id. */
function ensureRecord(records, id, project) {
  let record = records.get(id);
  if (record === undefined) {
    record = {
      id,
      project: '',
      dir: null,
      projectDir: null,
      fileNames: [],
      files: [],
      logBytes: 0,
      extra: [],
      extraBytes: 0,
      updatedAtMs: 0,
    };
    records.set(id, record);
  }
  if (record.project === '' && typeof project === 'string' && project !== '') record.project = project;
  return record;
}

/**
 * Whether a root-level directory name is a project-directory name rather than a session dir.
 *
 * DSH spells project directories `--<projectKey>--`, and uses `_no-cwd` when the session has no
 * recorded cwd. Both are valid {@link isValidSessionId} shapes on their own, so they must be
 * excluded before the flat-layout branch can mistake one for a session directory.
 *
 * @param {string} name one directory name.
 * @returns {boolean} true when the name is a project-directory name.
 */
function looksLikeProjectDirectory(name) {
  return name === '_no-cwd' || (name.length > 4 && name.startsWith('--') && name.endsWith('--'));
}

/**
 * Record one session directory.
 *
 * @param {Map<string, object>} records accumulator.
 * @param {string} id session id.
 * @param {string} dirPath absolute session directory.
 * @param {string} projectName owning project directory name (`''` for the flat layout).
 * @param {'main'|'cascade'} origin which root the directory was found under.
 * @param {Array<import('node:fs').Dirent>} [entries] already-read directory entries.
 * @param {string[]} warnings collector.
 */
async function addSessionDirectory(records, id, dirPath, projectName, origin, entries, warnings) {
  const record = ensureRecord(records, id, projectName);
  let listing = entries;
  if (!Array.isArray(listing)) {
    const result = await readDirEntries(dirPath);
    listing = result.entries;
    if (result.error && !isMissing(result.error)) {
      warnings.push(`cannot read session directory ${dirPath}: ${errText(result.error)}`);
    }
  }

  let updatedAtMs = 0;
  const names = [];
  let hasFile = false;
  for (const entry of listing) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    hasFile = true;
    names.push(entry.name);
    try {
      const info = await stat(path.join(dirPath, entry.name));
      if (info.mtimeMs > updatedAtMs) updatedAtMs = info.mtimeMs;
    } catch {
      /* raced away; the directory listing is still useful */
    }
  }
  if (!hasFile) {
    try {
      const info = await stat(dirPath);
      updatedAtMs = info.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  names.sort();
  const bytes = await sizeOfDir(dirPath);
  for (const name of names) record.fileNames.push(name);
  record.updatedAtMs = Math.max(record.updatedAtMs, updatedAtMs);

  if (origin === 'cascade') {
    record.extra.push(dirPath);
    record.extraBytes += bytes;
    return;
  }
  if (record.dir === null) {
    record.dir = dirPath;
    record.logBytes += bytes;
    if (projectName !== '' && record.projectDir === null) record.projectDir = path.dirname(dirPath);
    return;
  }
  record.extra.push(dirPath);
  record.extraBytes += bytes;
}

/**
 * Record one legacy flat generation file.
 *
 * @param {Map<string, object>} records accumulator.
 * @param {string} id session id.
 * @param {string} dirPath directory holding the file.
 * @param {string} fileName file name.
 * @param {string} projectName owning project directory name (`''` at the root).
 * @param {'main'|'cascade'} origin which root the file was found under.
 * @param {string[]} warnings collector.
 */
async function addLegacyFile(records, id, dirPath, fileName, projectName, origin, warnings) {
  const record = ensureRecord(records, id, projectName);
  const filePath = path.join(dirPath, fileName);
  let size = 0;
  let mtimeMs = 0;
  try {
    const info = await stat(filePath);
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch (error) {
    if (!isMissing(error)) warnings.push(`cannot stat session artifact ${filePath}: ${errText(error)}`);
  }
  record.fileNames.push(fileName);
  record.updatedAtMs = Math.max(record.updatedAtMs, mtimeMs);
  if (origin === 'cascade') {
    record.extra.push(filePath);
    record.extraBytes += size;
    return;
  }
  record.files.push(filePath);
  record.logBytes += size;
  if (projectName !== '' && record.projectDir === null) record.projectDir = dirPath;
}

/**
 * Walk one persistence root and fold every artifact into `records`.
 *
 * Every directory directly under the root is treated BOTH as a candidate project directory
 * (its children may be session directories) and as a candidate session directory itself
 * (the flat layout). No filename is ever assumed.
 *
 * @param {string} rootDir persistence root.
 * @param {'main'|'cascade'} origin which root this is.
 * @param {Map<string, object>} records accumulator.
 * @param {string[]} warnings collector.
 */
async function collectFromRoot(rootDir, origin, records, warnings) {
  const listing = await readDirEntries(rootDir);
  if (listing.error) {
    if (!isMissing(listing.error)) warnings.push(`cannot read directory ${rootDir}: ${errText(listing.error)}`);
    return;
  }

  const directories = [];
  for (const entry of listing.entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) directories.push(entry.name);
    else if (entry.isFile()) {
      const id = legacyFileId(entry.name);
      if (id !== null) await addLegacyFile(records, id, rootDir, entry.name, '', origin, warnings);
    }
  }

  for (const name of directories) {
    const dirPath = path.join(rootDir, name);
    const own = await readDirEntries(dirPath);
    if (own.error && !isMissing(own.error)) {
      warnings.push(`cannot read directory ${dirPath}: ${errText(own.error)}`);
      continue;
    }

    const ownId = sessionIdFor(name);
    if (ownId !== null && !looksLikeProjectDirectory(name)) {
      const carriesLog = own.entries.some((entry) => entry.isFile() && !entry.isSymbolicLink());
      if (carriesLog) {
        // Flat layout: this directory *is* the session directory; nothing nested can belong to it.
        await addSessionDirectory(records, ownId, dirPath, '', origin, own.entries, warnings);
        continue;
      }
    }

    for (const entry of own.entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const id = sessionIdFor(entry.name);
        if (id !== null) {
          await addSessionDirectory(records, id, path.join(dirPath, entry.name), name, origin, undefined, warnings);
        }
        continue;
      }
      if (entry.isFile()) {
        const id = legacyFileId(entry.name);
        if (id !== null) await addLegacyFile(records, id, dirPath, entry.name, name, origin, warnings);
      }
    }
  }
}

/**
 * Index projection-cache files by their stem (`<stem>.json`).
 *
 * Both the literal session id and `encodeSegment(id)` are looked up later, so this walks the
 * per-record tree once instead of scanning it per session.
 *
 * @param {string} cacheRoot `<storages>/session_projcache/sessions`.
 * @param {number} depth current depth.
 * @param {Map<string, string>} index stem -> absolute path.
 */
async function indexCacheFiles(cacheRoot, depth, index) {
  if (index.size >= CACHE_INDEX_MAX_ENTRIES) return;
  const listing = await readDirEntries(cacheRoot);
  if (listing.error) return;
  for (const entry of listing.entries) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(cacheRoot, entry.name);
    if (entry.isDirectory()) {
      if (depth < CACHE_WALK_MAX_DEPTH) await indexCacheFiles(target, depth + 1, index);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    const stem = entry.name.slice(0, -'.json'.length);
    if (stem !== '' && !index.has(stem)) index.set(stem, target);
  }
}

/**
 * Build the projection-cache lookup structure for one listing pass.
 *
 * @param {{cache: string, storages: string, cacheLayout: string}} roots resolved roots.
 * @returns {Promise<{kind: 'per-record', stems: Map<string,string>}|{kind: 'single-legacy', file: string}|null>}
 */
async function buildCacheIndex(roots) {
  const layout = str(roots.cacheLayout);
  if (layout === 'single-legacy') {
    const legacy = path.join(roots.storages, 'session_projcache.json');
    try {
      if (existsSync(legacy)) return { kind: 'single-legacy', file: legacy };
    } catch {
      /* ignore */
    }
    return null;
  }
  if (layout !== 'per-record' || roots.cache === '') return null;
  const stems = new Map();
  await indexCacheFiles(roots.cache, 0, stems);
  return { kind: 'per-record', stems };
}

/**
 * Find the projection cache of one session.
 *
 * @param {string} id session id.
 * @param {Awaited<ReturnType<typeof buildCacheIndex>>} index cache index.
 * @returns {{file: string|null, bytes: number, removable: boolean}} lookup result.
 */
async function lookupCache(id, index) {
  if (index === null) return { file: null, bytes: 0, removable: false };
  if (index.kind === 'single-legacy') {
    // One file holds every session's records: it is reported, never deleted.
    return { file: index.file, bytes: 0, removable: false };
  }
  for (const stem of [id, encodeSegment(id)]) {
    const hit = index.stems.get(stem);
    if (hit === undefined) continue;
    return { file: hit, bytes: await sizeOfPath(hit), removable: true };
  }
  return { file: null, bytes: 0, removable: false };
}

/**
 * List every session artifact found under the resolved roots.
 *
 * Never throws: an unreadable entry becomes a warning string. Items carry the SPEC.md §4.2
 * shape *without* `deletable`/`skipReason` (the caller adds those via `plan.decide`) plus the
 * `sources` handle used by {@link removeArtifacts}.
 *
 * @param {object} roots resolved roots (see {@link resolveRoots}).
 * @param {object} [opts] listing options.
 * @param {string[]|Set<string>} [opts.archivedIds] archived ids.
 * @param {string[]|Set<string>} [opts.pinnedIds] pinned ids.
 * @param {string[]|Set<string>} [opts.liveIds] ids with a live session object.
 * @param {string[]|Set<string>} [opts.runningIds] ids whose agent is running.
 * @param {string} [opts.currentSessionId] the requesting session.
 * @param {string[]|string} [opts.cascadeRoots] extra persistence roots to sweep for the same ids.
 * @param {boolean} [opts.purgeProjectionCache] look for projection caches at all.
 * @returns {Promise<{items: object[], warnings: string[]}>}
 */
export async function listArtifacts(roots, opts = {}) {
  const warnings = [];
  const safeRoots = roots && typeof roots === 'object' ? roots : {};
  const options = opts && typeof opts === 'object' ? opts : {};
  const persistenceRoot = str(safeRoots.persistence);
  const storagesRoot = str(safeRoots.storages);
  const cacheRoot = str(safeRoots.cache);
  const purgeCache = options.purgeProjectionCache !== false;

  const archivedIds = idSet(options.archivedIds);
  const pinnedIds = idSet(options.pinnedIds);
  const liveIds = idSet(options.liveIds);
  const runningIds = idSet(options.runningIds);
  const currentSessionId = str(options.currentSessionId);

  /** @type {Map<string, object>} */
  const records = new Map();
  if (persistenceRoot !== '') await collectFromRoot(persistenceRoot, 'main', records, warnings);

  const cascadeInput = options.cascadeRoots;
  const cascadeRoots = Array.isArray(cascadeInput)
    ? cascadeInput
    : typeof cascadeInput === 'string'
      ? [cascadeInput]
      : [];
  for (const candidate of cascadeRoots) {
    const root = typeof candidate === 'string' ? candidate.trim() : '';
    if (root === '' || isSamePath(root, persistenceRoot)) continue;
    await collectFromRoot(root, 'cascade', records, warnings);
  }

  const cacheIndex = purgeCache ? await buildCacheIndex(safeRoots) : null;

  const items = [];
  for (const record of records.values()) {
    const cache = await lookupCache(record.id, cacheIndex);
    const id = record.id;
    const fileNames = [...new Set(record.fileNames)].sort();
    const extra = [...new Set(record.extra)];
    const files = [...new Set(record.files)];
    const primaryPath = record.dir ?? files[0] ?? extra[0] ?? '';
    items.push({
      id,
      project: record.project,
      dir: record.dir,
      path: primaryPath,
      files: fileNames,
      logBytes: record.logBytes,
      cacheBytes: cache.bytes,
      extraBytes: record.extraBytes,
      bytes: record.logBytes + cache.bytes + record.extraBytes,
      cacheFile: cache.file,
      archived: archivedIds.has(id),
      pinned: pinnedIds.has(id),
      live: liveIds.has(id),
      running: runningIds.has(id),
      current: currentSessionId !== '' && currentSessionId === id,
      updatedAt: record.updatedAtMs > 0 ? new Date(record.updatedAtMs).toISOString() : null,
      sources: {
        dir: record.dir,
        files,
        cache: cache.removable ? cache.file : null,
        extra,
        projectDir: record.projectDir,
        root: persistenceRoot,
        storages: storagesRoot,
        cacheRoot,
      },
      // Containment anchor for removeArtifacts; kept on the item so delete.js can pass items through.
      root: persistenceRoot,
    });
  }

  items.sort((left, right) => {
    const leftTime = left.updatedAt === null ? 0 : Date.parse(left.updatedAt);
    const rightTime = right.updatedAt === null ? 0 : Date.parse(right.updatedAt);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  return { items, warnings };
}

/**
 * Remove every artifact owned by one item, collecting per-step failures instead of throwing.
 *
 * Containment is re-verified with {@link assertInside} immediately before *every* removal, so a
 * poisoned item can never delete the persistence root, the storages root, an unrelated project
 * directory, or anything outside the roots. A project directory is only ever removed by the
 * dedicated prune step, and only when it is empty afterwards and `pruneEmptyProjects` is on.
 *
 * @param {object} item an item returned by {@link listArtifacts}.
 * @param {object} [opts] removal options.
 * @param {boolean} [opts.pruneEmptyProjects] remove the owning project dir when it ends up empty.
 * @param {boolean} [opts.purgeProjectionCache] also remove the projection cache file.
 * @returns {Promise<{removed: {dir: boolean, files: number, cache: boolean, extra: boolean, projectDir: boolean}, failed: Record<string, string>, freedBytes: number}>}
 */
export async function removeArtifacts(item, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const sources =
    item && typeof item.sources === 'object' && item.sources !== null ? item.sources : {};
  const root = str(item && item.root) || str(sources.root);
  const storagesRoot = str(sources.storages);
  const cacheRoot = str(sources.cacheRoot);
  const cacheContainment = cacheRoot !== '' ? cacheRoot : storagesRoot;
  const pruneEmptyProjects = options.pruneEmptyProjects === true;
  const purgeProjectionCache = options.purgeProjectionCache !== false;

  const removed = { dir: false, files: 0, cache: false, extra: false, projectDir: false };
  /** @type {Record<string, string>} */
  const failed = {};
  let freedBytes = 0;

  const sessionDir = str(sources.dir);
  if (sessionDir !== '') {
    if (!assertInside(root, sessionDir)) {
      failed.dir = `refusing to remove a path outside the persistence root: ${sessionDir}`;
    } else if (isSamePath(sessionDir, root) || (storagesRoot !== '' && isSamePath(sessionDir, storagesRoot))) {
      failed.dir = `refusing to remove a storage root: ${sessionDir}`;
    } else {
      const bytes = await sizeOfPath(sessionDir);
      try {
        await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
        removed.dir = true;
        removed.files = Array.isArray(item && item.files) ? item.files.length : 0;
        freedBytes += bytes;
      } catch (error) {
        failed.dir = errText(error);
      }
    }
  }

  const fileFailures = [];
  const fileList = Array.isArray(sources.files) ? sources.files : [];
  for (const candidate of fileList) {
    const filePath = str(candidate);
    if (filePath === '') continue;
    if (!assertInside(root, filePath)) {
      fileFailures.push(`refusing to remove a path outside the persistence root: ${filePath}`);
      continue;
    }
    if (isSamePath(filePath, root) || (storagesRoot !== '' && isSamePath(filePath, storagesRoot))) {
      fileFailures.push(`refusing to remove a storage root: ${filePath}`);
      continue;
    }
    const bytes = await sizeOfPath(filePath);
    try {
      await rm(filePath, { force: true, maxRetries: 5, retryDelay: 120 });
      removed.files += 1;
      freedBytes += bytes;
    } catch (error) {
      fileFailures.push(`${filePath}: ${errText(error)}`);
    }
  }
  if (fileFailures.length > 0) failed.files = fileFailures.join('; ');

  const cacheFile = str(sources.cache);
  if (purgeProjectionCache && cacheFile !== '') {
    if (cacheContainment === '' || !assertInside(cacheContainment, cacheFile)) {
      failed.cache = `refusing to remove a path outside the projection cache root: ${cacheFile}`;
    } else {
      const bytes = await sizeOfPath(cacheFile);
      try {
        await rm(cacheFile, { force: true, maxRetries: 5, retryDelay: 120 });
        removed.cache = true;
        freedBytes += bytes;
      } catch (error) {
        failed.cache = errText(error);
      }
    }
  }

  const extraFailures = [];
  const extraList = Array.isArray(sources.extra) ? sources.extra : [];
  for (const candidate of extraList) {
    const target = str(candidate);
    if (target === '') continue;
    const containment = [cacheRoot, storagesRoot, root].find((base) => base !== '' && assertInside(base, target));
    if (containment === undefined) {
      extraFailures.push(`refusing to remove a path outside every known root: ${target}`);
      continue;
    }
    if (isSamePath(target, root) || (storagesRoot !== '' && isSamePath(target, storagesRoot))) {
      extraFailures.push(`refusing to remove a storage root: ${target}`);
      continue;
    }
    const bytes = await sizeOfPath(target);
    let targetIsDirectory = false;
    try {
      targetIsDirectory = (await lstat(target)).isDirectory();
    } catch {
      targetIsDirectory = false;
    }
    try {
      await rm(
        target,
        targetIsDirectory
          ? { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }
          : { force: true, maxRetries: 5, retryDelay: 120 },
      );
      removed.extra = true;
      freedBytes += bytes;
    } catch (error) {
      extraFailures.push(`${target}: ${errText(error)}`);
    }
  }
  if (extraFailures.length > 0) failed.extra = extraFailures.join('; ');

  const projectDir = str(sources.projectDir);
  if (pruneEmptyProjects && projectDir !== '') {
    if (!assertInside(root, projectDir) || isSamePath(projectDir, root)) {
      failed.projectDir = `refusing to remove a path outside the persistence root: ${projectDir}`;
    } else if (storagesRoot !== '' && isSamePath(projectDir, storagesRoot)) {
      failed.projectDir = `refusing to remove a storage root: ${projectDir}`;
    } else {
      let entries = null;
      try {
        entries = await readdir(projectDir);
      } catch (error) {
        if (!isMissing(error)) failed.projectDir = errText(error);
      }
      if (entries !== null && entries.length === 0) {
        try {
          // `rmdir` is atomic about emptiness: a concurrent writer turns this into ENOTEMPTY
          // instead of losing data, which `rm -r` could not guarantee.
          await rmdir(projectDir);
          removed.projectDir = true;
        } catch (error) {
          if (!isMissing(error) && error.code !== 'ENOTEMPTY') failed.projectDir = errText(error);
        }
      }
    }
  }

  return { removed, failed, freedBytes };
}
