# 分层会话搜索

本 fork 基于 MIT 社区插件 [xuhuaiqu/dsh-session-fts](https://github.com/xuhuaiqu/dsh-session-fts)，上游基线为 f35075d。标题与全文扩展现有页面；语义复用 Apache-2.0 Transformers.js 与 MIT/Apache-2.0 sqlite-vec，不替换 DSH 的 sessionQuery 服务。

## 使用

安装本仓库 Release 的固定 tgz：`dsh plugin --profile web add /absolute/path/dsh-session-fts-0.2.0-zzl.1.tgz`。启用 bundle 后打开侧栏“会话搜索”，选择标题、全文或语义；已有的工作区、日期、角色、子代理与排序筛选继续生效。插件新增独立入口，原有侧栏标题搜索保持原样。更新后刷新页面；宿主未动态装载新 bundle 时需重启。

语义首次使用下载 `Xenova/multilingual-e5-small` 的 q8 模型，网络只用于模型文件，不发送会话原文。模型失败会显示错误，标题与全文仍可用。受限网络可先在能联网的环境预加载模型缓存，或把 `semantic.model` 指向本地 Transformers.js 模型目录。Node 不自动使用 macOS 系统代理；下载时需要显式设置 `HTTPS_PROXY` 与 `NODE_USE_ENV_PROXY=1`，或者预置缓存，不会静默更换下载源。

## 配置

在 profile patch 中覆盖 `session-fts` 的整个 config，并保留需要的既有字段。语义默认启用；资源有限时设置 `semantic.enabled: false`。

```yaml
- id: session-fts
  config:
    indexToolOutput: false
    defaultDays: 30
    maxResults: 20
    maxDocChars: 20000
    includeSubagents: false
    startupDelayMs: 3000
    liveDelayMs: 1500
    refreshIntervalMs: 60000
    resultCacheSize: 64
    resultCacheBytes: 4194304
    semantic:
      enabled: true
      model: Xenova/multilingual-e5-small
      batchSize: 8
      chunkChars: 800
      queryCacheSize: 64
      minScore: 0.65
      maxCandidates: 200
```

`semantic.cacheDir` 可指定模型缓存目录，默认 `$DSH_HOME/models` 或 `~/.dsh/models`。模型、分块或池化身份变化会重建派生向量；首次下载和索引可能耗时较长。语义按候选上限返回近邻，命中总数是候选内统计，不表示语料全量匹配数。

## 性能与一致性

全文查询直接读取已提交索引，不等待后台所有任务结算；新增消息经过 `liveDelayMs` 合并写入后可见，外部新增或删除会话在周期扫描后可见。首次扫描期间结果可能不完整，页面显示扫描进度。持久化 revision 未变化的会话不重新读取。索引失败保留可查询内容并报告错误，下次扫描重试。

全文匹配先读取受限的命中元数据，仅为当前页加载片段原文。结果 LRU 同时限制条目和序列化字节，在索引提交、删除、重建时整体失效。客户端更改输入或筛选立即取消旧请求，防抖只控制下一次请求的发起。

语义模型和原生 cosine KNN 在专属 worker 执行，模型 CPU 线程数为一；推理批次和候选数有界。查询向量 LRU 按文本缓存，文档向量按内容 hash 持久复用。检索在 top-k 之前应用时间、角色、工作区与子代理过滤，并与当前全文库核对文档身份与原文，避免已删除或变更的内容残留。sqlite-vec 使用原生精确扫描，并非 ANN；超大语料仍应另行测量，worker 只隔离主线程，不消除计算成本。

每个索引路径只能由一个 DSH 进程拥有。卸载等待索引队列退出并终止语义 worker；索引不写 Session 原始数据。数据库有应用身份校验，新文件以 owner-only 权限创建。

## 验证

`pnpm test` 执行词法、缓存、索引、客户端异步行为和真实 sqlite-vec worker 测试；模型测试通过 Node loader 替换嵌入输出，以固定数据验证检索、过滤、持久复用和异常清理。`pnpm test:semantic` 单独运行真实模型下载及中英跨语言召回，不属于离线测试。`pnpm bench` 使用固定合成语料，不读取私人会话。

本机 Node v26.6.0 / macOS arm64 的合成测量：200 会话、10,000 条消息、每条约 2KB，全文广泛匹配查询。上游七次样本为 85.38/80.19/82.89/79.52/77.65/76.95/78.83ms，fork 为 19.93/19.41/19.22/19.08/19.33/19.25/19.17ms；中位数约 79.52→19.25ms。fork 缓存命中约 0.05–0.07ms。峰值 RSS 约 163→83MiB，保留堆约 4.54→4.48MiB。这是独立进程内索引查询诊断，排除浏览器、传输和模型成本，不是端到端产品延迟承诺。命令：`node --expose-gc tests/search.perf.mjs --upstream` 与 `node --expose-gc tests/search.perf.mjs`。
