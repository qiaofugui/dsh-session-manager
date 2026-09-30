/**
 * Plugin configuration — a hand-written Standard Schema v1 object plus normalisation.
 *
 * The framework only ever calls `Config['~standard'].validate(raw)` and consumes
 * `result.value`; any `{ issues: [...] }` result makes Cordis throw (see cordis
 * `resolveConfig`). Validation must therefore be synchronous and must never throw.
 *
 * Forward compatibility is a hard requirement: unknown keys are ignored, never reported.
 * Malformed *known* keys are reported as issues so the user learns about the typo.
 */

/** Package name; also the Standard Schema `vendor` string. */
export const PLUGIN_NAME = 'dsh-session-manager';

/** Package version reported by the `status` operation. */
export const PLUGIN_VERSION = '1.0.0';

/**
 * Every supported key with its default. `null`/`undefined` input normalises to this object.
 * `''` is the documented "unset" marker for the path-shaped options.
 */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  allowDeleteArchived: true,
  allowDeleteUnarchived: false,
  allowDeleteLive: false,
  purgeProjectionCache: true,
  pruneEmptyProjects: true,
  cascadeRoots: Object.freeze([]),
  protectedSessionIds: Object.freeze([]),
  maxBatch: 200,
  dryRun: false,
  auditLog: '',
  routePath: '',
  fallbackRoutePath: '',
  managerDir: '',
});

/** Accepted truthy/falsy spellings. `''` counts as truthy: an empty flag means "on". */
const TRUE_LITERALS = new Set(['true', '1', 'yes', 'on', '']);
const FALSE_LITERALS = new Set(['false', '0', 'no', 'off']);

/** Keys whose value must be a non-empty-or-empty string. */
const STRING_KEYS = ['auditLog', 'routePath', 'fallbackRoutePath', 'managerDir'];

/** Keys whose value must be a string or an array of strings. */
const STRING_LIST_KEYS = ['cascadeRoots', 'protectedSessionIds'];

/** Keys whose value must be a boolean. */
const BOOLEAN_KEYS = [
  'enabled',
  'allowDeleteArchived',
  'allowDeleteUnarchived',
  'allowDeleteLive',
  'purgeProjectionCache',
  'pruneEmptyProjects',
  'dryRun',
];

/**
 * Coerce one boolean-ish value.
 *
 * @param {unknown} input raw value.
 * @returns {{ value: boolean } | { invalid: true }} the coercion result.
 */
function coerceBoolean(input) {
  if (typeof input === 'boolean') return { value: input };
  if (typeof input === 'number') {
    if (input === 1) return { value: true };
    if (input === 0) return { value: false };
    return { invalid: true };
  }
  if (typeof input === 'string') {
    const text = input.trim().toLowerCase();
    if (TRUE_LITERALS.has(text)) return { value: true };
    if (FALSE_LITERALS.has(text)) return { value: false };
    return { invalid: true };
  }
  return { invalid: true };
}

/**
 * Coerce one finite positive integer (used for `maxBatch`).
 *
 * @param {unknown} input raw value.
 * @returns {{ value: number } | { invalid: true }} the coercion result.
 */
function coercePositiveInteger(input) {
  let numeric;
  if (typeof input === 'number') numeric = input;
  else if (typeof input === 'string' && input.trim() !== '') numeric = Number(input.trim());
  else return { invalid: true };
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) return { invalid: true };
  return { value: numeric };
}

/**
 * Coerce a string-or-array-of-strings option. Trailing/leading whitespace is trimmed and
 * blank entries are dropped; a non-string entry is reported (its index is in the path).
 *
 * @param {unknown} input raw value.
 * @param {string} key owning key name.
 * @param {Array<{message: string, path?: Array<string|number>}>} issues collector.
 * @returns {string[]} the normalised list.
 */
function coerceStringList(input, key, issues) {
  if (input === undefined || input === null || input === '') return [];
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text !== '') out.push(text);
      continue;
    }
    issues.push({ message: `${key}[${i}] must be a string`, path: [key, i] });
  }
  return out;
}

