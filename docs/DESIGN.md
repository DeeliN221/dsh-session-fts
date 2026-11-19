# 技术方案

本文说明 dsh-session-fts 的设计和实现，内容已对照 v0.1.0 源码核对。适用版本：DeepSeek Harness 0.2.2-rc.5。

## 1. 背景

DSH 自带的会话全文搜索由 `@deepseek-ai/dsh-session-query-sqlite` 提供，存在四个问题：

1. **默认关闭。** 官方配置为 `openAt: never`，侧栏 Mod+K 只匹配标题、工作区名和会话 ID。
2. **中文召回差。** 它使用 FTS5 的 `unicode61` 分词器，一段不带空格的中文会被当成一个词元。在一份真实数据上，“全文搜索”作为子串出现 11 次，内置索引命中 0 次。
3. **没有时间范围。** 后端支持按时间过滤，但侧栏请求不传时间，界面上也没有对应控件。
4. **Agent 不能直接用。** 面向模型的 `session_search` 工具在默认关闭的实验包里。

## 2. 目标与非目标

目标：

- 只在本地运行：索引放在本机 SQLite 文件里，没有远程数据库，也没有网络请求。
- 中文按字面子串命中，英文按单词和前缀命中。
- 支持时间范围，默认近 30 天。
- 页面和 Agent 工具调用同一个搜索方法。
- 不修改会话日志，索引删除后可以重建。

非目标：

- 不替换内置的 `ctx.sessionQuery` 服务。要替换它，需要继承 DSH 内部的抽象类，并重写约 1100 行对账、游标和分代逻辑，升级时容易出问题。
- 不做模糊搜索、同义词或向量检索。
- 不定位到具体消息（见第 9 节）。

## 3. 总体结构

```
会话日志（只读）
  │  ctx.sessionQuery.listSessions / readSession
  │  ctx.sessions.get(id).snapshotEvents(from)   ← 运行中的会话
  │  ctx.sessionPersistence.list / stat          ← 判断会话有没有变化
  ▼
Indexer（host/indexer.js）  串行队列、增量对账、实时合并
  ▼
FtsStore（host/store.js）    ~/.dsh/session-fts.sqlite
  ▲
search()（index.js）         请求规范化 → 等待索引追平 → 查询
  ├─ Agent 工具 session_fts_search
  └─ HTTP 路由 /session-fts/api/*  ←  client.js 搜索页面
```

插件声明的必需服务是 `sessions`、`sessionQuery`、`tools`。`sessionPersistence` 通过 `ctx.get` 按需读取。`webServer` 和 `connection` 用 `ctx.inject` 包起来，在没有 Web 的部署里，HTTP 路由不注册，Agent 工具照常可用。

## 4. 中文分词（核心决策）

| 方案 | 中文召回 | 两字词 | 结论 |
|---|---|---|---|
| `unicode61` 原样 | 差 | 差 | 否 |
| `trigram` 分词器 | 子串级 | 少于 3 个字无法走索引 | 否，DSH 官方也测过并放弃 |
| `Intl.Segmenter` 分词 | 切分不稳定，“插件”被切成“插｜件” | 一般 | 否 |
| **逐字加空格后用 `unicode61`，查询按短语匹配** | 等于子串扫描 | 可用 | **采用** |

做法（`host/text.js`）：

- **入库：** `tokenizeForIndex()` 在每个中日韩字符两边加空格。覆盖的 Unicode 范围包括平假名和片假名、CJK 扩展 A、CJK 统一汉字、兼容汉字、韩文音节、CJK 扩展 B 到 F。这样每个字都是一个词元，英文单词保持不变。FTS 表的配置是 `tokenize='unicode61 remove_diacritics 2'`。
- **查询：** `compileQuery()` 按空白把查询拆成多个词，最多 8 个，每个最多 200 字符。每个词经过同样的加空格处理后包成一个带引号的 FTS5 短语，短语里的 `"` 转义为 `""`。多个短语用 `AND` 连接。词以英文字母或数字结尾时追加 `*`，做前缀匹配。不含任何字母或数字的词会被丢弃；全部被丢弃时报错。
- **效果：** 短语要求字符连续出现，所以“全文搜索”只命中这四个字连在一起的位置，和字面子串一致。`OR`、`NEAR`、`*` 等用户输入都在引号内，不会被当成 FTS 语法执行。

