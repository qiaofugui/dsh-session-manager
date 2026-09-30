/**
 * Integration tests for the Host half of dsh-session-manager.
 *
 * Everything runs against a synthetic DSH home under the system temp directory
 * and a fake Cordis context that exposes only the services each case needs, so
 * the suite proves both the operation semantics and the "optional service"
 * compatibility rule (the plugin must be inert, never broken, when a service or
 * route surface is missing).
 *
 * Run with the bundled runtime:
 *   & 'C:\Users\Joe__\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' \
 *     --test 'E:\test\dsh-session-manager\test\integration.test.mjs'
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { Config, normalizeConfig } from '../lib/config.js';
import { dispatch } from '../lib/ops.js';
import { DEFAULT_FALLBACK_ROUTE, DEFAULT_ROUTE, PLUGIN_HEADER, registerRoutes } from '../lib/routes.js';
import { apply as hostApply, name as hostName } from '../index.js';

const A = 'session-aaaa1111-0000-4000-8000-000000000001';
const B = 'session-bbbb2222-0000-4000-8000-000000000002';
const C = 'cccc3333-0000-4000-8000-000000000003';
const D = 'session-dddd4444-0000-4000-8000-000000000004';
const GONE = 'session-eeee5555-0000-4000-8000-000000000005';
const WS = 'workspace-0000-0000-0000-00000000000a';

/**
 * One synthetic DSH home with three project directories and one cache record.
 *
 * `DSH_HOME` is pointed at the fixture for the duration of the test: the Host
 * resolves the storages root (and therefore the projection-cache location) from
 * `DSH_HOME`, exactly as it does in production, while `sessionPersistence.root`
 * supplies the log root.
 */
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'dsm-int-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const persistence = path.join(home, 'sessions');
  const storages = path.join(home, 'storages');
  const cache = path.join(storages, 'session_projcache', 'sessions');
  await mkdir(cache, { recursive: true });

  const layout = [
    ['--E-test--', A, 'session.v4.jsonl.zstd'],
    ['--E-test--', B, 'session.v4.jsonl.zstd'],
    ['--E-test--', D, 'session.jsonl.zst'],
    ['_no-cwd', C, 'session.v4.jsonl.zstd'],
  ];
  for (const [project, id, file] of layout) {
    const dir = path.join(persistence, project, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), `payload-${id}-${'x'.repeat(200)}`);
  }
  await writeFile(path.join(cache, `${A}.json`), JSON.stringify({ session: A, rows: 3 }));
  await writeFile(path.join(cache, `${B}.json`), JSON.stringify({ session: B, rows: 4 }));

  return {
    home,
    persistence,
    storages,
    cache,
    sessions: {
      [A]: path.join(persistence, '--E-test--', A),
      [B]: path.join(persistence, '--E-test--', B),
      [D]: path.join(persistence, '--E-test--', D),
      [C]: path.join(persistence, '_no-cwd', C),
    },
    cleanup: async () => {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** A fake Cordis context exposing only the services a case declares. */
function fakeCtx(options = {}) {
  const archived = [...(options.archived ?? [])];
  const pinned = [...(options.pinned ?? [])];
  const live = new Set(options.live ?? []);
  const running = new Set(options.running ?? []);
  const workspaces = (options.workspaces ?? []).map((workspace) => ({
    id: workspace.id,
    path: workspace.path ?? 'E:\\test',
    sessionIds: [...(workspace.sessionIds ?? [])],
    async detachSession(sessionId) {
      this.sessionIds = this.sessionIds.filter((id) => id !== sessionId);
      if (workspace.failDetach === true) throw new Error('detach failed');
    },
  }));

  const registry = {
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
    list: () => workspaces,
    get: (id) => workspaces.find((workspace) => workspace.id === id),
    sessionKnown: async (id) => options.known === undefined || options.known.includes(id),
    archiveSession: async (id) => {
      if (options.failArchive === true) throw new Error('archive refused');
      if (!archived.includes(id)) archived.push(id);
    },
    unarchiveSession: async (id) => {
      if (options.failUnarchive === true) throw new Error('unarchive refused');
      const at = archived.indexOf(id);
      if (at >= 0) archived.splice(at, 1);
    },
    unpinSession: async (id) => {
      const at = pinned.indexOf(id);
      if (at >= 0) pinned.splice(at, 1);
    },
    ...(options.withoutSeam === true ? {} : {
      stopSessionActivity: async (id) => {
        if (options.failStop === true) throw new Error('stop refused');
        stoppedSessions.push(id);
      },
    }),
  };

  const services = new Map();
  const emitted = [];
  const registeredEffect = [];
  const stoppedSessions = [];
  if (options.persistence !== false) services.set('sessionPersistence', { root: options.root });
  if (options.withRegistry !== false) services.set('workspaceRegistry', registry);
  if (options.withSessions !== false) {
    // Mirrors `SessionStore`: `get` returns the live object, `liveEntryFor`
    // returns the store entry whose `detach()` removes it from the store and
    // emits the paired `session/disposed`.
    const store = new Map();
    for (const id of live) store.set(id, { id });
    const sessionsService = {
      get: (id) => store.get(id),
      list: () => [...store.keys()].map((id) => ({ id })),
      liveEntryFor: (session) => ({ detach: () => store.delete(session.id) }),
    };
    if (options.detachFails === true) {
      sessionsService.liveEntryFor = () => {
        throw new Error('session "x" is not live in this store');
      };
    }
    if (options.stopFails === true) sessionsService.__stopFails = true;    services.set('sessions', sessionsService);
  }
  if (options.withAgents !== false) {
    services.set('agents', { get: (id) => (running.has(id) ? { status: 'running' } : undefined) });
  }

  const ctx = {
    get: (key) => services.get(key),
    emit: (event, ...args) => {
      emitted.push([event, ...args]);
    },
    parallel: async (event, payload) => {
      emitted.push([event, payload]);
      const sessionsService = services.get('sessions');
      if (sessionsService?.__stopFails === true) throw new Error('listener refused');
    },
    logger: { warn: () => {}, info: () => {} },
    effect: (execute) => {
      const dispose = execute();
      registeredEffect.push(dispose);
      return () => {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      };
    },
    inject: (names, callback) => {
      if (names.every((key) => services.has(key))) callback({ get: (key) => services.get(key) });
      return () => {};
    },
  };

  return { ctx, services, registry, workspaces, archived, pinned, live, running, emitted, registeredEffect, stoppedSessions };
}

/** A fake `webServer`/`connection` pair that records what the plugin mounts. */
function mountSurfaces(harness) {
  const raw = [];
  const exact = [];
  harness.services.set('webServer', {
    register: (route) => {
      raw.push(route);
      return () => {
        const at = raw.indexOf(route);
        if (at >= 0) raw.splice(at, 1);
      };
    },
  });
  harness.services.set('connection', {
    fetch: {
      register: (route) => {
        exact.push(route);
        return () => {
          const at = exact.indexOf(route);
          if (at >= 0) exact.splice(at, 1);
        };
      },
    },
  });
  return { raw, exact };
}

/** A fake Node request stream for the raw adapter. */
function fakeReq({ method = 'GET', url = DEFAULT_FALLBACK_ROUTE, headers = {}, remoteAddress = '127.0.0.1', body = '' } = {}) {
  const stream = Readable.from(body.length > 0 ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  stream.socket = { remoteAddress };
  return stream;
}

/** A fake Node response that records status, headers and body. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(text) {
      this.body = typeof text === 'string' ? text : '';
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** Wait until the raw adapter finished writing. */
async function settled(res, timeoutMs = 3000) {
  const start = Date.now();
  while (!res.writableEnded && Date.now() - start < timeoutMs) await new Promise((resolve) => setTimeout(resolve, 5));
  return res;
}

/** Call the raw adapter once and parse its JSON body. */
async function callRaw(handler, request) {
  const res = fakeRes();
  handler(request, res);
  await settled(res);
  return { status: res.statusCode, headers: res.headers, body: res.body.length > 0 ? JSON.parse(res.body) : null };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('Config is a Standard Schema that ignores unknown keys', () => {
  const result = Config['~standard'].validate({ enabled: false, futureKey: 'anything' });
  assert.equal(result.value.enabled, false);
  assert.equal(result.value.futureKey, undefined);
  assert.equal(Config['~standard'].version, 1);
  assert.equal(typeof Config['~standard'].vendor, 'string');
});

test('normalizeConfig coerces and defaults every documented key', () => {
  const { value, issues } = normalizeConfig({ maxBatch: '7', dryRun: 'true', cascadeRoots: 'C:\\x' });
  assert.deepEqual(issues, []);
  assert.equal(value.maxBatch, 7);
  assert.equal(value.dryRun, true);
  assert.deepEqual(value.cascadeRoots, ['C:\\x']);
  assert.equal(value.allowDeleteUnarchived, false);
  assert.equal(value.allowDeleteLive, false);
  assert.equal(value.purgeProjectionCache, true);
  assert.equal(value.enabled, true);
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

test('status reports capabilities, roots and counts', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, B], withSessions: false, withAgents: false });
  mountSurfaces(h);

  const { status, body } = await dispatch(h.ctx, normalizeConfig({}).value, 'status', {});
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.plugin.name, hostName);
  assert.equal(body.capabilities.authenticatedRoute, true);
  assert.equal(body.capabilities.rawRoute, true);
  assert.equal(body.capabilities.workspaceRegistry, true);
  assert.equal(body.capabilities.purgeCacheLayout, 'per-record');
  assert.equal(body.capabilities.liveDetection, false);
  assert.equal(body.roots.persistence, fx.persistence);
  assert.equal(body.roots.cache, fx.cache);
  assert.equal(body.counts.items, 4);
  assert.equal(body.counts.archived, 2);
  assert.ok(body.counts.bytes > 0);
});

test('status stays useful when every optional service is missing', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, withRegistry: false, withSessions: false, withAgents: false });
  const { status, body } = await dispatch(h.ctx, normalizeConfig({}).value, 'status', {});
  assert.equal(status, 200);
  assert.equal(body.capabilities.workspaceRegistry, false);
  assert.equal(body.capabilities.authenticatedRoute, false);
  assert.equal(body.counts.archived, 0);
  assert.equal(body.counts.items, 4);
});

