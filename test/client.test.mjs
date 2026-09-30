/**
 * dsh-session-manager — client bundle contract test.
 *
 * Runs with the bundled runtime:
 *   node --test test/client.test.mjs
 *
 * No React renderer, no DOM, no network: the bundle is loaded through a fake
 * `window.__ModuleLoader__`, `apply` runs against a fake `ctx`, and the
 * registered components are invoked once with empty props to prove they cannot
 * throw without the optional standard props.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'client.js');
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');

const MODULE_ID = 'dsh-session-manager';
const NS = 'dsh-session-manager';
const PANEL_ID = 'dsh-session-manager';
const MENU_ID = 'dsh-session-manager.delete';
const CONFIRM_ID = 'dsh-session-manager.confirm';

/** The frozen registration list of SPEC.md §6. */
const EXPECTED = [
	{
		owner: 'sidebar.panellist',
		keys: ['id', 'label', 'locale', 'name', 'order'],
		name: 'sidebar.panellist',
		id: PANEL_ID,
		key: undefined,
		order: 30,
		labelled: true,
	},
	{
		owner: 'main',
		keys: ['key', 'locale', 'name'],
		name: 'main',
		id: undefined,
		key: PANEL_ID,
		order: undefined,
		labelled: false,
	},
	{
		owner: 'sidebar.workspaces.session.menu.item',
		keys: ['id', 'locale', 'name', 'order'],
		name: 'sidebar.workspaces.session.menu.item',
		id: MENU_ID,
		key: undefined,
		order: 500,
		labelled: false,
	},
	{
		owner: 'shell.overlay',
		keys: ['id', 'locale', 'name', 'order'],
		name: 'shell.overlay',
		id: CONFIRM_ID,
		key: undefined,
		order: 500,
		labelled: false,
	},
	{
		owner: 'settings.section',
		keys: ['id', 'label', 'locale', 'name', 'order'],
		name: 'settings.section',
		id: PANEL_ID,
		key: undefined,
		order: 60,
		labelled: true,
	},
];

/** SPEC.md §4.3 reason codes: their display keys must exist in both dictionaries. */
const REASON_KEYS = [
	'reason.invalid-id',
	'reason.not-found',
	'reason.not-archived',
	'reason.live',
	'reason.running',
	'reason.protected',
	'reason.current',
	'reason.over-batch',
	'reason.disabled',
	'reason.dry-run',
];

/**
 * Load the bundle.
 *
 * The file is a plain browser script (no `import`/`export`) that reads
 * module-scope `window`. It is evaluated with `new Function('window', source)`
 * rather than `await import(...)`:
 *
 *  - `import()` would depend on this package's `"type"` field to decide ESM vs
 *    CJS, and on Node's ESM loader accepting a `.js` file with no exports;
 *  - `import()` caches the module, so a second test could not get fresh module
 *    state (the bundle keeps its endpoint cache and stores at module scope);
 *  - the dependency is passed as a formal parameter, so the bundle can never
 *    touch a real global `window` by accident.
 *
 * `globalThis.window` is also installed for the duration of the evaluation,
 * because the contract is stated as a global `window.__ModuleLoader__`.
 */
function loadBundle() {
	const captured = { loadCount: 0, id: null, factory: null };
	const fakeWindow = {
		__ModuleLoader__: {
			load(entry) {
				captured.loadCount += 1;
				captured.id = entry ? entry.id : null;
				captured.factory = entry ? entry.factory : null;
			},
		},
	};
	const previousWindow = globalThis.window;
	globalThis.window = fakeWindow;
	try {
		// eslint-disable-next-line no-new-func -- deliberate: see the comment above.
		const evaluate = new Function('window', SOURCE);
		evaluate(fakeWindow);
	} finally {
		if (previousWindow === undefined) delete globalThis.window;
		else globalThis.window = previousWindow;
	}
	return captured;
}