实测（57 个会话、954 条可搜索消息，与对同一批文档逐条做子串扫描相比）：

| 查询 | 本插件命中 | 子串扫描 |
|---|---|---|
| 全文搜索 | 5 | 5 |
| 搜索 | 22 | 22 |
| 插件 | 38 | 38 |
| 会话库 | 3 | 3 |
| sqlite | 24 | 24 |
| openAt never | 4 | 4 |

（这里的数字比 README 里的对比表小，是因为本插件只索引人写的消息和助手回复，见第 5 节；README 那张表统计的是内置索引的全部文档。）

## 5. 索引什么

由 `extractDocument()` 决定：

| 事件 | 条件 | 角色 |
|---|---|---|
| `user/message` | 仅当 `source.kind === 'user'`，即人输入的消息 | `user` |
| `assistant/message` | 文本块；推理块不索引 | `assistant` |
| `tool/call` | 仅当 `indexToolOutput: true`，索引工具名和参数 | `tool` |
| `tool/result` | 仅当 `indexToolOutput: true`，索引文本块 | `tool` |

被跳过的 `user/message` 是各插件注入的上下文，`source.kind` 为 `skill-catalog`、`runtime-context`、`time-context`、`agent-instructions`、`tool-jobs` 等。在作者的数据里，这类消息比人写的消息还多，不过滤会严重干扰结果。

每条消息最多索引 `maxDocChars` 个字符，默认 20000。fork 出来的会话只索引它自己的事件（`seq >= inheritedEventCount`），从父会话继承的部分不重复入库。

## 6. 存储结构

索引文件默认在 `~/.dsh/session-fts.sqlite`；设置了绝对路径的 `DSH_HOME` 时放在 `$DSH_HOME/session-fts.sqlite`。也可以用 `path` 配置指定绝对路径。打开时设置 `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=3000`。

| 表 | 内容 |
|---|---|
| `meta` | `schema` 版本（当前为 `1`）和 `options` 指纹 |
| `sessions` | 每个会话一行：`id`、`cwd`、`parent`、`origin`、`title`、`created_at`、`updated_at`、`stamp`、`indexed_seq`、`doc_count` |
| `events` | 每条可搜索消息一行：`id`、`session_id`、`seq`、`role`、`time`、`text`；`(session_id, seq)` 唯一，`time` 有索引 |
| `fts` | contentless FTS5 表（`content=''`、`contentless_delete=1`），只存加空格后的词元，`rowid` 等于 `events.id` |

- 原文只在 `events.text` 里存一份，FTS 表不保存原文，所以索引体积比较小。
- `options` 指纹由 `indexToolOutput` 和 `maxDocChars` 组成。打开时如果版本或指纹变了，就删除三张数据表并重建，所以改这两项配置后会自动重新建索引。
- 所有写操作都在事务里完成，失败时回滚。下次对账会重试。

## 7. 增量对账

`Indexer` 用一条 Promise 串行队列执行所有写任务，同一时刻只有一个任务在写库。

**会话标记（stamp）**

- 运行中的会话：`live:<当前事件数>`，从 `ctx.sessions.get(id)` 读取。
- 已持久化的会话：`rev:<revision>`，来自 `sessionPersistence.list()` 或 `stat()`。按 DSH 的约定，revision 相同表示日志没有变化。
- `formatStatus` 为 `migration-required` 的会话跳过，等它迁移完成后再处理。