test('list merges disk artifacts with the archive set and stamps flags', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, GONE], live: [B], running: [D], workspaces: [{ id: WS, sessionIds: [A, B, C] }] });
  const { status, body } = await dispatch(h.ctx, normalizeConfig({}).value, 'list', { currentSessionId: C });

  assert.equal(status, 200);
  assert.deepEqual(body.archivedIds, [A, GONE]);
  const byId = new Map(body.items.map((item) => [item.id, item]));
  assert.equal(byId.size, 4);
  assert.equal(byId.get(A).archived, true);
  assert.equal(byId.get(A).deletable, true);
  assert.equal(byId.get(B).live, true);
  assert.equal(byId.get(D).running, true);
  assert.equal(byId.get(C).current, true);
  assert.equal(byId.get(C).deletable, false);
  assert.equal(byId.get(C).skipReason, 'current');
  assert.ok(byId.get(A).logBytes > 0);
  assert.ok(byId.get(A).cacheFile.endsWith(`${A}.json`));
  assert.equal(byId.get(A).project, '--E-test--');
  assert.match(byId.get(C).project, /_no-cwd/);

  const searched = await dispatch(h.ctx, normalizeConfig({}).value, 'list', { query: 'no-cwd' });
  assert.equal(searched.body.items.length, 1);
  assert.equal(searched.body.items[0].id, C);
  assert.equal(searched.body.total, 4);
});

