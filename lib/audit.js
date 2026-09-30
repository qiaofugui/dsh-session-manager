/**
 * Append-only deletion audit log (JSONL).
 *
 * Every write is one `JSON.stringify(record)` line plus `\n`, appended to a file whose parent
 * directory is created on demand. Nothing in here is allowed to throw: an audit failure must
 * never abort a deletion that already succeeded, it is only reported back to the caller.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Default number of trailing records returned by {@link readAuditTail}. */
const DEFAULT_TAIL_LIMIT = 50;

/** Reduce an unknown error to a message string. */
function errText(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * Resolve the audit log path.
 *
 * Precedence: an explicit `config.auditLog`, then the `audit` path already resolved by
 * `scanner.resolveRoots`, then `<home>/session-manager/deleted.jsonl`.
 *
 * @param {{home?: string, manager?: string, audit?: string}|undefined} roots resolved roots.
 * @param {object|undefined} config normalised config.
 * @returns {string} absolute path of the audit log file.
 */
export function auditPath(roots, config) {
  const configured = config && typeof config.auditLog === 'string' ? config.auditLog.trim() : '';
  if (configured !== '') return path.resolve(configured);
  if (roots && typeof roots.audit === 'string' && roots.audit !== '') return roots.audit;
  const home =
    roots && typeof roots.home === 'string' && roots.home !== ''
      ? roots.home
      : process.env.DSH_HOME && process.env.DSH_HOME !== ''
        ? process.env.DSH_HOME
        : path.join(os.homedir(), '.dsh');
  return path.join(home, 'session-manager', 'deleted.jsonl');
}

/**
 * Append one record to the audit log.
 *
 * @param {string} filePath absolute audit log path.
 * @param {unknown} record any JSON-serialisable value.
 * @returns {Promise<{ok: boolean, error: string|null}>} `ok: false` on any failure; never rejects.
 */
export async function appendAudit(filePath, record) {
  try {
    if (typeof filePath !== 'string' || filePath === '') return { ok: false, error: 'audit path is empty' };
    await mkdir(path.dirname(filePath), { recursive: true });
    let line;
    try {
      line = JSON.stringify(record === undefined ? null : record);
    } catch (error) {
      return { ok: false, error: `unserializable audit record: ${errText(error)}` };
    }
    if (typeof line !== 'string') return { ok: false, error: 'unserializable audit record' };
    await appendFile(filePath, line + '\n', 'utf8');
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errText(error) };
  }
}

/**
 * Read the last `limit` parsable records from the audit log.
 *
 * Unparsable lines (a torn tail, a hand-edit) are skipped rather than fatal, and a missing
 * file is simply an empty log.
 *
 * @param {string} filePath absolute audit log path.
 * @param {number} [limit] how many trailing records to return.
 * @returns {Promise<{lines: object[], error: string|null}>} never rejects.
 */
export async function readAuditTail(filePath, limit = DEFAULT_TAIL_LIMIT) {
  try {
    if (typeof filePath !== 'string' || filePath === '') return { lines: [], error: 'audit path is empty' };
    const wanted = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TAIL_LIMIT;
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { lines: [], error: null };
      return { lines: [], error: errText(error) };
    }
    const raw = text.split(/\r?\n/);
    const lines = [];
    for (let i = raw.length - 1; i >= 0 && lines.length < wanted; i--) {
      const candidate = raw[i].trim();
      if (candidate === '') continue;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') lines.push(parsed);
      } catch {
        /* skip an unparsable line: a torn write must not hide the records around it */
      }
    }
    lines.reverse();
    return { lines, error: null };
  } catch (error) {
    return { lines: [], error: errText(error) };
  }
}