**全量对账**（`reconcileAll`）：启动 `startupDelayMs`（默认 3 s）后执行一次。页面上的“重新扫描”按钮也会触发。

1. 用 `ctx.sessionQuery.listSessions()` 列出全部会话，用 `sessionPersistence.list()` 一次性取回各会话的 revision。
2. 逐个比较标记，相同就跳过。不同时只读取 `indexed_seq` 之后的新事件：运行中的会话用 `snapshotEvents(from)`，已持久化的会话用 `readSession()` 再按 `seq` 过滤。会话日志只追加不改写，所以只需要补新事件。
3. 每处理完一个会话就 `setImmediate` 让出事件循环，避免长时间占用 Host。
4. 索引里有、但会话列表里已经没有的会话，删除其所有行。

**实时更新：** 监听 `session/event`。每个会话第一次有新事件时安排一个 `liveDelayMs`（默认 1.5 s）的定时器，在此期间该会话的后续事件不再重复安排；定时器到点后对这个会话执行一次对账。

**搜索前追平：** 每次搜索先调用 `settle()`，立即执行所有还在等待的实时更新，再等队列清空，所以刚发出的消息马上就能搜到。

**附带维护的字段：**

- `updated_at`：最后一条人写消息的时间，没有时用会话创建时间。
- `title`：取最后一个 `session/title` 事件。fork 出来的会话如果自己还没有标题，用 `ctx.sessionQuery.readTitle()` 读取从父会话继承的标题。

**“重建索引”按钮**（`rebuild`）：清空 `events`、`sessions` 和 FTS 数据，再执行一次全量对账。

## 8. 查询

**请求规范化**（`normalizeRequest`，页面和工具共用）：

- `from` / `to`：可以是毫秒时间戳、ISO 时间，或 `YYYY-MM-DD`。日期按 Host 本地时间解析，`from` 取当天 0 点，`to` 取当天最后一毫秒。
- `days`：没给 `from` 时，`from = 现在 − days × 24h`；`0` 表示不限时间。
- `from` 晚于 `to` 时报错。
- 时间过滤针对的是**消息时间**（`events.time`），不是会话创建时间。
- `roles` 只接受 `user`、`assistant`、`tool`。`limit` 限制在 1–200 之间，Agent 工具另外限制为 1–50。

**SQL：**

```sql
SELECT e.session_id, e.seq, e.role, e.time, e.text, bm25(fts) AS score
FROM fts JOIN events e ON e.id = fts.rowid JOIN sessions s ON s.id = e.session_id
WHERE fts MATCH ? [AND e.time >= ?] [AND e.time <= ?] [AND e.role IN (...)]
      [AND s.cwd = ?] [AND (s.origin IS NULL OR s.origin != 'subagent')] [AND e.session_id != ?]
ORDER BY score LIMIT 5001
```

所有值都通过参数绑定传入。最多取 5000 条命中，超出时结果标记为 `truncated`。

**分组和排序：** 在 JS 里按会话分组，每个会话记录命中数、最佳 bm25 分、最后命中时间，以及前 3 条片段。按相关度排序时用最佳分（bm25 越小越相关），按时间排序时用最后命中时间。最后用 `offset` / `limit` 分页。

**片段：** 在原文里找任一查询词最早出现的位置，取前 60、后 180 个字符，多余的空白压成一个空格。原文可能和查询词之间隔着分词器忽略的标点，找不到字面位置时从开头截取。

## 9. 接口

### Agent 工具 `session_fts_search`

| 参数 | 说明 |
|---|---|
| `query` | 必填 |
| `days` / `from` / `to` | 时间范围；都不给时用 `defaultDays`（默认 30） |
| `scope` | `workspace`（默认）只搜 `cwd` 和当前会话完全相同的会话；`all` 搜全部 |
| `roles`、`sort`、`limit`、`offset` | 同第 8 节；`limit` 默认取 `min(maxResults, 10)` |

