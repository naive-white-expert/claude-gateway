import type { ExposedModel, GatewayConfig, TierName } from '../config/load.js';

// 客户端配置片段生成（方案 §4.9、§4.11）：桌面端 inferenceModels、cc settings 与压缩窗口都从同一份
// “模型 × 渠道”元数据生成（窗口声明同源）。网关不自动写客户端配置。

export const KEY_PLACEHOLDER = '<gateway-key>';

export interface DesktopModelEntry {
  name: string;
  labelOverride: string;
  supports1m?: boolean;
  prefer1m?: boolean;
  anthropicFamilyTier?: TierName;
  isFamilyDefault?: boolean;
  maxEffort: string;
}

export function desktopModels(cfg: GatewayConfig): DesktopModelEntry[] {
  return [...cfg.exposed.values()].map((ex) => {
    const e: DesktopModelEntry = { name: ex.id, labelOverride: ex.model.displayName, maxEffort: ex.model.maxEffort };
    if (ex.model.contextWindow >= 1_000_000) {
      e.supports1m = true;
      e.prefer1m = true;
    }
    if (ex.tier) {
      e.anthropicFamilyTier = ex.tier;
      e.isFamilyDefault = true;
    }
    return e;
  });
}

/** 桌面端 3P 配置中与网关相关的键（docs/桌面端接入.md §2.2）；其余键（浏览器、出网等）保留用户现有值。 */
export function desktopInferenceConfig(cfg: GatewayConfig, opts: { baseUrl?: string; apiKey?: string } = {}): Record<string, unknown> {
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: opts.baseUrl ?? cfg.server.publicBaseUrl,
    inferenceCredentialKind: 'static',
    inferenceGatewayApiKey: opts.apiKey ?? KEY_PLACEHOLDER,
    inferenceModels: desktopModels(cfg),
    modelDiscoveryEnabled: false,
  };
}

/** 压缩窗口：显式配置优先；否则取窗口的 75%（DeepSeek 官方 Claude Code 指南对 1M 窗口建议 786432），限制在 cc 允许的 100000–1000000。 */
export function autoCompactWindowOf(ex: ExposedModel): number {
  const w = ex.model.autoCompactWindow ?? Math.floor(ex.model.contextWindow * 0.75);
  return Math.min(Math.max(w, 100_000), 1_000_000);
}

export function maxToolUseConcurrency(cfg: GatewayConfig): number | null {
  const v = cfg.concurrencyHint.clientMaxToolUseConcurrency;
  if (v === null) return null;
  if (typeof v === 'number') return v;
  const sonnet = cfg.clients.tiers.sonnet ? cfg.modelMap.get(cfg.clients.tiers.sonnet) : undefined;
  const n = sonnet?.effectiveConcurrency;
  return n == null ? null : Math.max(n - 1, 1);
}

function tierPin(cfg: GatewayConfig, tier: TierName): string | undefined {
  for (const ex of cfg.exposed.values()) if (ex.tier === tier) return ex.id;
  return undefined;
}

/** Claude Code settings 片段（用户级 settings.json 的 env 与 modelSettings）。 */
export function ccSettings(
  cfg: GatewayConfig,
  opts: { baseUrl?: string; apiKey?: string; apiKeyHelper?: string; forDesktop?: boolean } = {},
): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (!opts.forDesktop) {
    env.ANTHROPIC_BASE_URL = opts.baseUrl ?? cfg.server.publicBaseUrl;
    if (!opts.apiKeyHelper) env.ANTHROPIC_AUTH_TOKEN = opts.apiKey ?? KEY_PLACEHOLDER;
    const sonnet = tierPin(cfg, 'sonnet');
    if (sonnet) env.ANTHROPIC_MODEL = sonnet;
    for (const t of ['opus', 'sonnet', 'haiku'] as TierName[]) {
      const pin = tierPin(cfg, t);
      if (pin) env[`ANTHROPIC_DEFAULT_${t.toUpperCase()}_MODEL`] = pin;
    }
    if (cfg.clients.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.clients.subagentModel;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
    const maxWindow = Math.max(...[...cfg.exposed.values()].map((e) => e.model.contextWindow));
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(maxWindow, 1_000_000));
    env.API_TIMEOUT_MS = '900000';
  }
  env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  const mtc = maxToolUseConcurrency(cfg);
  if (mtc != null) env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = String(mtc);

  const modelSettings: Record<string, { autoCompactWindow: number }> = {};
  for (const ex of cfg.exposed.values()) modelSettings[ex.id] = { autoCompactWindow: autoCompactWindowOf(ex) };
  const out: Record<string, unknown> = { env, modelSettings };
  if (opts.apiKeyHelper) out.apiKeyHelper = opts.apiKeyHelper;
  return out;
}

/** `cgw cc` 启动器给子进程注入的环境变量（不修改全局 settings）。 */
export function ccLaunchEnv(cfg: GatewayConfig, apiKey: string, baseUrl?: string): Record<string, string> {
  const s = ccSettings(cfg, { baseUrl, apiKey }) as { env: Record<string, string> };
  return s.env;
}
