# dsh-session-manager · DSH 归档会话管理器

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-blue.svg)](https://github.com/deepseek-ai/dsh)
[![tests](https://img.shields.io/badge/tests-69%2F69-brightgreen.svg)](test)
[![zero deps](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

在 DeepSeek Harness (DSH) 的 Web UI 里管理**归档会话**，并且可以像 Codex 那样**永久删除**会话——
不只是取消归档，而是把会话日志、投影缓存和工作区登记一起清掉。

[English](README.md) · [接口契约 SPEC.md](SPEC.md) · [问题反馈](https://github.com/qiaofugui/dsh-session-manager/issues)

---

## 1. 它能做什么

| 入口 | 位置 | 作用 |
| --- | --- | --- |
| **会话管理面板** | 侧栏图标（`会话管理`） | 归档 / 全部两个标签页、搜索、多选、批量删除、批量恢复、单行删除与恢复、显示磁盘占用 |
| **行内删除** | 会话行 `⋯` 菜单里的 `删除会话…` | 针对单个会话的快捷删除（当前会话与运行中的会话不出现该项） |
| **确认弹窗** | 全局覆盖层 | 显示数量、总空间、完整 id 列表，必须确认「此操作不可撤销」 |
| **诊断页** | 设置 → 会话管理 | 只读：已挂载的路由、根目录、计数、能力探测结果、审计日志路径 |

删除是不可撤销的，但**每一步都写审计**：

```
$DSH_HOME/session-manager/deleted.jsonl
```

---

## 2. 兼容性

这一节是重点。插件被设计成「**能力探测优先、缺失即降级**」：任何一个 Host 服务、插槽、路由面或
存储布局不存在时，插件都只会**变得不完整，而不是报错**；未挂载的插槽永远不会被写入，缺服务时
整个 Host 半边保持静默。

### 2.1 设计规则（都是硬约束，代码里有对应实现）

| 规则 | 原因 |
| --- | --- |
| Host 半边**只 `import` `node:*`**，不引用任何 `@deepseek-ai/*`、不引用 `zod` | 第三方 bundle 装进 profile 后解析不到这些包（`profiles/<name>/node_modules/@deepseek-ai` 是空目录） |
| 客户端 bundle 是**手写单文件**，只 `require('react')` | 没有打包链；`require('@deepseek-ai/dsh-client-ui-primitives')` 之类会抛错并让整个插槽变空白 |
| `Config` 是**手写 Standard Schema v1**，未知键**忽略** | 框架只读 `Config['~standard'].validate()`；新版本 `cordis.patch.yml` 里的新配置项不会让旧插件加载失败 |
| 所有可选服务都用 `ctx.inject([...], cb)` 或 `svc?.method?.()` 探测 | 缺失服务只会让回调不执行，不会抛异常导致整行变 `failed` |
| 不注入任何 Harness 客户端包（`dsh.client.external` 为空） | 只声明 `inject` 顺序，不制造模块图边；缺失提供方不会让组合失败 |
| 主题只用已验证存在的 `--dsw-alias-*` 变量，并带字面量兜底 | 变量改名只会让观感退化，不会让渲染崩掉 |
| 不写 `document.body`、不读别人的 DOM、不注入全局样式表 | 插件与宿主 UI 共处一个应用，不越界 |

### 2.2 Host 服务能力矩阵

每个服务都是可选的，缺省时的行为如下：

| 服务 | 存在时 | 缺失时 |
| --- | --- | --- |
| `connection`（`fetch.register`） | 挂载**已鉴权**路由 `/api/session-manager`，复用 `/api` 前缀里的 Host/Origin 校验 + 浏览器 Cookie | 跳过，仅用下面那条回落路由 |
| `webServer`（`register`） | 挂载**回落**路由前缀 `/session-manager/api`（自带回环 + Origin 校验） | 该路由不存在；前端会先试已鉴权路由 |
| `workspaceRegistry` | 归档集合读改、`detachSession` 清工作区登记、`archive/unarchive` | 删除仍会清日志与缓存；`restore/archive` 返回 `503 workspace-registry-unavailable`；`archivedIds` 为空 |
| `sessionPersistence` | 用它的 `.root` 作为日志根 | 回落到 `$DSH_HOME/sessions` |
| `sessions` / `agents` | 精确判断「已打开」与「正在运行」 | `liveDetection: false`，此时**只靠归档集合与保护名单**做拦截（见 §7 安全） |
| `dshHomePath` | 取 DSH 主目录 | 回落到 `%DSH_HOME%`，再回落到 `~/.dsh` |
| `ctx.locale`（前端） | 使用宿主语言字典 | 回落到 `client.js` 内置的 zh / en 字典 |
| `useSessions` / `useWorkspaces`（前端 props） | 与磁盘视图合并 | 只显示 Host `list` 返回的磁盘行 |
| `ctx.remote` / `ctx.on`（前端） | 监听 `api-session/removed` 自动刷新 | 删除成功后自己重新拉取列表 |

两条路由是**同时**注册、互不冲突的：已鉴权路由是精确路径，回落路由是另一个前缀路径。前端按
`api/session-manager` → `session-manager/api` 的顺序探测并缓存命中的那一个；HTTP 404/405 视为
「试下一个」，其余错误直接显示在面板上，所以路由层面的不兼容在 UI 里就能看见，而不是白屏。

### 2.3 会话存储格式兼容

删除逻辑**不解析会话日志**（不需要 zstd 解压，因此没有二进制依赖），而是按目录/文件形状定位：

- 任何项目目录名都接受：`--<projectKey>--`、`_no-cwd`、以及任何其它名字；
- 会话目录名按 DSH 的 `encodeSegment` 规则解码后与请求的 id 比较，因此 `session-…` 与
  **裸 UUID**（子会话）都能识别；
- 日志文件名**不做假设**：`session.v0..v4.jsonl`、`.jsonl.zst`、`.jsonl.zstd`、`session.jsonl`
  等任意代数都行——删除时删掉**整个会话目录**，所以新版本号自动兼容；
- 同时支持根目录下的**扁平布局**（会话目录直接位于 `sessions/` 下，或旧的
  `<projectKey>/<encodedId>.jsonl*` 文件）；
- 旧版**单文件投影缓存** `<storages>/session_projcache.json`（一个文件装所有会话）**永不删除**，
  只报告布局为 `single-legacy`；新版 per-record 布局 `<storages>/session_projcache/sessions/<id>.json`
  才删除，且同时尝试原 id 与编码后的文件名两种 stem；
- 删除前对每个路径都做**根目录包含性复验**（`assertInside`），符号链接不会把删除带出根目录。

### 2.4 平台兼容

- Windows：目录删除用 `fs.rm(..., { recursive, maxRetries: 5, retryDelay: 120 })`，避免杀软/句柄
  占用导致的 `EBUSY/EPERM`；空项目目录用 `fs.rmdir`（原子 `ENOTEMPTY`）而不是递归删除，杜绝
  检查与删除之间目录被重新填充导致的误删。
- POSIX：同上逻辑，`session.lock` 等残留文件随目录一起消失。
- Node：只用 `node:fs`、`node:path`、`node:os` 等稳定 API；`engines.node >= 18`。

### 2.5 版本声明

`package.json` 里声明了 `dshTarget: "0.2.0-rc.2"`（本机 DSH 版本），这是给插件市场/管理页的
兼容性提示字段，运行时不强制校验。真正的兼容性由上面的能力探测保证。

### 2.6 与其它插件共存

- **只通过 `workspaceRegistry` 服务改工作区状态**，不直接改 `storages/workspace.json`，因此不与
  宿主的工作区写入队列冲突。
- **不动附件**（`attachments` 是内容寻址、跨会话共享的，删会话不该删图片）。
- **不动别的插件自己的索引**（`dsh-usage`、`task-board`、`redteam`、`skin-center` 等）。如果确实要
  一起清，用 `cascadeRoots` 显式列目录，见 §5。
- 如果部署启用了**持久化的会话搜索索引**（SQLite 路径），删日志后索引里会留一条陈旧行；下次
  重建索引时消失。本插件不直接改别的插件的数据库。

---

## 3. 安装

三种方式，从省事到手动排列。安装是**幂等**的，重复执行没有副作用。

### 方式 A：装成本地依赖（推荐，最省事）

编辑 `$DSH_HOME\profiles\<你的 profile>\package.json`（默认 `desktop`），加一条依赖：

```json
{
  "dependencies": {
    "dsh-session-manager": "https://codeload.github.com/qiaofugui/dsh-session-manager/tar.gz/refs/heads/main"
  }
}
```

然后在 DSH 里让 agent 调用：

```
action: install_bundle
target: dsh-session-manager
```

`install_bundle` 会自己装依赖、把 bundle 追加进 profile 的 `dsh.profile.bundles`、并热加载。返回的
`application` 字段说明是否已生效（`applied` = 已生效，`restart-required` = 需重启）。

> 用 GitHub 归档地址时，装的是「发布版」；想跟随仓库最新代码请改成具体的 tag 或 commit。

### 方式 B：本地开发安装

源码在本地目录时，用绝对目录直接装：

```
action: install_bundle
target: E:\test\dsh-session-manager
```

或者用仓库自带的等价脚本（不依赖 `plugin_manager`，幂等，会自动备份 manifest）：

```powershell
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  E:\test\dsh-session-manager\tools\install-profile.mjs
# 预览而不写入
& "...node.exe" "...\tools\install-profile.mjs" --dry-run
# 撤销 bundle 登记并删除复制目录
& "...node.exe" "...\tools\install-profile.mjs" --uninstall
```

### 方式 C：手动安装

<details>
<summary>展开</summary>

1. 把整个目录复制到 profile：

   ```powershell
   Copy-Item E:\test\dsh-session-manager `
     "$env:DSH_HOME\profiles\desktop\node_modules\dsh-session-manager" -Recurse -Force
   ```

2. 在 `$DSH_HOME\profiles\desktop\package.json` 里让 profile 认识这个 bundle：

   ```json
   {
     "dependencies": { "dsh-session-manager": "file:./node_modules/dsh-session-manager" },
     "dsh": { "profile": { "bundles": [ "...", "dsh-session-manager" ] } }
   }
   ```

   `bundles` 里追加一项，插件的 `cordis.patch.yml` 才会作为一层 patch 生效；
   `dependencies` 里加一项是为了让 DSH 的 reconcile 逻辑在后续升级/安装操作后不会把它摘掉。

3. 重启 DSH，或等热加载接管（新 bundle 常能热加载，见下）。

</details>

### 装完怎么确认

```powershell
Invoke-RestMethod "http://127.0.0.1:19387/session-manager/api?op=status"
```

返回 `ok: true` 就说明 Host 半边已挂载；随后**刷新浏览器页面**即可看到侧栏的 `会话管理` 图标。

> 该路由是回环专用的诊断入口：只接受本机连接、要求 `Origin` 与 `Host` 同源，且 `POST` 必须带
> `x-dsh-session-manager: 1` 头和 `application/json`。不带浏览器 Cookie 访问 `/api/session-manager`
> 会得到 `401`，这是正常的——浏览器里的面板会自动带上 Cookie。

### 升级

替换 `node_modules\dsh-session-manager` 下的文件后刷新或重启。**替换**已安装包时无法只靠热加载
加载新的 `client.js` 代码代，浏览器里旧的 bundle 会一直用到重启为止。

### 卸载

从 `dsh.profile.bundles` 里删掉 `dsh-session-manager`（和 `dependencies` 里的那一项），
再删掉 `node_modules\dsh-session-manager`，重启。插件不残留任何全局状态；审计日志在
`$DSH_HOME\session-manager\`，按需删除。

---

## 4. 使用

1. 侧栏点 `会话管理` 图标。
2. `归档` 标签页只列归档会话（默认）；`全部` 标签页列磁盘上所有会话（含正在运行的，但它们的
   删除按钮是禁用的）。
3. 用搜索框按 id / 项目目录 / 路径过滤。
4. 勾选若干行 → 底部批量条 → `删除选中 (n)`。
5. 确认弹窗里核对数量、总空间与完整 id；多选时必须勾选「我已确认」才能点删除。
6. 删除完成后会重新拉取列表，并显示释放的空间。

也可以在会话行的 `⋯` 菜单里直接点 `删除会话…`。当前会话与正在运行的会话**不会**出现在该菜单里
（前端直接不发请求）。

---

## 5. 删除语义：删了什么、没删什么

**删除的（按顺序执行）**

1. 会话目录 `$DSH_HOME/sessions/<project>/<encodedId>/`（整目录，涵盖所有代数的日志与锁文件）；
   若配置为扁平布局，则删除对应的 `*.jsonl*` 文件；
2. 投影缓存记录 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`（per-record 布局；
   单文件旧布局不删）；
3. `cascadeRoots` 里显式列出的目录中按会话 id 命名的文件/目录；
4. 归档集合：`workspaceRegistry.unarchiveSession(id)`；置顶集合：`unpinSession(id)`；
5. 工作区登记：每个包含该 id 的工作区执行 `detachSession(id)`；
6. 向浏览器发 `api-session/removed`，让会话列表立即少一行；
7. 追加一条审计记录（JSONL）：时间、id、项目、目录、释放字节、每步结果、失败原因、调用方。

**不删的**

- 共享附件（内容寻址、跨会话复用）；
- 别的插件自己的索引/数据库；
- 旧版单文件投影缓存；
- 任何不在上述根目录内的路径（包含性复验失败即拒绝）。

**顺序与可重试性**：先删文件（不可逆），再做登记（可逆）。如果文件删除失败，登记完全没动，
可以原样重试；如果文件删掉了但登记失败，结果会标 `error: "partial"` 并**不算成功**，下次重试会
只做「残留清理」（`action: cleanup-residue`），把归档集合与工作区登记补完。

### 级联清理（`cascadeRoots`）

默认是空的，因为别的插件的数据属于它们自己。若你确认要一起清，例如：

```yaml
cascadeRoots:
  - "C:\\Users\\Joe__\\.dsh\\task-board"
```

每个根目录下只会检查这四种形状：`<root>/<id>.json`、`<root>/<id>`、
`<root>/sessions/<id>.json`、`<root>/sessions/<id>`（id 同时尝试原样与 `encodeSegment` 编码形式）。

---

## 6. 配置

配置写在 profile 的 `cordis.patch.yml` 里（覆盖同一个 `id` 会**整体替换** `config`，所以要写全
你想保留的键）：

```yaml
- id: dsh-session-manager
  name: dsh-session-manager
  config:
    allowDeleteUnarchived: false
    maxBatch: 200
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时该行不注册任何东西 |
| `allowDeleteArchived` | `true` | `false` 时归档会话被视为受保护（原因码 `protected`） |
| `allowDeleteUnarchived` | `false` | 是否允许删除**未归档**的会话（面板「全部」标签页需要它） |
| `allowDeleteLive` | `false` | 是否允许删除仍然存活（已打开/可挂起）的会话；需要重载页面才能清掉内存里的旧对象 |
| `purgeProjectionCache` | `true` | 删除投影缓存记录（缓存可由日志重建，删除总是安全的） |
| `pruneEmptyProjects` | `true` | 项目目录下最后一个会话被删后，删除空的 `--<project>--` 目录 |
| `cascadeRoots` | `[]` | 额外按会话 id 清理的根目录，见 §5 |
| `protectedSessionIds` | `[]` | 永不删除的会话 id 名单 |
| `maxBatch` | `200` | 单次请求最多删多少个；超出的 id 会以 `over-batch` 跳过 |
| `dryRun` | `false` | 只报告计划，不动磁盘（前端「预览」按钮也会传 `dryRun`） |
| `auditLog` | `''` | 审计日志路径；空 = `$DSH_HOME/session-manager/deleted.jsonl` |
| `routePath` | `''` | 空 = `/api/session-manager` |
| `fallbackRoutePath` | `''` | 空 = `/session-manager/api` |
| `managerDir` | `''` | 空 = `$DSH_HOME/session-manager`（放审计日志） |

布尔值接受 `true/false`、`"true"/"false"/"1"/"0"`；`""` 一律按 `true`（避免把 `dryRun: ""` 误判成
关闭）。**未知键会被忽略并丢弃**，以便旧版插件读新配置时不报错。

配置校验失败时插件**不会**让整行变 `failed`：会退回默认值并写一条 warning 日志。

---

## 7. 安全设计

- **默认只删归档会话**。归档本身就是「我暂时不想看到它」，删除是它的自然延伸。
- **当前会话**：`decide` 的最高优先级拦截（`current`）。插件自身会话（`DSH_SESSION_ID`）也被保护。
- **存活/运行中会话**：默认拒绝（`live` / `running`），需要显式 `allowDeleteLive`。
- **保护名单**：`protectedSessionIds`，永远优先。
- **路径安全**：请求的 id 必须是单个路径段；解码后为 `.`/`..`/含分隔符的一律以 `invalid-id` 拒绝；
  每个待删路径在删除前都要通过「严格位于允许根目录内」的复验。
- **CSRF**：已鉴权路由靠 Cookie + Host/Origin 校验；回落路由额外要求循环回环地址、
  `sec-fetch-site != cross-site`、`Origin` 与 `Host` 同源、`content-type: application/json`，
  以及自定义头 `x-dsh-session-manager: 1`（表单无法伪造自定义头），并对 `OPTIONS` 一律不返回 CORS
  头。请求体上限 512 KiB。
- **写操作必须 POST**：`delete`/`restore`/`archive` 走 GET 一律 `405 use-post`。
- **审计**：每次删除和每次残留清理都会追加一行 JSONL，失败步骤也记录在案。

---

## 8. 已知限制

- 删除存活会话（`allowDeleteLive: true`）后，页面里可能残留一个内存对象，需要刷新页面。
- 不清理别的插件的会话索引（见 §2.6）。
- 旧版单文件投影缓存布局不清理（安全第一）。
- 面板的「全部」标签页在 `allowDeleteUnarchived: false` 时所有非归档行都不可删除——这是刻意的。
- 没有内置的「回收站」；删除不可撤销，只有审计日志留痕。

---

## 9. 开发与测试

```
dsh-session-manager/
├─ index.js            # Host 入口（Cordis apply）
├─ client.js           # 浏览器 bundle（手写，window.__ModuleLoader__）
├─ cordis.patch.yml    # bundle patch，插入插件行
├─ lib/
│  ├─ config.js        # 手写 Standard Schema + 默认值
│  ├─ encoder.js       # DSH 路径段编解码、id 校验
│  ├─ scanner.js       # 唯一触碰文件系统的模块：扫描 / 删字节 / 包含性复验
│  ├─ plan.js          # 纯策略：原因码与优先级
│  ├─ delete.js        # 删除流水线：文件 → 登记 → 事件 → 审计
│  ├─ audit.js         # JSONL 审计
│  ├─ ops.js           # 唯一的操作分发器（status/list/delete/restore/archive）
│  └─ routes.js        # 两条 HTTP 适配器 + 回落路由的围栏
├─ locale/             # 客户端字典（zh/en），client.js 内还有一份内置副本
├─ tools/
│  ├─ install-profile.mjs  # 幂等安装/卸载进 profile
│  └─ probe-live.mjs       # 只读探测真实 $DSH_HOME，预览删除计划
└─ test/
   ├─ host-core.test.mjs   # 29 项
   ├─ client.test.mjs      # 浏览器 bundle 的注册与降级
   ├─ integration.test.mjs # 31 项：假 ctx + 合成 DSH home + 真实请求/响应
   └─ run.mjs              # 一次跑全部
```

```powershell
# 全部测试（注意：node --test <多文件> 在受限沙箱里会 EPERM，用 --test-isolation=none 或直接跑单个文件）
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  --test --test-isolation=none E:\test\dsh-session-manager\test\run.mjs

# 只读探测真实 $DSH_HOME，确认插件看得见你的会话（不写任何东西）
& "...node.exe" E:\test\dsh-session-manager\tools\probe-live.mjs
```

测试不会读写真实的 `$DSH_HOME`：每个用例都在 `%TEMP%` 下建自己的合成 DSH 主目录并在结束时清理。

**实测状态**（DSH `0.2.0-rc.2`，desktop profile，Windows）：已在真实环境安装并挂载，
`/session-manager/api?op=status` 返回 13 个会话 / 3 个归档 / 6.2 MiB；
不带 Cookie 访问 `/api/session-manager` 返回 401；跨站 `Origin` 的删除请求返回 403。

[SPEC.md](SPEC.md) 是冻结的接口契约（wire protocol、模块签名、插槽注册、兼容性约束），
改动行为前先改它。

## 10. 许可

[MIT](LICENSE)
