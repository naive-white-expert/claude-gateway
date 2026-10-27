# src 模块

各模块职责见[方案 §8.2](../docs/方案-v0.1.md#82-模块与目录)。

| 目录 | 职责 |
|---|---|
| `server/` | HTTP(S) 入站与双向 TLS（`main.ts`）、端点分发、`/v1/messages` 流式与非流式转发、`/v1/models`、`count_tokens`（`app.ts`） |
| `auth/` | 网关 key 签发与校验（只存哈希）、按 key / IP 限流、认证失败封禁、IP 白名单、受信反代的真实 IP |
| `config/` | YAML + zod 配置校验（能力字段必填）、桌面端模型 ID 规则、已确认的用户文案 |
| `router/` | 会话线识别与切换检测、thinking 来源登记 |
| `protocol/anthropic/` | 出站请求改写（模型映射、`metadata.user_id`、`max_tokens`、thinking 过滤、并发说明注入、工具配对校验）、上游错误措辞改写、SSE 回流、token 估算 |
| `providers/` | 出站请求头（认证替换、beta 过滤、`x-claude-code-*` 不转发）、上游连接池与超时 |
| `limits/` | 按对外 ID 的并发上限与排队 |
| `observability/` | 结构化日志（脱敏）、请求日志元数据、改写诊断 |
| `store/` | SQLite（Node 内置 `node:sqlite`） |
| `clients/` | 桌面端与 Claude Code 配置片段生成 |
| `cli/` | `cgw` 命令 |
| `protocol/openai-chat/`、`accounts/`、`enhance/` | 备用 / 后续里程碑（M2 额度、M3、M4），本期为空 |