test('delete removes logs, cache and registry accounting for an archived session', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], workspaces: [{ id: WS, sessionIds: [A, 'keep'] }] });

  const { status, body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: [A] });
  assert.equal(status, 200);
  assert.deepEqual(body.deleted, [A]);
  assert.deepEqual(body.skipped, []);
  assert.deepEqual(body.failedIds, []);
  assert.ok(body.freedBytes > 0);
  assert.equal(existsSync(fx.sessions[A]), false);
  assert.equal(existsSync(path.join(fx.cache, `${A}.json`)), false);
  assert.deepEqual(h.archived, []);
  assert.deepEqual(h.workspaces[0].sessionIds, ['keep']);
  assert.deepEqual(h.emitted, [['api-session/removed', A]]);
  assert.equal(body.results[0].removed.dir, true);
  assert.equal(body.results[0].removed.cache, true);

  const audit = await readFile(path.join(fx.home, 'session-manager', 'deleted.jsonl'), 'utf8');
  const record = JSON.parse(audit.trim().split('\n').at(-1));
  assert.equal(record.action, 'delete');
  assert.equal(record.id, A);
  assert.equal(record.actor, 'web-ui');
  // The other sessions are untouched.
  assert.equal(existsSync(fx.sessions[B]), true);
  assert.equal(existsSync(path.join(fx.cache, `${B}.json`)), true);
});

