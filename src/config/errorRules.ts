import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// 上游错误分类规则（声明式，规则格式见 config/error-rules.yaml 文件头）。

export const ERROR_CLASSES = [
  'quota_exhausted',
  'rate_limited',
  'overloaded',
  'context_overflow',
  'auth_failed',
  'model_unavailable',
  'history_incompatible',
  'signature_invalid',
  'invalid_request',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number] | 'unknown';

const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['rate_limited', 'overloaded']);

export const ErrorRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    class: z.enum(ERROR_CLASSES),
    match: z
      .object({
        status: z.array(z.number().int().min(400).max(599)).min(1).optional(),
        code: z.array(z.union([z.string(), z.number()]).transform(String)).min(1).optional(),
        type: z.array(z.string()).min(1).optional(),
        message: z.string().min(1).optional(),
      })
      .strict()
      .refine((m) => m.code || m.type || m.message, 'match needs at least one of code / type / message besides status'),
    retryAfterSec: z.number().int().min(1).max(60).optional(),
    source: z.string().min(1),
    note: z.string().optional(),
  })
  .strict()
  .refine((r) => r.retryAfterSec === undefined || RETRYABLE.has(r.class), 'retryAfterSec is only allowed for rate_limited / overloaded');

export type ErrorRule = z.infer<typeof ErrorRuleSchema>;

export const RuleFileSchema = z.object({ sets: z.record(z.string(), z.array(ErrorRuleSchema)) }).strict();

export interface CompiledRule {
  id: string;
  set: string;
  class: Exclude<ErrorClass, 'unknown'>;
  status?: ReadonlySet<number>;
  code?: ReadonlySet<string>;
  type?: ReadonlySet<string>;
  message?: RegExp;
  retryAfterSec?: number;
}

export class ErrorRuleError extends Error {}

export function compileRule(rule: ErrorRule, set: string): CompiledRule {
  let message: RegExp | undefined;
  if (rule.match.message) {
    try {
      message = new RegExp(rule.match.message, 'i');
    } catch (e) {
      throw new ErrorRuleError(`error rule ${set}/${rule.id}: invalid message regex: ${(e as Error).message}`);
    }
    const src = rule.match.message;
    const hasReq = src.includes('?<req>');
    const hasMax = src.includes('?<max>');
    if (hasReq !== hasMax) throw new ErrorRuleError(`error rule ${set}/${rule.id}: named groups req and max must appear together`);
    if ((hasReq || hasMax) && rule.class !== 'context_overflow') throw new ErrorRuleError(`error rule ${set}/${rule.id}: req/max groups are only meaningful for context_overflow`);
  }
  return {
    id: rule.id,
    set,
    class: rule.class,
    status: rule.match.status ? new Set(rule.match.status) : undefined,
    code: rule.match.code ? new Set(rule.match.code) : undefined,
    type: rule.match.type ? new Set(rule.match.type) : undefined,
    message,
    retryAfterSec: rule.retryAfterSec,
  };
}

export type RuleSets = Map<string, CompiledRule[]>;

export const DEFAULT_RULES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'error-rules.yaml');

export function loadRuleSets(path: string = DEFAULT_RULES_FILE): RuleSets {
  if (!existsSync(path)) throw new ErrorRuleError(`error rules file not found: ${path}`);
  const parsed = RuleFileSchema.safeParse(parseYaml(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ErrorRuleError(`invalid error rules file ${path}:\n  ${msgs.join('\n  ')}`);
  }
  const sets: RuleSets = new Map();
  for (const [name, rules] of Object.entries(parsed.data.sets)) {
    const ids = new Set<string>();
    for (const r of rules) {
      if (ids.has(r.id)) throw new ErrorRuleError(`error rules file ${path}: duplicate rule id ${name}/${r.id}`);
      ids.add(r.id);
    }
    sets.set(name, rules.map((r) => compileRule(r, name)));
  }
  if (!sets.has('common')) throw new ErrorRuleError(`error rules file ${path}: missing the "common" set`);
  return sets;
}

/** 从上游错误体中取出分类所需的字段（Anthropic 形态、方舟 / 智谱的变体都兼容）。 */
export interface UpstreamError {
  status: number;
  code?: string;
  type?: string;
  message?: string;
}

export function parseUpstreamError(status: number, text: string): UpstreamError {
  const out: UpstreamError = { status };
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  if (!j || typeof j !== 'object') return out;
  const e = j.error && typeof j.error === 'object' ? j.error : j;
  const code = e.code ?? j.code;
  if (typeof code === 'string' || typeof code === 'number') out.code = String(code);
  if (typeof e.type === 'string' && e.type) out.type = e.type;
  const msg = e.message ?? j.message ?? j.msg;
  if (typeof msg === 'string') out.message = msg;
  return out;
}

export function classify(err: UpstreamError, rules: readonly CompiledRule[]): { rule: CompiledRule; groups?: Record<string, string> } | null {
  for (const r of rules) {
    if (r.status && !r.status.has(err.status)) continue;
    if (r.code && (err.code === undefined || !r.code.has(err.code))) continue;
    if (r.type && (err.type === undefined || !r.type.has(err.type))) continue;
    if (r.message) {
      const m = err.message === undefined ? null : r.message.exec(err.message);
      if (!m) continue;
      return { rule: r, groups: m.groups };
    }
    return { rule: r };
  }
  return null;
}
