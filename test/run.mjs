/**
 * Run every dsh-session-manager test file in one process.
 *
 * `node --test <dir>` cannot be used here: the test runner spawns one child per
 * file with piped stdio, which a confined Windows sandbox denies with `EPERM`.
 * Importing the files instead registers their tests on the root context, and
 * `node:test` runs them once this module finishes loading.
 *
 *   & '<bundled node>' 'E:\test\dsh-session-manager\test\run.mjs'
 *
 * The process exits non-zero when at least one test failed.
 */
import './host-core.test.mjs';
import './client.test.mjs';
import './integration.test.mjs';
