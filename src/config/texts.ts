// 面向用户的三段文案，均为 2026-10-27 用户确认的原文（方案 §4.12、会话专题 §4.8），不得改写。
// 配置中可以覆盖模板，但默认值必须与文档原文一致。

export const CONCURRENCY_LIMIT_MESSAGE =
  '「{模型显示名}」当前同时进行中的请求已达上限（{N} 个，包括主对话和子任务），本次请求排队 60 秒后仍未轮到，已取消。可以稍后重发，或在模型选择器中切换到其他模型继续。（诊断码 cgw_concurrency_limit）';

export const HISTORY_INCOMPATIBLE_MESSAGE =
  '切换到「{新模型}」后，这段对话里由「{原模型}」产生的历史记录（思考过程或工具调用记录）不被新模型接受，本轮无法继续。你可以：① 压缩后继续——先切回「{原模型}」，发送 /compact，完成后再切到「{新模型}」；② 新建一个对话，直接使用「{新模型}」。（诊断码 cgw_history_incompatible）';

export const CONCURRENCY_HINT_TEXT =
  '[claude-gateway] 你当前使用的模型渠道同时最多处理 {N} 个请求（主对话与所有子 agent 合计）。并行启动子 agent 或批量并行调用工具时，请让同时运行的子 agent 不超过 {N-1} 个；任务较多时分批进行，等前一批完成后再启动下一批。超出上限的请求会排队，排队超过 60 秒会失败。';

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
