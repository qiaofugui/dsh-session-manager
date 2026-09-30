/**
 * Install (or uninstall) this plugin's directory layout into a DSH profile.
 *
 * This performs the same two steps DSH's own `install_bundle` performs, without
 * a package manager: it copies the package into the profile's `node_modules` and
 * appends the bundle name to `dsh.profile.bundles` in the profile manifest (plus
 * a `file:` dependency so the profile's own reconciliation keeps it). It is
 * idempotent and always backs the manifest up before writing.
 *
 *   # install into the desktop profile
 *   & '<bundled node>' 'E:\test\dsh-session-manager\tools\install-profile.mjs'
 *
 *   # a different profile / source, or a dry run
 *   & '<node>' '...\install-profile.mjs' --profile "$env:DSH_HOME\profiles\web" --dry-run
 *
 *   # remove the bundle entry again (leaves the copied files in place)
 *   & '<node>' '...\install-profile.mjs' --uninstall
 *
 * A restart of DSH is required afterwards: replacing or newly adding a bundle
 * cannot hot-load a fresh browser `client.js` generation.
 */
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-session-manager';
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Files and directories copied into the profile; nothing else leaves the repo. */
const COPY = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'icon.svg', 'lib', 'locale', 'SPEC.md', 'README.md', 'README.zh-CN.md'];

/** Parse argv. */
function parseArgs(argv) {
  const options = { profile: '', source: SOURCE, uninstall: false, dryRun: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--profile') options.profile = String(argv[++index] ?? '');
    else if (arg === '--source') options.source = String(argv[++index] ?? '');
  }
  return options;
}

/** Default profile directory, matching DSH's own layout. */
function defaultProfile() {
  const home = String(process.env.DSH_HOME ?? '').trim() || path.join(homedir(), '.dsh');
  const name = String(process.env.DSH_PROFILE ?? '').trim() || 'desktop';
  return path.join(home, 'profiles', name);
}

/** Print unless quiet. */
function say(options, text) {
  if (!options.quiet) process.stdout.write(`${text}\n`);
}

const options = parseArgs(process.argv.slice(2));
const profileDir = path.resolve(options.profile.trim() !== '' ? options.profile.trim() : defaultProfile());
const manifestPath = path.join(profileDir, 'package.json');
const targetDir = path.join(profileDir, 'node_modules', PACKAGE_NAME);

// --- read the manifest -------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  process.stderr.write(`install-profile: cannot read ${manifestPath}: ${message(error)}\n`);
  process.exit(1);
}
if (manifest === null || typeof manifest !== 'object') {
  process.stderr.write(`install-profile: ${manifestPath} is not a JSON object\n`);
  process.exit(1);
}

const before = JSON.parse(JSON.stringify(manifest));
manifest.dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
manifest.dsh = manifest.dsh !== null && typeof manifest.dsh === 'object' ? manifest.dsh : {};
manifest.dsh.profile = manifest.dsh.profile !== null && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : [];

if (options.uninstall) {
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
  delete manifest.dependencies[PACKAGE_NAME];
  if (manifest.dsh.profile.bundles.length === 0) delete manifest.dsh.profile.bundles;
} else {
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);
  manifest.dsh.profile.bundles = bundles;
  if (typeof manifest.dependencies[PACKAGE_NAME] !== 'string') {
    manifest.dependencies[PACKAGE_NAME] = `file:./node_modules/${PACKAGE_NAME}`;
  }
}

const manifestChanged = JSON.stringify(before) !== JSON.stringify(manifest);
say(options, `${options.uninstall ? 'uninstall' : 'install'}  profile   ${profileDir}`);
say(options, `${options.uninstall ? 'uninstall' : 'install'}  package   ${targetDir}`);
say(options, `manifest  ${manifestChanged ? 'will be updated' : 'already up to date'}`);
if (manifestChanged) {
  say(options, `  bundles   ${JSON.stringify(before.dsh?.profile?.bundles ?? [])} -> ${JSON.stringify(manifest.dsh.profile.bundles)}`);
}

if (options.dryRun) {
  say(options, 'dry run: nothing was written');
  process.exit(0);
}

// --- copy the package --------------------------------------------------------
if (!options.uninstall) {
  const sourceManifest = path.join(options.source, 'package.json');
  try {
    await stat(sourceManifest);
  } catch {
    process.stderr.write(`install-profile: --source ${options.source} has no package.json\n`);
    process.exit(1);
  }
  await mkdir(targetDir, { recursive: true });
  for (const entry of COPY) {
    const from = path.join(options.source, entry);
    try {
      await stat(from);
    } catch {
      continue;
    }
    await cp(from, path.join(targetDir, entry), { recursive: true, force: true });
  }
  say(options, `copied    ${COPY.length} entries -> ${targetDir}`);
}

// --- write the manifest, with a backup --------------------------------------
if (manifestChanged) {
  const backup = `${manifestPath}.bak-${Date.now()}`;
  await rename(manifestPath, backup);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  say(options, `manifest  written (backup: ${backup})`);
}

if (options.uninstall) {
  await rm(targetDir, { recursive: true, force: true });
  say(options, `removed   ${targetDir}`);
}

say(options, '');
say(options, 'Restart DSH to load the change. Then verify:');
say(options, '  Invoke-RestMethod "http://127.0.0.1:19387/session-manager/api?op=status"');

/** Render an unknown thrown value. */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