test('delete refuses a session that is not archived, and leaves the disk alone', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [] });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: [B] });
  assert.deepEqual(body.deleted, []);
  assert.deepEqual(body.skipped, [{ id: B, reason: 'not-archived' }]);
  assert.equal(existsSync(fx.sessions[B]), true);
  assert.equal(h.emitted.length, 0);
});

test('delete honors allowDeleteUnarchived', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [] });
  const config = normalizeConfig({ allowDeleteUnarchived: true }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [B] });
  assert.deepEqual(body.deleted, [B]);
  assert.equal(existsSync(fx.sessions[B]), false);
});

test('delete refuses live, running and current sessions by default', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, B, C, D], live: [A, B], running: [B] });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', {
    ids: [A, B, C, D],
    currentSessionId: C,
  });
  assert.deepEqual(body.deleted, [D]);
  const reasons = new Map(body.skipped.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons.get(A), 'live');
  assert.equal(reasons.get(B), 'running');
  assert.equal(reasons.get(C), 'current');
  for (const id of [A, B, C]) assert.equal(existsSync(fx.sessions[id]), true, `${id} must survive`);
  assert.equal(existsSync(fx.sessions[D]), false);
});

test('delete removes a live session when allowDeleteLive is set', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], live: [A] });
  const config = normalizeConfig({ allowDeleteLive: true }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });
  assert.deepEqual(body.deleted, [A]);
  assert.equal(existsSync(fx.sessions[A]), false);
});

test('a live session is stopped and detached from the in-memory store', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], live: [A] });
  const config = normalizeConfig({ allowDeleteLive: true }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });

  const result = body.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.removed.stopped, true, 'the running turn must be stopped first');
  assert.equal(result.removed.detached, true, 'the session must leave the store');
  assert.deepEqual(result.failed, {});
  // The stop went through the registry seam the archive admission uses.
  assert.deepEqual(h.stoppedSessions, [A]);
  // Release happens before the files are gone, so a late append cannot resurrect them.
  assert.equal(existsSync(fx.sessions[A]), false);
  assert.equal(h.services.get('sessions').get(A), undefined, 'the store must no longer hold it');
});

test('the stop seam falls back to ctx.parallel when the registry has none', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], live: [A], withoutSeam: true });
  const config = normalizeConfig({ allowDeleteLive: true }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].removed.stopped, true);
  assert.equal(body.results[0].removed.detached, true);
  assert.ok(
    h.emitted.some(([event]) => event === 'workspace/session-stop'),
    'the fallback must still broadcast session-stop',
  );
});

test('a release failure fails the delete instead of leaving an orphan', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], live: [A], detachFails: true });
  const config = normalizeConfig({ allowDeleteLive: true }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });
  assert.deepEqual(body.deleted, []);
  assert.deepEqual(body.failedIds, [A]);
  // The detach threw, so the session is still in the store: that must fail the
  // delete rather than leave an orphan that can resurrect the log directory.
  assert.equal(body.results[0].failed.release, 'session is still live after detach');
  assert.ok(h.live.has(A), 'the session must still be in the store');
  assert.equal(body.results[0].ok, false);
});

test('a failing stop is reported but does not block the detach', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], live: [A], failStop: true });
  const config = normalizeConfig({ allowDeleteLive: true }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });
  const result = body.results[0];
  assert.deepEqual(result.failed.stop, 'stop refused');
  assert.equal(result.removed.detached, true);
  assert.equal(result.error, 'partial');
});

test('releaseLive off leaves a live session in memory, with a warning', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], live: [A] });
  const config = normalizeConfig({ allowDeleteLive: true, releaseLive: false }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });
  const result = body.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.removed.detached, undefined);
  assert.deepEqual(result.warnings, ['live session left in the in-memory store (releaseLive is off)']);
  assert.equal(h.live.has(A), true);
});

test('a session that is not live reports no release work', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const config = normalizeConfig({}).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A] });
  assert.equal(body.results[0].removed.release, 'not-live');
  assert.deepEqual(body.results[0].failed, {});
});

