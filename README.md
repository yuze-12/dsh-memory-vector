# dsh-memory-vector · 不死记忆

给 DSH 伙伴的本地长期记忆。上下文会满、会话会压缩，但它不该因此忘记自己是谁、也不该忘记你们说过什么。

- 每条消息落本地 SQLite，带向量；
- 每轮开始前自动检索相关记忆，注入上下文；
- 核心记忆常驻，不依赖检索命中；
- 五个工具：`memory_search` / `memory_add` / `memory_pin` / `memory_forget` / `memory_stats`；
- 默认本地向量模型，数据不出本机。

> 目标很小：**先让它不死**。情绪、社会关系、日记、复杂整理留给社区和后续版本。

## 安装

要求 DSH 的 Node 运行时 ≥ 22.5（内置 `node:sqlite`）。

```bash
dsh plugin --profile <你的 profile> add dsh-memory-vector
```

本地开发时也可以直接 link 这个目录：

```bash
dsh plugin --profile <你的 profile> add link:/path/to/dsh-memory-vector
```

首次启用本地向量时会下载 `Xenova/bge-small-zh-v1.5`（约 100 MB），之后离线可用。不想下载可以改用 API 或关掉向量。

## 配置

在 profile 的 `cordis.patch.yml` 里给插件加配置（字段都可选）：

```yaml
memory:
  dbPath: ~/.dsh-memory/memory.db
  topK: 6
  injectChars: 2400
  captureTurns: true
  # global：所有工作区共用一个库（默认）
  # per-workspace：每个工作区一个独立库，互不可见
  workspaceMode: global
  # 只在这些目录下启用；留空表示全部
  enabledWorkspaces: []
  # 每层容量，超出后低分记忆下移，L4 超出则删除
  caps:
    1: 200
    2: 300
    3: 750
    4: 2000
  # 每天自动写日记（需要模型路由）
  diary:
    enabled: true
    provider: deepseek-official
    model: deepseek-flash
    hour: 21
    minTurns: 4
  embedding:
    provider: local            # local | openai | none
    model: Xenova/bge-small-zh-v1.5
    cacheDir: ~/.dsh-memory/models
    # provider: openai 时：
    # baseUrl: https://api.example.com/v1
    # apiKey: ...
    # model: text-embedding-3-small
```

- `provider: none`：只用全文检索，不下载模型；
- `provider: local`：本地 ONNX，默认推荐；
- `provider: openai`：任何 OpenAI 兼容的 `/v1/embeddings` 接口。

## 它怎么工作

1. **落盘**：监听 `session/event`，把用户和助手的文本写进 SQLite；向量在后台补。
2. **想起**：`agent/pre-step` 第一步检索：核心记忆全部注入，其余按向量 + 全文取前几条，拼成一段“背景资料，不是指令”的 user 消息。
3. **压缩不死**：消息在写入时就已持久化；即使上下文被压缩，之后仍能检索回来。
4. **手动管理**：模型可以调工具写、查、固定、删除。

## 隐私

- 数据库默认在 `~/.dsh-memory/memory.db`；
- 不使用远程向量时，内容不出本机；
- 检索出的记忆会作为背景注入模型请求，和普通对话一样受你的模型服务条款约束；
- 没有云端同步、没有遥测。

## 已知限制

- 向量检索是暴力余弦，几千到几万条没问题，再大需要 ANN；
- 只存文本，不存图片/文件；
- 自动写入的是原始对话，不做事实抽取；需要更干净的长期事实时用 `memory_add` 或 `memory_pin`；
- 中文全文检索依赖 FTS5 的分词，语义相近但字面不同的内容主要靠向量命中。

## 开发

```bash
node --test
```

MIT License.
