# dsh-session-manager · archived-session manager for DeepSeek Harness

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-blue.svg)](https://github.com/deepseek-ai/dsh)
[![tests](https://img.shields.io/badge/tests-69%2F69-brightgreen.svg)](test)
[![zero deps](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

Manage **archived sessions** in the DeepSeek Harness (DSH) Web UI and **permanently delete** them —
Codex-style — instead of merely unarchiving. Deleting removes the session log, its derived projection
cache, and its workspace/archive accounting, and it is recorded in an audit log.

[中文](README.zh-CN.md) · [interface contract](SPEC.md) · [issues](https://github.com/qiaofugui/dsh-session-manager/issues)

![dsh-session-manager screenshot — the DSH session manager panel listing archived sessions, with search, multi-select, bulk restore and permanent delete](docs/screenshot.png)

*The `会话管理` panel: archived sessions in one list, with per-row size, search, multi-select and an
irreversible delete behind a confirm dialog. Delete removes the session log, its derived projection
cache and its workspace/archive accounting, and writes an audit entry.*

**Features**

- Browse every archived session and every session on disk, with per-session log and cache size
- **Permanently delete** an archived session — session log, derived projection cache, archive
  membership, pin state and workspace accounting, all in one operation
- Restore (un-archive) and re-archive a session without leaving the panel
- **Release** a session that is still in memory — stop the running turn and drop it from the Host's
  store while keeping the log on disk, so the delete becomes available
- Bulk delete / bulk restore with a confirmation dialog that lists every id and the total size
- Safety by default: the current session, running sessions and live sessions are refused unless you
  opt in; an explicit protection list always wins
- An audit log records every delete, each failed step, and the bytes reclaimed
- Zero npm dependencies on the Host side and zero client-package imports on the browser side, so it
  can never fail composition
- Capability-probed: every optional Host service, slot, route and storage layout degrades instead of
  throwing

---

## 0. Quick install

```
dsh plugin add https://github.com/qiaofugui/dsh-session-manager
```

Or, in the Web UI: sidebar **插件** → **添加插件** → paste the same address.
Full details in [§ 3 Install](#3-install).

---

## 1. What it adds

| Surface | Where | What it does |
| --- | --- | --- |
| **Session manager panel** | sidebar icon (`会话管理`) | `归档` / `全部` tabs, search, multi-select, bulk delete, bulk restore, per-row delete/restore, on-disk size per session |
| **Row delete action** | the `⋯` menu on a session row → `删除会话…` | single-session delete (never shown for the open session or a running one) |
| **Confirm dialog** | global overlay | count, total size, the complete id list, and a mandatory "this cannot be undone" confirmation |
| **Diagnostics page** | Settings → 会话管理 | read-only: mounted routes, roots, counts, capability probes, audit-log path |

Every deletion is audited to `$DSH_HOME/session-manager/deleted.jsonl`.

---

## 2. Compatibility

This is the design centre of the plugin. Everything is **capability-probed and degrades**: when a Host
service, slot, route surface, or storage layout is missing, the plugin becomes *less capable*, never
broken. An undeclared slot is never written to, and the Host half stays inert instead of failing
activation.

### 2.1 Hard rules (each one has a matching implementation)

| Rule | Why |
| --- | --- |
| The Host half imports **only `node:*`** — no `@deepseek-ai/*`, no `zod` | a third-party package installed into a profile cannot resolve them (`profiles/<name>/node_modules/@deepseek-ai` is empty) |
| The client bundle is **one hand-written file** that only `require`s `react` | there is no build chain; requiring a Harness client package throws and blanks the slot |
| `Config` is a **hand-written Standard Schema v1** that **ignores unknown keys** | the framework only reads `Config['~standard'].validate()`; a newer `cordis.patch.yml` can never break an older plugin |
| Optional services are probed with `ctx.inject([...], cb)` / `svc?.method?.()` | a missing service skips the callback instead of throwing the row into `failed` |
| No Harness client package is requested (`dsh.client.external` is empty) | `inject` only orders activation; no module-graph edge, so a missing provider cannot fail composition |
| Styling uses only verified `--dsw-alias-*` tokens with literal fallbacks | a renamed token degrades looks, never rendering |
| No `document.body` writes, no cross-plugin DOM/style access | the plugin shares one application with the host UI |

### 2.2 Host capability matrix

| Service | When present | When missing |
| --- | --- | --- |
| `connection` (`fetch.register`) | mounts the **authenticated** route `/api/session-manager`, reusing the `/api` prefix Host/Origin fence plus the browser cookie | skipped; only the fallback route is used |
| `webServer` (`register`) | mounts the **fallback** prefix route `/session-manager/api` with its own loopback + Origin fence | route absent; the client tries the authenticated one first |
| `workspaceRegistry` | archive/pin set reads and writes, `detachSession` accounting cleanup | logs and cache are still deleted; `restore`/`archive` answer `503 workspace-registry-unavailable`; `archivedIds` is empty |
| `sessionPersistence` | its `.root` is the log root | falls back to `$DSH_HOME/sessions` |
| `sessions` / `agents` | precise "open" and "running" detection | `liveDetection: false`; only the archive set and the protection list gate deletions (see §7) |
| `dshHomePath` | resolves the DSH home | falls back to `%DSH_HOME%`, then `~/.dsh` |
| `ctx.locale` (client) | host language dictionaries | the inline zh/en dictionaries inside `client.js` |
| `useSessions` / `useWorkspaces` (client props) | merged with the disk view | only the rows the Host `list` returned |
| `ctx.remote` / `ctx.on` (client) | reacts to `api-session/removed` | the panel re-fetches after a successful delete |

Both routes are registered **simultaneously** and cannot collide: the authenticated one is an exact
path, the fallback is a different prefix. The client probes `api/session-manager` then
`session-manager/api`, caches the one that answers, and treats HTTP 404/405 as "try the next" — any
other failure is shown in the panel, so a route-level incompatibility is visible in the UI instead of
producing a blank page.

### 2.3 Session-storage compatibility

Deletion **never parses a session log** (so there is no zstd dependency or binary asset); it locates
artifacts by shape:

- any project directory name is accepted: `--<projectKey>--`, `_no-cwd`, anything else;
- a session directory is matched by decoding its name with DSH's `encodeSegment`, so both `session-…`
  ids and **bare UUIDs** (subagent sessions) resolve;
- log file names are **never assumed**: `session.v0..v4.jsonl`, `.jsonl.zst`, `.jsonl.zstd`,
  `session.jsonl`, … deleting removes the **whole session directory**, so a future generation number
  is compatible by construction;
- legacy flat layouts are supported too (session directory directly under `sessions/`, or
  `<projectKey>/<encodedId>.jsonl*` files);
- the legacy **single-file projection cache** `<storages>/session_projcache.json` is **never deleted**
  (it holds every session's records); only the per-record layout
  `<storages>/session_projcache/sessions/<id>.json` is, and both the literal and the encoded file stem
  are tried;
- every path is re-verified as strictly inside an allowed root (`assertInside`) immediately before
  removal, and symlinks cannot walk the deletion out of a root.

### 2.4 Platform compatibility

- Windows: directory removal uses `fs.rm(..., { recursive, maxRetries: 5, retryDelay: 120 })` to ride
  out antivirus/handle `EBUSY`/`EPERM`; empty project directories are pruned with `fs.rmdir` (atomic
  `ENOTEMPTY`) instead of a recursive delete, so a directory repopulated between the check and the
  removal can never be deleted.
- POSIX: the same logic; a `session.lock` disappears with its directory.
- Node: stable `node:fs` / `node:path` / `node:os` APIs only; `engines.node >= 18`.

### 2.5 Version declaration

`package.json` declares `dshTarget: "0.2.0-rc.2"` (this machine's DSH version). It is a hint for the
plugin market/manager; the runtime does not enforce it. Real compatibility is the capability probing
above.

### 2.6 Coexistence with other plugins

- Workspace state is changed **only through the `workspaceRegistry` service**, never by editing
  `storages/workspace.json`, so it cannot race the host's write queue.
- **Attachments are untouched** (content-addressed and shared across sessions).
- **Other plugins' own indexes are untouched** (`dsh-usage`, `task-board`, `redteam`, `skin-center`,
  …). Use `cascadeRoots` (§5) to opt into cleaning a specific directory.
- If a deployment enables a **durable session-search index** (SQLite), a stale row remains until the
  index is rebuilt. This plugin does not write other plugins' databases.

---

## 3. Install

## 3. Install

### Paste the GitHub address into the Plugins page (recommended)

In the DSH sidebar open **插件 (Plugins)** → **添加插件 (Add plugin)** and enter:

```
https://github.com/qiaofugui/dsh-session-manager
```

**Add plugin** accepts a package name, a **Git address**, a tarball, or an absolute local path — so
the repository URL alone is enough. Then click **立即启用 (Enable now)** and refresh the browser page;
the `会话管理` sidebar icon appears.

> A newer release cannot be auto-updated: uninstall first, then install again.
> A package without a bundle patch is refused before install; this repo ships `cordis.patch.yml`, so
> it passes.

### Command line

```
dsh plugin add https://github.com/qiaofugui/dsh-session-manager
```

Pin a tag or commit (the default branch is used without `#`):

```
dsh plugin add https://github.com/qiaofugui/dsh-session-manager#v1.0.0
```

### Agent tool call

From a DSH session, let an agent call `plugin_manager`:

```
action: install_bundle
target: https://github.com/qiaofugui/dsh-session-manager
```

### Local development install

With the source in a local directory, install by absolute path (no GitHub network needed):

```
action: install_bundle
target: E:\test\dsh-session-manager
```

Or equivalently run the bundled script (idempotent, backs the profile's `package.json` up):

```powershell
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  E:\test\dsh-session-manager\tools\install-profile.mjs
# preview without writing
& "...node.exe" "...\tools\install-profile.mjs" --dry-run
# undo the bundle registration and remove the copied directory
& "...node.exe" "...\tools\install-profile.mjs" --uninstall
```

### Uninstall

Use the bundle's uninstall control on the Plugins page (it asks for confirmation), or call
`remove_bundle` with `target: dsh-session-manager`. The plugin leaves no global state; the audit log
lives in `$DSH_HOME\session-manager\` and can be deleted by hand.

### Verifying the install

```powershell
Invoke-RestMethod "http://127.0.0.1:19387/session-manager/api?op=status"
```

`ok: true` proves the Host half is mounted.

> That route is a loopback-only diagnostic: it accepts connections from this machine, requires the
> `Origin` host to equal `Host`, and every `POST` needs `x-dsh-session-manager: 1` plus
> `application/json`. Hitting `/api/session-manager` without a browser cookie returns `401`, which
> is expected — the panel sends the cookie automatically.

### Upgrade

DSH has no auto-update for plugins: **uninstall, then install the new version again**. From local
sources, replacing the files under `node_modules\dsh-session-manager` needs a restart — an already
installed package cannot hot-load a fresh JavaScript generation, so the browser keeps the old
`client.js` until then.

---

## 4. Using it

1. Click the `会话管理` sidebar icon.
2. The `归档` tab lists archived sessions (the default); `全部` lists every session on disk, including
   running ones — whose delete buttons are disabled.
3. Filter by id / project directory / path with the search box.
4. Tick rows → bottom bar → `删除选中 (n)`.
5. In the dialog, check the count, total size and the complete id list; with more than one session you
   must tick the confirmation checkbox before the delete button enables.
6. After the delete the panel re-fetches and reports the space reclaimed.

The `⋯` menu on a session row offers `删除会话…` for a single session. The open session and running
sessions are not offered there at all (the UI does not even send a request).

---

## 5. Delete semantics — what is and is not removed

**Removed, in order**

1. the session directory `$DSH_HOME/sessions/<project>/<encodedId>/` (whole directory: every log
   generation and lock file), or the flat `*.jsonl*` files in a legacy layout;
2. the projection-cache record `$DSH_HOME/storages/session_projcache/sessions/<id>.json` (per-record
   layout only);
3. files/directories named by the session id inside any `cascadeRoots`;
4. archive accounting: `workspaceRegistry.unarchiveSession(id)`; pin: `unpinSession(id)`;
5. workspace accounting: `detachSession(id)` on every workspace listing that id;
6. a browser notification: the Host emits `api-session/removed` so the row disappears immediately;
7. an audit record (JSONL): timestamp, id, project, directory, freed bytes, per-step outcome, failures,
   caller.

**Not removed**

- shared attachments (content-addressed, reused across sessions);
- other plugins' indexes/databases;
- the legacy single-file projection cache;
- anything outside the allowed roots (a failed containment check refuses the removal).

**Ordering and retryability.** Files go first (irreversible), accounting second (reversible). If the
file step fails, accounting is untouched and a retry starts from the same state. If the files are gone
but accounting fails, the result is reported as `error: "partial"` and **not** counted as a success;
the next attempt performs residue cleanup only (`action: cleanup-residue`) and finishes the job.

### Cascading cleanup (`cascadeRoots`)

Empty by default, because other plugins' data belongs to them. To opt in:

```yaml
cascadeRoots:
  - "C:\\Users\\Joe__\\.dsh\\task-board"
```

Only four shapes are considered inside each root: `<root>/<id>.json`, `<root>/<id>`,
`<root>/sessions/<id>.json`, `<root>/sessions/<id>` — with the id tried both literally and in
`encodeSegment` form.

---

## 6. Configuration

Set it in the profile's `cordis.patch.yml`. An override targeting the same `id` replaces the **whole**
`config`, so repeat every key you want to keep:

```yaml
- id: dsh-session-manager
  name: dsh-session-manager
  config:
    allowDeleteUnarchived: false
    maxBatch: 200
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch; `false` registers nothing |
| `allowDeleteArchived` | `true` | `false` treats archived sessions as protected (`protected`) |
| `allowDeleteUnarchived` | `false` | allow deleting **non-archived** sessions (needed by the `全部` tab) |
| `allowDeleteLive` | `false` | allow deleting a session that is still live |
| `releaseLive` | `true` | before deleting a live session, **free the in-memory session object**: stop the running turn (`workspace/session-stop`) and detach it from `SessionStore`. Also enables the explicit 释放 / Release action. Turning this off leaves an orphan object that can rewrite the log directory |
| `purgeProjectionCache` | `true` | remove the derived projection-cache record (it regenerates from the log) |
| `pruneEmptyProjects` | `true` | delete an empty `--<project>--` directory after its last session goes |
| `cascadeRoots` | `[]` | extra roots cleaned by session id, see §5 |
| `protectedSessionIds` | `[]` | ids that must never be deleted |
| `maxBatch` | `200` | per-request ceiling; the overflow is skipped as `over-batch` |
| `dryRun` | `false` | report the plan only (the panel's preview passes `dryRun` too) |
| `auditLog` | `''` | audit path; empty = `$DSH_HOME/session-manager/deleted.jsonl` |
| `routePath` | `''` | empty = `/api/session-manager` |
| `fallbackRoutePath` | `''` | empty = `/session-manager/api` |
| `managerDir` | `''` | empty = `$DSH_HOME/session-manager` (holds the audit log) |

Booleans accept `true/false`, `"true"/"false"/"1"/"0"`; `""` always means `true`, so `dryRun: ""` cannot
silently switch dry-run off. **Unknown keys are ignored and dropped**, so an older plugin can read a
newer config without failing. An invalid config never fails the row: the plugin falls back to the
defaults and logs a warning.

---

## 7. Safety design

- **Archived only, by default.** Archiving means "hide it", and deleting is its natural extension.
- **The open session** is the highest-priority guard (`current`). The plugin's own session
  (`DSH_SESSION_ID`) is protected as well.
- **Live/running sessions are refused by default** (`live` / `running`); they need an explicit
  `allowDeleteLive`.
- **Protection list**: `protectedSessionIds`, always wins.
- **Path safety**: a requested id must be a single path segment; anything that decodes to `.`/`..` or
  contains a separator is refused as `invalid-id`, and every removal re-verifies strict containment
  inside an allowed root.
- **CSRF**: the authenticated route uses the cookie plus the Host/Origin fence; the fallback route also
  requires a loopback peer, `sec-fetch-site != cross-site`, `Origin` host equal to `Host`,
  `content-type: application/json`, and the custom header `x-dsh-session-manager: 1` (a form post
  cannot set a custom header). `OPTIONS` never receives CORS headers. Bodies are capped at 512 KiB.
- **Mutations must be POST**: `delete`/`release`/`restore`/`archive` over GET answer `405 use-post`.
- **Audit**: every delete, every release and every residue cleanup appends one JSONL line, failures
  included.

---

## 7a. Releasing a session that is still in memory

### The button: release first, delete afterwards

A session that DSH still has open cannot be deleted — that is the `live` / `running` refusal. Rather
than leaving that as a dead end, the panel offers a **释放 / Release** action on every row that is
still held in memory (and is not the session you are looking at):

1. The row shows `释放` instead of only a disabled `删除`. In the bottom bar, `释放选中 (n)` does the
   same for the selection, and only counts the rows that are actually releasable.
2. Release stops the running turn and drops the session from the Host's in-memory store. **Nothing on
   disk is touched** — the log and the projection cache stay exactly where they were.
3. The panel re-reads the list. The row loses its `live`/`running` badges and, because it is now
   merely an archived session on disk, its `删除` button enables. If it was not archived, turn on
   `allowDeleteUnarchived` to delete it.

So the normal flow for "this running session has to go" is **释放 → 删除**, with no configuration
change at all. The current session is never offered for release: tearing down the Host object your
own view is bound to would break the UI you are using.

### What the Host actually does

1. **Stop the activity.** `workspaceRegistry.stopSessionActivity(id)` — the same seam DSH's own
   archive admission uses. The Agent registry cancels the running turn the way the user would
   (`agent.cancel({ kind: 'user' })`), and the job registry kills that session's tasks. The call is
   awaited, so the turn's final events are written before anything is removed. Without the seam the
   plugin falls back to `ctx.parallel('workspace/session-stop', { sessionId })`, then to `ctx.emit`.
2. **Detach it from the store.** `sessions.liveEntryFor(session).detach()` — `SessionStore`'s public
   release: it removes the entry from the store and emits the paired `session/disposed`. The owning
   fiber's disposer becomes a no-op afterwards, so a double release is safe.
3. **Verify.** `sessions.get(id)` must now be `undefined`. If the session is still live after the
   detach, the operation is reported as failed rather than leaving an orphan that can resurrect the log.

The same three steps run automatically inside `delete` when `allowDeleteLive` is on, so a delete of a
live session can never leave a stale object appending into a directory that has already been removed.
Every step is separately guarded, so a composition without a `sessions` service, or without a stop
listener, degrades into a reported failure (`failed.stop` / `failed.release`) instead of a throw. Set
`releaseLive: false` to disable both spellings; the result then carries the warning
`live session left in the in-memory store (releaseLive is off)`.

The same release runs during residue cleanup, so a retry after a partial failure also frees the
object.

---

## 8. Known limitations

- Other plugins' session indexes are not cleaned (§2.6).
- The legacy single-file projection-cache layout is left alone on purpose.
- With `allowDeleteUnarchived: false`, no non-archived row in the `全部` tab is deletable — that is
  intentional.
- There is no recycle bin: deletion is irreversible, with only the audit log as a trace.
- `releaseLive` depends on `SessionStore` exposing `liveEntryFor()`; if DSH changes that API the
  delete fails with `failed.release` instead of silently leaving an orphan session behind.

---

## 9. Development and tests

```
dsh-session-manager/
├─ index.js            # Host entry (Cordis apply)
├─ client.js           # browser bundle (hand-written, window.__ModuleLoader__)
├─ cordis.patch.yml    # bundle patch inserting the plugin row
├─ lib/
│  ├─ config.js        # hand-written Standard Schema + defaults
│  ├─ encoder.js       # DSH path-segment codec, id validation
│  ├─ scanner.js       # the only module that touches the filesystem
│  ├─ plan.js          # pure policy: reason codes and precedence
│  ├─ delete.js        # delete pipeline: release memory → files → accounting → event → audit
│  ├─ audit.js         # JSONL audit log
│  ├─ ops.js           # the single operation dispatcher (status/list/delete/release/restore/archive)
│  └─ routes.js        # the two HTTP adapters and the fallback route's fence
├─ locale/             # client dictionaries (zh/en), mirrored inline in client.js
├─ tools/
│  ├─ install-profile.mjs  # idempotent install/uninstall into a profile
│  └─ probe-live.mjs       # read-only probe of the real $DSH_HOME, delete preview
└─ test/
   ├─ host-core.test.mjs   # 29 tests
   ├─ client.test.mjs      # registrations, degradation, dictionaries, release wiring
   ├─ integration.test.mjs # 44 tests: fake ctx + synthetic DSH home + real requests
   └─ run.mjs              # runs everything in one process
```

```powershell
# All tests. Note: `node --test <dir>` hits the sandbox's piped-stdio EPERM; use
# --test-isolation=none, or run the files directly.
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  --test --test-isolation=none E:\test\dsh-session-manager\test\run.mjs

# Read-only probe of the real $DSH_HOME to confirm the plugin sees your sessions
# (writes nothing at all).
& "...node.exe" E:\test\dsh-session-manager\tools\probe-live.mjs
```

Tests never read or write the real `$DSH_HOME`: every case builds its own synthetic DSH home under
`%TEMP%` and removes it afterwards.

**Verified status** (DSH `0.2.0-rc.2`, `desktop` profile, Windows): installed and mounted in a live
environment — `GET /session-manager/api?op=status` answered `items=13, archived=3, bytes=6.2 MiB`;
`/api/session-manager` without a cookie returned `401`; a cross-origin delete returned `403`.

[SPEC.md](SPEC.md) is the frozen interface contract (wire protocol, module signatures, slot
registrations, compatibility constraints). Change it before changing behaviour.

## 10. License

[MIT](LICENSE)
