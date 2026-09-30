/**
 * HTTP mounting for dsh-session-manager.
 *
 * Two adapters, one dispatcher. The primary route is an *authenticated* exact
 * Fetch route on the client-connection service, which is reached inside the
 * `/api` prefix handler after `connection.admit(req)` has checked the Host
 * origin fence and the browser cookie — so a browser session gets auth for free.
 * The fallback is a raw `webServer` route for compositions that do not mount the
 * connection service at all; it carries its own loopback + Origin fence and
 * demands a plugin-specific header on every mutation, so a cross-site form post
 * cannot reach it.
 *
 * Both registrations are optional and independently disposed:
 * `ctx.inject` keeps the plugin inert when a service never appears, and the
 * returned disposers are collected by the plugin's own effect so unloading the
 * row also unregisters what it mounted.
 *
 * @module dsh-session-manager/lib/routes
 */
import { DESTRUCTIVE_OPS, dispatch } from './ops.js';

/** Authenticated exact route (registered through `connection.fetch`). */
export const DEFAULT_ROUTE = '/api/session-manager';
/** Raw fallback prefix (registered through `webServer`). */
export const DEFAULT_FALLBACK_ROUTE = '/session-manager/api';
/** Request bodies are small JSON documents; anything larger is refused. */
export const MAX_BODY_BYTES = 512 * 1024;
/** A mutation from the raw route must carry this header (custom headers defeat CSRF). */
export const PLUGIN_HEADER = 'x-dsh-session-manager';

/**
 * Mount both adapters.
 * @param ctx - the plugin's Host context.
 * @param config - normalized config; `routePath`/`fallbackRoutePath` override the defaults.
 * @returns a disposer that unregisters both routes (idempotent).
 */
export function registerRoutes(ctx, config) {
  const disposers = [
    mount(ctx, ['connection'], (svcCtx) => {
      const routes = svcCtx?.get?.('connection')?.fetch;
      if (routes === undefined || routes === null || typeof routes.register !== 'function') return null;
      const path = nonEmpty(config.routePath) ?? DEFAULT_ROUTE;
      return routes.register({
        path,
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => authenticatedFetch(ctx, config, request),
      });
    }),
    mount(ctx, ['webServer'], (svcCtx) => {
      const webServer = svcCtx?.get?.('webServer');
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return null;
      const path = nonEmpty(config.fallbackRoutePath) ?? DEFAULT_FALLBACK_ROUTE;
      const handler = (req, res) => {
        void handleRaw(ctx, config, req, res);
      };
      return webServer.register({ kind: 'prefix', path, handler });
    }),
  ];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* unloading must not throw */
      }
    }
  };
}

/**
 * Run one `ctx.inject` registration, capturing its disposer.
 *
 * `ctx.inject` fires the callback only once every named service exists, so a
 * missing service means the callback never runs and the plugin simply stays
 * inert. The callback result is used only as a disposal hint: some Harness
 * versions own the registration on the service's own context, where the returned
 * effect disposer is already enough and calling it twice is a no-op.
 */
