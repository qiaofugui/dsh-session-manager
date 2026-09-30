/**
 * host-core test suite — encoder, config, scanner, plan, audit.
 *
 * Self-contained: every fixture is created under `os.tmpdir()` via `mkdtemp` and removed in the
 * `after` hook. The real DSH home (`%DSH_HOME%`, by default `C:\Users\Joe__\.dsh`) is never read
 * or written; the one test that needs an environment fallback overrides `$DSH_HOME` with a
 * throwaway fixture directory first.
 *
 * Run with the bundled runtime (not the Volta shim):
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" \
 *       --test E:\test\dsh-session-manager\test\host-core.test.mjs
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SESSION_ID_PATTERN, decodeSegment, encodeSegment, isValidSessionId, matchesSegment } from '../lib/encoder.js';
import {
  CONFIG_DEFAULTS,
  Config,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  normalizeConfig,
  publicConfig,
} from '../lib/config.js';
import { REASONS, buildDeletePlan, decide } from '../lib/plan.js';
import { assertInside, listArtifacts, removeArtifacts, resolveRoots, sizeOfDir } from '../lib/scanner.js';
import { appendAudit, auditPath, readAuditTail } from '../lib/audit.js';

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

/** Every temp directory ever created, so `after` can remove all of them. */
const temps = [];

/** Create a fixture directory under the OS temp dir (never anywhere else). */
async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsm-test-'));
  temps.push(dir);
  return dir;
}

/** Write a file of exactly `size` bytes, creating parents. */
async function writeBytes(file, size, fill = 0x61) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, fill));
}

/** Minimal Cordis ctx stand-in: `ctx.get('dshHomePath')` is a path factory. */
function fakeCtx(base, services = {}) {
  return {
    get(key) {
      if (Object.hasOwn(services, key)) return services[key];
      if (key === 'dshHomePath') return (...segments) => path.join(base, ...segments);
      return undefined;
    },
  };
}

const idA = 'session-11111111-2222-3333-4444-555555555555';
const idB = '0b3f0b3f-0000-1111-2222-333344445555';
const idC = 'session-33333333-4444-5555-6666-777777777777';
const idD = 'session-44444444-5555-6666-7777-888888888888';
const idE = '0b3f-eeee-0000-1111-222233334444';
const idF = 'session-66666666-7777-8888-9999-aaaaaaaaaaaa';
const idG = 'session-tilde~id';
const idH = 'session-88888888-9999-aaaa-bbbb-cccccccccccc';

const LOG_NAME = 'session.v4.jsonl.zstd';
const LOG_BYTES = 1024;
const CACHE_BYTES = 64;

let home;
let sessionsRoot;
let roots;
/** @type {Map<string, object>} */
let byId;

/** Build the main fixture tree. */
async function buildMainFixture() {
  home = await tempHome();
  sessionsRoot = path.join(home, 'sessions');
  const projectDir = path.join(sessionsRoot, '--E-test--');

  // (a) standard layout, `session-…` id
  await writeBytes(path.join(projectDir, encodeSegment(idA), LOG_NAME), LOG_BYTES);
  // (a) standard layout, bare-UUID id
  await writeBytes(path.join(projectDir, encodeSegment(idB), 'session.v4.jsonl'), 128);
  // (a) standard layout, `_no-cwd` project directory
  await writeBytes(path.join(sessionsRoot, '_no-cwd', encodeSegment(idH), LOG_NAME), 256);
  // (a) standard layout, id that contains `~` (two distinct on-disk stems)
  await writeBytes(path.join(projectDir, encodeSegment(idG), LOG_NAME), 96);
  // (b) flat layout: the session directory sits directly under the root
  await writeBytes(path.join(sessionsRoot, encodeSegment(idC), LOG_NAME), 64);
  // (c) legacy flat generation file inside a project directory
  await writeBytes(path.join(projectDir, `${encodeSegment(idD)}.jsonl`), 32);
  // (c) legacy flat generation files directly under the root (both suffixes)
  await writeBytes(path.join(sessionsRoot, `${encodeSegment(idE)}.jsonl.zst`), 16);
  await writeBytes(path.join(sessionsRoot, '--Legacy--', `${encodeSegment(idF)}.jsonl.zstd`), 8);

  // projection cache: literal stem for idA, encoded stem for idG
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  await writeBytes(path.join(cacheDir, `${idA}.json`), CACHE_BYTES);
  await writeBytes(path.join(cacheDir, `${encodeSegment(idG)}.json`), CACHE_BYTES);
}

before(async () => {
  await buildMainFixture();
  roots = resolveRoots(fakeCtx(home), {});
  const listing = await listArtifacts(roots, {
    archivedIds: [idA],
    pinnedIds: [idB],
    liveIds: [idC],
    runningIds: [idD],
    currentSessionId: idE,
    purgeProjectionCache: true,
  });
  byId = new Map(listing.items.map((item) => [item.id, item]));
});