test('residue cleanup also releases a session left in memory', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [GONE], live: [GONE] });
  const config = normalizeConfig({}).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [GONE] });
  const result = body.results[0];
  assert.equal(result.removed.detached, true);
  assert.equal(h.services.get('sessions').get(GONE), undefined, 'the store must no longer hold it');
  assert.deepEqual(h.stoppedSessions, [GONE]);
  assert.ok(h.emitted.some(([event]) => event === 'api-session/removed'));
  assert.equal(result.ok, true);
  assert.equal(body.skipped.some((entry) => entry.id === GONE), false, 'residue must not stay skipped');
});

test('delete refuses ids that escape the persistence root', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', {
    ids: ['../etc', 'a/b', '..', '~002E~002E', A],
  });
  assert.deepEqual(body.deleted, [A]);
  const invalid = body.skipped.filter((entry) => entry.reason === 'invalid-id').map((entry) => entry.id);
  assert.deepEqual(invalid, ['../etc', 'a/b', '..', '~002E~002E']);
});

test('delete dryRun reports the plan and touches nothing', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: [A], dryRun: true });
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.skipped, [{ id: A, reason: 'dry-run' }]);
  assert.ok(body.freedBytes > 0);
  assert.equal(existsSync(fx.sessions[A]), true);
  assert.equal(h.emitted.length, 0);
});

test('config dryRun is honored too', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const { body } = await dispatch(h.ctx, normalizeConfig({ dryRun: true }).value, 'delete', { ids: [A] });
  assert.equal(body.dryRun, true);
  assert.equal(existsSync(fx.sessions[A]), true);
});

test('maxBatch moves the overflow to skipped instead of deleting it', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, B, D] });
  const { body } = await dispatch(h.ctx, normalizeConfig({ maxBatch: 1 }).value, 'delete', { ids: [A, B, D] });
  assert.deepEqual(body.deleted, [A]);
  assert.deepEqual(body.skipped, [
    { id: B, reason: 'over-batch' },
    { id: D, reason: 'over-batch' },
  ]);
  assert.equal(existsSync(fx.sessions[B]), true);
});

test('delete of a missing but still-archived id cleans the residue', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [GONE], workspaces: [{ id: WS, sessionIds: [GONE] }] });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: [GONE] });
  assert.deepEqual(body.skipped, []);
  assert.deepEqual(body.deleted, [GONE]);
  assert.deepEqual(h.archived, []);
  assert.deepEqual(h.workspaces[0].sessionIds, []);
  assert.deepEqual(h.emitted, [['api-session/removed', GONE]]);
});

test('delete of an unknown id with no residue is a plain not-found skip', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [] });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: ['session-nope'] });
  assert.deepEqual(body.skipped, [{ id: 'session-nope', reason: 'not-found' }]);
  assert.equal(h.emitted.length, 0);
});

test('delete reports a partial failure from a failing registry without lying about files', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A], failUnarchive: true });
  const { body } = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: [A] });
  assert.equal(existsSync(fx.sessions[A]), false);
  assert.deepEqual(body.deleted, [], 'a failed bookkeeping step must not report success');
  assert.deepEqual(body.failedIds, [A]);
  assert.equal(body.results[0].error, 'partial');
  assert.match(body.results[0].failed.archive, /unarchive refused/);
});

test('disabled config makes every delete a no-op', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const { body } = await dispatch(h.ctx, normalizeConfig({ enabled: false }).value, 'delete', { ids: [A] });
  assert.deepEqual(body.skipped, [{ id: A, reason: 'disabled' }]);
  assert.equal(existsSync(fx.sessions[A]), true);
});

test('protectedSessionIds wins over the archive set', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, B] });
  const config = normalizeConfig({ protectedSessionIds: [A] }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A, B] });
  assert.deepEqual(body.deleted, [B]);
  assert.deepEqual(body.skipped, [{ id: A, reason: 'protected' }]);
  assert.equal(existsSync(fx.sessions[A]), true);
});

test('allowDeleteArchived false protects every archived session', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, B] });
  const config = normalizeConfig({ allowDeleteArchived: false }).value;
  const { body } = await dispatch(h.ctx, config, 'delete', { ids: [A, B] });
  assert.deepEqual(body.deleted, []);
  assert.deepEqual(body.skipped, [
    { id: A, reason: 'protected' },
    { id: B, reason: 'protected' },
  ]);
  assert.equal(existsSync(fx.sessions[A]), true);
  assert.equal(existsSync(fx.sessions[B]), true);
});

