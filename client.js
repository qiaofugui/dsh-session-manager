/**
 * dsh-session-manager — browser half.
 *
 * Hand-written single-file browser bundle: no build step, no JSX, no bundler.
 * The ONLY module this file may `require` is `react`; every optional service,
 * hook, prop and slot is feature-detected so a missing piece can never throw
 * at module scope, during `apply`, or from a component body.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-manager',
	factory(require) {
		'use strict';

		/* ================================================================== *
		 * 1. React wiring — `react` is the only allowed require target.
		 * ================================================================== */

		var loadedReact = null;
		try {
			loadedReact = require('react');
		} catch (error) {
			loadedReact = null;
		}
		if (loadedReact && typeof loadedReact.createElement !== 'function' && loadedReact.default !== undefined) {
			loadedReact = loadedReact.default;
		}
		if (loadedReact && typeof loadedReact.createElement !== 'function') loadedReact = null;

		var h = loadedReact !== null ? loadedReact.createElement : function (type, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			return { type: type, props: props || {}, children: children };
		};
		var Fragment = loadedReact !== null && loadedReact.Fragment !== undefined ? loadedReact.Fragment : 'div';

		/** Bind one React hook, falling back to a harmless stand-in. */
		function bindHook(name, fallback) {
			if (loadedReact !== null && typeof loadedReact[name] === 'function') return loadedReact[name];
			return fallback;
		}

		var useState = bindHook('useState', function (initial) {
			return [typeof initial === 'function' ? initial() : initial, function () {}];
		});
		var useEffect = bindHook('useEffect', function () {
			return undefined;
		});
		var useMemo = bindHook('useMemo', function (factory) {
			return factory();
		});
		var useRef = bindHook('useRef', function (initial) {
			return { current: initial };
		});

		/* ================================================================== *
		 * 2. Constants
		 * ================================================================== */

		var NS = 'dsh-session-manager';
		var PANEL_ID = 'dsh-session-manager';

		/** Document-relative first, so the app's `<base href="./">` resolves. */
		var ENDPOINTS = ['api/session-manager', 'session-manager/api'];
		var DELETE_MENU_ID = 'dsh-session-manager.delete';
		var CONFIRM_OVERLAY_ID = 'dsh-session-manager.confirm';

		var EMPTY_ARRAY = Object.freeze([]);
		var EMPTY_OBJECT = Object.freeze({});
		var EMPTY_SESSIONS = Object.freeze({ ids: EMPTY_ARRAY, byId: EMPTY_OBJECT });
		var EMPTY_WORKSPACES = Object.freeze({ items: EMPTY_ARRAY, archivedSessionIds: EMPTY_ARRAY, pinnedSessionIds: EMPTY_ARRAY });

		/* ================================================================== *
		 * 3. Locale dictionaries (inline: the browser cannot fetch JSON).
		 * ================================================================== */

		/** Simplified Chinese — key-set source of truth. */
		var zh = {
			'panelLabel': '会话管理',
			'settingsLabel': '会话管理诊断',
			'title': '会话管理',
			'subtitle': '管理已归档会话并永久删除会话记录',
			'tab.archived': '归档',
			'tab.all': '全部',
			'search.placeholder': '搜索标题、ID 或工作目录',
			'search.clear': '清除搜索',
			'refresh': '刷新',
			'refreshing': '正在刷新…',
			'loading': '正在加载…',
			'empty.none': '暂无会话',
			'empty.noMatches': '无匹配结果',
			'empty.hint': '切换到“全部”可查看未归档会话。',
			'counts': '显示 {shown} / {total} 个会话',
			'badge.archived': '归档',
			'badge.running': '运行中',
			'badge.current': '当前',
			'badge.live': '在线',
			'badge.noLog': '无日志',
			'badge.pinned': '已置顶',
			'row.delete': '删除',
			'row.restore': '恢复',
			'row.release': '释放',
			'row.release.title': '从内存中释放此会话：停止正在运行的回合，日志保留在磁盘上。释放后即可删除。',
			'bulk.selected': '已选 {n} 项',
			'bulk.selectAll': '全选',
			'bulk.clear': '取消选择',
			'bulk.delete': '删除选中 ({n})',
			'bulk.restore': '恢复选中 ({n})',
			'bulk.release': '释放选中 ({n})',
			'bulk.hint': '勾选会话后可批量删除或恢复。',
			'select.row': '选择会话 {id}',
			'title.untitled': '未命名',
			'cwd.none': '（无工作目录）',
			'size.unknown': '未知',
			'time.now': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'time.months': '{n} 个月前',
			'time.years': '{n} 年前',
			'menu.delete': '删除会话…',
			'menu.delete.notArchived': '仅可删除已归档会话（可在主机配置中开启未归档删除）',
			'banner.dismiss': '关闭',
			'list.error.title': '主机接口不可用',
			'list.stale.title': '主机接口刷新失败',
			'list.error.body': '已尝试端点：{endpoints}；错误：{message}',
			'list.error.hint': '下面仍会列出浏览器端已知的会话行，但缺少主机侧的大小、可删除判定与归档权威数据。',
			'notice.deleted': '已删除 {n} 个会话，释放 {size}',
			'notice.deleteFailed': '删除失败：{message}',
			'notice.restored': '已恢复 {n} 个会话',
			'notice.restoreFailed': '恢复失败：{message}',
			'notice.skipped': '已跳过 {n} 个不可删除的会话（含当前会话或未归档会话）',
			'notice.nothingSelected': '请先选择要操作的会话',
			'notice.nothingReleasable': '所选会话都无需释放（只有仍在内存中的会话可以释放）',
			'notice.released': '已释放 {n} 个会话，日志仍保留在磁盘上',
			'notice.releasedPartly': '已释放 {n} 个，{m} 个失败',
			'notice.releaseFailed': '释放失败：{message}',
			'notice.currentOnly': '当前打开的会话不能删除，已取消操作',
			'confirm.title': '永久删除会话',
			'confirm.count': '将要永久删除 {n} 个会话',
			'confirm.ids': '会话 ID',
			'confirm.total': '合计大小：{size}',
			'confirm.warning': '此操作不可撤销',
			'confirm.warningDetail': '会话日志、投影缓存与归档记录都会被永久移除，无法恢复。',
			'confirm.checkbox': '我确认要永久删除以上会话',
			'confirm.cancel': '取消',
			'confirm.action': '永久删除',
			'confirm.busy': '正在删除…',
			'confirm.skipped': '另有 {n} 个会话被跳过',
			'diag.title': '会话管理诊断',
			'diag.subtitle': '只读诊断信息，来自主机 status 接口与客户端端点解析结果。',
			'diag.refresh': '刷新诊断',
			'diag.endpoint': '客户端当前端点',
			'diag.endpoint.none': '（尚未确定）',
			'diag.tried': '已尝试端点',
			'diag.plugin': '插件',
			'diag.version': '版本',
			'diag.capabilities': '能力',
			'diag.config': '配置',
			'diag.roots': '路径',
			'diag.counts': '统计',
			'diag.audit': '审计日志',
			'diag.warnings': '警告',
			'diag.generatedAt': '列表生成时间',
			'diag.home': 'DSH 主目录',
			'diag.persistence': '会话持久化',
			'diag.storages': '存储目录',
			'diag.cache': '投影缓存',
			'diag.items': '条目',
			'diag.archived': '已归档',
			'diag.bytes': '字节数',
			'diag.none': '（无）',
			'diag.unavailable': '主机 status 接口不可用',
			'diag.loading': '正在读取主机状态…',
			'diag.yes': '是',
			'diag.no': '否',
			'reason.invalid-id': '会话 ID 非法',
			'reason.not-found': '未找到会话',
			'reason.not-archived': '会话未归档',
			'reason.live': '会话仍在内存中',
			'reason.running': '会话正在运行',
			'reason.protected': '会话受保护',
			'reason.current': '会话当前已打开',
			'reason.over-batch': '超出单次批量上限',
			'reason.disabled': '插件已禁用删除',
			'reason.dry-run': '演练模式未真正删除',
		};

		/** English fallback, key-complete against {@link zh}. */
		var en = {
			'panelLabel': 'Session manager',
			'settingsLabel': 'Session manager diagnostics',
			'title': 'Session manager',
			'subtitle': 'Manage archived sessions and permanently delete session records',
			'tab.archived': 'Archived',
			'tab.all': 'All',
			'search.placeholder': 'Search title, id or cwd',
			'search.clear': 'Clear search',
			'refresh': 'Refresh',
			'refreshing': 'Refreshing…',
			'loading': 'Loading…',
			'empty.none': 'No sessions',
			'empty.noMatches': 'No matches',
			'empty.hint': 'Switch to “All” to include unarchived sessions.',
			'counts': 'Showing {shown} / {total} sessions',
			'badge.archived': 'Archived',
			'badge.running': 'Running',
			'badge.current': 'Current',
			'badge.live': 'Live',
			'badge.noLog': 'No log',
			'badge.pinned': 'Pinned',
			'row.delete': 'Delete',
			'row.restore': 'Restore',
			'row.release': 'Release',
			'row.release.title': 'Free this session from memory: stop the running turn, keep the log on disk. Deleting becomes possible afterwards.',
			'bulk.selected': '{n} selected',
			'bulk.selectAll': 'Select all',
			'bulk.clear': 'Clear selection',
			'bulk.delete': 'Delete selected ({n})',
			'bulk.restore': 'Restore selected ({n})',
			'bulk.release': 'Release selected ({n})',
			'bulk.hint': 'Tick sessions to delete or restore them in bulk.',
			'select.row': 'Select session {id}',
			'title.untitled': 'Untitled',
			'cwd.none': '(no cwd)',
			'size.unknown': 'unknown',
			'time.now': 'now',
			'time.minutes': '{n} min ago',
			'time.hours': '{n} h ago',
			'time.days': '{n} d ago',
			'time.months': '{n} mo ago',
			'time.years': '{n} y ago',
			'menu.delete': 'Delete session…',
			'menu.delete.notArchived': 'Only archived sessions can be deleted (enable unarchived deletion in the host config)',
			'banner.dismiss': 'Dismiss',
			'list.error.title': 'Host endpoint unavailable',
			'list.stale.title': 'Host endpoint refresh failed',
			'list.error.body': 'Endpoints tried: {endpoints}; error: {message}',
			'list.error.hint': 'Browser-side session rows are still listed below, without host-side size, deletability or authoritative archive data.',
			'notice.deleted': 'Deleted {n} sessions, freed {size}',
			'notice.deleteFailed': 'Delete failed: {message}',
			'notice.restored': 'Restored {n} sessions',
			'notice.restoreFailed': 'Restore failed: {message}',
			'notice.skipped': 'Skipped {n} non-deletable sessions (current or unarchived)',
			'notice.nothingSelected': 'Select at least one session first',
			'notice.nothingReleasable': 'None of the selected sessions need releasing (only sessions still held in memory can be)',
			'notice.released': 'Released {n} sessions; their logs stay on disk',
			'notice.releasedPartly': 'Released {n}, {m} failed',
			'notice.releaseFailed': 'Release failed: {message}',
			'notice.currentOnly': 'The currently open session cannot be deleted; the request was cancelled',
			'confirm.title': 'Permanently delete sessions',
			'confirm.count': 'About to permanently delete {n} sessions',
			'confirm.ids': 'Session ids',
			'confirm.total': 'Total size: {size}',
			'confirm.warning': 'This action cannot be undone',
			'confirm.warningDetail': 'Session logs, projection cache entries and archive records are removed permanently and cannot be restored.',
			'confirm.checkbox': 'I confirm the permanent deletion of these sessions',
			'confirm.cancel': 'Cancel',
			'confirm.action': 'Delete permanently',
			'confirm.busy': 'Deleting…',
			'confirm.skipped': '{n} more sessions were skipped',
			'diag.title': 'Session manager diagnostics',
			'diag.subtitle': 'Read-only diagnostics from the host status op and the client endpoint resolution.',
			'diag.refresh': 'Refresh diagnostics',
			'diag.endpoint': 'Client endpoint',
			'diag.endpoint.none': '(not resolved yet)',
			'diag.tried': 'Endpoints tried',
			'diag.plugin': 'Plugin',
			'diag.version': 'Version',
			'diag.capabilities': 'Capabilities',
			'diag.config': 'Config',
			'diag.roots': 'Roots',
			'diag.counts': 'Counts',
			'diag.audit': 'Audit log',
			'diag.warnings': 'Warnings',
			'diag.generatedAt': 'List generated at',
			'diag.home': 'DSH home',
			'diag.persistence': 'Session persistence',
			'diag.storages': 'Storages',
			'diag.cache': 'Projection cache',
			'diag.items': 'Items',
			'diag.archived': 'Archived',
			'diag.bytes': 'Bytes',
			'diag.none': '(none)',
			'diag.unavailable': 'Host status op unavailable',
			'diag.loading': 'Reading host status…',
			'diag.yes': 'yes',
			'diag.no': 'no',
			'reason.invalid-id': 'Invalid session id',
			'reason.not-found': 'Session not found',
			'reason.not-archived': 'Session is not archived',
			'reason.live': 'Session is still live in memory',
			'reason.running': 'Session is running',
			'reason.protected': 'Session is protected',
			'reason.current': 'Session is currently open',
			'reason.over-batch': 'Over the batch limit',
			'reason.disabled': 'Deletion is disabled by config',
			'reason.dry-run': 'Dry-run did not delete anything',
		};

		/* ================================================================== *
		 * 4. Text helpers
		 * ================================================================== */

		function interpolate(template, params) {
			if (typeof template !== 'string') return '';
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, function (match, name) {
				return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
			});
		}

		/** Dictionary lookup used when a slot hands us no `t` seat at all. */
		function fallbackTranslate(key, params) {
			var template = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
			return interpolate(template, params);
		}

		/**
		 * Wrap a host-provided `t` seat so an unresolved key can never surface as
		 * raw text.
		 *
		 * Slot props hand every plugin the host's `t`, and a host that answers a
		 * lookup it does not know by echoing the key back would otherwise print
		 * `notice.releaseFailed` straight into the UI. An answer equal to the key
		 * asked for counts as a miss, the inline dictionary wins, and a throwing
		 * seat degrades to the same fallback instead of breaking the component.
		 */
		function guardT(t) {
			if (typeof t !== 'function') return fallbackTranslate;
			return function (key, params) {
				var value;
				try {
					value = t(key, params);
				} catch (error) {
					value = null;
				}
				if (typeof value === 'string' && value !== '' && value !== key) return value;
				return fallbackTranslate(key, params);
			};
		}

		function pickT(props) {
			if (props && typeof props.t === 'function') return guardT(props.t);
			return fallbackTranslate;
		}

		function describeError(error) {
			if (error === null || error === undefined) return 'unknown error';
			if (typeof error === 'string') return error;
			if (typeof error.message === 'string' && error.message !== '') return error.message;
			return String(error);
		}

		function toNumber(value) {
			return typeof value === 'number' && isFinite(value) ? value : 0;
		}

		function formatBytes(value) {
			var bytes = toNumber(value);
			if (bytes <= 0) return '0 B';
			var units = ['B', 'KB', 'MB', 'GB', 'TB'];
			var index = 0;
			var scaled = bytes;
			while (scaled >= 1024 && index < units.length - 1) {
				scaled = scaled / 1024;
				index += 1;
			}
			var digits = index === 0 ? 0 : scaled < 10 ? 1 : 0;
			return scaled.toFixed(digits) + ' ' + units[index];
		}

		function relativeTimeBucket(updatedAt, now) {
			var stamp = toNumber(updatedAt);
			if (stamp <= 0) return null;
			var delta = Math.max(0, toNumber(now) - stamp);
			var minutes = Math.floor(delta / 60000);
			if (minutes < 1) return { key: 'time.now', n: 0 };
			if (minutes < 60) return { key: 'time.minutes', n: minutes };
			var hours = Math.floor(minutes / 60);
			if (hours < 24) return { key: 'time.hours', n: hours };
			var days = Math.floor(hours / 24);
			if (days < 30) return { key: 'time.days', n: days };
			var months = Math.floor(days / 30);
			if (months < 12) return { key: 'time.months', n: months };
			return { key: 'time.years', n: Math.floor(months / 12) };
		}

		function relativeTimeText(updatedAt, now, t) {
			var bucket = relativeTimeBucket(updatedAt, now);
			if (bucket === null) return '';
			return bucket.n === 0 ? t(bucket.key) : t(bucket.key, { n: bucket.n });
		}

		function hasOwn(target, key) {
			return Object.prototype.hasOwnProperty.call(target, key);
		}

		function merge(base, patch) {
			var next = {};
			var key;
			for (key in base) if (hasOwn(base, key)) next[key] = base[key];
			for (key in patch) if (hasOwn(patch, key)) next[key] = patch[key];
			return next;
		}

		function scalarText(value, t) {
			if (value === null || value === undefined) return t('diag.none');
			if (typeof value === 'boolean') return value ? t('diag.yes') : t('diag.no');
			if (typeof value === 'number') return isFinite(value) ? String(value) : t('diag.none');
			if (typeof value === 'string') return value === '' ? t('diag.none') : value;
			if (Array.isArray(value)) return value.length === 0 ? t('diag.none') : value.map(function (entry) {
				return scalarText(entry, t);
			}).join(', ');
			try {
				return JSON.stringify(value);
			} catch (error) {
				return String(value);
			}
		}

		/* ================================================================== *
		 * 5. Module-level stores (shared across slots)
		 * ================================================================== */

		/** Minimal listener bus: no DOM, no globals, disposal-friendly. */
		function createBus(initial) {
			var state = initial;
			var listeners = new Set();
			return {
				get: function () {
					return state;
				},
				set: function (next) {
					state = typeof next === 'function' ? next(state) : next;
					var snapshot = [];
					listeners.forEach(function (listener) {
						snapshot.push(listener);
					});
					for (var index = 0; index < snapshot.length; index += 1) {
						try {
							snapshot[index]();
						} catch (error) {
							/* one broken subscriber must not break the bus */
						}
					}
					return state;
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},
			};
		}

		/** Subscribe a component to a bus and read its current value. */
		function useBus(bus) {
			var pair = useState(0);
			var setTick = pair[1];
			useEffect(function () {
				return bus.subscribe(function () {
					setTick(function (value) {
						return value + 1;
					});
				});
			}, [bus]);
			return bus.get();
		}

		var hostBus = createBus({
			status: null,
			list: null,
			error: '',
			statusError: '',
			tried: EMPTY_ARRAY,
			endpoint: '',
			busy: false,
		});
		var removedBus = createBus(new Set());
		var noticeBus = createBus(null);
		var confirmBus = createBus(null);

		var noticeSeq = 0;
		function pushNotice(kind, text, detail) {
			noticeSeq += 1;
			noticeBus.set({ seq: noticeSeq, kind: kind, text: text, detail: detail || '' });
		}

		var confirmSeq = 0;

		/* ================================================================== *
		 * 6. Host transport
		 * ================================================================== */

		/** Endpoint winner cache: resolved once, reused afterwards. */
		var cachedEndpoint = '';

		function endpointOrder() {
			var order = [];
			if (cachedEndpoint !== '') order.push(cachedEndpoint);
			for (var index = 0; index < ENDPOINTS.length; index += 1) {
				if (ENDPOINTS[index] !== cachedEndpoint) order.push(ENDPOINTS[index]);
			}
			return order;
		}

		function requestBody(op, payload) {
			var body = { op: op };
			if (payload) {
				for (var key in payload) if (hasOwn(payload, key)) body[key] = payload[key];
			}
			return body;
		}

		/**
		 * POST one op, trying `api/session-manager` and then `session-manager/api`.
		 * HTTP 404/405 and network failures advance to the next endpoint; the
		 * winner is cached. Never throws — failures return `{ ok: false }`.
		 */
		async function callHost(op, payload) {
			var order = endpointOrder();
			var failure = '';
			var fetchImpl = typeof fetch === 'function' ? fetch : null;
			if (fetchImpl === null) {
				return { ok: false, endpoint: '', error: 'fetch is unavailable in this environment', tried: order, body: null };
			}
			for (var index = 0; index < order.length; index += 1) {
				var url = order[index];
				var response = null;
				try {
					response = await fetchImpl(url, {
						method: 'POST',
						credentials: 'same-origin',
						cache: 'no-store',
						headers: {
							'content-type': 'application/json',
							'x-dsh-session-manager': '1',
						},
						body: JSON.stringify(requestBody(op, payload)),
					});
				} catch (error) {
					failure = describeError(error);
					continue;
				}
				if (response.status === 404 || response.status === 405) {
					failure = 'HTTP ' + String(response.status);
					continue;
				}
				if (response.ok !== true) {
					return { ok: false, endpoint: url, error: 'HTTP ' + String(response.status), tried: order, body: null };
				}
				var parsed = null;
				try {
					parsed = await response.json();
				} catch (error) {
					return { ok: false, endpoint: url, error: 'response was not valid JSON', tried: order, body: null };
				}
				cachedEndpoint = url;
				return { ok: true, endpoint: url, error: '', tried: order, body: parsed };
			}
			return { ok: false, endpoint: '', error: failure === '' ? 'no endpoint responded' : failure, tried: order, body: null };
		}

		var refreshInFlight = null;

		/** Fetch `status` + `list` and publish them; safe to call anywhere. */
		function refreshHost() {
			if (refreshInFlight !== null) return refreshInFlight;
			hostBus.set(function (state) {
				return merge(state, { busy: true });
			});
			refreshInFlight = (async function () {
				var statusResult = await callHost('status', EMPTY_OBJECT);
				var listResult = await callHost('list', { includeUnarchived: true });
				hostBus.set(function (state) {
					return merge(state, {
						busy: false,
						status: statusResult.ok ? statusResult.body : state.status,
						statusError: statusResult.ok ? '' : statusResult.error,
						list: listResult.ok ? listResult.body : state.list,
						error: listResult.ok ? '' : listResult.error,
						tried: listResult.tried.length > 0 ? listResult.tried : statusResult.tried,
						endpoint: listResult.endpoint !== '' ? listResult.endpoint : statusResult.endpoint !== '' ? statusResult.endpoint : state.endpoint,
					});
				});
				refreshInFlight = null;
				return listResult;
			})();
			return refreshInFlight;
		}

		function safeRefreshHost() {
			try {
				var pending = refreshHost();
				if (pending && typeof pending.catch === 'function') {
					pending.catch(function () {
						/* refreshHost already reports failures through the bus */
					});
				}
			} catch (error) {
				/* never let a refresh attempt escape */
			}
		}

		/** `api-session/removed` relay: prune client rows without a re-fetch. */
		function onHostSessionRemoved(id) {
			if (typeof id !== 'string' || id === '') return;
			markRemoved([id]);
			safeRefreshHost();
		}

		async function deleteSessions(ids, dryRun) {
			return callHost('delete', { ids: ids, dryRun: dryRun === true });
		}

		async function restoreSessions(ids) {
			return callHost('restore', { ids: ids });
		}

		/**
		 * Free the in-memory copies of sessions, keeping their logs on disk.
		 *
		 * This is what unblocks a `live`/`running` row: the Host stops the running
		 * turn and drops the session from its store, after which the row becomes
		 * deletable on its own merits. Nothing on disk is touched, so the list is
		 * re-fetched rather than the row being dropped locally.
		 * @param ids - session ids to release.
		 * @param currentSessionId - the open session, which the Host refuses to release.
		 * @returns the same shape every other op returns.
		 */
		async function releaseSessions(ids, currentSessionId) {
			return callHost('release', {
				ids: ids,
				currentSessionId: typeof currentSessionId === 'string' ? currentSessionId : '',
			});
		}

		function markRemoved(ids) {
			if (!ids || ids.length === 0) return;
			removedBus.set(function (current) {
				var next = new Set(current);
				for (var index = 0; index < ids.length; index += 1) next.add(ids[index]);
				return next;
			});
		}

		var REASON_KEYS = Object.freeze({
			'invalid-id': 'reason.invalid-id',
			'not-found': 'reason.not-found',
			'not-archived': 'reason.not-archived',
			'live': 'reason.live',
			'running': 'reason.running',
			'protected': 'reason.protected',
			'current': 'reason.current',
			'over-batch': 'reason.over-batch',
			'disabled': 'reason.disabled',
			'dry-run': 'reason.dry-run',
		});

		function reasonText(t, code) {
			if (typeof code !== 'string' || code === '') return '';
			if (hasOwn(REASON_KEYS, code)) return t(REASON_KEYS[code]);
			return code;
		}

		/* ================================================================== *
		 * 7. Row derivation — client rows merged with the host `list` payload
		 * ================================================================== */

		/** Stable hook fallbacks: the hook COUNT never changes between renders. */
		function fallbackSessions(selector) {
			return typeof selector === 'function' ? selector(EMPTY_SESSIONS) : EMPTY_SESSIONS;
		}

		function fallbackWorkspaces(selector) {
			return typeof selector === 'function' ? selector(EMPTY_WORKSPACES) : EMPTY_WORKSPACES;
		}

		var MENU_CLOSED = Object.freeze([false, function () {}]);

		function fallbackMenuOpenState() {
			return MENU_CLOSED;
		}

		function selectSelf(state) {
			return state;
		}

		function buildIndex(input) {
			var sessions = input && input.sessions ? input.sessions : null;
			var workspaces = input && input.workspaces ? input.workspaces : null;
			var list = input && input.list ? input.list : null;
			var status = input && input.status ? input.status : null;
			var removed = input && input.removed instanceof Set ? input.removed : null;

			var byId = {};
			var ids = [];

			function ensure(id) {
				if (!hasOwn(byId, id)) {
					byId[id] = {
						id: id,
						title: '',
						cwd: '',
						updatedAt: 0,
						clientRunning: false,
						clientCurrent: false,
						clientKnown: false,
						host: null,
					};
					ids.push(id);
				}
				return byId[id];
			}

			if (sessions && sessions.byId && typeof sessions.byId === 'object') {
				var sourceIds = Array.isArray(sessions.ids) && sessions.ids.length > 0 ? sessions.ids : Object.keys(sessions.byId);
				for (var index = 0; index < sourceIds.length; index += 1) {
					var id = sourceIds[index];
					var summary = sessions.byId[id];
					if (!summary) continue;
					var row = ensure(id);
					row.clientKnown = true;
					var title = typeof summary.displayTitle === 'string' && summary.displayTitle !== '' ? summary.displayTitle : summary.title;
					row.title = typeof title === 'string' ? title : '';
					row.cwd = typeof summary.cwd === 'string' ? summary.cwd : '';
					row.updatedAt = toNumber(summary.updatedAt);
					row.clientRunning = summary.running === true;
					row.clientCurrent = !!(summary.retainedBy && toNumber(summary.retainedBy.mainView) > 0);
				}
			}

			var hostItems = list && Array.isArray(list.items) ? list.items : EMPTY_ARRAY;
			for (var itemIndex = 0; itemIndex < hostItems.length; itemIndex += 1) {
				var item = hostItems[itemIndex];
				if (!item || typeof item.id !== 'string' || item.id === '') continue;
				ensure(item.id).host = item;
			}

			var archivedIds = list && Array.isArray(list.archivedIds)
				? list.archivedIds
				: workspaces && Array.isArray(workspaces.archivedSessionIds)
					? workspaces.archivedSessionIds
					: EMPTY_ARRAY;

			return {
				byId: byId,
				ids: ids,
				archivedSet: new Set(archivedIds),
				removed: removed,
				allowUnarchived: !!(status && status.config && status.config.allowDeleteUnarchived === true),
			};
		}

		function projectRow(index, id) {
			if (index.removed !== null && index.removed.has(id)) return null;
			var base = hasOwn(index.byId, id) ? index.byId[id] : null;
			if (base === null) return null;
			var host = base.host;

			var archived = host && typeof host.archived === 'boolean' ? host.archived : index.archivedSet.has(id);
			var live = host && typeof host.live === 'boolean' ? host.live : base.clientRunning;
			var running = host && typeof host.running === 'boolean' ? host.running : base.clientRunning;
			var current = host && typeof host.current === 'boolean' ? host.current : base.clientCurrent;
			var pinned = host && typeof host.pinned === 'boolean' ? host.pinned : false;

			var bytes = 0;
			if (host) {
				bytes = typeof host.bytes === 'number' && isFinite(host.bytes)
					? host.bytes
					: toNumber(host.logBytes) + toNumber(host.cacheBytes) + toNumber(host.extraBytes);
			}

			var noLog = false;
			if (host) {
				var hasLog = Array.isArray(host.files) ? host.files.length > 0 : toNumber(host.logBytes) > 0 || bytes > 0;
				noLog = !hasLog;
			}

			var skipReason = null;
			if (host && typeof host.deletable === 'boolean') {
				skipReason = typeof host.skipReason === 'string' && host.skipReason !== '' ? host.skipReason : host.deletable ? null : 'disabled';
			} else if (current) {
				skipReason = 'current';
			} else if (running) {
				skipReason = 'running';
			} else if (live) {
				skipReason = 'live';
			} else if (!archived && index.allowUnarchived !== true) {
				skipReason = 'not-archived';
			}

			/* The currently open session must be impossible to delete from the UI. */
			if (current) skipReason = 'current';
			var deletable = host && typeof host.deletable === 'boolean' && !current ? host.deletable === true : skipReason === null;

			// "Release" frees the in-memory session while the log stays on disk, so it is
			// offered exactly where a delete is refused for being live or running — never
			// for the open session, which must stay attached to the running UI.
			var releasable = false;
			if (host && typeof host.releasable === 'boolean') releasable = host.releasable;
			else releasable = (live || running) && !current;

			return {
				id: id,
				title: base.title,
				cwd: base.cwd,
				updatedAt: base.updatedAt,
				archived: archived === true,
				pinned: pinned === true,
				live: live === true,
				running: running === true,
				current: current === true,
				bytes: bytes,
				noLog: noLog,
				deletable: deletable,
				skipReason: deletable ? null : skipReason,
				// Only the Host knows whether the store still holds this session, so
				// honour its `releasable` flag and fall back to the visible flags.
				releasable: releasable,
				clientKnown: base.clientKnown,
				hostKnown: host !== null,
				path: host && typeof host.path === 'string' ? host.path : '',
				project: host && typeof host.project === 'string' ? host.project : '',
			};
		}

		function deriveRows(input) {
			var index = buildIndex(input);
			var rows = [];
			for (var position = 0; position < index.ids.length; position += 1) {
				var row = projectRow(index, index.ids[position]);
				if (row !== null) rows.push(row);
			}
			rows.sort(function (left, right) {
				var delta = toNumber(right.updatedAt) - toNumber(left.updatedAt);
				if (delta !== 0) return delta;
				return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
			});
			return rows;
		}

		function deriveRow(input, id) {
			if (typeof id !== 'string' || id === '') return null;
			return projectRow(buildIndex(input), id);
		}

		function matchesQuery(row, needle) {
			return row.id.toLowerCase().indexOf(needle) !== -1
				|| row.title.toLowerCase().indexOf(needle) !== -1
				|| row.cwd.toLowerCase().indexOf(needle) !== -1;
		}

		function filterRows(rows, tab, query) {
			var needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
			var out = [];
			for (var index = 0; index < rows.length; index += 1) {
				var row = rows[index];
				if (tab === 'archived' && row.archived !== true) continue;
				if (needle !== '' && !matchesQuery(row, needle)) continue;
				out.push(row);
			}
			return out;
		}

		function rowsForIds(rows, ids) {
			var wanted = new Set(ids);
			var out = [];
			for (var index = 0; index < rows.length; index += 1) {
				if (wanted.has(rows[index].id)) out.push(rows[index]);
			}
			return out;
		}

		/* ================================================================== *
		 * 8. Theme tokens + inline styles (inline style objects only)
		 * ================================================================== */

		function token(name, fallback) {
			return 'var(--dsw-alias-' + name + ', ' + fallback + ')';
		}

		var C = {
			text: token('label-primary', '#e6e6e6'),
			textSecondary: token('label-secondary', '#b8b8bd'),
			textTertiary: token('label-tertiary', '#8d8d94'),
			caption: token('label-caption', '#7c7c85'),
			dimmed: token('label-dimmed', '#6a6a72'),
			bgBase: token('bg-base', '#151517'),
			bg1: token('bg-layer-1', '#1c1c1f'),
			bg2: token('bg-layer-2', '#232327'),
			bg3: token('bg-layer-3', '#2a2a2f'),
			platform: token('bg-module-platform', '#232327'),
			skeleton: token('bg-skeleton', 'rgba(255,255,255,0.06)'),
			border1: token('border-l1', 'rgba(255,255,255,0.08)'),
			border2: token('border-l2', 'rgba(255,255,255,0.14)'),
			border3: token('border-l3', 'rgba(255,255,255,0.2)'),
			border4: token('border-l4', 'rgba(255,255,255,0.28)'),
			brand: token('brand-primary', '#4d6bfe'),
			link: token('link', '#7d95ff'),
			danger: token('state-error-primary', '#f2555a'),
			warn: token('state-warn-primary', '#e0912a'),
			warnLabel: token('state-warn-label', '#e0912a'),
			warn3: token('state-warn-tertiary', 'rgba(224,145,42,0.22)'),
			success: token('state-success-primary', '#3fb950'),
			success2: token('state-success-secondary', '#2ea043'),
			business: token('state-business-primary', '#4d6bfe'),
			hover: token('interactive-bg-hover', 'rgba(255,255,255,0.06)'),
			hoverDanger: token('interactive-bg-hover-danger', 'rgba(242,85,90,0.14)'),
			primaryFill: token('button-primary-fill', '#4d6bfe'),
			primaryHover: token('button-primary-hover', '#5f7bff'),
			ghostFill: token('button-ghost-active-fill', 'rgba(255,255,255,0.08)'),
			ghostBorder: token('button-ghost-active-border', 'rgba(255,255,255,0.16)'),
			elevated: token('button-elevated-fill', '#2b2b31'),
			scrollbar: token('scrollbar-bg-l2', 'rgba(255,255,255,0.16)'),
			scrollbarHover: token('scrollbar-hover-l2', 'rgba(255,255,255,0.3)'),
		};

		var ellipsis = {
			minWidth: 0,
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
		};

		var styles = {
			page: {
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				minWidth: 0,
				height: '100%',
				maxHeight: '100%',
				boxSizing: 'border-box',
				background: C.bgBase,
				color: C.text,
				fontSize: '13px',
				lineHeight: '1.45',
			},
			header: {
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				padding: '12px 12px 8px 12px',
				borderBottom: '1px solid ' + C.border1,
				minWidth: 0,
			},
			titleRow: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				flexWrap: 'wrap',
				minWidth: 0,
			},
			title: Object.assign({
				fontSize: '15px',
				fontWeight: 600,
				color: C.text,
				margin: 0,
			}, ellipsis),
			subtitle: Object.assign({
				fontSize: '12px',
				color: C.textTertiary,
			}, ellipsis),
			controls: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				flexWrap: 'wrap',
				minWidth: 0,
			},
			search: {
				flex: '1 1 auto',
				minWidth: 0,
				boxSizing: 'border-box',
				padding: '5px 8px',
				borderRadius: '6px',
				border: '1px solid ' + C.border2,
				background: C.bg1,
				color: C.text,
				fontSize: '12px',
			},
			body: {
				flex: '1 1 auto',
				overflowY: 'auto',
				overflowX: 'hidden',
				minWidth: 0,
				minHeight: 0,
				padding: '0 0 24px 0',
			},
			banner: {
				display: 'flex',
				alignItems: 'flex-start',
				gap: '8px',
				margin: '8px 12px 0 12px',
				padding: '8px 10px',
				borderRadius: '6px',
				border: '1px solid ' + C.border2,
				background: C.bg1,
				minWidth: 0,
			},
			bannerText: {
				flex: '1 1 auto',
				minWidth: 0,
				overflowWrap: 'anywhere',
			},
			bannerTitle: {
				fontWeight: 600,
				color: C.text,
			},
			bannerBody: {
				color: C.textSecondary,
				fontSize: '12px',
				overflowWrap: 'anywhere',
			},
			row: {
				display: 'flex',
				alignItems: 'flex-start',
				gap: '8px',
				flexWrap: 'wrap',
				padding: '8px 12px',
				borderBottom: '1px solid ' + C.border1,
				minWidth: 0,
			},
			rowMain: {
				flex: '1 1 auto',
				display: 'flex',
				flexDirection: 'column',
				gap: '3px',
				minWidth: 0,
			},
			rowTop: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				flexWrap: 'wrap',
				minWidth: 0,
			},
			rowTitle: Object.assign({
				fontSize: '13px',
				color: C.text,
			}, ellipsis),
			rowMeta: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				flexWrap: 'wrap',
				fontSize: '11px',
				color: C.textTertiary,
				minWidth: 0,
			},
			metaItem: Object.assign({
				color: C.textTertiary,
			}, ellipsis),
			metaId: {
				color: C.dimmed,
				minWidth: 0,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
				maxWidth: '100%',
			},
			rowActions: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				flexWrap: 'wrap',
				flex: '0 0 auto',
			},
			badges: {
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
				flexWrap: 'wrap',
				minWidth: 0,
			},
			badge: {
				display: 'inline-block',
				padding: '1px 6px',
				borderRadius: '999px',
				border: '1px solid ' + C.border2,
				color: C.textSecondary,
				background: C.bg2,
				fontSize: '10px',
				whiteSpace: 'nowrap',
			},
			empty: {
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: '4px',
				padding: '32px 16px',
				color: C.textTertiary,
				textAlign: 'center',
			},
			bulkBar: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				flexWrap: 'wrap',
				padding: '8px 12px',
				borderBottom: '1px solid ' + C.border1,
				background: C.bg1,
				minWidth: 0,
			},
			tabStrip: {
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
				padding: '2px',
				borderRadius: '8px',
				border: '1px solid ' + C.border1,
				background: C.bg1,
			},
			backdrop: {
				position: 'fixed',
				inset: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '16px',
				background: 'rgba(0,0,0,0.55)',
				zIndex: 90,
				boxSizing: 'border-box',
			},
			dialog: {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				width: '100%',
				maxWidth: '560px',
				maxHeight: '100%',
				overflowY: 'auto',
				minWidth: 0,
				boxSizing: 'border-box',
				padding: '16px',
				borderRadius: '10px',
				border: '1px solid ' + C.border3,
				background: C.bg2,
				color: C.text,
				boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
			},
			dialogTitle: {
				fontSize: '15px',
				fontWeight: 600,
				color: C.text,
			},
			warning: {
				display: 'flex',
				flexDirection: 'column',
				gap: '2px',
				padding: '8px 10px',
				borderRadius: '6px',
				border: '1px solid ' + C.danger,
				background: C.hoverDanger,
				color: C.danger,
				fontWeight: 600,
			},
			idList: {
				listStyle: 'none',
				margin: 0,
				padding: '6px 8px',
				borderRadius: '6px',
				border: '1px solid ' + C.border1,
				background: C.bg1,
				maxHeight: '180px',
				overflowY: 'auto',
				minWidth: 0,
			},
			idItem: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				minWidth: 0,
				padding: '2px 0',
			},
			idCode: Object.assign({
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
				fontSize: '11px',
				color: C.textSecondary,
				flex: '1 1 auto',
			}, ellipsis),
			idSize: {
				flex: '0 0 auto',
				fontSize: '11px',
				color: C.textTertiary,
			},
			checkboxRow: {
				display: 'flex',
				alignItems: 'flex-start',
				gap: '6px',
				color: C.textSecondary,
				fontSize: '12px',
				minWidth: 0,
			},
			dialogActions: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'flex-end',
				gap: '8px',
				flexWrap: 'wrap',
				minWidth: 0,
			},
			diagSection: {
				display: 'flex',
				flexDirection: 'column',
				gap: '6px',
				padding: '9px 12px',
				borderRadius: '8px',
				border: '1px solid ' + C.border1,
				background: C.bg1,
				minWidth: 0,
			},
			diagHeading: {
				fontSize: '12px',
				fontWeight: 600,
				color: C.text,
				minWidth: 0,
			},
			diagRow: {
				display: 'flex',
				alignItems: 'baseline',
				gap: '8px',
				minWidth: 0,
			},
			diagLabel: {
				flex: '0 0 auto',
				color: C.textTertiary,
				fontSize: '11px',
			},
			diagValue: Object.assign({
				flex: '1 1 auto',
				color: C.textSecondary,
				fontSize: '11px',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
			}, ellipsis),
			diagValueScalar: {
				flex: '1 1 auto',
				color: C.textSecondary,
				fontSize: '11px',
				minWidth: 0,
				overflowWrap: 'anywhere',
			},
			diagBody: {
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				padding: '12px',
				minWidth: 0,
				overflowY: 'auto',
			},
			icon: {
				display: 'block',
			},
			spacer: {
				flex: '1 1 auto',
				minWidth: 0,
			},
		};

		function buttonStyle(kind, disabled) {
			var base = {
				boxSizing: 'border-box',
				padding: '4px 10px',
				borderRadius: '6px',
				fontSize: '12px',
				lineHeight: '1.6',
				cursor: disabled ? 'not-allowed' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				whiteSpace: 'nowrap',
				fontFamily: 'inherit',
			};
			if (kind === 'primary') {
				base.border = '1px solid transparent';
				base.background = C.primaryFill;
				base.color = '#ffffff';
			} else if (kind === 'danger') {
				base.border = '1px solid ' + C.danger;
				base.background = C.hoverDanger;
				base.color = C.danger;
			} else {
				base.border = '1px solid ' + C.border2;
				base.background = C.bg2;
				base.color = C.text;
			}
			if (disabled) {
				base.background = C.bg2;
				base.color = C.textTertiary;
				base.border = '1px solid ' + C.border1;
			}
			return base;
		}

		function tabStyle(active) {
			return {
				boxSizing: 'border-box',
				padding: '3px 10px',
				borderRadius: '6px',
				border: '1px solid ' + (active ? C.ghostBorder : 'transparent'),
				background: active ? C.ghostFill : 'transparent',
				color: active ? C.text : C.textTertiary,
				fontSize: '12px',
				cursor: 'pointer',
				whiteSpace: 'nowrap',
				fontFamily: 'inherit',
			};
		}

		/* ================================================================== *
		 * 9. Small shared components
		 * ================================================================== */

		function Badge(props) {
			var style = Object.assign({}, styles.badge, props.tone ? { borderColor: props.tone, color: props.tone } : null);
			return h('span', { style: style }, props.label);
		}

		/** Inline banner: never depends on a Toast service. */
		function Banner(props) {
			var t = props.t;
			var tones = {
				error: C.danger,
				warning: C.warnLabel,
				success: C.success,
				info: C.textSecondary,
			};
			var tone = tones[props.kind] || C.textSecondary;
			return h('div', { style: Object.assign({}, styles.banner, { borderColor: tone }) },
				h('div', { style: styles.bannerText },
					props.title ? h('div', { style: Object.assign({}, styles.bannerTitle, { color: tone }) }, props.title) : null,
					props.text ? h('div', { style: styles.bannerBody }, props.text) : null,
					props.hint ? h('div', { style: styles.bannerBody }, props.hint) : null),
				props.onDismiss ? h('button', {
					type: 'button',
					style: buttonStyle('ghost', false),
					'aria-label': t('banner.dismiss'),
					onClick: props.onDismiss,
				}, t('banner.dismiss')) : null);
		}

		/* ================================================================== *
		 * 10. `sidebar.panellist` occupant — inline SVG icon
		 * ================================================================== */

		function PanelIcon(props) {
			var size = toNumber(props && props.size);
			if (size <= 0) size = 16;
			var active = !!(props && props.active);
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 16 16',
				fill: 'none',
				style: Object.assign({}, styles.icon, { color: active ? C.brand : 'currentColor' }),
				'aria-hidden': 'true',
				focusable: 'false',
			},
				h('path', {
					d: 'M2 3.5h12M2 3.5v9h12v-9',
					stroke: 'currentColor',
					strokeWidth: 1.2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
				h('path', {
					d: 'M6 3.5v9',
					stroke: 'currentColor',
					strokeWidth: 1.2,
					strokeLinecap: 'round',
				}),
				h('path', {
					d: 'M8 6.2h4M8 8.4h4M8 10.6h2.5',
					stroke: 'currentColor',
					strokeWidth: 1.2,
					strokeLinecap: 'round',
				}));
		}

		/* ================================================================== *
		 * 11. `main` occupant — the manager page
		 * ================================================================== */

		function SessionRow(props) {
			var t = props.t;
			var row = props.row;
			var now = props.now;
			var selected = props.selected === true;
			var badges = [];
			if (row.archived) badges.push(h(Badge, { key: 'archived', label: t('badge.archived'), tone: C.success }));
			if (row.running) badges.push(h(Badge, { key: 'running', label: t('badge.running'), tone: C.warnLabel }));
			if (row.current) badges.push(h(Badge, { key: 'current', label: t('badge.current'), tone: C.brand }));
			if (row.live && !row.running) badges.push(h(Badge, { key: 'live', label: t('badge.live'), tone: C.business }));
			if (row.pinned) badges.push(h(Badge, { key: 'pinned', label: t('badge.pinned') }));
			if (row.noLog) badges.push(h(Badge, { key: 'noLog', label: t('badge.noLog'), tone: C.textTertiary }));

			var timeText = relativeTimeText(row.updatedAt, now, t);
			var sizeText = row.hostKnown ? formatBytes(row.bytes) : t('size.unknown');
			var titleText = row.title === '' ? t('title.untitled') : row.title;
			var cwdText = row.cwd === '' ? t('cwd.none') : row.cwd;

			return h('div', { style: styles.row, 'data-session-id': row.id },
				h('input', {
					type: 'checkbox',
					style: { flex: '0 0 auto', marginTop: '2px', accentColor: C.brand },
					checked: selected,
					disabled: row.deletable !== true,
					'aria-label': t('select.row', { id: row.id }),
					onChange: function () {
						props.onToggle(row);
					},
				}),
				h('div', { style: styles.rowMain },
					h('div', { style: styles.rowTop },
						h('span', { style: styles.rowTitle, title: titleText }, titleText),
						badges.length > 0 ? h('span', { style: styles.badges }, badges) : null),
					h('div', { style: styles.rowMeta },
						h('span', { style: styles.metaItem, title: row.cwd }, cwdText),
						h('span', { style: styles.metaId, title: row.id }, row.id),
						timeText === '' ? null : h('span', { style: styles.metaItem }, timeText),
						h('span', { style: styles.metaItem }, sizeText),
						row.deletable !== true && row.skipReason ? h('span', { style: Object.assign({}, styles.metaItem, { color: C.warnLabel }) }, reasonText(t, row.skipReason)) : null)) ,
				h('div', { style: styles.rowActions },
					row.releasable === true ? h('button', {
						type: 'button',
						style: buttonStyle('ghost', false),
						title: t('row.release.title'),
						onClick: function () {
							props.onRelease([row.id]);
						},
					}, t('row.release')) : null,
					h('button', {
						type: 'button',
						style: buttonStyle('danger', row.deletable !== true),
						disabled: row.deletable !== true,
						title: row.deletable !== true ? reasonText(t, row.skipReason) : t('row.delete'),
						onClick: function () {
							props.onDelete([row.id]);
						},
					}, t('row.delete')),
					row.archived ? h('button', {
						type: 'button',
						style: buttonStyle('ghost', false),
						onClick: function () {
							props.onRestore([row.id]);
						},
					}, t('row.restore')) : null));
		}

		function SessionManagerPage(props) {
			var t = pickT(props);

			var useSessionsHook = props && typeof props.useSessions === 'function' ? props.useSessions : fallbackSessions;
			var useWorkspacesHook = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : fallbackWorkspaces;

			var sessions = useSessionsHook(selectSelf);
			var workspaces = useWorkspacesHook(selectSelf);
			var host = useBus(hostBus);
			var removed = useBus(removedBus);
			var notice = useBus(noticeBus);

			var tabPair = useState('archived');
			var tab = tabPair[0];
			var setTab = tabPair[1];

			var queryPair = useState('');
			var query = queryPair[0];
			var setQuery = queryPair[1];

			var selectedPair = useState(EMPTY_ARRAY);
			var selected = selectedPair[0];
			var setSelected = selectedPair[1];

			var nowPair = useState(function () {
				return Date.now();
			});
			var now = nowPair[0];
			var setNow = nowPair[1];

			useEffect(function () {
				var timer = setInterval(function () {
					setNow(Date.now());
				}, 30000);
				return function () {
					clearInterval(timer);
				};
			}, []);

			var allRows = useMemo(function () {
				return deriveRows({
					sessions: sessions,
					workspaces: workspaces,
					list: host.list,
					status: host.status,
					removed: removed,
				});
			}, [sessions, workspaces, host.list, host.status, removed]);

			var visible = useMemo(function () {
				return filterRows(allRows, tab, query);
			}, [allRows, tab, query]);

			var selectedIds = useMemo(function () {
				var live = new Set();
				for (var index = 0; index < allRows.length; index += 1) live.add(allRows[index].id);
				var out = [];
				for (var position = 0; position < selected.length; position += 1) {
					if (live.has(selected[position])) out.push(selected[position]);
				}
				return out;
			}, [allRows, selected]);

			var selectedRows = useMemo(function () {
				return rowsForIds(allRows, selectedIds);
			}, [allRows, selectedIds]);

			// The subset of the selection that is still in memory and can therefore be
			// released. A selection made on another tab may contain rows that cannot.
			var releasableSelected = useMemo(function () {
				var out = [];
				for (var index = 0; index < selectedIds.length; index += 1) {
					for (var scan = 0; scan < allRows.length; scan += 1) {
						if (allRows[scan].id !== selectedIds[index]) continue;
						if (allRows[scan].releasable === true) out.push(selectedIds[index]);
						break;
					}
				}
				return out;
			}, [allRows, selectedIds]);

			function requestDelete(ids, rows) {
				var provided = rows && rows.length > 0 ? rows : rowsForIds(allRows, ids);
				var deletable = [];
				var skipped = 0;
				for (var index = 0; index < provided.length; index += 1) {
					var row = provided[index];
					if (row.current === true) {
						skipped += 1;
						continue;
					}
					if (row.deletable !== true) {
						skipped += 1;
						continue;
					}
					deletable.push(row);
				}
				if (deletable.length === 0) {
					pushNotice('warning', provided.length > 0 && skipped === provided.length && provided[0].current === true ? t('notice.currentOnly') : t('notice.skipped', { n: skipped }));
					return;
				}
				if (skipped > 0) pushNotice('warning', t('notice.skipped', { n: skipped }));
				var idsToDelete = [];
				for (var position = 0; position < deletable.length; position += 1) idsToDelete.push(deletable[position].id);
				confirmSeq += 1;
				confirmBus.set({ seq: confirmSeq, ids: idsToDelete, rows: deletable });
			}

			/** The id of the session the main view currently holds, or '' when it is unknown. */
		function openSessionId() {
			var store = sessions && sessions.byId && typeof sessions.byId === 'object' ? sessions.byId : null;
			if (store === null) return '';
			var ids = Array.isArray(sessions.ids) && sessions.ids.length > 0 ? sessions.ids : Object.keys(store);
			for (var index = 0; index < ids.length; index += 1) {
				var summary = store[ids[index]];
				if (summary && summary.retainedBy && toNumber(summary.retainedBy.mainView) > 0) return ids[index];
			}
			return '';
		}

		function releaseRows(ids) {
			if (!ids || ids.length === 0) {
				pushNotice('info', t('notice.nothingSelected'));
				return;
			}
			if (host.busy === true) return;
			var releasable = [];
			var refused = 0;
			for (var index = 0; index < visible.length; index += 1) {
				if (ids.indexOf(visible[index].id) === -1) continue;
				if (visible[index].releasable === true) releasable.push(visible[index].id);
				else refused += 1;
			}
			if (refused > 0) pushNotice('warning', t('notice.skipped', { n: refused }));
			if (releasable.length === 0) {
				pushNotice('warning', t('notice.nothingReleasable'));
				return;
			}
			hostBus.set(function (state) {
				return merge(state, { busy: true });
			});
			releaseSessions(releasable, openSessionId()).then(function (result) {
				hostBus.set(function (state) {
					return merge(state, { busy: false });
				});
				if (result.ok !== true) {
					// `release-disabled` and `sessions-unavailable` are configuration answers
					// rather than per-row failures, so they get their own wording.
					var reason = result.body && typeof result.body.error === 'string' && result.body.error !== ''
						? result.body.error
						: result.error;
					pushNotice('error', t('notice.releaseFailed', { message: reason }));
					return;
				}
				var body = result.body || {};
				var done = Array.isArray(body.released) ? body.released.length : releasable.length;
				if (Array.isArray(body.failedIds) && body.failedIds.length > 0) {
					pushNotice('warning', t('notice.releasedPartly', { n: done, m: body.failedIds.length }));
				} else {
					pushNotice('success', t('notice.released', { n: done }));
				}
				// Nothing was deleted, so the rows stay; they just lose their live/running
				// badges and their delete button enables. A re-read is the honest way.
				safeRefreshHost();
			}, function (error) {
				hostBus.set(function (state) {
					return merge(state, { busy: false });
				});
				pushNotice('error', t('notice.releaseFailed', { message: describeError(error) }));
			});
		}

		function restoreRows(ids) {
				if (!ids || ids.length === 0) {
					pushNotice('info', t('notice.nothingSelected'));
					return;
				}
				restoreSessions(ids).then(function (result) {
					if (result.ok !== true) {
						pushNotice('error', t('notice.restoreFailed', { message: result.error }));
						return;
					}
					var body = result.body || {};
					var restored = Array.isArray(body.results) ? body.results.filter(function (entry) {
						return entry && entry.ok === true;
					}).length : ids.length;
					removedBus.set(function (current) {
						var next = new Set(current);
						for (var index = 0; index < ids.length; index += 1) next.delete(ids[index]);
						return next;
					});
					pushNotice('success', t('notice.restored', { n: restored }));
					safeRefreshHost();
				}, function (error) {
					pushNotice('error', t('notice.restoreFailed', { message: describeError(error) }));
				});
			}

			function toggleRow(row) {
				setSelected(function (current) {
					var next = [];
					var found = false;
					for (var index = 0; index < current.length; index += 1) {
						if (current[index] === row.id) {
							found = true;
							continue;
						}
						next.push(current[index]);
					}
					if (!found) next.push(row.id);
					return next;
				});
			}

			function toggleAll() {
				var selectable = [];
				for (var index = 0; index < visible.length; index += 1) {
					if (visible[index].deletable === true) selectable.push(visible[index].id);
				}
				if (selectedIds.length >= selectable.length && selectable.length > 0) {
					setSelected(EMPTY_ARRAY);
					return;
				}
				setSelected(selectable);
			}

			var banners = [];
			if (notice !== null) {
				banners.push(h(Banner, {
					key: 'notice',
					t: t,
					kind: notice.kind,
					text: notice.text,
					hint: notice.detail,
					onDismiss: function () {
						noticeBus.set(null);
					},
				}));
			}
			if (host.error !== '' || host.statusError !== '') {
				var endpointsText = host.tried.length > 0 ? host.tried.join(', ') : ENDPOINTS.join(', ');
				banners.push(h(Banner, {
					key: 'host',
					t: t,
					kind: host.list ? 'warning' : 'error',
					title: host.list ? t('list.stale.title') : t('list.error.title'),
					text: t('list.error.body', { endpoints: endpointsText, message: host.error !== '' ? host.error : host.statusError }),
					hint: host.list ? '' : t('list.error.hint'),
				}));
			}

			var body = null;
			if (host.busy && host.list === null && visible.length === 0) {
				body = h('div', { style: styles.empty }, h('div', null, t('loading')));
			} else if (visible.length === 0) {
				body = h('div', { style: styles.empty },
					h('div', null, query.trim() === '' ? t('empty.none') : t('empty.noMatches')),
					h('div', { style: { fontSize: '11px', color: C.dimmed } }, t('empty.hint')));
			} else {
				body = h(Fragment, null, visible.map(function (row) {
					return h(SessionRow, {
						key: row.id,
						t: t,
						row: row,
						now: now,
						selected: selectedIds.indexOf(row.id) !== -1,
						onToggle: toggleRow,
						onDelete: function (ids) {
							requestDelete(ids, rowsForIds(allRows, ids));
						},
						onRelease: releaseRows,
						onRestore: restoreRows,
					});
				}));
			}

			var archiveCount = 0;
			for (var scan = 0; scan < allRows.length; scan += 1) if (allRows[scan].archived === true) archiveCount += 1;

			return h('div', { style: styles.page },
				h('div', { style: styles.header },
					h('div', { style: styles.titleRow },
						h('h1', { style: styles.title }, t('title')),
						h('span', { style: styles.spacer }),
						h('span', { style: styles.subtitle }, t('counts', { shown: visible.length, total: allRows.length }))),
					h('div', { style: styles.subtitle }, t('subtitle')),
					h('div', { style: styles.controls },
						h('div', { style: styles.tabStrip },
							h('button', {
								type: 'button',
								style: tabStyle(tab === 'archived'),
								onClick: function () {
									setTab('archived');
								},
							}, t('tab.archived') + ' (' + String(archiveCount) + ')'),
							h('button', {
								type: 'button',
								style: tabStyle(tab === 'all'),
								onClick: function () {
									setTab('all');
								},
							}, t('tab.all') + ' (' + String(allRows.length) + ')')),
						h('input', {
							type: 'search',
							style: styles.search,
							value: query,
							placeholder: t('search.placeholder'),
							'aria-label': t('search.placeholder'),
							onChange: function (event) {
								setQuery(event && event.target ? String(event.target.value) : '');
							},
						}),
						query === '' ? null : h('button', {
							type: 'button',
							style: buttonStyle('ghost', false),
							onClick: function () {
								setQuery('');
							},
						}, t('search.clear')),
						h('button', {
							type: 'button',
							style: buttonStyle('primary', host.busy === true),
							disabled: host.busy === true,
							onClick: function () {
								safeRefreshHost();
							},
						}, host.busy === true ? t('refreshing') : t('refresh')))),
				banners,
				h('div', { style: styles.bulkBar },
					h('button', {
						type: 'button',
						style: buttonStyle('ghost', false),
						onClick: toggleAll,
					}, t('bulk.selectAll')),
					h('span', { style: styles.metaItem }, selectedIds.length === 0 ? t('bulk.hint') : t('bulk.selected', { n: selectedIds.length })),
					h('span', { style: styles.spacer }),
					h('button', {
						type: 'button',
						style: buttonStyle('danger', selectedIds.length === 0),
						disabled: selectedIds.length === 0,
						onClick: function () {
							requestDelete(selectedIds, selectedRows);
						},
					}, t('bulk.delete', { n: selectedIds.length })),
					h('button', {
						type: 'button',
						style: buttonStyle('ghost', selectedIds.length === 0),
						disabled: selectedIds.length === 0,
						onClick: function () {
							restoreRows(selectedIds);
						},
					}, t('bulk.restore', { n: selectedIds.length })),
					h('button', {
					type: 'button',
					style: buttonStyle('ghost', releasableSelected.length === 0),
					disabled: releasableSelected.length === 0,
					title: releasableSelected.length === 0 ? t('notice.nothingReleasable') : t('row.release.title'),
					onClick: function () {
					releaseRows(releasableSelected);
					},
					}, t('bulk.release', { n: releasableSelected.length })),
					selectedIds.length === 0 ? null : h('button', {
						type: 'button',
						style: buttonStyle('ghost', false),
						onClick: function () {
							setSelected(EMPTY_ARRAY);
						},
					}, t('bulk.clear'))),
				h('div', { style: styles.body }, body));
		}

		/* ================================================================== *
		 * 12. `shell.overlay` occupant — the destructive confirm modal
		 * ================================================================== */

		function ConfirmDialog(props) {
			var t = props.t;
			var pending = props.pending;
			var ids = pending.ids;
			var rows = pending.rows;
			var sizeById = {};
			var totalBytes = 0;
			for (var index = 0; index < rows.length; index += 1) {
				sizeById[rows[index].id] = toNumber(rows[index].bytes);
				totalBytes += toNumber(rows[index].bytes);
			}

			var checkedPair = useState(ids.length <= 1);
			var checked = checkedPair[0];
			var setChecked = checkedPair[1];

			var busyPair = useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];

			var errorPair = useState('');
			var errorText = errorPair[0];
			var setErrorText = errorPair[1];

			var cancelRef = useRef(null);

			useEffect(function () {
				var node = cancelRef.current;
				if (node && typeof node.focus === 'function') {
					try {
						node.focus();
					} catch (error) {
						/* focus is best-effort */
					}
				}
			}, []);

			function close() {
				if (busy === true) return;
				confirmBus.set(null);
			}

			function confirm() {
				if (busy === true) return;
				if (ids.length > 1 && checked !== true) return;
				setBusy(true);
				setErrorText('');
				deleteSessions(ids, false).then(function (result) {
					if (result.ok !== true) {
						setBusy(false);
						setErrorText(result.error);
						pushNotice('error', t('notice.deleteFailed', { message: result.error }));
						return;
					}
					var body = result.body || {};
					var deleted = Array.isArray(body.deleted) ? body.deleted : [];
					var failedIds = Array.isArray(body.failedIds) ? body.failedIds : [];
					var freed = toNumber(body.freedBytes);
					confirmBus.set(null);
					if (failedIds.length > 0) {
						pushNotice('warning', t('notice.deleteFailed', { message: failedIds.join(', ') }));
					} else {
						pushNotice('success', t('notice.deleted', { n: deleted.length, size: formatBytes(freed) }));
					}
					markRemoved(deleted);
					safeRefreshHost();
				}, function (error) {
					setBusy(false);
					setErrorText(describeError(error));
					pushNotice('error', t('notice.deleteFailed', { message: describeError(error) }));
				});
			}

			return h('div', {
				style: styles.backdrop,
				tabIndex: -1,
				onClick: close,
				onKeyDown: function (event) {
					if (event && event.key === 'Escape') {
						if (typeof event.stopPropagation === 'function') event.stopPropagation();
						close();
					}
				},
			},
				h('div', {
					style: styles.dialog,
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': t('confirm.title'),
					onClick: function (event) {
						if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
					},
				},
					h('div', { style: styles.dialogTitle }, t('confirm.title')),
					h('div', { style: styles.bannerBody }, t('confirm.count', { n: ids.length })),
					h('div', { style: styles.bannerBody }, t('confirm.total', { size: formatBytes(totalBytes) })),
					h('div', { style: styles.warning },
						h('div', null, t('confirm.warning')),
						h('div', { style: { fontSize: '11px', fontWeight: 400 } }, t('confirm.warningDetail'))),
					h('div', { style: styles.diagHeading }, t('confirm.ids')),
					h('ul', { style: styles.idList }, ids.map(function (id) {
						return h('li', { key: id, style: styles.idItem },
							h('code', { style: styles.idCode, title: id }, id),
							h('span', { style: styles.idSize }, formatBytes(hasOwn(sizeById, id) ? sizeById[id] : 0)));
					})),
					ids.length > 1 ? h('label', { style: styles.checkboxRow },
						h('input', {
							type: 'checkbox',
							style: { flex: '0 0 auto', marginTop: '2px', accentColor: C.brand },
							checked: checked === true,
							disabled: busy === true,
							onChange: function () {
								setChecked(function (value) {
									return !value;
								});
							},
						}),
						h('span', null, t('confirm.checkbox'))) : null,
					errorText === '' ? null : h('div', { style: Object.assign({}, styles.bannerBody, { color: C.danger }) }, errorText),
					h('div', { style: styles.dialogActions },
						h('button', {
							type: 'button',
							ref: cancelRef,
							style: buttonStyle('ghost', busy === true),
							disabled: busy === true,
							onClick: close,
						}, t('confirm.cancel')),
						h('button', {
							type: 'button',
							style: buttonStyle('danger', busy === true || (ids.length > 1 && checked !== true)),
							disabled: busy === true || (ids.length > 1 && checked !== true),
							onClick: confirm,
						}, busy === true ? t('confirm.busy') : t('confirm.action')))));
		}

		function ConfirmDeleteOverlay(props) {
			var t = pickT(props);
			var pending = useBus(confirmBus);
			if (pending === null || !pending) return null;
			return h(ConfirmDialog, { key: String(pending.seq), pending: pending, t: t });
		}

		/* ================================================================== *
		 * 13. `sidebar.workspaces.session.menu.item` occupant
		 * ================================================================== */

		function DeleteSessionMenuItem(props) {
			var t = pickT(props);

			var useSessionsHook = props && typeof props.useSessions === 'function' ? props.useSessions : fallbackSessions;
			var useWorkspacesHook = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : fallbackWorkspaces;
			var useMenuOpenState = props && typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : fallbackMenuOpenState;

			var sessions = useSessionsHook(selectSelf);
			var workspaces = useWorkspacesHook(selectSelf);
			var host = useBus(hostBus);

			/* Owner-injected when present; must work when absent. */
			var menuState = useMenuOpenState();
			var closeMenu = Array.isArray(menuState) && typeof menuState[1] === 'function' ? menuState[1] : null;

			var sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
			var displayTitle = props && typeof props.displayTitle === 'string' ? props.displayTitle : '';

			var row = useMemo(function () {
				if (sessionId === '') return null;
				return deriveRow({
					sessions: sessions,
					workspaces: workspaces,
					list: host.list,
					status: host.status,
					removed: null,
				}, sessionId);
			}, [sessionId, sessions, workspaces, host.list, host.status]);

			/* Hidden for `current` and `live` sessions. */
			if (row !== null && (row.current === true || row.live === true)) return null;

			var effective = row !== null ? row : {
				id: sessionId,
				title: displayTitle,
				bytes: 0,
				archived: false,
				live: false,
				running: false,
				current: false,
				deletable: false,
				skipReason: 'not-archived',
			};

			var disabled = effective.deletable !== true;
			var subtitle = effective.skipReason === 'not-archived'
				? t('menu.delete.notArchived')
				: disabled
					? reasonText(t, effective.skipReason)
					: '';

			return h('button', {
				type: 'button',
				role: 'menuitem',
				'aria-disabled': disabled ? 'true' : undefined,
				disabled: disabled,
				title: subtitle === '' ? t('menu.delete') : subtitle,
				style: {
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
					width: '100%',
					minWidth: 0,
					boxSizing: 'border-box',
					padding: '5px 8px',
					border: '1px solid transparent',
					borderRadius: '6px',
					background: 'transparent',
					color: disabled ? C.textTertiary : C.danger,
					fontSize: '12px',
					textAlign: 'left',
					cursor: disabled ? 'not-allowed' : 'pointer',
					opacity: disabled ? 0.6 : 1,
					fontFamily: 'inherit',
				},
				onClick: function () {
					if (disabled) return;
					if (closeMenu !== null) {
						try {
							closeMenu(false);
						} catch (error) {
							/* a foreign hook must not break the menu item */
						}
					}
					confirmSeq += 1;
					confirmBus.set({ seq: confirmSeq, ids: [effective.id], rows: [effective] });
				},
			},
				h('svg', {
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					'aria-hidden': 'true',
					focusable: 'false',
					style: styles.icon,
				},
					h('path', {
						d: 'M3 4.5h10M6.5 4.5V3.2h3v1.3M4.4 4.5l.6 8.1h6l.6-8.1',
						stroke: 'currentColor',
						strokeWidth: 1.2,
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
					})),
				h('span', { style: ellipsis }, t('menu.delete')));
		}

		/* ================================================================== *
		 * 14. `settings.section` occupant — read-only diagnostics
		 * ================================================================== */

		function DiagnosticsRows(props) {
			var t = props.t;
			var entries = props.entries || EMPTY_ARRAY;
			var rendered = [];
			for (var index = 0; index < entries.length; index += 1) {
				var entry = entries[index];
				if (!entry) continue;
				rendered.push(h('div', { key: entry.label + ':' + String(index), style: styles.diagRow },
					h('span', { style: styles.diagLabel }, entry.label),
					h('span', { style: entry.mono === false ? styles.diagValueScalar : styles.diagValue, title: entry.raw === undefined ? entry.value : String(entry.raw) }, entry.value)));
			}
			if (rendered.length === 0) return null;
			return h('div', { style: styles.diagSection },
				props.heading ? h('div', { style: styles.diagHeading }, props.heading) : null,
				rendered);
		}

		function entriesFromObject(t, source) {
			var out = [];
			if (!source || typeof source !== 'object') return out;
			var keys = Object.keys(source);
			for (var index = 0; index < keys.length; index += 1) {
				out.push({
					label: keys[index],
					value: scalarText(source[keys[index]], t),
					raw: source[keys[index]],
					mono: typeof source[keys[index]] === 'string',
				});
			}
			return out;
		}

		function DiagnosticsSection(props) {
			var t = pickT(props);
			var host = useBus(hostBus);
			var status = host.status && typeof host.status === 'object' ? host.status : null;
			var list = host.list && typeof host.list === 'object' ? host.list : null;

			var pluginEntries = [];
			if (status && status.plugin && typeof status.plugin === 'object') {
				pluginEntries.push({ label: t('diag.plugin'), value: scalarText(status.plugin.name, t), mono: false });
				pluginEntries.push({ label: t('diag.version'), value: scalarText(status.plugin.version, t), mono: false });
			}
			pluginEntries.push({ label: t('diag.endpoint'), value: host.endpoint === '' ? t('diag.endpoint.none') : host.endpoint });
			pluginEntries.push({ label: t('diag.tried'), value: host.tried.length > 0 ? host.tried.join(', ') : ENDPOINTS.join(', ') });
			if (host.error !== '') pluginEntries.push({ label: t('list.error.title'), value: host.error, mono: false });
			if (host.statusError !== '') pluginEntries.push({ label: t('diag.unavailable'), value: host.statusError, mono: false });
			if (list && typeof list.generatedAt === 'string') pluginEntries.push({ label: t('diag.generatedAt'), value: list.generatedAt });

			var rootEntries = [];
			if (status && status.roots && typeof status.roots === 'object') {
				rootEntries.push({ label: t('diag.home'), value: scalarText(status.roots.home, t) });
				rootEntries.push({ label: t('diag.persistence'), value: scalarText(status.roots.persistence, t) });
				rootEntries.push({ label: t('diag.storages'), value: scalarText(status.roots.storages, t) });
				rootEntries.push({ label: t('diag.cache'), value: scalarText(status.roots.cache, t) });
				rootEntries.push({ label: t('diag.audit'), value: scalarText(status.roots.audit, t) });
			}

			var countEntries = [];
			if (status && status.counts && typeof status.counts === 'object') {
				countEntries.push({ label: t('diag.items'), value: scalarText(status.counts.items, t), mono: false });
				countEntries.push({ label: t('diag.archived'), value: scalarText(status.counts.archived, t), mono: false });
				countEntries.push({ label: t('diag.bytes'), value: scalarText(status.counts.bytes, t) + ' (' + formatBytes(status.counts.bytes) + ')', mono: false });
			}

			var warningEntries = [];
			if (list && Array.isArray(list.warnings)) {
				for (var index = 0; index < list.warnings.length; index += 1) {
					warningEntries.push({ label: t('diag.warnings'), value: scalarText(list.warnings[index], t), mono: false });
				}
			}

			return h('div', { style: styles.diagBody },
				h('div', { style: styles.title }, t('diag.title')),
				h('div', { style: styles.subtitle }, t('diag.subtitle')),
				h('div', { style: styles.controls },
					h('button', {
						type: 'button',
						style: buttonStyle('primary', host.busy === true),
						disabled: host.busy === true,
						onClick: function () {
							safeRefreshHost();
						},
					}, t('diag.refresh'))),
				status === null ? h('div', { style: styles.empty }, h('div', null, host.statusError === '' ? t('diag.loading') : t('diag.unavailable'))) : null,
				h(DiagnosticsRows, { t: t, heading: t('diag.plugin'), entries: pluginEntries }),
				h(DiagnosticsRows, { t: t, heading: t('diag.capabilities'), entries: entriesFromObject(t, status ? status.capabilities : null) }),
				h(DiagnosticsRows, { t: t, heading: t('diag.config'), entries: entriesFromObject(t, status ? status.config : null) }),
				h(DiagnosticsRows, { t: t, heading: t('diag.roots'), entries: rootEntries }),
				h(DiagnosticsRows, { t: t, heading: t('diag.counts'), entries: countEntries }),
				h(DiagnosticsRows, { t: t, heading: t('diag.warnings'), entries: warningEntries }));
		}

		/* ================================================================== *
		 * 15. apply — five registrations, one effect, nothing throws
		 * ================================================================== */

		/**
		 * Build the `t` seat used by registration-time label thunks: prefer the
		 * locale service, otherwise fall back to the inline dictionaries so a
		 * label is never empty and nothing throws.
		 */
		/**
		 * Build the `t` seat used by registration-time label thunks: prefer the
		 * locale service, otherwise fall back to the inline dictionaries so a
		 * label is never empty and nothing throws.
		 *
		 * A locale service that answers a lookup it does not know by echoing the
		 * key back is common, and trusting that answer would print the raw key
		 * (`notice.releaseFailed`) in the UI. An answer equal to the key asked
		 * for is therefore treated as a miss and the inline dictionary wins.
		 */
		function makeTranslate(ctx) {
			var locale = ctx && ctx.locale ? ctx.locale : null;
			if (locale && typeof locale.bind === 'function') {
				try {
					var bound = locale.bind(NS);
					if (typeof bound === 'function') {
						return function (key, params) {
							var value;
							try {
								value = bound(key, params);
							} catch (error) {
								value = null;
							}
							if (typeof value === 'string' && value !== '' && value !== key) return value;
							return fallbackTranslate(key, params);
						};
					}
				} catch (error) {
					/* fall through to the inline dictionaries */
				}
			}
			return fallbackTranslate;
		}

		function apply(ctx) {
			var safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
			var t = guardT(makeTranslate(safeCtx));
			var slots = safeCtx.slots && typeof safeCtx.slots === 'object' ? safeCtx.slots : null;

			var registrations = [
				{
					owner: 'sidebar.panellist',
					options: { name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: function () { return t('panelLabel'); } },
					component: PanelIcon,
				},
				{
					owner: 'main',
					options: { name: 'main', key: PANEL_ID, locale: NS },
					component: SessionManagerPage,
				},
				{
					owner: 'sidebar.workspaces.session.menu.item',
					options: { name: 'sidebar.workspaces.session.menu.item', id: DELETE_MENU_ID, order: 500, locale: NS },
					component: DeleteSessionMenuItem,
				},
				{
					owner: 'shell.overlay',
					options: { name: 'shell.overlay', id: CONFIRM_OVERLAY_ID, order: 500, locale: NS },
					component: ConfirmDeleteOverlay,
				},
				{
					owner: 'settings.section',
					options: { name: 'settings.section', id: PANEL_ID, order: 60, locale: NS, label: function () { return t('settingsLabel'); } },
					component: DiagnosticsSection,
				},
			];

			function install() {
				var disposers = [];

				if (safeCtx.locale && typeof safeCtx.locale.register === 'function') {
					try {
						var disposeDictionaries = safeCtx.locale.register(NS, { zh: zh, en: en });
						if (typeof disposeDictionaries === 'function') disposers.push(disposeDictionaries);
					} catch (error) {
						/* an already-registered namespace must not break apply */
					}
				}

				if (slots !== null && typeof slots.inject === 'function' && typeof slots.register === 'function') {
					for (var index = 0; index < registrations.length; index += 1) {
						(function (registration) {
							try {
								var disposeSlot = slots.inject(registration.owner, function () {
									return slots.register(registration.options, registration.component);
								});
								if (typeof disposeSlot === 'function') disposers.push(disposeSlot);
							} catch (error) {
								/* an undeclared slot must not break the other registrations */
							}
						})(registrations[index]);
					}
				}

				/* Prefer the remote relay the client actually exposes. */
				if (safeCtx.remote && typeof safeCtx.remote.$on === 'function') {
					try {
						var disposeRemote = safeCtx.remote.$on('api-session/removed', onHostSessionRemoved);
						if (typeof disposeRemote === 'function') disposers.push(disposeRemote);
					} catch (error) {
						/* remote events are optional */
					}
				} else if (typeof safeCtx.on === 'function') {
					try {
						var disposeEvent = safeCtx.on('api-session/removed', onHostSessionRemoved);
						if (typeof disposeEvent === 'function') disposers.push(disposeEvent);
					} catch (error) {
						/* the event channel is optional */
					}
				}

				safeRefreshHost();

				return function () {
					for (var position = disposers.length - 1; position >= 0; position -= 1) {
						try {
							disposers[position]();
						} catch (error) {
							/* disposal must never throw */
						}
					}
					disposers.length = 0;
				};
			}

			if (typeof safeCtx.effect === 'function') {
				try {
					safeCtx.effect(install, 'dsh-session-manager: registrations');
					return;
				} catch (error) {
					/* fall back to a direct install below */
				}
			}
			try {
				var dispose = install();
				if (typeof dispose === 'function') dispose;
			} catch (error) {
				/* apply must stay inert even with no effect channel at all */
			}
		}

		return { name: NS, inject: ['slots', 'locale'], apply: apply };
	},
});