/** Minimal fake `require('react')`: element objects, hooks that never render. */
function createFakeReact() {
	const calls = [];
	const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
	return {
		calls,
		module: {
			createElement,
			Fragment: Symbol.for('test.react.fragment'),
			useState(initial) {
				calls.push('useState');
				return [typeof initial === 'function' ? initial() : initial, () => {}];
			},
			useEffect(callback) {
				calls.push('useEffect');
				return callback;
			},
			useMemo(factory) {
				calls.push('useMemo');
				return factory();
			},
			useRef(initial) {
				calls.push('useRef');
				return { current: initial };
			},
		},
	};
}

/** Build one fake client `ctx` plus the observations the assertions need. */
function createFakeContext(options = {}) {
	const state = {
		injections: [],
		registrations: [],
		disposed: [],
		effects: [],
		effectLabels: [],
		localeDictionaries: null,
		localeRegisterCalls: [],
		remoteSubscriptions: [],
		ctxEventSubscriptions: [],
	};
	const injectCallbacksMissing = options.injectCallbacksMissing === true;

	const slots = {
		inject(owner, callback) {
			if (typeof callback !== 'function') throw new TypeError('slots.inject requires a callback');
			const before = state.registrations.length;
			let result;
			if (!injectCallbacksMissing) result = callback();
			state.injections.push({ owner, added: state.registrations.length - before });
			if (typeof result === 'function') state.disposed.push(`inject:${owner}`);
			return () => {
				state.disposed.push(`inject:${owner}`);
			};
		},
		register(registrationOptions, component) {
			state.registrations.push({ options: registrationOptions, component });
			const label = registrationOptions && (registrationOptions.id ?? registrationOptions.key ?? registrationOptions.name);
			return () => {
				state.disposed.push(`register:${registrationOptions && registrationOptions.name}:${label}`);
			};
		},
	};

	const ctx = { slots };

	if (options.slots === false) delete ctx.slots;

	if (options.locale !== false) {
		const dictionaries = new Map();
		ctx.locale = {
			register(namespace, dicts) {
				if (options.localeRegisterThrows === true) throw new Error('namespace already registered');
				state.localeRegisterCalls.push(namespace);
				state.localeDictionaries = dicts;
				dictionaries.set(namespace, dicts);
				return () => {
					state.disposed.push(`locale:${namespace}`);
				};
			},
			bind(namespace) {
				return (key, params) => {
					const dicts = dictionaries.get(namespace) ?? {};
					const template = dicts.zh && Object.prototype.hasOwnProperty.call(dicts.zh, key)
						? dicts.zh[key]
						: dicts.en && Object.prototype.hasOwnProperty.call(dicts.en, key)
							? dicts.en[key]
							: key;
					if (!params) return template;
					return String(template).replace(/\{(\w+)\}/g, (match, name) => (
						Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
					));
				};
			},
		};
	}

	if (options.effect !== false) {
		ctx.effect = (callback, label) => {
			state.effectLabels.push(label);
			const dispose = callback();
			state.effects.push(dispose);
			return () => {
				if (typeof dispose === 'function') dispose();
			};
		};
	}

	if (options.remote === true) {
		ctx.remote = {
			$on(event, handler) {
				assert.equal(typeof handler, 'function');
				state.remoteSubscriptions.push(event);
				return () => {
					state.disposed.push(`remote:${event}`);
				};
			},
		};
	}

	if (options.ctxOn === true) {
		ctx.on = (event, handler) => {
			assert.equal(typeof handler, 'function');
			state.ctxEventSubscriptions.push(event);
			return () => {
				state.disposed.push(`event:${event}`);
			};
		};
	}

	if (options.injectThrows === true) {
		slots.inject = (owner) => {
			state.injections.push({ owner, added: 0 });
			throw new Error('slot is not declared yet');
		};
	}

	return { ctx, state };
}