test('restore and archive drive the registry', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });

  const restored = await dispatch(h.ctx, normalizeConfig({}).value, 'restore', { ids: [A] });
  assert.deepEqual(restored.body.failedIds, []);
  assert.deepEqual(h.archived, []);

  const archived = await dispatch(h.ctx, normalizeConfig({}).value, 'archive', { ids: [B] });
  assert.deepEqual(archived.body.failedIds, []);
  assert.deepEqual(h.archived, [B]);

  const refused = await dispatch(h.ctx, normalizeConfig({}).value, 'archive', { ids: ['../x'] });
  assert.equal(refused.body.results[0].error, 'invalid-id');
});

test('restore and archive degrade to 503 without a workspace registry', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, withRegistry: false });
  const { status, body } = await dispatch(h.ctx, normalizeConfig({}).value, 'restore', { ids: [A] });
  assert.equal(status, 503);
  assert.equal(body.error, 'workspace-registry-unavailable');
});

test('unknown operations and empty id lists are rejected', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence });
  const config = normalizeConfig({}).value;
  assert.equal((await dispatch(h.ctx, config, 'nope', {})).status, 400);
  assert.equal((await dispatch(h.ctx, config, 'delete', {})).status, 400);
  assert.equal((await dispatch(h.ctx, config, 'delete', { ids: [1, null, '  '] })).status, 400);
});

test('a broken scanner path is reported, not thrown', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: path.join(fx.home, 'does-not-exist') });
  const { status, body } = await dispatch(h.ctx, normalizeConfig({}).value, 'list', {});
  assert.equal(status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(body.ok, true);
});

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

test('host apply mounts both adapters and unregisters them on unload', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const surfaces = mountSurfaces(h);

  hostApply(h.ctx, {});
  assert.equal(surfaces.exact.length, 1);
  assert.equal(surfaces.raw.length, 1);
  assert.equal(surfaces.exact[0].path, DEFAULT_ROUTE);
  assert.deepEqual([...surfaces.exact[0].methods].sort(), ['GET', 'HEAD', 'POST']);
  assert.equal(surfaces.exact[0].requestBody, 'buffered');
  assert.equal(surfaces.raw[0].kind, 'prefix');
  assert.equal(surfaces.raw[0].path, DEFAULT_FALLBACK_ROUTE);
  assert.equal(typeof surfaces.raw[0].handler, 'function');
});

test('host apply is inert and silent without webServer or connection', async () => {
  const h = fakeCtx({ root: 'C:\\nowhere' });
  assert.doesNotThrow(() => hostApply(h.ctx, {}));
  assert.doesNotThrow(() => hostApply(h.ctx, { enabled: false }));
  assert.doesNotThrow(() => hostApply(h.ctx, { maxBatch: 'not-a-number' }));
  assert.doesNotThrow(() => hostApply({ get: () => undefined, inject: () => () => {}, effect: () => () => {}, logger: undefined }, {}));
});

test('the authenticated adapter answers list/status and refuses mutations over GET', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A] });
  const surfaces = mountSurfaces(h);
  hostApply(h.ctx, {});
  const route = surfaces.exact[0];

  const listing = await route.fetch(new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}?op=list`));
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  const listed = await listing.json();
  assert.equal(listed.items.length, 4);

  const status = await route.fetch(new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}`));
  assert.equal((await status.json()).counts.items, 4);

  const getDelete = await route.fetch(new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}?op=delete&ids=${A}`));
  assert.equal(getDelete.status, 405);
  assert.equal(existsSync(fx.sessions[A]), true);

  const head = await route.fetch(new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}?op=status`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const options = await route.fetch(new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}`, { method: 'OPTIONS' }));
  assert.equal(options.status, 405);

  const badJson = await route.fetch(
    new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}`, { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } }),
  );
  assert.equal(badJson.status, 400);

  const posted = await route.fetch(
    new Request(`http://127.0.0.1:19387${DEFAULT_ROUTE}`, {
      method: 'POST',
      body: JSON.stringify({ op: 'delete', ids: [A] }),
      headers: { 'content-type': 'application/json', [PLUGIN_HEADER]: '1' },
    }),
  );
  assert.equal(posted.status, 200);
  assert.deepEqual((await posted.json()).deleted, [A]);
  assert.equal(existsSync(fx.sessions[A]), false);
});