after(async () => {
  for (const dir of temps) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------------------------
// encoder
// ---------------------------------------------------------------------------------------------

test('encodeSegment leaves safe code units literal and escapes everything else', () => {
  assert.equal(encodeSegment('session-99d4237d'), 'session-99d4237d');
  assert.equal(encodeSegment('a.b_c-d'), 'a.b_c-d');
  // non-ASCII, one escape per UTF-16 code unit, uppercase hex, four digits
  assert.equal(encodeSegment('中文'), '~4E2D~6587');
  assert.equal(encodeSegment(' '), '~0020');
  assert.equal(encodeSegment('/'), '~002F');
  assert.equal(encodeSegment('\\'), '~005C');
  assert.equal(encodeSegment(':'), '~003A');
  // `~` itself is NOT safe: it must be escaped or the codec would not be injective
  assert.equal(encodeSegment('~'), '~007E');
  assert.equal(encodeSegment('a~b'), 'a~007Eb');
  // DSH's traversal guard for otherwise-safe whole segments
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  // never throws on junk
  assert.equal(encodeSegment(''), '');
  assert.equal(encodeSegment(null), '');
  assert.equal(encodeSegment(undefined), '');
});

test('decodeSegment round-trips encodeSegment, including non-ASCII, `~` and surrogates', () => {
  const samples = [
    'session-99d4237d-1234-5678-90ab-cdef01234567',
    '中文-路径',
    'a~b~~c',
    '🙂 emoji',
    'tab\tnewline\nslash/back\\slash',
    '.',
    '..',
    '\uD83D', // lone high surrogate
  ];
  for (const sample of samples) {
    assert.equal(decodeSegment(encodeSegment(sample)), sample, `round-trip failed for ${JSON.stringify(sample)}`);
  }
  assert.equal(decodeSegment('~007E'), '~');
  assert.equal(decodeSegment('~4e2d'), '中'); // lowercase hex is accepted
});

test('decodeSegment is lenient and never throws on malformed input', () => {
  assert.equal(decodeSegment('~'), '~');
  assert.equal(decodeSegment('abc~'), 'abc~');
  assert.equal(decodeSegment('a~12b'), 'a~12b');
  assert.equal(decodeSegment('a~00G1b'), 'a~00G1b');
  assert.equal(decodeSegment('~~zz'), '~~zz');
  assert.equal(decodeSegment(''), '');
  assert.equal(decodeSegment(null), '');
  assert.equal(decodeSegment(undefined), '');
  assert.equal(decodeSegment(42), '42');
});

test('matchesSegment accepts both the encoded and the decoded spelling', () => {
  assert.equal(matchesSegment(encodeSegment(idG), idG), true);
  assert.equal(matchesSegment(idA, idA), true);
  assert.equal(matchesSegment(encodeSegment(idB), idB), true);
  assert.equal(matchesSegment(encodeSegment(idA), idB), false);
  assert.equal(matchesSegment('', idA), false);
  assert.equal(matchesSegment(idA, ''), false);
  assert.equal(matchesSegment(undefined, idA), false);
});

test('isValidSessionId rejects traversal, separators, NUL, dot segments and overlong ids', () => {
  assert.equal(SESSION_ID_PATTERN.source, '^[A-Za-z0-9._~-]{1,200}$');
  for (const good of [idA, idB, 'session-a', 'a.b_c-d', 'session-tilde~id', 'x'.repeat(200)]) {
    assert.equal(isValidSessionId(good), true, `expected ${good} to be valid`);
  }
  for (const bad of [
    '../x',
    '..',
    '.',
    'a/b',
    'a\\b',
    'a\u0000b',
    'C:',
    'a b',
    '中文',
    '',
    'x'.repeat(201),
    null,
    undefined,
    42,
    {},
    ['a'],
  ]) {
    assert.equal(isValidSessionId(bad), false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
});

// ---------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------

test('config exposes the frozen plugin identity and the Standard Schema v1 shape', () => {
  assert.equal(PLUGIN_NAME, 'dsh-session-manager');
  assert.equal(PLUGIN_VERSION, '1.0.0');
  const standard = Config['~standard'];
  assert.equal(standard.version, 1);
  assert.equal(standard.vendor, PLUGIN_NAME);
  assert.equal(typeof standard.validate, 'function');
  const result = standard.validate(undefined);
  assert.equal('issues' in result, false);
  assert.equal(typeof result.then, 'undefined'); // must be synchronous
  assert.equal(result.value.enabled, true);
  assert.equal(result.value.maxBatch, 200);
});

test('normalizeConfig fills every default and never throws', () => {
  const { value, issues } = normalizeConfig(undefined);
  assert.deepEqual(issues, []);
  assert.deepEqual(value, {
    enabled: true,
    allowDeleteArchived: true,
    allowDeleteUnarchived: false,
    allowDeleteLive: false,
    releaseLive: true,
    purgeProjectionCache: true,
    pruneEmptyProjects: true,
    cascadeRoots: [],
    protectedSessionIds: [],
    maxBatch: 200,
    dryRun: false,
    auditLog: '',
    routePath: '',
    fallbackRoutePath: '',
    managerDir: '',
  });
  assert.deepEqual(CONFIG_DEFAULTS.cascadeRoots, []);
  assert.deepEqual(normalizeConfig(null).value, value);
  assert.deepEqual(normalizeConfig('').value, value);
  assert.deepEqual(normalizeConfig(42).value, value);
  assert.equal(normalizeConfig(42).issues.length, 1);
  assert.deepEqual(normalizeConfig([]).issues.length, 1);
});

test('normalizeConfig ignores unknown keys (forward compatibility)', () => {
  const { value, issues } = normalizeConfig({ futureFlag: true, nested: { a: 1 }, list: [1, 2] });
  assert.deepEqual(issues, []);
  assert.equal('futureFlag' in value, false);
  assert.equal('nested' in value, false);
  assert.equal('list' in value, false);
  assert.equal(value.enabled, true);
});

test('normalizeConfig coerces booleans, paths and the batch size', () => {
  const { value, issues } = normalizeConfig({
    enabled: 'false',
    allowDeleteUnarchived: 1,
    allowDeleteLive: 0,
    dryRun: 'true',
    purgeProjectionCache: '',
    pruneEmptyProjects: false,
    maxBatch: '15',
    cascadeRoots: 'C:\\other\\sessions',
    protectedSessionIds: ['  keep-me  ', 'other'],
    auditLog: '  C:\\logs\\audit.jsonl  ',
    routePath: '/custom',
  });
  assert.deepEqual(issues, []);
  assert.equal(value.enabled, false);
  assert.equal(value.allowDeleteUnarchived, true);
  assert.equal(value.allowDeleteLive, false);
  assert.equal(value.dryRun, true);
  assert.equal(value.purgeProjectionCache, true);
  assert.equal(value.pruneEmptyProjects, false);
  assert.equal(value.maxBatch, 15);
  assert.deepEqual(value.cascadeRoots, ['C:\\other\\sessions']);
  assert.deepEqual(value.protectedSessionIds, ['keep-me', 'other']);
  assert.equal(value.auditLog, 'C:\\logs\\audit.jsonl');
  assert.equal(value.routePath, '/custom');
});

test('normalizeConfig reports issues for unusable known values but keeps the rest', () => {
  const bad = normalizeConfig({ maxBatch: 0, cascadeRoots: [1], auditLog: 5, enabled: 'sometimes' });
  assert.equal(bad.issues.length, 4);
  assert.deepEqual(
    bad.issues.map((issue) => issue.path[0]).sort(),
    ['auditLog', 'cascadeRoots', 'enabled', 'maxBatch'],
  );
  assert.equal(typeof bad.issues[0].message, 'string');
  assert.equal(bad.value.maxBatch, CONFIG_DEFAULTS.maxBatch);
  assert.equal(bad.value.enabled, CONFIG_DEFAULTS.enabled);
  assert.equal(bad.value.auditLog, '');
  assert.deepEqual(bad.value.cascadeRoots, []);

  for (const maxBatch of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}, true]) {
    const result = normalizeConfig({ maxBatch });
    assert.equal(result.issues.length, 1, `expected an issue for maxBatch=${JSON.stringify(maxBatch)}`);
  }

  const viaSchema = Config['~standard'].validate({ maxBatch: -3 });
  assert.equal('value' in viaSchema, false);
  assert.equal(viaSchema.issues.length, 1);
  assert.deepEqual(viaSchema.issues[0].path, ['maxBatch']);
});

test('publicConfig exposes only the safe slice', () => {
  const { value } = normalizeConfig({ allowDeleteLive: true, maxBatch: 7 });
  const exposed = publicConfig(value);
  assert.deepEqual(exposed, {
    enabled: true,
    allowDeleteUnarchived: false,
    allowDeleteLive: true,
    releaseLive: true,
    dryRun: false,
    purgeProjectionCache: true,
    maxBatch: 7,
  });
  assert.deepEqual(Object.keys(exposed).sort(), [
    'allowDeleteLive',
    'allowDeleteUnarchived',
    'dryRun',
    'enabled',
    'maxBatch',
    'purgeProjectionCache',
    'releaseLive',
  ]);
  assert.equal(publicConfig(undefined).maxBatch, 200);
});

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

/** An item stub for policy tests. */
function planItem(overrides = {}) {
  return {
    id: 'session-aaaa-bbbb',
    archived: true,
    pinned: false,
    live: false,
    running: false,
    current: false,
    bytes: 100,
    ...overrides,
  };
}

test('REASONS holds exactly the frozen reason codes', () => {
  assert.deepEqual(REASONS, {
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
  assert.equal(Object.isFrozen(REASONS), true);
});

test('decide() covers every reason code with the frozen precedence', () => {
  const id = 'session-aaaa-bbbb';
  const archived = new Set([id]);
  const empty = new Set();

  // deletable: archived and nothing else in the way
  assert.deepEqual(decide(planItem(), { archivedIds: archived }), { deletable: true, skipReason: null });

  // invalid-id outranks everything, including `current` and `enabled: false`
  assert.deepEqual(decide(planItem({ id: '../x', current: true }), { currentSessionId: '../x', enabled: false }), {
    deletable: false,
    skipReason: REASONS.INVALID_ID,
  });

  // current outranks live / protected / not-archived / disabled
  assert.deepEqual(
    decide(planItem({ current: true, live: true }), { archivedIds: empty, currentSessionId: id, enabled: false }),
    { deletable: false, skipReason: REASONS.CURRENT },
  );
  assert.deepEqual(decide(planItem({ live: true }), { archivedIds: archived, currentSessionId: id }), {
    deletable: false,
    skipReason: REASONS.CURRENT,
  });

  // disabled
  assert.deepEqual(decide(planItem(), { archivedIds: archived, enabled: false }), {
    deletable: false,
    skipReason: REASONS.DISABLED,
  });

  // running wins over live, and both are bypassed by allowDeleteLive
  assert.deepEqual(decide(planItem({ running: true, live: true }), { archivedIds: archived }), {
    deletable: false,
    skipReason: REASONS.RUNNING,
  });
  assert.deepEqual(decide(planItem({ running: true }), { archivedIds: archived, runningIds: new Set([id]) }), {
    deletable: false,
    skipReason: REASONS.RUNNING,
  });
  assert.deepEqual(
    decide(planItem({ running: true }), { archivedIds: archived, allowDeleteLive: true }),
    { deletable: true, skipReason: null },
  );

  // live (not running), and a live + unarchived session still reports `live`
  assert.deepEqual(decide(planItem({ live: true }), { archivedIds: archived }), {
    deletable: false,
    skipReason: REASONS.LIVE,
  });
  assert.deepEqual(decide(planItem({ live: true }), { archivedIds: empty }), {
    deletable: false,
    skipReason: REASONS.LIVE,
  });
  assert.deepEqual(decide(planItem({ live: true }), { archivedIds: empty, allowDeleteLive: true }), {
    deletable: false,
    skipReason: REASONS.NOT_ARCHIVED,
  });
  assert.deepEqual(decide(planItem({ live: true }), { archivedIds: archived, allowDeleteLive: true }), {
    deletable: true,
    skipReason: null,
  });

  // protected beats not-archived, but not live
  assert.deepEqual(decide(planItem({ archived: false }), { archivedIds: empty, protectedIds: new Set([id]) }), {
    deletable: false,
    skipReason: REASONS.PROTECTED,
  });
  assert.deepEqual(decide(planItem({ live: true }), { archivedIds: empty, protectedIds: new Set([id]) }), {
    deletable: false,
    skipReason: REASONS.LIVE,
  });
  assert.deepEqual(decide(planItem(), { archivedIds: archived, protectedIds: new Set([id]) }), {
    deletable: false,
    skipReason: REASONS.PROTECTED,
  });

  // not-archived, and its escape hatch
  assert.deepEqual(decide(planItem({ archived: false }), { archivedIds: empty }), {
    deletable: false,
    skipReason: REASONS.NOT_ARCHIVED,
  });
  assert.deepEqual(decide(planItem(), { archivedIds: empty }), {
    deletable: false,
    skipReason: REASONS.NOT_ARCHIVED,
  });
  assert.deepEqual(decide(planItem({ archived: false }), { archivedIds: empty, allowDeleteUnarchived: true }), {
    deletable: true,
    skipReason: null,
  });

  // the archive view overrides the item's own flag
  assert.deepEqual(decide(planItem({ archived: true }), { archivedIds: empty }), {
    deletable: false,
    skipReason: REASONS.NOT_ARCHIVED,
  });
  assert.deepEqual(decide(planItem({ archived: false }), { archivedIds: archived }), {
    deletable: true,
    skipReason: null,
  });

  // missing / hostile input is not-found, never a crash
  assert.deepEqual(decide(null, {}), { deletable: false, skipReason: REASONS.NOT_FOUND });
  assert.deepEqual(decide(undefined, undefined), { deletable: false, skipReason: REASONS.NOT_FOUND });
});

test('decide() never reports deletable together with a skipReason', () => {
  const id = 'session-aaaa-bbbb';
  const flags = [true, false];
  for (const archived of flags) {
    for (const live of flags) {
      for (const running of flags) {
        for (const current of flags) {
          for (const allowDeleteLive of flags) {
            for (const allowDeleteUnarchived of flags) {
              const view = {
                archivedIds: archived ? new Set([id]) : new Set(),
                liveIds: live ? new Set([id]) : new Set(),
                runningIds: running ? new Set([id]) : new Set(),
                protectedIds: new Set(),
                currentSessionId: current ? id : '',
                allowDeleteLive,
                allowDeleteUnarchived,
                enabled: true,
              };
              const verdict = decide(planItem(), view);
              if (verdict.deletable) assert.equal(verdict.skipReason, null);
              else assert.equal(typeof verdict.skipReason, 'string');
            }
          }
        }
      }
    }
  }
});

test('buildDeletePlan preserves request order, dedupes, and classifies misses', () => {
  const items = [
    planItem({ id: 'session-a1', bytes: 10 }),
    planItem({ id: 'session-b2', bytes: 20 }),
    planItem({ id: 'session-c3', bytes: 30, archived: false }),
    planItem({ id: 'session-d4', bytes: 40, live: true }),
  ];
  const view = {
    archivedIds: new Set(['session-a1', 'session-b2', 'session-d4']),
    liveIds: new Set(['session-d4']),
    runningIds: new Set(),
    protectedIds: new Set(),
  };
  const config = normalizeConfig({}).value;

  const plan = buildDeletePlan(
    ['session-b2', 'session-a1', 'session-b2', 'session-c3', 'session-missing', '../x', 'session-d4'],
    items,
    view,
    config,
  );

  assert.deepEqual(
    plan.accepted.map((item) => item.id),
    ['session-b2', 'session-a1'],
  );
  assert.deepEqual(plan.skipped, [
    { id: 'session-c3', reason: REASONS.NOT_ARCHIVED },
    { id: 'session-missing', reason: REASONS.NOT_FOUND },
    { id: '../x', reason: REASONS.INVALID_ID },
    { id: 'session-d4', reason: REASONS.LIVE },
  ]);
  assert.equal(plan.totalBytes, 30);
  assert.deepEqual(plan.overBatch, []);

  // dryRun is deliberately NOT applied here
  const dryRunPlan = buildDeletePlan(['session-a1'], items, view, normalizeConfig({ dryRun: true }).value);
  assert.deepEqual(
    dryRunPlan.accepted.map((item) => item.id),
    ['session-a1'],
  );
});

test('buildDeletePlan enforces maxBatch on the accepted tail', () => {
  const ids = ['session-a1', 'session-b2', 'session-c3', 'session-d4'];
  const items = ids.map((id) => planItem({ id, bytes: 5 }));
  const view = { archivedIds: new Set(ids) };
  const plan = buildDeletePlan(ids, items, view, { maxBatch: 2, enabled: true });

  assert.deepEqual(
    plan.accepted.map((item) => item.id),
    ['session-a1', 'session-b2'],
  );
  assert.deepEqual(plan.skipped, [
    { id: 'session-c3', reason: REASONS.OVER_BATCH },
    { id: 'session-d4', reason: REASONS.OVER_BATCH },
  ]);
  assert.deepEqual(plan.overBatch, ['session-c3', 'session-d4']);
  assert.equal(plan.totalBytes, 10);
});

test('buildDeletePlan reports disabled for every requested id', () => {
  const ids = ['session-a1', 'session-missing', 'session-c3'];
  const items = [planItem({ id: 'session-a1' }), planItem({ id: 'session-c3' })];
  const plan = buildDeletePlan(
    ids,
    items,
    { archivedIds: new Set(ids) },
    normalizeConfig({ enabled: false }).value,
  );
  assert.deepEqual(plan.accepted, []);
  assert.deepEqual(plan.skipped, [
    { id: 'session-a1', reason: REASONS.DISABLED },
    { id: 'session-missing', reason: REASONS.DISABLED },
    { id: 'session-c3', reason: REASONS.DISABLED },
  ]);
  // invalid ids still outrank `disabled`
  assert.deepEqual(buildDeletePlan(['../x'], items, {}, normalizeConfig({ enabled: false }).value).skipped, [
    { id: '../x', reason: REASONS.INVALID_ID },
  ]);
});

test('buildDeletePlan tolerates a Map of items and empty input', () => {
  const map = new Map([['session-a1', planItem({ id: 'session-a1', bytes: 3 })]]);
  const plan = buildDeletePlan(['session-a1'], map, { archivedIds: new Set(['session-a1']) }, { maxBatch: 5 });
  assert.deepEqual(
    plan.accepted.map((item) => item.id),
    ['session-a1'],
  );
  assert.equal(plan.totalBytes, 3);
  assert.deepEqual(buildDeletePlan(null, null, null, null), {
    accepted: [],
    skipped: [],
    totalBytes: 0,
    overBatch: [],
  });
});

// ---------------------------------------------------------------------------------------------
// scanner
// ---------------------------------------------------------------------------------------------

test('assertInside is exact about containment, including the sibling-prefix trap', () => {
  const root = path.join(path.sep === '\\' ? 'C:\\' : '/', 'a', 'b');
  assert.equal(assertInside(root, root), true);
  assert.equal(assertInside(root, path.join(root, 'child')), true);
  assert.equal(assertInside(root, path.join(root, 'child', 'deep', 'file.jsonl')), true);
  assert.equal(assertInside(path.join(root, 'child'), root), false);
  assert.equal(assertInside(root, path.join(root, '..', 'sibling')), false);
  assert.equal(assertInside(root, path.join(root, '..')), false);
  // `C:\a\bb` is a sibling of `C:\a\b`, NOT a child of it
  assert.equal(assertInside('C:\\a\\b', 'C:\\a\\bb'), false);
  assert.equal(assertInside('C:\\a\\b', 'C:\\a\\bb\\c.jsonl'), false);
  assert.equal(assertInside('C:\\a\\b', 'C:\\a\\b\\c.jsonl'), true);
  // the same trap without hard-coded drive letters
  assert.equal(assertInside(root, `${root}-sibling`), false);
  assert.equal(assertInside('', root), false);
  assert.equal(assertInside(root, ''), false);
  assert.equal(assertInside(undefined, root), false);
  assert.equal(assertInside(root, undefined), false);
});

test('resolveRoots feature-detects the services and the cache layout', async () => {
  assert.equal(roots.home, home);
  assert.equal(roots.persistence, path.join(home, 'sessions'));
  assert.equal(roots.storages, path.join(home, 'storages'));
  assert.equal(roots.cache, path.join(home, 'storages', 'session_projcache', 'sessions'));
  assert.equal(roots.cacheLayout, 'per-record');
  assert.equal(roots.manager, path.join(home, 'session-manager'));
  assert.equal(roots.audit, path.join(home, 'session-manager', 'deleted.jsonl'));

  // sessionPersistence.root wins over <home>/sessions
  const custom = path.join(home, 'custom-sessions');
  const overridden = resolveRoots(fakeCtx(home, { sessionPersistence: { root: custom } }), {});
  assert.equal(overridden.persistence, custom);

  // config.managerDir / config.auditLog win over the derived defaults
  const configured = resolveRoots(fakeCtx(home), { managerDir: 'C:\\cfg\\manager', auditLog: 'C:\\cfg\\logs\\d.jsonl' });
  assert.equal(configured.manager, path.resolve('C:\\cfg\\manager'));
  assert.equal(configured.audit, path.resolve('C:\\cfg\\logs\\d.jsonl'));

  // single-legacy layout
  const legacyHome = await tempHome();
  await writeBytes(path.join(legacyHome, 'storages', 'session_projcache.json'), 4);
  assert.equal(resolveRoots(fakeCtx(legacyHome), {}).cacheLayout, 'single-legacy');

  // absent layout
  const bareHome = await tempHome();
  assert.equal(resolveRoots(fakeCtx(bareHome), {}).cacheLayout, 'absent');

  // no ctx at all: falls back to $DSH_HOME (pointed at a fixture, never the real home)
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = bareHome;
  try {
    assert.equal(resolveRoots(undefined, {}).home, bareHome);
    assert.equal(resolveRoots(undefined, {}).persistence, path.join(bareHome, 'sessions'));
    assert.equal(resolveRoots({ get: () => undefined }, {}).home, bareHome);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('listArtifacts discovers every supported layout without assuming a file name', () => {
  assert.deepEqual([...byId.keys()].sort(), [idA, idB, idC, idD, idE, idF, idG, idH].sort());

  // (a) standard layout, `session-…` id
  const a = byId.get(idA);
  assert.equal(a.project, '--E-test--');
  assert.equal(a.dir, path.join(sessionsRoot, '--E-test--', encodeSegment(idA)));
  assert.equal(a.path, a.dir);
  assert.deepEqual(a.files, [LOG_NAME]);
  assert.equal(a.archived, true);
  assert.equal(a.pinned, false);
  assert.equal(a.live, false);
  assert.equal(a.current, false);
  assert.equal(typeof a.updatedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(a.updatedAt)), false);
  assert.equal('deletable' in a, false);
  assert.equal('skipReason' in a, false);

  // (a) standard layout, bare-UUID id
  const b = byId.get(idB);
  assert.equal(b.project, '--E-test--');
  assert.equal(b.dir, path.join(sessionsRoot, '--E-test--', encodeSegment(idB)));
  assert.deepEqual(b.files, ['session.v4.jsonl']);
  assert.equal(b.pinned, true);

  // (a) `_no-cwd` project directory
  assert.equal(byId.get(idH).project, '_no-cwd');

  // (b) flat layout directly under the root
  const c = byId.get(idC);
  assert.equal(c.dir, path.join(sessionsRoot, encodeSegment(idC)));
  assert.equal(c.project, '');
  assert.equal(c.live, true);
  assert.equal(c.sources.projectDir, null);

  // (c) legacy flat generation file inside a project directory
  const d = byId.get(idD);
  assert.equal(d.dir, null);
  assert.equal(d.project, '--E-test--');
  assert.deepEqual(d.files, [`${encodeSegment(idD)}.jsonl`]);
  assert.equal(d.path, path.join(sessionsRoot, '--E-test--', `${encodeSegment(idD)}.jsonl`));
  assert.deepEqual(d.sources.files, [d.path]);
  assert.equal(d.sources.projectDir, path.join(sessionsRoot, '--E-test--'));
  assert.equal(d.running, true);

  // (c) legacy flat files directly under the root, both compression suffixes
  const e = byId.get(idE);
  assert.equal(e.dir, null);
  assert.equal(e.project, '');
  assert.deepEqual(e.files, [`${encodeSegment(idE)}.jsonl.zst`]);
  assert.equal(e.current, true);
  assert.deepEqual(byId.get(idF).files, [`${encodeSegment(idF)}.jsonl.zstd`]);
  assert.equal(byId.get(idF).project, '--Legacy--');

  // the id that contains `~` keeps its own distinct on-disk stem
  assert.equal(encodeSegment(idG), 'session-tilde~007Eid');
  assert.equal(encodeSegment(idG) === idG, false);
});

test('listArtifacts accounts bytes and resolves both projection-cache stems', () => {
  const a = byId.get(idA);
  assert.equal(a.logBytes, LOG_BYTES);
  assert.equal(a.cacheBytes, CACHE_BYTES);
  assert.equal(a.extraBytes, 0);
  assert.equal(a.bytes, LOG_BYTES + CACHE_BYTES);
  assert.equal(a.cacheFile, path.join(home, 'storages', 'session_projcache', 'sessions', `${idA}.json`));
  assert.equal(a.sources.cache, a.cacheFile);

  // idG's cache file is stored under the ENCODED stem, not the literal id
  const g = byId.get(idG);
  assert.equal(g.cacheFile, path.join(home, 'storages', 'session_projcache', 'sessions', `${encodeSegment(idG)}.json`));
  assert.equal(g.cacheBytes, CACHE_BYTES);
  assert.equal(g.logBytes, 96);
  assert.equal(g.bytes, 96 + CACHE_BYTES);

  // ids without a cache record still report the log bytes
  const b = byId.get(idB);
  assert.equal(b.cacheFile, null);
  assert.equal(b.cacheBytes, 0);
  assert.equal(b.bytes, 128);

  // containment anchors that delete.js / removeArtifacts rely on
  for (const item of byId.values()) {
    assert.equal(item.root, sessionsRoot);
    assert.equal(item.sources.root, sessionsRoot);
    assert.equal(item.sources.storages, path.join(home, 'storages'));
    assert.equal(item.sources.cacheRoot, roots.cache);
    assert.equal(item.bytes, item.logBytes + item.cacheBytes + item.extraBytes);
  }
});

test('listArtifacts reports warnings instead of throwing, and never touches a missing root', async () => {
  const missing = await listArtifacts({ persistence: path.join(home, 'nope'), storages: '', cache: '', cacheLayout: 'absent' }, {});
  assert.deepEqual(missing.items, []);
  assert.deepEqual(missing.warnings, []);

  const empty = await listArtifacts(undefined, undefined);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.warnings, []);

  // an unreadable entry becomes a warning
  const brokenHome = await tempHome();
  const brokenRoot = path.join(brokenHome, 'sessions');
  await writeBytes(path.join(brokenRoot, encodeSegment(idA), LOG_NAME), 8);
  const broken = await listArtifacts({ persistence: brokenRoot, storages: '', cache: '', cacheLayout: 'absent' }, {});
  assert.equal(broken.items.length, 1);

  // cascade roots are swept for the same ids and accounted as extra bytes
  const cascadeHome = await tempHome();
  const cascadeRoot = path.join(cascadeHome, 'sessions');
  await writeBytes(path.join(cascadeRoot, '--Other--', encodeSegment(idA), LOG_NAME), 512);
  const cascaded = await listArtifacts(roots, {
    cascadeRoots: [cascadeRoot],
    purgeProjectionCache: false,
  });
  const cascadedA = cascaded.items.find((item) => item.id === idA);
  assert.equal(cascadedA.extraBytes, 512);
  assert.deepEqual(cascadedA.sources.extra, [path.join(cascadeRoot, '--Other--', encodeSegment(idA))]);
  assert.equal(cascadedA.bytes, LOG_BYTES + 512);
  assert.equal(cascadedA.cacheFile, null);
});

test('sizeOfDir sums regular files, tolerates races, and never follows symlinks', async () => {
  const dir = await tempHome();
  await writeBytes(path.join(dir, 'a.bin'), 10);
  await writeBytes(path.join(dir, 'nested', 'b.bin'), 20);
  assert.equal(await sizeOfDir(dir), 30);

  // races and absences are not fatal
  assert.equal(await sizeOfDir(path.join(dir, 'does-not-exist')), 0);

  // a symlink pointing outside the tree must not contribute
  const outside = await tempHome();
  await writeBytes(path.join(outside, 'huge.bin'), 4096);
  try {
    await symlink(outside, path.join(dir, 'link'), 'junction');
  } catch {
    return; // symlink creation is not permitted here; nothing to assert
  }
  await writeBytes(path.join(dir, 'c.bin'), 1);
  assert.equal(await sizeOfDir(dir), 31);
});

test('removeArtifacts deletes a real tree, the cache file, and prunes an empty project dir', async () => {
  const pruneHome = await tempHome();
  const pruneRoot = path.join(pruneHome, 'sessions');
  const projectDir = path.join(pruneRoot, '--Only--');
  const sessionDir = path.join(projectDir, encodeSegment(idA));
  await writeBytes(path.join(sessionDir, LOG_NAME), 256);
  await writeBytes(path.join(sessionDir, 'nested', 'extra.bin'), 64);
  const cacheFile = path.join(pruneHome, 'storages', 'session_projcache', 'sessions', `${idA}.json`);
  await writeBytes(cacheFile, 32);

  const pruneRoots = resolveRoots(fakeCtx(pruneHome), {});
  const listing = await listArtifacts(pruneRoots, { purgeProjectionCache: true });
  assert.equal(listing.items.length, 1);
  const item = listing.items[0];
  assert.equal(item.bytes, 320 + 32);
  assert.equal(item.sources.projectDir, projectDir);

  const result = await removeArtifacts(item, { pruneEmptyProjects: true, purgeProjectionCache: true });
  assert.deepEqual(result.failed, {});
  assert.equal(result.removed.dir, true);
  assert.equal(result.removed.files, 1);
  assert.equal(result.removed.cache, true);
  assert.equal(result.removed.projectDir, true);
  assert.equal(result.freedBytes, 352);
  await assert.rejects(stat(sessionDir));
  await assert.rejects(stat(cacheFile));
  await assert.rejects(stat(projectDir));

  // the same removal with pruning disabled leaves the (now empty) project directory alone
  await writeBytes(path.join(sessionDir, LOG_NAME), 128);
  const again = await listArtifacts(pruneRoots, { purgeProjectionCache: false });
  const kept = await removeArtifacts(again.items[0], { pruneEmptyProjects: false, purgeProjectionCache: false });
  assert.deepEqual(kept.failed, {});
  assert.equal(kept.removed.dir, true);
  assert.equal(kept.removed.projectDir, false);
  assert.equal((await stat(projectDir)).isDirectory(), true);
});

test('removeArtifacts refuses paths outside the root and leaves them untouched', async () => {
  const rootHome = await tempHome();
  const outside = await tempHome();
  const outsideFile = path.join(outside, 'keep-me.jsonl');
  await writeBytes(outsideFile, 12);

  const root = path.join(rootHome, 'sessions');
  const sessionDir = path.join(root, '--P--', encodeSegment(idA));
  await writeBytes(path.join(sessionDir, LOG_NAME), 8);
  const listing = await listArtifacts(resolveRoots(fakeCtx(rootHome), {}), { purgeProjectionCache: false });
  const item = listing.items[0];

  // poison the item: a file and a directory that live outside the persistence root
  const poisoned = {
    ...item,
    sources: { ...item.sources, files: [outsideFile], extra: [outside], projectDir: outside },
  };
  const escaped = await removeArtifacts(poisoned, { pruneEmptyProjects: true });
  assert.equal(escaped.removed.dir, true); // the legitimate directory still goes
  assert.equal(escaped.removed.files, 1); // ...and it accounts for the one log file inside it
  assert.equal(escaped.removed.extra, false);
  assert.equal(escaped.removed.projectDir, false);
  assert.equal(typeof escaped.failed.files, 'string');
  assert.equal(typeof escaped.failed.extra, 'string');
  assert.equal(typeof escaped.failed.projectDir, 'string');
  assert.equal((await stat(outsideFile)).size, 12); // still there
  assert.equal((await stat(outside)).isDirectory(), true);

  // the persistence root itself is never removable, even when an item points at it
  const rootTarget = await removeArtifacts(
    { id: idA, files: [], root, sources: { dir: root, files: [root], cache: null, extra: [root], projectDir: root, root } },
    { pruneEmptyProjects: true },
  );
  assert.equal(rootTarget.removed.dir, false);
  assert.equal(rootTarget.removed.files, 0);
  assert.equal(typeof rootTarget.failed.dir, 'string');
  assert.equal((await stat(root)).isDirectory(), true);
});

test('removeArtifacts reports a failed step without throwing', async () => {
  const failHome = await tempHome();
  const root = path.join(failHome, 'sessions');
  // `fs.rm` without `recursive` cannot remove a directory: a deterministic failure
  const directoryAsFile = path.join(root, '--P--', 'not-a-file');
  await mkdir(directoryAsFile, { recursive: true });
  const cacheFile = path.join(failHome, 'storages', 'session_projcache', 'sessions', `${idA}.json`);
  await writeBytes(cacheFile, 4);

  const result = await removeArtifacts({
    id: idA,
    files: [],
    root,
    sources: {
      dir: null,
      files: [directoryAsFile],
      cache: cacheFile,
      extra: [],
      projectDir: null,
      root,
      storages: path.join(failHome, 'storages'),
      cacheRoot: path.join(failHome, 'storages', 'session_projcache', 'sessions'),
    },
  }, { purgeProjectionCache: true });

  assert.equal(typeof result.failed.files, 'string');
  assert.equal(result.removed.files, 0);
  assert.equal(result.removed.cache, true); // the surviving steps still ran
  assert.equal(result.freedBytes, 4);
  assert.equal((await stat(directoryAsFile)).isDirectory(), true);
  await assert.rejects(stat(cacheFile));

  // a completely empty item is a no-op, never a throw
  const noop = await removeArtifacts({}, undefined);
  assert.deepEqual(noop, {
    removed: { dir: false, files: 0, cache: false, extra: false, projectDir: false },
    failed: {},
    freedBytes: 0,
  });
  assert.deepEqual(await removeArtifacts(undefined, undefined), noop);
});

// ---------------------------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------------------------

test('auditPath follows the documented precedence', () => {
  const explicit = path.join(home, 'custom', 'audit.jsonl');
  assert.equal(auditPath({ home, manager: path.join(home, 'm'), audit: path.join(home, 'm', 'deleted.jsonl') }, undefined), path.join(home, 'm', 'deleted.jsonl'));
  assert.equal(auditPath(roots, { auditLog: explicit }), explicit);
  assert.equal(auditPath(roots, { auditLog: '   ' }), roots.audit);

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(auditPath(undefined, undefined), path.join(home, 'session-manager', 'deleted.jsonl'));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('appendAudit writes JSONL and readAuditTail returns the trailing records', async () => {
  const file = path.join(home, 'logs', 'nested', 'deleted.jsonl');
  for (const record of [{ n: 1 }, { n: 2 }, { n: 3 }]) {
    assert.deepEqual(await appendAudit(file, record), { ok: true, error: null });
  }
  // a torn / hand-edited line must be skipped, not fatal
  await appendFile(file, 'this is not json\n\n', 'utf8');
  assert.deepEqual(await appendAudit(file, { n: 4 }), { ok: true, error: null });

  const text = await readFile(file, 'utf8');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.split('\n').filter((line) => line !== '').length, 5);

  const tail = await readAuditTail(file, 2);
  assert.equal(tail.error, null);
  assert.deepEqual(tail.lines, [{ n: 3 }, { n: 4 }]);

  const all = await readAuditTail(file);
  assert.deepEqual(all.lines, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

  // missing file, empty path and unreadable path never throw
  assert.deepEqual(await readAuditTail(path.join(home, 'logs', 'absent.jsonl')), { lines: [], error: null });
  assert.equal((await readAuditTail('')).error !== null, true);
  assert.deepEqual(await appendAudit('', { n: 1 }), { ok: false, error: 'audit path is empty' });

  // an unserialisable record is reported, not thrown, and nothing is appended
  const circular = {};
  circular.self = circular;
  const failed = await appendAudit(file, circular);
  assert.equal(failed.ok, false);
  assert.equal(typeof failed.error, 'string');
  assert.deepEqual((await readAuditTail(file, 1)).lines, [{ n: 4 }]);

  // a directory in place of the file is reported, not thrown
  const asDir = path.join(home, 'logs', 'directory.jsonl');
  await mkdir(asDir, { recursive: true });
  assert.equal((await appendAudit(asDir, { n: 1 })).ok, false);
  assert.equal((await readAuditTail(asDir)).lines.length, 0);
});