function mount(ctx, services, register) {
  let dispose = null;
  try {
    const injected = ctx.inject(services, (svcCtx) => {
      const own = register(svcCtx);
      if (typeof own === 'function') dispose = own;
    });
    return () => {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
      try {
        injected?.();
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}

/** Adapter for the authenticated `connection.fetch` surface. */
async function authenticatedFetch(ctx, config, request) {
  const method = String(request?.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') return respond(405, { ok: false, error: 'options-not-supported' }, { includeBody: true });
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return respond(400, { ok: false, error: 'invalid-url' }, { includeBody: true });
  }
  const payload = queryPayload(url);
  if (method === 'POST') {
    const tooLarge = respond(413, { ok: false, error: 'body-too-large' }, { includeBody: true });
    const declared = Number.parseInt(String(request.headers?.get?.('content-length') ?? ''), 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge;
    let text = '';
    try {
      text = await request.text();
    } catch (error) {
      return respond(400, { ok: false, error: 'unreadable-body', message: describe(error) }, { includeBody: true });
    }
    if (text.length > MAX_BODY_BYTES) return tooLarge;
    if (text.trim().length > 0) {
      try {
        Object.assign(payload, JSON.parse(text));
      } catch {
        return respond(400, { ok: false, error: 'invalid-json' }, { includeBody: true });
      }
    }
  }
  const op = resolveOp(payload, url);
  if (method !== 'POST' && DESTRUCTIVE_OPS.includes(op)) {
    return respond(405, { ok: false, error: 'use-post', op }, { includeBody: true });
  }
  const { status, body } = await dispatch(ctx, config, op, payload);
  return respond(status, body, { includeBody: method !== 'HEAD' });
}

/** Adapter for the raw `webServer` prefix route. */
async function handleRaw(ctx, config, req, res) {
  try {
    const fence = checkFence(req);
    if (!fence.ok) {
      send(res, fence.status, { ok: false, error: fence.error });
      return;
    }
    const method = String(req?.method ?? 'GET').toUpperCase();
    let url;
    try {
      url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1');
    } catch {
      send(res, 400, { ok: false, error: 'invalid-url' });
      return;
    }
    const payload = queryPayload(url);
    if (method === 'POST') {
      const contentType = String(req?.headers?.['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        send(res, 415, { ok: false, error: 'content-type' });
        return;
      }
      if (req?.headers?.[PLUGIN_HEADER] !== '1') {
        send(res, 403, { ok: false, error: 'missing-plugin-header' });
        return;
      }
      let text;
      try {
        text = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        send(res, error?.status === 413 ? 413 : 400, { ok: false, error: error?.status === 413 ? 'body-too-large' : 'unreadable-body' });
        return;
      }
      if (text.trim().length > 0) {
        try {
          Object.assign(payload, JSON.parse(text));
        } catch {
          send(res, 400, { ok: false, error: 'invalid-json' });
          return;
        }
      }
    }
    const op = resolveOp(payload, url);
    if (method !== 'POST' && DESTRUCTIVE_OPS.includes(op)) {
      send(res, 405, { ok: false, error: 'use-post', op });
      return;
    }
    const { status, body } = await dispatch(ctx, config, op, payload);
    send(res, status, body);
  } catch (error) {
    send(res, 500, { ok: false, error: 'internal', message: describe(error) });
  }
}

/**
 * Reject anything that did not come from the local page.
 *
 * The raw route exists only for compositions without the connection service, so
 * it must re-implement the two properties that matter: the peer is this machine,
 * and the request was issued by the page served from the same authority.
 */
function checkFence(req) {
  const remote = String(req?.socket?.remoteAddress ?? '');
  if (!isLoopback(remote)) return { ok: false, status: 403, error: 'loopback-only' };
  const site = String(req?.headers?.['sec-fetch-site'] ?? '');
  if (site === 'cross-site') return { ok: false, status: 403, error: 'cross-site' };
  const host = String(req?.headers?.host ?? '');
  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, error: 'bad-origin' };
    }
    if (host.length > 0 && originHost !== host) return { ok: false, status: 403, error: 'cross-origin' };
  }
  return { ok: true };
}

/** @returns whether a socket remote address belongs to this machine. */
function isLoopback(remote) {
  if (remote.length === 0) return true;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
}

/** Read a Node request body with a hard size cap. */
async function readBody(req, max) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > max) {
      const error = new Error('body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Query-string payload: `op`, `query`, `ids` (comma separated) and `limit`. */
function queryPayload(url) {
  const payload = {};
  const op = url.searchParams.get('op');
  if (typeof op === 'string' && op.length > 0) payload.op = op;
  const query = url.searchParams.get('query');
  if (typeof query === 'string') payload.query = query;
  const ids = url.searchParams.get('ids');
  if (typeof ids === 'string' && ids.length > 0) payload.ids = ids.split(',').map((id) => id.trim()).filter(Boolean);
  const current = url.searchParams.get('currentSessionId');
  if (typeof current === 'string' && current.length > 0) payload.currentSessionId = current;
  return payload;
}

/**
 * @returns the operation to dispatch. Both surfaces default to the read-only
 * `status` operation, so a bare `GET` can never reach a mutation.
 */
function resolveOp(payload, url) {
  if (typeof payload.op === 'string' && payload.op.length > 0) return payload.op;
  const fromQuery = url.searchParams.get('op');
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  return 'status';
}

/** Build a WHATWG Response for the authenticated adapter. */
function respond(status, body, options = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const includeBody = options.includeBody !== false;
  return new Response(includeBody ? JSON.stringify(body) : null, { status, headers });
}

/** Write a JSON response for the raw adapter, tolerating an already-sent response. */
function send(res, status, body) {
  if (res === undefined || res === null) return;
  try {
    if (res.headersSent === true || res.writableEnded === true) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
  } catch {
    try {
      res.destroy?.();
    } catch {
      /* nothing left to do */
    }
  }
}

/** @returns a trimmed non-empty string, or `undefined`. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Render an unknown thrown value as a short message. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
