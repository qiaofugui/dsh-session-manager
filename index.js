/**
 * dsh-session-manager — Host half.
 *
 * Manages archived DSH sessions and permanently deletes them, driven by the
 * plugin's own Web UI panel. This file is the only Cordis entry: it resolves the
 * config, mounts the two HTTP adapters, and registers nothing else.
 *
 * Compatibility rules this module follows (see SPEC.md §2):
 *   - no `@deepseek-ai/*` import, no third-party dependency: `node:*` only;
 *   - every Host service is optional and feature-detected, so the plugin stays
 *     inert in a composition that lacks it instead of throwing at activation;
 *   - `Config` is a hand-written Standard Schema whose validator ignores
 *     unknown keys, so a newer `cordis.patch.yml` never fails to load here.
 *
 * @module dsh-session-manager
 */
import { Config, PLUGIN_NAME, PLUGIN_VERSION, normalizeConfig } from './lib/config.js';
import { registerRoutes } from './lib/routes.js';

export const name = PLUGIN_NAME;
export const version = PLUGIN_VERSION;
export { Config };

/**
 * No static service dependency: every service this plugin uses is optional, and
 * a static `inject` would keep the whole row inactive in a minimal composition
 * that lacks it. Route registration is gated through `ctx.inject` inside
 * `registerRoutes` instead.
 */
export const inject = [];

/**
 * Host plugin body.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row's `config`, validated by `Config` before `apply`.
 */
export function apply(ctx, rawConfig) {
  let config;
  try {
    config = normalizeConfig(rawConfig).value;
  } catch (error) {
    warn(ctx, `invalid config, falling back to defaults: ${describe(error)}`);
    config = normalizeConfig(undefined).value;
  }
  if (config.enabled === false) {
    warn(ctx, 'disabled by config; no route registered');
    return;
  }
  try {
    registerRoutes(ctx, config);
  } catch (error) {
    // A route conflict must not take down the profile: report and stay inert.
    warn(ctx, `route registration failed: ${describe(error)}`);
  }
}

/** Best-effort logger access; a composition without `ctx.logger` stays silent. */
function warn(ctx, text) {
  try {
    ctx?.logger?.warn?.(`${PLUGIN_NAME}: ${text}`);
  } catch {
    /* logging must never break activation */
  }
}

/** Render an unknown thrown value as a short message. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