- 当前会话始终被排除。
- 未知参数会被拒绝。
- 工具超时 60 s，可以和其他工具并行执行。
- 返回纯文本，列出每个会话的标题、`session_id`、`cwd`、命中数，以及带角色、`seq` 和时间的片段；还有更多结果时，提示下一次调用的 `offset`。

### HTTP 路由

注册在 `ctx.webServer` 的前缀路由 `/session-fts/api` 上。每个请求先经过 `ctx.connection.requestRejection(req)`，它和 DSH 自己的 API 使用同样的 Host/Origin 校验和浏览器登录态校验，不通过就返回 401 或 403。请求体上限 64 KB。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `search` | 请求体同第 8 节，另有 `cwd` 和 `includeSubagents` |
| `GET` | `status` | 会话数、消息数、时间跨度、建索引进度、工作区列表、索引路径、`indexToolOutput`、`defaultDays` |
| `POST` | `reindex` | `{}` 为增量扫描，`{"full": true}` 为重建；立即返回 202 |

输入错误返回 400，其他错误返回 500，响应体都是 `{ ok: false, error }`。

### Web 页面（`client.js`）

- 用 `window.__ModuleLoader__` 注册，不需要构建步骤。React 由 DSH 的共享模块表提供。
- 在 `sidebar.panellist` 注册 id 为 `session-fts`、order 为 30 的入口，在 `main` 插槽注册同一 key 的页面。
- 界面文字通过 `ctx.locale` 注册中英文词典（命名空间 `session-fts`）。样式只用 `--dsw-alias-*` 主题变量，跟随亮色和暗色主题。
- 输入后 300 ms 自动搜索，新搜索会中止上一次请求。每页 20 个会话，可以加载更多。
- 每 4 s 刷新一次索引状态。
- 请求 URL 基于 `document.baseURI` 解析，Desktop 的 `dsh-app://` 页面和反向代理子路径下都能正确访问。
- 点击结果调用 `ctx.uiWorkspace.openSession(id)`。

## 10. 性能

在作者机器上的实测数据（Apple Silicon，DSH 0.2.2-rc.5 自带 Node 24.21 和 SQLite 3.53.4）：

| 场景 | 数据量 | 耗时 |
|---|---|---|
| 首次建索引（只含人和助手的消息） | 57 个会话 / 954 条消息 | 约 80 ms |
| 没有变化时的全量对账 | 同上 | 约 1 ms |
| 包含工具输出的规模测试 | 9608 条文档 / 1085 万字符 | 建库约 200 ms，单次查询约 0.1 ms，contentless 索引约 6.3 MB |

当前索引文件约 2 MB。

## 11. 安全与隐私

- 不发起任何网络请求。索引里有会话原文，和会话日志一样只存在本机。
- 索引目录不存在时以 `0700` 权限创建。数据库文件本身的权限由进程 umask 决定，插件不额外收紧。
- 查询词作为数据处理，FTS5 语法不会被执行；SQL 全部使用参数绑定。
- HTTP 路由复用 DSH 的连接鉴权，Agent 工具默认只能看到当前工作区。`scope: "all"` 可以跨工作区读取片段，这是有意的设计，和 DSH 内置 `session_search` 只搜当前工作区不同。

## 12. 已知限制与后续

- 点击结果只打开会话，不定位到命中的消息。现有 `openSession` 不支持指定消息位置。
- `node:sqlite` 的 `DatabaseSync` 是同步的，查询和写入期间会占用 Host 的 JavaScript 线程。目前的数据规模下影响可以忽略。
- 每个索引文件只能被一个 DSH 进程使用。
- 会话被删除后，要到下一次全量对账（启动时或手动重新扫描）才会从索引中移除。
- 只能按消息时间过滤，不能按会话创建时间过滤。
- 可能的后续工作：定位到具体消息；按会话创建时间过滤；在 Mod+K 快速搜索里也接入本插件的结果。
