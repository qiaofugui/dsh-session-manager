/**
 * Read-only probe of the live DSH home.
 *
 * Answers "would this plugin see my sessions correctly?" without installing it
 * and without touching anything: it reads the real `$DSH_HOME`, runs the plugin's
 * own `status` and `list` operations against it, and prints a deletion preview
 * (a `dryRun` delete, which by construction performs no writes and no audit).
 *
 *   & '<bundled node>' 'E:\test\dsh-session-manager\tools\probe-live.mjs'
 *   & '<bundled node>' '...\probe-live.mjs' --home 'C:\Users\you\.dsh'
 *
 * Options:
 *   --home <path>     DSH home to inspect (default: $DSH_HOME, else ~/.dsh)
 *   --delete <id,...> preview a delete of these ids instead of every archived id
 *   --json            print the raw JSON instead of a table
 *
 * NOTHING in this file writes: no `removeArtifacts`, no audit append, no
 * registry mutation. The registry is a read-only stub built from
 * `storages/workspace.json`, so the plugin's own write paths are unreachable.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { dispatch } from '../lib/ops.js';

/** Parse argv into the three supported options. */
function parseArgs(argv) {
  const options = { home: '', delete: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--home') options.home = String(argv[++index] ?? '');
    else if (arg === '--delete') options.delete = String(argv[++index] ?? '');
  }
  return options;
}

/** Resolve the DSH home the same way the plugin does. */
function resolveHome(explicit) {
  if (explicit.trim() !== '') return path.resolve(explicit.trim());
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  if (fromEnv !== '') return path.resolve(fromEnv);
  return path.join(homedir(), '.dsh');
}

/**
 * Build a read-only context from the real home.
 *
 * `workspace.json` is parsed to recover the archive and pin sets and the
 * workspace memberships; the registry stub exposes them but every mutating method
 * is absent, which the plugin treats as "unavailable" rather than failing.
 */
async function readOnlyContext(home) {
  const persistenceRoot = path.join(home, 'sessions');
  let state = { archived: [], pinned: [], workspaces: [] };
  try {
    const raw = await readFile(path.join(home, 'storages', 'workspace.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const global = parsed?.global ?? {};
    const tables = parsed?.tables?.workspaces ?? {};
    state = {
      archived: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [],
      pinned: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : [],
      workspaces: Object.entries(tables).map(([id, record]) => ({
        id,
        path: typeof record?.path === 'string' ? record.path : '',
        sessionIds: Array.isArray(record?.sessionIds) ? record.sessionIds : [],
      })),
    };
  } catch (error) {
    process.stderr.write(`probe: could not read workspace.json (${describe(error)}); archive set treated as empty\n`);
  }

  const registry = {
    archivedSessionIds: [...state.archived],
    pinnedSessionIds: [...state.pinned],
    list: () => state.workspaces.map((workspace) => ({ ...workspace })),
    get: (id) => state.workspaces.find((workspace) => workspace.id === id),
  };

  const services = new Map([
    ['sessionPersistence', { root: persistenceRoot }],
    ['workspaceRegistry', registry],
    ['sessions', { get: () => undefined, list: () => [] }],
    ['agents', { get: () => undefined }],
    ['dshHomePath', () => home],
  ]);

  return {
    state,
    ctx: {
      get: (key) => services.get(key),
      emit: () => {},
      logger: { warn: (text) => process.stderr.write(`${text}\n`), info: () => {} },
      effect: () => () => {},
      inject: (names, callback) => {
        if (names.every((key) => services.has(key))) callback({ get: (key) => services.get(key) });
        return () => {};
      },
    },
  };
}

/** Human-readable byte size. */
function bytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** One table row, padded for fixed-width terminals. */
function row(cells, widths) {
  return cells
    .map((cell, index) => {
      const text = String(cell);
      const clipped = text.length > widths[index] ? `${text.slice(0, widths[index] - 1)}~` : text;
      return clipped.padEnd(widths[index]);
    })
    .join('  ');
}

/** Render an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

const options = parseArgs(process.argv.slice(2));
const home = resolveHome(options.home);
const { ctx, state } = await readOnlyContext(home);
const config = normalizeConfig({}).value;

const status = await dispatch(ctx, config, 'status', {});
const list = await dispatch(ctx, config, 'list', {});

if (options.json) {
  process.stdout.write(`${JSON.stringify({ home, status: status.body, list: list.body }, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`DSH home        ${home}\n`);
process.stdout.write(`persistence     ${status.body.roots?.persistence ?? '?'}\n`);
process.stdout.write(`storages        ${status.body.roots?.storages ?? '?'}\n`);
process.stdout.write(`cache layout    ${status.body.capabilities?.purgeCacheLayout ?? '?'}\n`);
process.stdout.write(`audit log       ${status.body.roots?.audit ?? '?'}\n`);
process.stdout.write(`capabilities    ${JSON.stringify(status.body.capabilities)}\n`);
process.stdout.write(
  `counts          items=${status.body.counts?.items ?? 0} archived=${status.body.counts?.archived ?? 0} bytes=${bytes(status.body.counts?.bytes ?? 0)}\n`,
);
process.stdout.write(`workspaces      ${state.workspaces.length} (${state.workspaces.map((workspace) => `${workspace.id.slice(0, 8)}:${workspace.sessionIds.length}`).join(' ') || 'none'})\n`);
if (Array.isArray(status.body.warnings) && status.body.warnings.length > 0) {
  process.stdout.write(`warnings        ${status.body.warnings.join(' | ')}\n`);
}
process.stdout.write('\n');

const widths = [40, 14, 10, 10, 14, 22];
process.stdout.write(`${row(['id', 'project', 'log', 'cache', 'updated', 'flags'], widths)}\n`);
process.stdout.write(`${row(['-'.repeat(40), '-'.repeat(14), '-'.repeat(10), '-'.repeat(10), '-'.repeat(14), '-'.repeat(22)], widths)}\n`);
for (const item of list.body.items ?? []) {
  const flags = [
    item.archived ? 'archived' : '',
    item.live ? 'live' : '',
    item.running ? 'running' : '',
    item.pinned ? 'pinned' : '',
    item.deletable ? 'deletable' : `skip:${item.skipReason ?? '?'}`,
  ]
    .filter(Boolean)
    .join(',');
  process.stdout.write(
    `${row([item.id, item.project, bytes(item.logBytes), bytes(item.cacheBytes), String(item.updatedAt ?? '').slice(0, 19), flags], widths)}\n`,
  );
}

const previewIds =
  options.delete.trim() !== ''
    ? options.delete.split(',').map((id) => id.trim()).filter(Boolean)
    : (list.body.archivedIds ?? []);
if (previewIds.length === 0) {
  process.stdout.write('\nNo archived session selected for a delete preview.\n');
  process.exit(0);
}

const preview = await dispatch(ctx, config, 'delete', { ids: previewIds, dryRun: true });
process.stdout.write(`\nDelete preview (dry run — nothing was written), ${previewIds.length} requested:\n`);
for (const entry of preview.body.results ?? []) {
  process.stdout.write(`  would delete  ${entry.id}  ${bytes(entry.freedBytes)}\n`);
}
for (const entry of preview.body.skipped ?? []) {
  process.stdout.write(`  skipped       ${entry.id}  (${entry.reason})\n`);
}
process.stdout.write(`  total         ${bytes(preview.body.freedBytes)}\n`);
