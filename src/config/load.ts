import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type ChannelConfig, type ModelConfig, type RawConfig } from './schema.js';
import { checkDesktopModelId } from './desktopModelId.js';

// 所有渠道共用的内置识别规则（M0 实测原文，见 docs/M0-渠道行为.md）；渠道 profile 中的规则在此基础上追加。
export const BUILTIN_OVERLONG = [
  // DeepSeek 官方 /anthropic：This model's maximum context length is 1048576 tokens. However, you requested 1132004 tokens (...)
  String.raw`maximum context length is (?<max>\d+) tokens\. However, you requested (?<req>\d+) tokens`,
];
export const BUILTIN_REPLAY = [
  // DeepSeek 官方 /anthropic：thinking 模式下历史工具调用轮缺少 thinking
  String.raw`content\[\]\.thinking.{0,3} in the thinking mode must be passed back`,
];

export type TierName = 'sonnet' | 'haiku' | 'opus';
export const TIER_ORDER: TierName[] = ['sonnet', 'opus', 'haiku'];

export interface ResolvedChannel extends ChannelConfig {
  overlong: RegExp[];
  replay: RegExp[];
  signature: RegExp[];
  apiKey: string | undefined;
}

export interface ResolvedModel extends ModelConfig {
  id: string;
  channelRef: ResolvedChannel;
  effectiveConcurrency: number | null;
}

export interface ExposedModel {
  /** 对外 ID（客户端发来的 model） */
  id: string;
  /** 实际转发所用的模型条目（档位别名指向原条目） */
  model: ResolvedModel;
  tier?: TierName;
  isTierAlias: boolean;
}

export interface GatewayConfig extends RawConfig {
  channelMap: Map<string, ResolvedChannel>;
  modelMap: Map<string, ResolvedModel>;
  /** 对外 ID → 条目（含档位别名），按 /v1/models 的顺序 */
  exposed: Map<string, ExposedModel>;
  warnings: string[];
}

export class ConfigError extends Error {}

function compile(list: string[], where: string, needGroups: boolean): RegExp[] {
  return list.map((src) => {
    let re: RegExp;
    try {
      re = new RegExp(src, 'i');
    } catch (e) {
      throw new ConfigError(`${where}: invalid regex ${JSON.stringify(src)}: ${(e as Error).message}`);
    }
    if (needGroups && !(src.includes('?<req>') && src.includes('?<max>')))
      throw new ConfigError(`${where}: overlong pattern must contain named groups (?<req>..) and (?<max>..): ${src}`);
    return re;
  });
}

function expandEnv(s: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (s === undefined) return s;
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k: string) => {
    const v = env[k];
    if (v === undefined) throw new ConfigError(`environment variable ${k} referenced in config is not set`);
    return v;
  });
}

export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env, opts: { requireKeys?: boolean } = {}): GatewayConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`invalid config:\n  ${msgs.join('\n  ')}`);
  }
  const cfg = parsed.data;
  const warnings: string[] = [];

  if (cfg.server.tls.enabled) {
    for (const k of ['certFile', 'keyFile'] as const) if (!cfg.server.tls[k]) throw new ConfigError(`server.tls.${k} is required when tls.enabled`);
    if (cfg.server.tls.requireClientCert && !cfg.server.tls.clientCa) throw new ConfigError('server.tls.clientCa is required when requireClientCert');
    cfg.server.tls.certFile = expandEnv(cfg.server.tls.certFile, env);
    cfg.server.tls.keyFile = expandEnv(cfg.server.tls.keyFile, env);
    cfg.server.tls.clientCa = expandEnv(cfg.server.tls.clientCa, env);
  }
  if (cfg.security.trustProxyHeaders && cfg.security.trustedProxies.length === 0)
    throw new ConfigError('security.trustProxyHeaders requires security.trustedProxies');

  const channelMap = new Map<string, ResolvedChannel>();
  for (const ch of cfg.channels) {
    if (channelMap.has(ch.id)) throw new ConfigError(`duplicate channel id ${ch.id}`);
    const where = `channels.${ch.id}.profile`;
    const apiKey = env[ch.apiKeyEnv] || undefined;
    if (ch.enabled && !apiKey) {
      if (opts.requireKeys) throw new ConfigError(`channel ${ch.id}: environment variable ${ch.apiKeyEnv} is not set (set enabled: false to keep it configured but unused)`);
      warnings.push(`channel ${ch.id}: ${ch.apiKeyEnv} not set`);
    }
    channelMap.set(ch.id, {
      ...ch,
      apiKey,
      overlong: compile([...BUILTIN_OVERLONG, ...ch.profile.overlongPatterns], `${where}.overlongPatterns`, true),
      replay: compile([...BUILTIN_REPLAY, ...ch.profile.replayErrorPatterns], `${where}.replayErrorPatterns`, false),
      signature: compile(ch.profile.signatureErrorPatterns, `${where}.signatureErrorPatterns`, false),
    });
  }

  const modelMap = new Map<string, ResolvedModel>();
  for (const [id, m] of Object.entries(cfg.models)) {
    const check = checkDesktopModelId(id);
    if (!check.ok) throw new ConfigError(`models.${id}: external model ID rejected: ${check.reason}`);
    const ch = channelMap.get(m.channel);
    if (!ch) throw new ConfigError(`models.${id}: unknown channel ${m.channel}`);
    const effectiveConcurrency = m.concurrency !== undefined ? m.concurrency : ch.concurrency;
    modelMap.set(id, { ...m, id, channelRef: ch, effectiveConcurrency });
  }

  const exposed = new Map<string, ExposedModel>();
  const tierOf = new Map<string, TierName>();
  const usedIds = new Set<string>();
  for (const tier of TIER_ORDER) {
    const target = cfg.clients.tiers[tier];
    if (!target) continue;
    const m = modelMap.get(target);
    if (!m) throw new ConfigError(`clients.tiers.${tier}: unknown model ${target}`);
    if (!m.channelRef.enabled) throw new ConfigError(`clients.tiers.${tier}: model ${target} uses disabled channel ${m.channel}`);
    if (!usedIds.has(target)) {
      usedIds.add(target);
      tierOf.set(target, tier);
      exposed.set(target, { id: target, model: m, tier, isTierAlias: false });
    } else {
      // 桌面端每个 inferenceModels 条目只能带一个档位、name 不能重复：为后出现的档位生成档位别名（方案 §4.9）
      const alias = `${target}-${tier}`;
      const check = checkDesktopModelId(alias);
      if (!check.ok) throw new ConfigError(`tier alias ${alias}: ${check.reason}`);
      if (modelMap.has(alias)) throw new ConfigError(`tier alias ${alias} collides with a configured model`);
      exposed.set(alias, { id: alias, model: m, tier, isTierAlias: true });
    }
  }
  for (const [id, m] of modelMap) {
    if (exposed.has(id) || !m.channelRef.enabled) continue;
    exposed.set(id, { id, model: m, isTierAlias: false });
  }
  if (cfg.clients.subagentModel && !exposed.has(cfg.clients.subagentModel))
    throw new ConfigError(`clients.subagentModel: unknown model ${cfg.clients.subagentModel}`);

  return { ...cfg, channelMap, modelMap, exposed, warnings };
}

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env, opts: { requireKeys?: boolean } = {}): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config ${path}: ${(e as Error).message}`);
  }
  return resolveConfig(parseYaml(text), env, opts);
}
