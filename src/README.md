# src 模块骨架

各模块职责见[方案 §8.2](../docs/方案-v0.1.md#82-模块与目录)。技术栈已定为 Node.js / TypeScript；目前只有空目录，M1 开始时再初始化工程。

| 目录 | 职责 |
|---|---|
| `server/` | HTTP 入站、端点分发、SSE 输出 |
| `auth/` | 网关 key 校验、限流、IP 白名单、认证失败记录（边界防护） |
| `router/` | 场景识别、规则引擎、会话状态与切换分类、回退 |
| `protocol/anthropic/` | Messages 校验、原生透传与 compat 应用 |
| `protocol/openai-chat/` | OpenAI 格式转换器（备用，本期不实现） |
| `providers/` | 渠道注册表、“模型 × 渠道”元数据、compat profile |
| `accounts/` | 渠道 credential、额度窗口、冷却、额度连接器 |
| `enhance/` | 图片转写（M4）、搜索与抓取 MCP |
| `observability/` | 基本请求日志、usage、诊断事件 |
