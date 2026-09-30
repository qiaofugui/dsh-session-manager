# dsh-session-manager — frozen interface contract (v1)

Authoritative spec for all writers. Do not change a shape here without telling the Lead.
Everything is plain JavaScript ESM, **no build step**, **no external dependencies**.

## 0. Deliverable

A persistent DSH plugin (Cordis bundle) that manages **archived sessions** and can
**permanently delete** a session — like Codex's session deletion — from the DSH Web UI at
`http://127.0.0.1:19387`.

Package directory: `E:\test\dsh-session-manager\`

| File | Owner |
| --- | --- |
| `SPEC.md` | Lead (frozen) |
| `package.json`, `cordis.patch.yml`, `index.js` | Lead |
| `lib/ops.js`, `lib/routes.js`, `lib/delete.js` | Lead |
| `lib/config.js`, `lib/encoder.js`, `lib/scanner.js`, `lib/plan.js`, `lib/audit.js` | host-core |
| `test/host-core.test.mjs` | host-core |
| `client.js`, `locale/en.json`, `locale/zh.json`, `icon.svg` | client-ui |
| `test/client.test.mjs` | client-ui |
| `test/integration.test.mjs`, `README.md`, `README.en.md` | Lead |

## 1. Environment facts (verified, do not re-derive)

- DSH home: `%DSH_HOME%` = `C:\Users\Joe__\.dsh`. Profile: `desktop`.
- Profile dir: `C:\Users\Joe__\.dsh\profiles\desktop` (installed packages live in
  `profiles\desktop\node_modules\<name>`).
- Session logs: `<DSH_HOME>\sessions\--<projectKey>--\<encodedId>\session.v4.jsonl.zstd`
  - project key: `projectKey(cwd)` = replace `/ \ :` with `-`, escape unsafe code units as
    `~XXXX` (uppercase hex, 4 digits), truncate to 251 chars, wrap in `--…--`.
  - `encodeSegment(raw)` = each code unit outside `[A-Za-z0-9._-]` becomes
    `~` + `codeUnit.toString(16).toUpperCase().padStart(4, '0')`.
  - generation file name: `session.v<version>.jsonl[.zstd]` (also seen: `session.jsonl`,
    `session.jsonl.zst`, `session.v1..v4.*`). **Never assume one name — delete the dir.**
  - Session ids are **not** always prefixed `session-`: subagent sessions are bare UUIDs.
- Projection cache: `<DSH_HOME>\storages\session_projcache\sessions\<sessionId>.json`
  (per-record layout `<root>/<unit>/<table>/<key>.json`, key used literally).
  Legacy single-file layout would be `<DSH_HOME>\storages\session_projcache.json`.
- Registry state: `<DSH_HOME>\storages\workspace.json`.

## 2. Third-party constraints (hard)

- A plugin installed into a profile **cannot** `import` any `@deepseek-ai/*` package, nor
  `zod`. Host code imports **only `node:*` builtins**. Client code `require`s **only
  `react`** (and `react-dom`); never a Harness client package.
- `Config` must be a hand-written Standard Schema v1 object; the framework only reads
  `Config['~standard'].validate(config)` and uses `result.value`. `{ issues: [...] }` throws.
- Unknown config keys must be **ignored**, not reported as issues (forward compatibility).
- Client bundle is hand-written: `window.__ModuleLoader__.load({ id, factory })`, where `id`
  equals the package name `dsh-session-manager`.
- Never write to the profile's `package.json` / `cordis.patch.yml` from plugin code.
- Plugin must stay **inert, never throwing**, when a service/slot/route is unavailable.

## 3. Host: service discovery (all optional, feature-detected)

Service keys and shapes that exist today (all optional):

```js
ctx.get('webServer')          // .register({ kind:'exact'|'prefix', path, handler(req,res) }) -> disposer
ctx.get('connection')         // .fetch.register({ path, methods, requestBody:'buffered', fetch(Request)->Response })
ctx.get('dshHomePath')        // (…segments) => absolute path
ctx.get('workspaceRegistry')  // .list() : Workspace[]; .archiveSession(id,{stopActivity}); .unarchiveSession(id);
                              // .archivedSessionIds : string[]; .pinnedSessionIds : string[]; .sessionKnown(id)
                              // Workspace: .id, .path, .title, .sessionIds : string[], .detachSession(sessionId)
ctx.get('sessionPersistence') // .root : absolute path (implementation field, feature-detect)
ctx.get('sessions')           // .get(id) : live Session | undefined; .list()
ctx.get('agents')             // .get(sessionId) : live Agent | undefined
ctx.emit('api-session/removed', id)   // forwarded to the browser by dsh-api-remotes allowlist
```

`ctx.dshHomePath` is provided by `dsh-app-boot`; fall back to
`ctx.get('dshHomePath')`, then `process.env.DSH_HOME`, then `<os.homedir()>/.dsh`.

## 4. Wire protocol

Both adapters call the **same** dispatcher:

```js
// lib/ops.js
export async function dispatch(ctx, config, op, payload) -> { status: number, body: object }
```

`op` values: `status`, `list`, `delete`, `release`, `restore`, `archive`.

### 4.1 `status` (GET or POST)

```jsonc
{
  "ok": true,
  "plugin": { "name": "dsh-session-manager", "version": "1.0.0" },
  "capabilities": {
    "authenticatedRoute": true, "rawRoute": true, "workspaceRegistry": true,
    "projectionCache": true, "purgeProjectionCache": true, "purgeCacheLayout": "per-record" | "single-legacy" | "absent",
    "liveDetection": true, "releaseLive": true, "canRelease": true, "auditLog": true,
    "canDeleteLive": false
  },
  "config": { "allowDeleteUnarchived": false, "allowDeleteLive": false, "releaseLive": true,
              "dryRun": false, "purgeProjectionCache": true, "maxBatch": 200 },
  "roots": { "home": "…", "persistence": "…", "storages": "…", "cache": "…", "audit": "…" },
  "counts": { "items": 7, "archived": 3, "bytes": 123456 }
}
```

### 4.2 `list`

Request: `{ "op": "list", "query": "optional substring", "includeUnarchived": true }`
(also accessible as `GET <route>?op=list`)

```jsonc
{
  "ok": true,
  "generatedAt": "2026-02-14T10:00:00.000Z",
  "archivedIds": ["session-…", "…"],
  "items": [{
    "id": "session-99d4237d-…",
    "project": "--E-test--",
    "dir": "C:\\…\\sessions\\--E-test--\\session-99d4237d-…",
    "path": "C:\\…\\session-99d4237d-…",
    "files": ["session.v4.jsonl.zstd"],
    "logBytes": 40960, "cacheBytes": 2048, "bytes": 43008,
    "cacheFile": "C:\\…\\session_projcache\\sessions\\session-99d4237d-….json",
    "archived": true, "pinned": false, "live": false, "running": false, "current": false,
    "updatedAt": "2026-02-14T09:59:00.000Z",
    "deletable": true, "skipReason": null
  }],
  "warnings": ["…"]
}
```

`query` matches id / title-less fields case-insensitively. `skipReason` is one of the
reason codes in §4.3 when `deletable` is false (never throw for a non-deletable item).

`archivedIds` is always the full registry archive set, so the client can render correctly
even when its `useWorkspaces` hook is unavailable.

### 4.3 `delete`

Request: `{ "op": "delete", "ids": ["session-…"], "dryRun": false }`
(`dryRun` overrides the config flag only in the *true* direction.)

```jsonc
{
  "ok": true,
  "dryRun": false,
  "requested": 1,
  "deleted": ["session-…"],
  "skipped": [{ "id": "session-…", "reason": "not-archived" }],
  "failedIds": [],
  "freedBytes": 43008,
  "results": [{
    "id": "session-99d4237d-…",
    "ok": true,
    "freedBytes": 43008,
    "removed": { "dir": true, "files": 1, "cache": true, "archive": true, "membership": true },
    "failed": {},
    "error": null
  }],
  "auditLog": "C:\\Users\\Joe__\\.dsh\\session-manager\\deleted.jsonl"
}
```

**Reason codes** (exact strings): `invalid-id`, `not-found`, `not-archived`, `live`,
`running`, `protected`, `current`, `over-batch`, `disabled`, `dry-run`.
`ok` is `true` when the request was *processed* (a plan may legitimately contain skips);
use `failedIds.length === 0` for "nothing went wrong".

### 4.4 `restore` / `archive`

Request: `{ "op": "restore", "ids": [...] }` or `{ "op": "archive", "ids": [...], "stopActivity": false }`

```jsonc
{ "ok": true, "results": [{ "id": "…", "ok": true, "error": null }], "failedIds": [] }
```

## 5. HTTP mounting

Primary — authenticated, inside the `/api` prefix route (registered when `connection` exists):

```js
connection.fetch.register({
  path: '/api/session-manager',
  methods: ['GET', 'HEAD', 'POST'],
  requestBody: 'buffered',
  fetch: async (request) => { /* → new Response(json) */ },
});
```

Fallback — raw `node:http`, registered on `webServer` at **prefix** `/session-manager/api`:

```js
webServer.register({ kind: 'prefix', path: '/session-manager/api', handler: (req, res) => {…} });
```

Fallback fence (mandatory): loopback remote address, `Origin` host === `Host` header when
`Origin` is present, `content-type: application/json` for POST, body ≤ 512 KiB, and the
custom header `x-dsh-session-manager: 1` present. Reply `403`/`413`/`415`/`400` otherwise;
never answer `OPTIONS` with CORS headers.

Client endpoint resolution order: `api/session-manager` (document-relative, so `<base href="./">`
works) then `session-manager/api`; cache the winner; treat HTTP 404/405 as "try next".

## 6. Client bundle contract

```js
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory(require) {
    const React = require('react');
    // …
    return { name: 'dsh-session-manager', inject: ['slots', 'locale'], apply(ctx) { /* … */ } };
  },
});
```

Registrations (all via `ctx.slots.inject(owner, () => ctx.slots.register(opts, Component))`,
returned disposers must be collected by `ctx.effect`):

| Slot | opts | Component |
| --- | --- | --- |
| `sidebar.panellist` | `{ name, id: PANEL_ID, order: 30, locale: NS, label: () => t('panelLabel') }` | icon, props `{ size, active }` |
| `main` | `{ name: 'main', key: PANEL_ID, locale: NS }` | manager page |
| `sidebar.workspaces.session.menu.item` | `{ name, id: 'dsh-session-manager.delete', order: 500, locale: NS }` | `删除会话…` menu item, ownerProps `{ sessionId, displayTitle }` |
| `shell.overlay` | `{ name, id: 'dsh-session-manager.confirm', order: 500, locale: NS }` | confirm modal |
| `settings.section` | `{ name, id: PANEL_ID, order: 60, locale: NS, label: () => t('settingsLabel') }` | read-only diagnostics page |
| `sidebar.workspaces.session.row.action` | `{ name, id: 'dsh-session-manager.archive-toggle', order: 500, locale: NS }` | **(optional, only if trivial)** restore button for archived rows |

`PANEL_ID = 'dsh-session-manager'`, `NS = 'dsh-session-manager'`.

Every slot component receives the `t` function (from `locale: NS`) and the standard props:
`useSessions`, `useWorkspaces`, `usePanelInfo`, `useSessionStatus`, `useSessionRetainInfo`,
`useResource`. Read data as `useSessions(s => s)` / `useWorkspaces(s => s)` and derive with
`useMemo` — never return a fresh array from a selector.

`ctx.locale.register(NS, { en, zh })` in `apply` (feature-detect `ctx.locale?.register`).

Styles: inline `style={{}}` only, using `--dsw-alias-*` tokens exactly as in §7.
**No CSS files, no imports of primitives, no `document.body` writes, no DOM reads.**

UI text: zh-CN primary, en fallback, via the registered locale dictionaries.

### 6.1 Required UX

- Manager page: tabs `归档` / `全部`, search box, refresh button, row list (checkbox, title,
  cwd, id, relative time, size, badges `归档`/`运行中`/`当前`/`无日志`), row actions `删除` and
  `恢复`, bulk bar with `全选` / `删除选中 (n)` / `恢复选中`, and an empty state.
- Deletion always goes through the confirm modal showing count, total size, the exact ids,
  and an explicit "此操作不可撤销" warning. The confirm button is disabled until the user
  ticks a checkbox when more than one session is selected.
- Errors and successes surface as an inline banner (no dependency on a Toast service).
- The row menu item is hidden for `current` and `live` sessions; it is disabled (with a
  tooltip/subtitle) when the session is not archived and `allowDeleteUnarchived` is false.
- Menu item must work through the owner-injected `useMenuOpenState` hook when present, and
  must not crash when it is absent.

## 7. Theme tokens (verified to exist)

`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-bg-layer-3`, `--dsw-alias-bg-module-platform`, `--dsw-alias-bg-skeleton`,
`--dsw-alias-border-l1..l4`, `--dsw-alias-brand-primary`, `--dsw-alias-button-elevated-fill`,
`--dsw-alias-button-ghost-active-border`, `--dsw-alias-button-ghost-active-fill`,
`--dsw-alias-button-primary-fill`, `--dsw-alias-button-primary-hover`,
`--dsw-alias-interactive-bg-hover`, `--dsw-alias-interactive-bg-hover-danger`,
`--dsw-alias-label-caption`, `--dsw-alias-label-dimmed`, `--dsw-alias-label-primary`,
`--dsw-alias-label-secondary`, `--dsw-alias-label-tertiary`, `--dsw-alias-link`,
`--dsw-alias-scrollbar-bg-l2`, `--dsw-alias-scrollbar-hover-l2`,
`--dsw-alias-state-business-primary`, `--dsw-alias-state-error-primary`,
`--dsw-alias-state-success-primary`, `--dsw-alias-state-success-secondary`,
`--dsw-alias-state-warn-label`, `--dsw-alias-state-warn-primary`,
`--dsw-alias-state-warn-tertiary`.

Always give a literal fallback: `var(--dsw-alias-label-primary, #e6e6e6)`.

## 7.5 Host-core module signatures (frozen)

`lib/config.js`

```js
export const PLUGIN_NAME = 'dsh-session-manager';
export const PLUGIN_VERSION = '1.0.0';
export const CONFIG_DEFAULTS = Object.freeze({ /* every key of §5 with defaults */ });
export const Config = { '~standard': { version: 1, vendor: PLUGIN_NAME, validate(value) {…} } };
export function normalizeConfig(raw) -> { value: normalized, issues: [] }
// normalized keys (all present after normalize):
//   enabled: true
//   allowDeleteArchived: true
//   allowDeleteUnarchived: false
//   allowDeleteLive: false
//   releaseLive: true         // stop+detach a still-live session before deleting
//   purgeProjectionCache: true
//   pruneEmptyProjects: true
//   cascadeRoots: []          // string[]
//   protectedSessionIds: []   // string[]
//   maxBatch: 200
//   dryRun: false
//   auditLog: ''              // '' => <home>/session-manager/deleted.jsonl
//   routePath: ''             // '' => /api/session-manager
//   fallbackRoutePath: ''     // '' => /session-manager/api
//   managerDir: ''            // '' => <home>/session-manager
export function publicConfig(normalized) -> { allowDeleteUnarchived, allowDeleteLive, releaseLive,
                                               dryRun, purgeProjectionCache, maxBatch, enabled }
```

`lib/encoder.js`

```js
export function encodeSegment(raw: string) -> string
export function decodeSegment(name: string) -> string      // lenient, never throws
export function matchesSegment(name: string, id: string) -> boolean
export function isValidSessionId(id: unknown) -> boolean   // /^[A-Za-z0-9._~-]{1,200}$/ and not '.'/'..'
export const SESSION_ID_PATTERN: RegExp
```

`lib/scanner.js`

```js
export function resolveRoots(ctx, config) -> { home, persistence, storages, cache, cacheLayout, audit, manager }
// ctx may be undefined; then use process.env.DSH_HOME || <homedir>/.dsh
// persistence: ctx.get('sessionPersistence')?.root if it is a non-empty string, else <home>/sessions
// cache: <storages>/session_projcache/sessions ; cacheLayout: 'per-record' | 'single-legacy' | 'absent'

export async function listArtifacts(roots, opts = {}) -> { items, warnings }
// opts = { archivedIds: string[], pinnedIds: string[], cascadeRoots: string[], liveIds: Set<string>,
//          runningIds: Set<string>, currentSessionId: string, purgeProjectionCache: boolean }
// items: the Item shape of §4.2, WITHOUT deletable/skipReason (the Lead's plan.js step adds those
//        via decide()), plus `sources: { dir, files, cache, extra }` used by delete.js.
// Never throw for an unreadable entry; push a warning string instead.
// `bytes` = logBytes + cacheBytes + extraBytes.

export async function removeArtifacts(item, opts) -> { removed, failed, freedBytes }
// opts = { pruneEmptyProjects: boolean, purgeProjectionCache: boolean }
// Uses fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }) for dirs,
// fs.rm(path, { force: true, maxRetries: 5, retryDelay: 120 }) for files.
// Re-verifies containment with assertInside before every removal.
// removed keys: dir, files (count), cache, extra, projectDir
// failed: { [step]: message }

export function assertInside(root, target) -> boolean
export function sizeOfDir(dir) -> Promise<number>
```

`lib/plan.js` — pure, no fs, no ctx

```js
export const REASONS = Object.freeze({ INVALID_ID:'invalid-id', NOT_FOUND:'not-found',
  NOT_ARCHIVED:'not-archived', LIVE:'live', RUNNING:'running', PROTECTED:'protected',
  CURRENT:'current', OVER_BATCH:'over-batch', DISABLED:'disabled', DRY_RUN:'dry-run' });

export function decide(item, view) -> { deletable: boolean, skipReason: string|null }
// view = { archivedIds:Set, liveIds:Set, runningIds:Set, protectedIds:Set, currentSessionId:string,
//          allowDeleteUnarchived:boolean, allowDeleteLive:boolean, enabled:boolean }

export function buildDeletePlan(ids, items, view, config) ->
  { accepted: Item[], skipped: [{id, reason}], totalBytes, overBatch: string[] }
// preserves request order; dedupes ids; unknown id => NOT_FOUND; !item.deletable => item.skipReason;
// more than config.maxBatch accepted ids => the overflow ids are skipped with OVER_BATCH.
// disabled => every id is DISABLED. config.dryRun is NOT applied here (delete.js applies it).
```

`lib/audit.js`

```js
export function auditPath(roots, config) -> string
export async function appendAudit(path, record) -> { ok, error }   // JSONL, mkdir -p, never throws
export async function readAuditTail(path, limit = 50) -> { lines: object[], error: string|null }
```

## 7.6 Lead addenda (binding, additive only)

1. `package.json` with `"type": "module"` is written; plain ESM `import` resolves.
2. The real DSH codec special-cases `.` → `~002E`, `..` → `~002E~002E`, and escapes
   `~` as `~007E`. Keep `encodeSegment` faithful to that. The Lead looks up the
   projection-cache stem by trying **both** the literal id and `encodeSegment(id)`.
3. `_no-cwd` is a real project directory (`projectDir(root, undefined)`). The scanner must
   treat **any** directory under the persistence root as a potential project dir and must
   not depend on the `--…--` shape.
4. `listArtifacts` items carry `sources: { dir, files, cache, extra }` and leave
   `live`/`running`/`current` false; the Lead stamps them.
5. `removeArtifacts(item, opts)` treats a missing/`null` `sources.dir` or `sources.cache`
   and an empty `sources.files` as "nothing to do", never as an error, and returns
   `freedBytes` (possibly 0) even when every step failed.
6. `releaseLive: true` (default) — when the requested session is still in the in-memory
   `SessionStore`, `lib/delete.js` releases it **before** removing files: stop the activity
   through `workspaceRegistry.stopSessionActivity` (falling back to
   `ctx.parallel('workspace/session-stop', { sessionId })`, then `ctx.emit`), then
   `sessions.liveEntryFor(session).detach()`, then re-check `sessions.get(id) === undefined`.
   `liveEntryFor` throwing "not live" counts as success; any other outcome fails the delete,
   because a still-attached Session can append to the log directory after it was removed.
   `releaseLive: false` keeps the legacy behaviour and records the warning
   `live session left in the in-memory store (releaseLive is off)`.
8. `release` is a POST-only operation of its own (`status`, `list`, `delete`, `release`,
   `restore`, `archive`): it performs steps 7.1–7.3 above and deletes nothing, which is how a
   user unblocks a `live`/`running` row before deciding to delete it. It refuses the open
   session with `reason: 'current'`, answers `403 release-disabled` when `releaseLive` is off and
   `503 sessions-unavailable` when the composition has no `sessions` service. Its audit action
   is `release`. `list` items carry `releasable` so the UI only offers it where it applies.
7. `status.capabilities` gained `releaseLive`; `publicConfig` includes `releaseLive`.

## 8. Testing rules

- Node tests use the bundled runtime:
  `C:\Users\Joe__\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  (not the Volta `node` shim).
- Tests must be self-contained: create a temp fixture root under `$env:TEMP`, never touch the
  real `C:\Users\Joe__\.dsh` tree, and clean up.
- `lib/*` modules must be importable with plain `import` and must not require a Cordis ctx.
- The client test must fake `window.__ModuleLoader__`, fake `require('react')` minimally, and
  assert the exact registration list, `label` thunks, `locale` namespace, and that the
  returned `apply` never throws when every optional hook/service is missing.