function loadFactory() {
	const captured = loadBundle();
	assert.equal(captured.loadCount, 1, 'the bundle must call __ModuleLoader__.load exactly once');
	assert.equal(captured.id, MODULE_ID, 'module id must equal the package name');
	assert.equal(typeof captured.factory, 'function');
	const react = createFakeReact();
	const returned = captured.factory((specifier) => {
		assert.equal(specifier, 'react', 'react is the only allowed require target');
		return react.module;
	});
	return { returned, react, captured };
}

/** Every key used through `t('…')` in the bundle source. */
function extractUsedKeys(source) {
	const keys = new Set();
	const pattern = /\bt\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*(?=[,)])/g;
	let match = pattern.exec(source);
	while (match !== null) {
		keys.add(match[2]);
		match = pattern.exec(source);
	}
	return keys;
}

test('module id, factory shape and inject list', () => {
	const { returned } = loadFactory();
	assert.equal(typeof returned, 'object');
	assert.equal(returned.name, MODULE_ID);
	assert.deepEqual(returned.inject, ['slots', 'locale']);
	assert.equal(typeof returned.apply, 'function');
});

test('apply registers exactly the five contract slots with exact owners and options', () => {
	const { returned, react } = loadFactory();
	const { ctx, state } = createFakeContext({ remote: true });
	assert.doesNotThrow(() => returned.apply(ctx));

	assert.equal(state.registrations.length, 5, 'exactly five registrations');
	assert.equal(state.injections.length, 5, 'each registration waits on its owner slot');
	assert.equal(state.effectLabels.length, 1, 'all registrations live in one ctx.effect');
	assert.match(String(state.effectLabels[0]), /dsh-session-manager/);

	EXPECTED.forEach((expected, index) => {
		const injection = state.injections[index];
		const registration = state.registrations[index];
		assert.equal(injection.owner, expected.owner, `injection ${index} owner`);
		assert.equal(injection.added, 1, `injection ${index} registers one component`);

		const options = registration.options;
		assert.equal(options.name, expected.name);
		assert.equal(options.locale, NS, `registration ${index} locale namespace`);
		assert.deepEqual(Object.keys(options).sort(), expected.keys.slice().sort(), `registration ${index} option keys`);

		if (expected.id === undefined) assert.ok(!('id' in options), `registration ${index} must not carry id`);
		else assert.equal(options.id, expected.id, `registration ${index} id`);

		if (expected.key === undefined) assert.ok(!('key' in options), `registration ${index} must not carry key`);
		else assert.equal(options.key, expected.key, `registration ${index} key`);

		if (expected.order === undefined) assert.ok(!('order' in options), `registration ${index} must not carry order`);
		else assert.equal(options.order, expected.order, `registration ${index} order`);

		assert.equal(typeof registration.component, 'function', `registration ${index} component`);

		if (expected.labelled) assert.equal(typeof options.label, 'function');
		else assert.ok(!('label' in options), `registration ${index} must not carry a label`);
	});

	assert.equal(state.localeRegisterCalls.length, 1);
	assert.equal(state.localeRegisterCalls[0], NS, 'dictionaries register under the plugin namespace');
	assert.ok(state.localeDictionaries && state.localeDictionaries.zh && state.localeDictionaries.en);
	assert.deepEqual(state.remoteSubscriptions, ['api-session/removed']);
	assert.deepEqual(react.calls, [], 'apply must not call any hook');
});

test('label thunks resolve through the registered dictionaries', () => {
	const { returned } = loadFactory();
	const { ctx, state } = createFakeContext();
	returned.apply(ctx);

	const labelled = state.registrations.filter((entry) => typeof entry.options.label === 'function');
	assert.equal(labelled.length, 2);

	for (const entry of labelled) {
		const value = entry.options.label();
		assert.equal(typeof value, 'string');
		assert.ok(value.trim().length > 0, `label for ${entry.options.name} must not be empty`);
		assert.notEqual(value, 'panelLabel');
		assert.notEqual(value, 'settingsLabel');
	}

	const labels = labelled.map((entry) => entry.options.label());
	assert.deepEqual(labels, ['会话管理', '会话管理诊断']);
});

