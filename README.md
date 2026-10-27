# claude-gateway

一个人自己部署的网关，让 **Claude 桌面端（Code 模式）** 和 Claude Code 顺畅使用国产模型。

网关部署在你自己的服务器上，入站只说 Anthropic 协议，出站走各上游的原生 Anthropic 兼容端点。默认纯透传，只做必要的兼容改写，每一处改写都记录下来。网关处理的问题包括：

- 桌面端对模型 ID 的要求；
- 会话中途换模型；
- prompt 缓存；
- 上下文窗口与自动压缩。

单部署、单使用者。

## 当前状态

**设计阶段，尚无可用实现。** 仓库里目前只有设计文档、配置格式草案和目录骨架。

## 计划支持的上游

| 渠道 | 端点 | 计费 |
|---|---|---|
| DeepSeek 官方 | `https://api.deepseek.com/anthropic` | 按量 |
| 智谱 GLM 开放平台 | `https://open.bigmodel.cn/api/anthropic` | 按量 |
| 智谱 GLM Coding Plan | 同上 | 订阅套餐 |
| 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | 订阅套餐 |
| 火山方舟（按量） | `https://ark.cn-beijing.volces.com/api/compatible` | 按量 |

配置以“模型 × 渠道”为单位：同一个模型可以有多条渠道。端点与模型列表以各家官方文档为准，见[方案 §5.2](docs/方案-v0.1.md#52-首批渠道核实结果2026-10-27)。

## 关于 Coding Plan

各家 Coding Plan 对使用范围有限制（例如限定支持的编码工具、限定本人交互式使用）。使用 Coding Plan 渠道前，请自行阅读并遵守官方条款：

- 智谱：[订阅及自动续费协议](https://docs.bigmodel.cn/cn/terms/subscription-agreement)、[使用须知](https://docs.bigmodel.cn/cn/coding-plan/usage-notes)
- 火山方舟：[大模型订阅套餐服务专用条款](https://ark.volcengine.com/region:cn-beijing/docs/subscription-package-service-terms-conditions)

本项目不提供、也不鼓励任何转售、共享或池化套餐额度的用法。详见[方案 §6.3](docs/方案-v0.1.md#63-coding-plan-使用范围)。

## 文档

- [方案 v0.1](docs/方案-v0.1.md)：定位与纯透传原则、架构、兼容策略、渠道核实、安全设计、部署、里程碑、开放设计问题、边界。
- [Claude 桌面端接入](docs/桌面端接入.md)：桌面端 3P / Gateway 配置、模型 ID 检查、模型发现、窗口与压缩、与 CLI 的差异（附证据）。
- [会话管理与模型切换](docs/会话管理与模型切换.md)：Claude Code 原生的切换行为（附证据）与网关侧策略。
- [参考项目源码调研](docs/research/参考项目源码调研.md)：Claude Code Router 与 deepseek-harness 的版本锁定和源码证据。
- [配置示例](config/gateway.example.yaml)：配置格式草案。

## 目录

```text
docs/            方案与调研
config/          配置示例
deploy/          部署示例（反代机 nginx 配置等）
src/             模块骨架（见 src/README.md）
test/            契约测试与脱敏 fixture
scripts/         辅助脚本
```

## 约定

- 不提交第三方源码。参考仓库 clone 在本仓库之外，或放在已被 `.gitignore` 忽略的 `refs/` 下。
- 不提交密钥、真实配置和未脱敏的抓包数据；配置示例只使用占位符。

## 致谢

- [Claude Code Router（CCR）](https://github.com/musistudio/claude-code-router)：场景路由、key 池、额度连接器、托管搜索等思路。
- [deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)：声明式 compat 描述国产模型差异、严格的 tool_use / thinking 校验。

- [Hermes Agent（Nous Research）](https://github.com/NousResearch/hermes-agent)：第三方 Anthropic 端点的 thinking 回放策略、大图压缩与 MIME 嗅探、错误分类。

三者均为 MIT 许可。本仓库目前只在文档中引用它们的源码位置，不包含其代码。今后如复用代码，会在 `THIRD_PARTY_NOTICES` 中保留原版权声明并注明出处（[方案 §8.6](docs/方案-v0.1.md#86-第三方代码与许可)）。

## 许可证

[MIT](LICENSE)
