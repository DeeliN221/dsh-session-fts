# NAS 最小接线候选与无损回滚

日期：2026-11-20。状态：仅评审候选，未修改已安装 runtime、生产 profile、原生档案或生产中央库。

## 原生搜索入口的实际所有者

生产 `nas-session-query-tool` 由 `@deepseek-ai/dsh-tool-session-query` 注册；依赖 `tools, systemPrompt, sessionQuery, agents`。`sessionQuery` 来自 `@deepseek-ai/dsh-session-query-sqlite`，通过可选 `sessionPersistence` 接入 `@deepseek-ai/dsh-session-persistence-jsonl`。base JSONL 根是 `/data/dsh/sessions`，生产 SQLite 路径 `/data/dsh/session-search.sqlite`，`openAt:first-search`。未发现丢失服务注入或需新注册工具的证据。

只读列表能枚举 582 份 current 档案；有界 cold-read 在另一工作区档案发现 `SessionPersistenceCorruptionError`，内部原因为 `system/message requires a protected first surface head`。原实现先对所有档案进行 reconciliation，再按调用者工作区/目标会话过滤，因此无关档案的解码错误会使原生搜索整体返回 `session history storage is unavailable`。活动会话的 `session_event_read` 可直接读 live snapshot，故仍可工作。未读取生产日志中的完整 cause 链，不能把该坏档案断言为线上失败的唯一原因。

候选核心补丁把查询的 session metadata filters 传入 cold-read 阶段；event-search 使用目标 id。完整 metadata 仍保留，未删掉非目标工作区的已有索引，未跳过目标范围的损坏，未改变授权边界和 SQLite schema。全局 metadata list 仍存在；若其失败或全局 revision 持续变化，仍会显式失败。该补丁不修复损坏档案，也不伪造缺失记录。

- `native-query-scope-source.patch`：供上游源码审查；源基线 commit `f3323e4748c2ee3503ea5dedaed005d29ca98ee7`，路径 `packages/session-query/session-query-sqlite/src/index.ts`。
- `native-query-scope.patch`：已安装 rc.1 JavaScript 的等价补丁，原文件 SHA256 `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0`。**只能对隔离副本应用**，不能原地替换镜像内模块。
- 原生 SDK 对照：原实现的两个 search 工具均复现同一 storage 错误；候选两个工具通过；live exact read 两者均通过；目标坏档案仍报错；跨工作区读取仍拒绝；无关索引保留；稳定分页通过。
- TypeScript patch 未跑完整上游编译/测试；已执行等价构建 JS 的真实 SDK 测试。正式合入前必须在目标核心版本重基、类型检查、跑其原测试和新增回归。

## 隔离配置骨架

以下是评审用 `cordis.patch.yml` 条目，值需由目标独立 profile 填入。生产已有对应工具时不要再插入一个重复提供者。现有 profile 文件完全未改。

```yaml
# 唯一的 native persistence/query 提供者。
- id: session-persistence-jsonl
  config:
    root: /ABSOLUTE/ISOLATED/native-archive
- id: session-query-sqlite
  config:
    path: /ABSOLUTE/ISOLATED/native-query.sqlite
    openAt: first-search
# 插件必须先装在独立 profile；本轮没有执行安装。
- id: session-fts
  name: dsh-session-fts
  config:
    userId: my-user
    deviceId: nas
    profile: search-canary
    path: /ABSOLUTE/ISOLATED/session-fts.sqlite
    sourceId: /ABSOLUTE/ISOLATED/native-archive
    refreshIntervalMs: 60000
- id: dsh-session-memory
  name: dsh-session-memory
  config:
    memory:
      retrievalMode: shared
      userId: my-user
      deviceId: nas
      profile: search-canary
      stateDir: /ABSOLUTE/ISOLATED/memory
      centralUrl: http://127.0.0.1:EXISTING_CENTRAL_PORT
      tokenFile: /ABSOLUTE/PRIVATE/device-token.json
      workspaceMappings:
        /local/workspace:
          - deviceId: mac
            cwd: /explicit/remote/workspace
```

插件真实 bundle id 为 `session-fts`/`dsh-session-memory`；以目标 profile 合并后配置为准。`centralServer` 不必启用：复用现有中央服务，客户端只注册 remote adapter。身份和 token principal 必须一致；跨设备的 profile 值也需明确一致。同名字工作区不授权远端；要配显式 device/cwd 映射。一个 shared-state 目录仅允许一个活跃写入者。中央 bearer token 仅放受限私有文件，不记录在交付物。

原生失败不能仅靠增加上述 FTS/memory 配置修复。核心补丁正式发布后，需要由获得生产变更授权的人切到新 runtime 并做上线验收。另一条临时隔离路线是使用只含已验证档案副本的独立 persistence 根；它缩窄可检索语料，不能冒充全量线上修复。

## 维护成本与回滚

插件：第二轮不改变运行时实现，只添加验收材料与版本标识。沿用第一轮统一检索、capture/outbox、lazy semantic 的维护边界；中央 schema 仍是 nullable seq 的增量扩展。回滚到第一轮候选包即可；旧 production 和旧候选包都保留。

核心：这是一个下游维护补丁，直到上游采纳前，每次 `session-query` / `session-query-sqlite` / `session-persistence` API 或构建变更都要重基并重跑原生 fixture。不要承诺低于此成本。补丁无 schema 变更，回退 runtime 和配置即可；所有 native archives 不变，独立派生索引可保留供审计。

生产切换前仍需独立授权，按 NAS profile 锁与 EDIT_LOG 协议操作，验证 `--dump-config`、生产登录态与原生工具，再决定是否重启。此文没有执行任何切换。中央库需 SQLite 一致性备份；原 native 档案、旧插件、旧 FTS/memory 数据路径及 token 文件均保留。回滚恢复旧包/旧配置与原数据路径；若要逐字节恢复中央 DB，使用切换前一致性备份，不删除源档案。
