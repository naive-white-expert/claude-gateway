// 桌面端 gateway provider 的模型 ID 检查（docs/桌面端接入.md §2.4）。
// 片段表与判定逻辑取自 Claude 桌面端 3.6556.2（macOS）app.asar 中的字符串常量，逐字一致。
export const DESKTOP_RULE_SOURCE = 'Claude Desktop 3.6556.2';

const TIERS = ['sonnet', 'opus', 'haiku', 'fable', 'mythos'];
const TIER_ALIAS = new RegExp(`^(${TIERS.join('|')})(-[\\d.]+)?$`);
const ANTHROPIC_WORDS = ['claude', ...TIERS, 'anthropic'];
const NON_ANTHROPIC_FRAGMENTS =
  /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;

export function checkDesktopModelId(id: string): { ok: true } | { ok: false; reason: string } {
  const lower = id.toLowerCase();
  const hit = NON_ANTHROPIC_FRAGMENTS.exec(lower);
  if (hit) return { ok: false, reason: `contains non-Anthropic fragment "${hit[0]}" (${DESKTOP_RULE_SOURCE} would drop it)` };
  if (TIER_ALIAS.test(lower) || ANTHROPIC_WORDS.some((w) => lower.includes(w))) return { ok: true };
  return { ok: false, reason: `must contain one of ${ANTHROPIC_WORDS.join('/')} (${DESKTOP_RULE_SOURCE} would drop it)` };
}