test('the raw adapter enforces its loopback, origin, header and size fences', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, archived: [A, B] });
  const surfaces = mountSurfaces(h);
  hostApply(h.ctx, {});
  const handler = surfaces.raw[0].handler;

  const remote = await callRaw(handler, fakeReq({ url: `${DEFAULT_FALLBACK_ROUTE}?op=list`, remoteAddress: '10.0.0.9' }));
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error, 'loopback-only');

  const crossOrigin = await callRaw(
    handler,
    fakeReq({ url: `${DEFAULT_FALLBACK_ROUTE}?op=list`, headers: { host: '127.0.0.1:19387', origin: 'http://evil.test' } }),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error, 'cross-origin');

  const sameOrigin = await callRaw(
    handler,
    fakeReq({ url: `${DEFAULT_FALLBACK_ROUTE}?op=list`, headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }),
  );
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.body.items.length, 4);

  const noHeader = await callRaw(
    handler,
    fakeReq({
      method: 'POST',
      url: DEFAULT_FALLBACK_ROUTE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'delete', ids: [A] }),
    }),
  );
  assert.equal(noHeader.status, 403);
  assert.equal(existsSync(fx.sessions[A]), true);

  const wrongType = await callRaw(
    handler,
    fakeReq({
      method: 'POST',
      url: DEFAULT_FALLBACK_ROUTE,
      headers: { 'content-type': 'text/plain', [PLUGIN_HEADER]: '1' },
      body: JSON.stringify({ op: 'delete', ids: [A] }),
    }),
  );
  assert.equal(wrongType.status, 415);

  const tooBig = await callRaw(
    handler,
    fakeReq({
      method: 'POST',
      url: DEFAULT_FALLBACK_ROUTE,
      headers: { 'content-type': 'application/json', [PLUGIN_HEADER]: '1' },
      body: JSON.stringify({ op: 'delete', ids: [A], pad: 'x'.repeat(600 * 1024) }),
    }),
  );
  assert.equal(tooBig.status, 413);

  const crossSite = await callRaw(
    handler,
    fakeReq({ url: `${DEFAULT_FALLBACK_ROUTE}?op=list`, headers: { 'sec-fetch-site': 'cross-site' } }),
  );
  assert.equal(crossSite.status, 403);

  const deleted = await callRaw(
    handler,
    fakeReq({
      method: 'POST',
      url: DEFAULT_FALLBACK_ROUTE,
      headers: { 'content-type': 'application/json', [PLUGIN_HEADER]: '1' },
      body: JSON.stringify({ op: 'delete', ids: [A] }),
    }),
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.deleted, [A]);
  assert.equal(existsSync(fx.sessions[A]), false);
  assert.equal(existsSync(fx.sessions[B]), true);
});

test('the raw adapter still answers with a diagnostic when nothing is configured', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence, withRegistry: false });
  const surfaces = mountSurfaces(h);
  hostApply(h.ctx, {});

  const listed = await callRaw(surfaces.raw[0].handler, fakeReq({ url: `${DEFAULT_FALLBACK_ROUTE}?op=list` }));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.archivedIds, []);

  const restore = await callRaw(
    surfaces.raw[0].handler,
    fakeReq({
      method: 'POST',
      url: DEFAULT_FALLBACK_ROUTE,
      headers: { 'content-type': 'application/json', [PLUGIN_HEADER]: '1' },
      body: JSON.stringify({ op: 'restore', ids: [A] }),
    }),
  );
  assert.equal(restore.status, 503);
});

test('custom route paths from config are honored', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: fx.persistence });
  const surfaces = mountSurfaces(h);
  hostApply(h.ctx, { routePath: '/api/my-sessions', fallbackRoutePath: '/my-sessions/api' });
  assert.equal(surfaces.exact[0].path, '/api/my-sessions');
  assert.equal(surfaces.raw[0].path, '/my-sessions/api');
});

test('the DSH_HOME fallback is used when no persistence service exists', async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const h = fakeCtx({ root: undefined, persistence: false, archived: [A] });

  const listed = await dispatch(h.ctx, normalizeConfig({}).value, 'list', {});
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 4);
  const deleted = await dispatch(h.ctx, normalizeConfig({}).value, 'delete', { ids: [A] });
  assert.deepEqual(deleted.body.deleted, [A]);
  assert.equal(existsSync(fx.sessions[A]), false);
});