test('every t() key exists in BOTH registered dictionaries, which are key-identical', () => {
	const { returned } = loadFactory();
	const { ctx, state } = createFakeContext();
	returned.apply(ctx);

	const dicts = state.localeDictionaries;
	const zhKeys = Object.keys(dicts.zh);
	const enKeys = Object.keys(dicts.en);
	assert.deepEqual(zhKeys.slice().sort(), enKeys.slice().sort(), 'zh and en must have identical key sets');

	const used = extractUsedKeys(SOURCE);
	assert.ok(used.size > 40, `expected a substantial key set, found ${used.size}`);
	const missing = [...used].filter((key) => !zhKeys.includes(key) || !enKeys.includes(key));
	assert.deepEqual(missing, [], `translation keys missing from a dictionary: ${missing.join(', ')}`);

	for (const key of REASON_KEYS) {
		assert.ok(zhKeys.includes(key), `zh is missing ${key}`);
		assert.ok(enKeys.includes(key), `en is missing ${key}`);
	}

	assert.match(String(dicts.zh['confirm.warning']), /此操作不可撤销/);
	assert.match(String(dicts.zh['panelLabel']), /会话/);
});

test('apply never throws when locale, inject callbacks, effect, remote and hooks are missing', () => {
	// Nothing at all beyond the bare context.
	const bare = {};
	assert.doesNotThrow(() => loadFactory().returned.apply(bare));

	// Only `slots.inject` exists and it never invokes the callback.
	const noCallbacks = createFakeContext({ injectCallbacksMissing: true, locale: false, effect: false });
	assert.doesNotThrow(() => loadFactory().returned.apply(noCallbacks.ctx));
	assert.deepEqual(noCallbacks.state.registrations, []);

	// `slots.inject` throws for every call (slot not declared).
	const throwing = createFakeContext({ injectThrows: true, locale: false, effect: false });
	assert.doesNotThrow(() => loadFactory().returned.apply(throwing.ctx));
	assert.equal(throwing.state.injections.length, 5);

	// `ctx.locale.register` throws (namespace already taken) — the rest still registers.
	const localeThrows = createFakeContext({ localeRegisterThrows: true });
	assert.doesNotThrow(() => loadFactory().returned.apply(localeThrows.ctx));
	assert.equal(localeThrows.state.registrations.length, 5);

	// `ctx.on` is the only event channel available.
	const eventOnly = createFakeContext({ ctxOn: true });
	assert.doesNotThrow(() => loadFactory().returned.apply(eventOnly.ctx));
	assert.deepEqual(eventOnly.state.ctxEventSubscriptions, ['api-session/removed']);

	// `slots` entirely absent.
	assert.doesNotThrow(() => loadFactory().returned.apply(createFakeContext({ slots: false }).ctx));
});

test('registered components render one element with empty props and no renderer', () => {
	const { returned, react } = loadFactory();
	const { ctx, state } = createFakeContext({ remote: true, ctxOn: false });
	returned.apply(ctx);

	assert.equal(state.registrations.length, 5);
	for (const entry of state.registrations) {
		assert.doesNotThrow(
			() => entry.component({}),
			`component for ${entry.options.name} must survive missing props`,
		);
	}
	// The manager page (and the menu item) must reach the standard hooks through
	// the injected React; the icon and the modal render without any.
	assert.ok(react.calls.includes('useState'), 'the page must use useState');
	assert.ok(react.calls.includes('useEffect'), 'the page must use useEffect');
	assert.ok(react.calls.includes('useMemo'), 'the page must use useMemo');
	assert.ok(!react.calls.includes('useSyncExternalStore'), 'useSyncExternalStore is forbidden');
});

