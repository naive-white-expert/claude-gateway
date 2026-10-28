import { z } from 'zod';
import { CONCURRENCY_HINT_TEXT, CONCURRENCY_LIMIT_MESSAGE, HISTORY_INCOMPATIBLE_MESSAGE } from './texts.js';

const ms = z.number().int().nonnegative();

const PatternList = z.array(z.string()).default([]);

export const ProfileSchema = z
  .object({
    authHeader: z.enum(['x-api-key', 'bearer']),
    betaStrip: z.array(z.string()),
    thinkingReplay: z.enum(['keep-unsigned', 'strip-foreign', 'passthrough']),
    redactedThinking: z.enum(['supported', 'unsupported']),
    timeouts: z.object({ connectMs: ms, firstByteMs: ms, idleMs: ms }).strict(),
    countTokens: z.enum(['upstream', 'estimate']).default('estimate'),
    metadataUserId: z.enum(['strip', 'passthrough']).default('strip'),
    // 转发前从 tools 中去掉的工具名（上游对某些工具名有特殊处理时用）
    toolStrip: z.array(z.string()).default([]),
    // 已知的非 Anthropic 超长错误：正则需带命名组 req（请求 token 数）与 max（上限）
    overlongPatterns: PatternList,
    // 用户切换模型后才会出现的“回放类”400（会话专题 §4.8）
    replayErrorPatterns: PatternList,
    // 签名类错误，措辞不是 cc 能识别的形式时改写（会话专题 §4.2 第 5 条）
    signatureErrorPatterns: PatternList,
  })
  .strict();

export const ChannelSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    protocol: z.literal('anthropic_messages'),
    baseUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u), 'upstream baseUrl must be https (plain http only for loopback)'),
    billing: z.enum(['payg', 'coding-plan']),
    interactiveOnly: z.boolean().default(false),
    enabled: z.boolean().default(true),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    concurrency: z.number().int().positive().nullable(),
    profile: ProfileSchema,
    quota: z.unknown().optional(),
  })
  .strict();

export const ModelSchema = z
  .object({
    displayName: z.string().min(1),
    channel: z.string(),
    upstreamModel: z.string().min(1),
    // 能力字段必填（方案 §5.3）
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    inputModalities: z.array(z.enum(['text', 'image'])).min(1),
    thinking: z.enum(['optional', 'always-on', 'none']),
    maxEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    concurrency: z.number().int().positive().nullable().optional(),
    autoCompactWindow: z.number().int().min(100000).max(1000000).optional(),
  })
  .strict();

const Tier = z.string().nullable().optional();

export const ConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(1).max(65535),
        tls: z
          .object({
            enabled: z.boolean(),
            certFile: z.string().optional(),
            keyFile: z.string().optional(),
            clientCa: z.string().optional(),
            requireClientCert: z.boolean().default(false),
            allowedClientCNs: z.array(z.string()).default([]),
          })
          .strict()
          .default({ enabled: false }),
        publicBaseUrl: z.string().url(),
        maxRequestBodyMB: z.number().positive().default(64),
        pingIntervalMs: ms.default(15000),
        stateDir: z.string().default('/var/lib/claude-gateway'),
      })
      .strict(),
    security: z
      .object({
        keys: z.object({ acceptHeaders: z.array(z.enum(['authorization', 'x-api-key'])).default(['authorization', 'x-api-key']) }).strict().default({}),
        rateLimit: z
          .object({
            perKey: z.object({ rpm: z.number().int().positive() }).strict().default({ rpm: 240 }),
            perIpUnauthenticated: z.object({ rpm: z.number().int().positive() }).strict().default({ rpm: 30 }),
          })
          .strict()
          .default({}),
        authFailure: z
          .object({
            banAfter: z.number().int().positive().default(5),
            windowSec: z.number().int().positive().default(300),
            banSec: z.array(z.number().int().positive()).min(1).default([600, 3600, 86400]),
          })
          .strict()
          .default({}),
        ipAllowlist: z.object({ enabled: z.boolean().default(false), cidrs: z.array(z.string()).default([]) }).strict().default({}),
        trustProxyHeaders: z.boolean().default(false),
        trustedProxies: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    channels: z.array(ChannelSchema).min(1),
    models: z.record(z.string(), ModelSchema),
    clients: z
      .object({
        tiers: z.object({ sonnet: Tier, haiku: Tier, opus: Tier }).strict(),
        subagentModel: z.string().nullable().default(null),
        sessionStateTtlHours: z.number().positive().default(24),
      })
      .strict(),
    limits: z
      .object({
        queueTimeoutMs: ms.default(60000),
        rejectStatus: z.number().int().default(429),
        rejectRetryAfterSec: z.number().int().positive().default(120),
        rejectMessage: z.string().default(CONCURRENCY_LIMIT_MESSAGE),
        responseHeaders: z.enum(['ietf-draft', 'off']).default('ietf-draft'),
      })
      .strict()
      .default({}),
    concurrencyHint: z
      .object({
        clientMaxToolUseConcurrency: z.union([z.literal('auto'), z.number().int().positive(), z.null()]).default('auto'),
        injectSystemPrompt: z.union([z.literal('auto'), z.literal(false)]).default('auto'),
        injectFor: z.array(z.string()).default(['main', 'subagent']),
        textTemplate: z.string().default(CONCURRENCY_HINT_TEXT),
      })
      .strict()
      .default({}),
    switchAdvice: z
      .object({
        mode: z.literal('reactive').default('reactive'),
        messageTemplate: z.string().default(HISTORY_INCOMPATIBLE_MESSAGE),
      })
      .strict()
      .default({}),
    logging: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        requestLog: z.literal('metadata').default('metadata'),
        bodies: z.literal('off').default('off'),
        retentionDays: z.number().int().positive().default(14),
      })
      .strict()
      .default({}),
    // 后续里程碑（M4）的配置块，本期不读取
    enhance: z.unknown().optional(),
    mcp: z.unknown().optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof ConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type ModelConfig = z.infer<typeof ModelSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
