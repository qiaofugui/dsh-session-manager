/**
 * DSH path-segment codec — a dependency-free re-implementation of the codec inside
 * `dsh-session-persistence-jsonl` (`encodeSegment` / `projectKey`).
 *
 * A session id is only *loosely* constrained (see {@link SESSION_ID_PATTERN}), so every id is
 * path-escaped before it is ever joined onto a filesystem path. Safe code units from
 * `[A-Za-z0-9._-]` stay literal; every other UTF-16 code unit — including `~` — becomes
 * `~XXXX` with uppercase hex and four digits. Operating on code units keeps lone surrogates
 * and astral characters round-trippable.
 *
 * Only `node:*` builtins may be imported by this package; this module needs none at all.
 */

/** One safe code unit, exactly the class used by DSH's own encoder. */
const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/;

/** Four uppercase-or-lowercase hex digits, the payload of an escape sequence. */
const HEX_QUAD = /^[0-9a-fA-F]{4}$/;

/**
 * The accepted shape of a session id, as frozen by SPEC.md §7.5.
 *
 * Note that `~` is *legal inside an id* even though the encoder escapes it in path names;
 * that asymmetry is why cache lookups try both the literal id and {@link encodeSegment}(id).
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

/** Coerce arbitrary input to a string without throwing. */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Escape one raw string into a single filesystem-safe path segment.
 *
 * Never throws: an empty or non-string input yields `''` (DSH's own encoder rejects an empty
 * segment, but a plugin must stay inert rather than explode on hostile input).
 *
 * @param {unknown} raw value to escape.
 * @returns {string} the escaped single path segment.
 */
export function encodeSegment(raw) {
  const source = toText(raw);
  if (source.length === 0) return '';
  // DSH refuses to let an otherwise-safe whole segment mean traversal.
  if (source === '.') return '~002E';
  if (source === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    const ch = source[i];
    if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Decode a path segment produced by {@link encodeSegment}.
 *
 * Deliberately lenient: every well-formed `~XXXX` is decoded, malformed escapes (a trailing
 * `~`, a short tail, non-hex digits) are copied through untouched, and this never throws.
 *
 * @param {unknown} name segment to decode.
 * @returns {string} the decoded text.
 */
export function decodeSegment(name) {
  const source = toText(name);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '~' && i + 5 <= source.length) {
      const quad = source.slice(i + 1, i + 5);
      if (HEX_QUAD.test(quad)) {
        out += String.fromCharCode(parseInt(quad, 16));
        i += 4;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Whether a directory/file name is the on-disk spelling of one session id.
 *
 * Accepts either the canonical encoded spelling or a name that already decodes to the id,
 * so hand-written fixtures and DSH-produced directories both match.
 *
 * @param {unknown} name a single path segment (a directory or file name).
 * @param {unknown} id the session id to test for.
 * @returns {boolean} true when `name` names `id`.
 */
export function matchesSegment(name, id) {
  if (typeof name !== 'string' || typeof id !== 'string' || id.length === 0) return false;
  if (name === id) return true;
  if (name === encodeSegment(id)) return true;
  return decodeSegment(name) === id;
}

/**
 * Validate a session id before it is used as an identity or a path component.
 *
 * @param {unknown} id candidate id.
 * @returns {boolean} true when the id is safe to use.
 */
export function isValidSessionId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 200) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('/') || id.includes('\\') || id.includes('\u0000')) return false;
  return SESSION_ID_PATTERN.test(id);
}