test('the effect cleanup invokes every returned disposer and never throws', () => {
	const { returned } = loadFactory();
	const { ctx, state } = createFakeContext({ remote: true });
	returned.apply(ctx);

	assert.equal(state.effects.length, 1);
	const dispose = state.effects[0];
	assert.equal(typeof dispose, 'function');

	assert.doesNotThrow(() => dispose());
	// 5 slot injections + 5 registrations + 1 dictionary registration + 1 remote relay.
	assert.equal(state.disposed.length, 12, `disposed: ${state.disposed.join(' | ')}`);
	for (const marker of state.disposed) assert.match(marker, /^(inject|register|locale|remote|event):/);

	// Idempotent, and still silent on a second run.
	assert.doesNotThrow(() => dispose());
	assert.equal(state.disposed.length, 12);

	for (const effectDisposer of state.effects) {
		if (typeof effectDisposer === 'function') assert.doesNotThrow(() => effectDisposer());
	}
});

test('the bundle stays inside the hand-written browser contract', () => {
	assert.equal((SOURCE.match(/require\(/g) ?? []).length, 1, 'exactly one require() call');
	assert.match(SOURCE, /require\('react'\)/);
	assert.ok(!/react-dom|jsx-runtime|dsh-client-ui-primitives/.test(SOURCE), 'no other module may be required');
	assert.ok(!/\bdocument\b/.test(SOURCE), 'the bundle must not touch the document');
	assert.ok(!/useSyncExternalStore/.test(SOURCE), 'useSyncExternalStore is forbidden');
	assert.ok(!/document\.head|createElement\('style'\)/.test(SOURCE), 'no style injection');
	assert.match(SOURCE, /window\.__ModuleLoader__\.load\(\{/);
	assert.match(SOURCE, /id: 'dsh-session-manager'/);
	assert.match(SOURCE, /inject: \['slots', 'locale'\]/);
	assert.match(SOURCE, /'api\/session-manager'/);
	assert.match(SOURCE, /'session-manager\/api'/);
	assert.match(SOURCE, /'x-dsh-session-manager': '1'/);
	assert.match(SOURCE, /credentials: 'same-origin'/);
	assert.match(SOURCE, /cache: 'no-store'/);
	assert.match(SOURCE, /textOverflow: 'ellipsis'/);
	assert.match(SOURCE, /var\(--dsw-alias-/);
});

test('the release action is wired end to end in the bundle', () => {
	// The request carries the open session id, because the Host refuses to release it.
	assert.match(SOURCE, /async function releaseSessions\(ids, currentSessionId\)/);
	assert.match(SOURCE, /callHost\('release', \{/);
	assert.match(SOURCE, /currentSessionId: typeof currentSessionId === 'string' \? currentSessionId : ''/);

	// The row offers it only where the Host said it applies.
	assert.match(SOURCE, /row\.releasable === true \? h\('button'/);
	assert.match(SOURCE, /onRelease: releaseRows/);
	assert.match(SOURCE, /releasable: releasable,/);
	assert.match(SOURCE, /releasable = \(live \|\| running\) && !current/);
	assert.match(SOURCE, /t\('bulk\.release'/);

	// The handler re-reads the list instead of dropping rows, since nothing was deleted.
	assert.match(SOURCE, /t\('notice\.released', \{ n: done \}\)/);
	assert.match(SOURCE, /t\('notice\.releasedPartly', \{ n: done, m: body\.failedIds\.length \}\)/);
	assert.match(SOURCE, /t\('notice\.releaseFailed', \{ message: reason \}\)/);
});

test('locale JSON metadata files parse and carry meta.title/description', () => {
	for (const name of ['en', 'zh']) {
		const raw = readFileSync(join(HERE, '..', 'locale', `${name}.json`), 'utf8');
		const parsed = JSON.parse(raw);
		assert.equal(typeof parsed.meta, 'object');
		assert.ok(String(parsed.meta.title).length > 0, `${name}.json meta.title`);
		assert.ok(String(parsed.meta.description).length > 0, `${name}.json meta.description`);
	}
});