/**
 * Normalise raw plugin config into the complete key set of SPEC.md §7.5.
 *
 * Never throws. `issues` is empty for unknown keys; a known key with an unusable value is
 * reported and its default is kept, so a partially broken config still loads.
 *
 * @param {unknown} raw user config (any shape).
 * @returns {{ value: Record<string, unknown>, issues: Array<{message: string, path?: Array<string|number>}> }}
 */
export function normalizeConfig(raw) {
  /** @type {Array<{message: string, path?: Array<string|number>}>} */
  const issues = [];
  const value = {
    enabled: CONFIG_DEFAULTS.enabled,
    allowDeleteArchived: CONFIG_DEFAULTS.allowDeleteArchived,
    allowDeleteUnarchived: CONFIG_DEFAULTS.allowDeleteUnarchived,
    allowDeleteLive: CONFIG_DEFAULTS.allowDeleteLive,
    purgeProjectionCache: CONFIG_DEFAULTS.purgeProjectionCache,
    pruneEmptyProjects: CONFIG_DEFAULTS.pruneEmptyProjects,
    cascadeRoots: [],
    protectedSessionIds: [],
    maxBatch: CONFIG_DEFAULTS.maxBatch,
    dryRun: CONFIG_DEFAULTS.dryRun,
    auditLog: CONFIG_DEFAULTS.auditLog,
    routePath: CONFIG_DEFAULTS.routePath,
    fallbackRoutePath: CONFIG_DEFAULTS.fallbackRoutePath,
    managerDir: CONFIG_DEFAULTS.managerDir,
  };

  if (raw === undefined || raw === null) return { value, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ message: 'config must be an object' });
    return { value, issues };
  }

  const source = /** @type {Record<string, unknown>} */ (raw);

  for (const key of BOOLEAN_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const input = source[key];
    if (input === undefined || input === null) continue;
    const coerced = coerceBoolean(input);
    if ('invalid' in coerced) issues.push({ message: `${key} must be a boolean`, path: [key] });
    else value[key] = coerced.value;
  }

  if (Object.hasOwn(source, 'maxBatch') && source.maxBatch !== undefined && source.maxBatch !== null && source.maxBatch !== '') {
    const coerced = coercePositiveInteger(source.maxBatch);
    if ('invalid' in coerced) issues.push({ message: 'maxBatch must be a finite positive integer', path: ['maxBatch'] });
    else value.maxBatch = coerced.value;
  }

  for (const key of STRING_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const input = source[key];
    if (input === undefined || input === null) continue;
    if (typeof input !== 'string') issues.push({ message: `${key} must be a string`, path: [key] });
    else value[key] = input.trim();
  }

  for (const key of STRING_LIST_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const input = source[key];
    if (input === undefined || input === null) continue;
    value[key] = coerceStringList(input, key, issues);
  }

  return { value, issues };
}

/**
 * The Standard Schema v1 schema handed to Cordis. Validation is synchronous and total.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: PLUGIN_NAME,
    /**
     * @param {unknown} value raw user config.
     * @returns {{ value: Record<string, unknown> } | { issues: Array<{message: string, path?: Array<string|number>}> }}
     */
    validate(value) {
      const { value: normalized, issues } = normalizeConfig(value);
      if (issues.length > 0) return { issues };
      return { value: normalized };
    },
  },
};

/**
 * The safe, non-sensitive slice of the config echoed by the `status` operation.
 *
 * @param {unknown} normalized a normalised config (raw input is normalised defensively).
 * @returns {{ enabled: boolean, allowDeleteUnarchived: boolean, allowDeleteLive: boolean, dryRun: boolean, purgeProjectionCache: boolean, maxBatch: number }}
 */
export function publicConfig(normalized) {
  const { value } = normalizeConfig(normalized);
  return {
    enabled: value.enabled,
    allowDeleteUnarchived: value.allowDeleteUnarchived,
    allowDeleteLive: value.allowDeleteLive,
    dryRun: value.dryRun,
    purgeProjectionCache: value.purgeProjectionCache,
    maxBatch: value.maxBatch,
  };
}
