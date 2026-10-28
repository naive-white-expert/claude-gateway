import { describe, expect, it } from 'vitest';
import { classify, compileRule, ErrorRuleSchema, loadRuleSets, parseUpstreamError, type CompiledRule } from '../src/config/errorRules.js';
import { resolveConfig, type ResolvedChannel } from '../src/config/load.js';
import { decideUpstreamError } from '../src/protocol/anthropic/errors.js';
import { fixture, testConfig } from './helpers.js';

const SETS = loadRuleSets();
const rulesFor = (...sets: string[]): CompiledRule[] => [...sets, 'common'].flatMap((s) => SETS.get(s)!);

const zhipu = (status: number, code: string, message: string, type = 'rate_limit_error') =>
  JSON.stringify({ type: 'error', error: { type, code, message: `[${code}][${message}][000000000000000000000000000000]` }, request_id: '000000000000000000000000000000' });
const ark = (status: number, code: string, message: string, type = '') => JSON.stringify({ error: { code, message, param: '', type } });
const fx = (p: string): { status: number; body: string } => {
  const f = JSON.parse(fixture(p));
  return { status: f.status, body: JSON.stringify(f.body) };
};

// 每条规则至少一个用例。real：真实样本（fixture）；doc：按官方错误码文档的原文与该渠道已实测的错误体格式构造
const CASES: { set: string; status: number; body: string; rule: string; real?: boolean }[] = [
  { set: 'deepseek', ...fx('deepseek/error-overlong.json'), rule: 'common/common-openai-overlong', real: true },
  { set: 'deepseek', status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } }), rule: 'common/common-cc-overlong' },
  { set: 'deepseek', ...fx('deepseek/error-thinking-must-be-passed-back.json'), rule: 'deepseek/deepseek-thinking-must-pass-back', real: true },
  { set: 'deepseek', ...fx('deepseek/error-redacted-thinking-422.json'), rule: 'deepseek/deepseek-redacted-thinking', real: true },
  { set: 'deepseek', ...fx('deepseek/error-unknown-model.json'), rule: 'deepseek/deepseek-unknown-model', real: true },
  { set: 'deepseek', ...fx('deepseek/error-auth-invalid.json'), rule: 'deepseek/deepseek-auth', real: true },
  { set: 'deepseek', status: 402, body: JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } }), rule: 'deepseek/deepseek-insufficient-balance' },
  { set: 'deepseek', status: 429, body: JSON.stringify({ error: { message: 'Rate Limit Reached', type: 'rate_limit_error', param: null, code: 'rate_limit_error' } }), rule: 'deepseek/deepseek-rate-limit' },
  { set: 'deepseek', status: 503, body: JSON.stringify({ error: { message: 'Server overloaded, please retry later', type: 'api_error' } }), rule: 'deepseek/deepseek-overloaded' },

  { set: 'zhipu', ...fx('zhipu-api/error-1113-insufficient-balance.json'), rule: 'zhipu/zhipu-1113-insufficient-balance', real: true },
  { set: 'zhipu', status: 429, body: zhipu(429, '1308', '已达到 5 小时的使用上限。您的限额将在 2026-10-28 15:00:00 重置'), rule: 'zhipu/zhipu-plan-quota-reached' },
  { set: 'zhipu', status: 429, body: zhipu(429, '1309', '您的 GLM Coding Plan 套餐已到期，暂无法使用'), rule: 'zhipu/zhipu-plan-expired' },
  { set: 'zhipu', status: 429, body: zhipu(429, '1313', '您的账户当前使用模式不符合公平使用策略，请求频率已受到限制'), rule: 'zhipu/zhipu-fair-use-restricted' },
  { set: 'zhipu', status: 429, body: zhipu(429, '1311', '当前订阅套餐暂未开放 glm-5.3 权限'), rule: 'zhipu/zhipu-plan-model-not-included' },
  { set: 'zhipu', status: 429, body: zhipu(429, '1315', '该 API Key 仅限企业编程套餐场景使用'), rule: 'zhipu/zhipu-key-plan-mismatch' },
  { set: 'zhipu', status: 429, body: zhipu(429, '1302', '您的账户已达到速率限制，请您控制请求频率'), rule: 'zhipu/zhipu-1302-rate-limit' },
  { set: 'zhipu', status: 529, body: zhipu(529, '1305', '该模型当前访问量过大，请您稍后再试', 'overloaded_error'), rule: 'zhipu/zhipu-1305-overloaded' },
  { set: 'zhipu', status: 400, body: zhipu(400, '1261', 'Prompt 超长', 'invalid_request_error'), rule: 'zhipu/zhipu-1261-prompt-too-long' },
  { set: 'zhipu', ...fx('zhipu-coding/error-unknown-model.json'), rule: 'zhipu/zhipu-1211-unknown-model', real: true },
  { set: 'zhipu', ...fx('zhipu-coding/error-max-tokens-over.json'), rule: 'zhipu/zhipu-invalid-parameter', real: true },
  { set: 'zhipu', ...fx('zhipu-api/error-1210-thinking-disabled.json'), rule: 'zhipu/zhipu-invalid-parameter', real: true },
  { set: 'zhipu', status: 401, body: JSON.stringify({ error: { message: '令牌已过期或验证不正确', type: '401' } }), rule: 'zhipu/zhipu-auth', real: true },

  { set: 'ark', ...fx('ark-coding/error-unsupported-model-404.json'), rule: 'ark/ark-unsupported-model', real: true },
  { set: 'ark', status: 429, body: ark(429, 'QuotaExceeded', 'You have exceeded the 5-hour/weekly/monthly usage quota. It will reset at 2026-10-28 15:00:00.'), rule: 'ark/ark-plan-usage-quota' },
  { set: 'ark', status: 429, body: ark(429, 'QuotaExceeded', 'Your account [2100000000] has exhausted its free trial quota for the [deepseek-v4-pro] model. Request ID: x.'), rule: 'ark/ark-free-trial-quota' },
  { set: 'ark', status: 429, body: ark(429, 'QuotaExceeded', 'The request has exceeded the quota. Request ID: x.'), rule: 'ark/ark-queued-tasks-limit' },
  { set: 'ark', status: 429, body: ark(429, 'AccountQuotaExceeded', 'The request has exceeded the quota. Request id: x.'), rule: 'ark/ark-account-quota' },
  { set: 'ark', status: 403, body: ark(403, 'AccountOverdueError', 'The request failed because your account has an overdue balance.'), rule: 'ark/ark-account-overdue' },
  { set: 'ark', status: 429, body: ark(429, 'ModelAccountTpmRateLimitExceeded', 'TPM (Tokens Per Minute) limit of the model is exceeded. Request ID: x.'), rule: 'ark/ark-rate-limit' },
  { set: 'ark', status: 429, body: ark(429, 'ServerOverloaded', 'The service is currently unable to handle additional requests due to server overload.'), rule: 'ark/ark-server-overloaded' },
  { set: 'ark', status: 400, body: ark(400, 'OutofContextError', 'Total tokens of image and text exceed max message tokens.'), rule: 'ark/ark-out-of-context' },
  { set: 'ark', status: 401, body: ark(401, 'AuthenticationError', 'The API key format is incorrect. Request id: x', 'Unauthorized'), rule: 'ark/ark-auth', real: true },
];

describe('shipped error rules', () => {
  it('load, validate and every rule has a source', () => {
    for (const set of SETS.values()) expect(set.length).toBeGreaterThan(0);
    expect([...SETS.keys()].sort()).toEqual(['ark', 'common', 'deepseek', 'zhipu']);
  });

  it.each(CASES)('$rule ← $status ($set)', ({ set, status, body, rule }) => {
    const hit = classify(parseUpstreamError(status, body), rulesFor(set));
    expect(hit && `${hit.rule.set}/${hit.rule.id}`).toBe(rule);
  });

  it('every shipped rule is covered by at least one case', () => {
    const covered = new Set(CASES.map((c) => c.rule));
    const all = [...SETS.values()].flat().map((r) => `${r.set}/${r.id}`);
    expect(all.filter((r) => !covered.has(r))).toEqual([]);
  });

  it('tells apart errors with the same status but different codes', () => {
    const r = rulesFor('zhipu');
    expect(classify(parseUpstreamError(429, zhipu(429, '1113', '余额不足或无可用资源包,请充值。')), r)?.rule.class).toBe('quota_exhausted');
    expect(classify(parseUpstreamError(429, zhipu(429, '1302', '您的账户已达到速率限制')), r)?.rule.class).toBe('rate_limited');
    expect(classify(parseUpstreamError(429, zhipu(429, '1305', '该模型当前访问量过大')), r)?.rule.class).toBe('overloaded');
    const a = rulesFor('ark');
    expect(classify(parseUpstreamError(429, ark(429, 'QuotaExceeded', 'The request has exceeded the quota. Request ID: x.')), a)?.rule.class).toBe('rate_limited');
    expect(classify(parseUpstreamError(429, ark(429, 'AccountQuotaExceeded', 'The request has exceeded the quota. Request id: x.')), a)?.rule.class).toBe('quota_exhausted');
  });

  it('leaves unmatched errors unclassified', () => {
    expect(classify(parseUpstreamError(429, zhipu(429, '9999', 'new code')), rulesFor('zhipu'))).toBeNull();
    expect(classify(parseUpstreamError(500, '<html>bad gateway</html>'), rulesFor('zhipu', 'ark', 'deepseek'))).toBeNull();
    // 同一错误码换了渠道（规则集不同）不命中
    expect(classify(parseUpstreamError(429, zhipu(429, '1113', 'x')), rulesFor('ark'))).toBeNull();
  });
});

describe('rule validation', () => {
  const base = { id: 'x', class: 'rate_limited', source: 'test' };
  it('rejects a rule that only looks at the status code', () => {
    expect(ErrorRuleSchema.safeParse({ ...base, match: { status: [429] } }).success).toBe(false);
  });
  it('rejects retryAfterSec on a non-retryable class and values above 60', () => {
    expect(ErrorRuleSchema.safeParse({ ...base, class: 'quota_exhausted', match: { code: ['1'] }, retryAfterSec: 5 }).success).toBe(false);
    expect(ErrorRuleSchema.safeParse({ ...base, match: { code: ['1'] }, retryAfterSec: 61 }).success).toBe(false);
  });
  it('rejects bad regexes and unpaired req/max groups', () => {
    const p = (message: string, cls = 'context_overflow') => compileRule(ErrorRuleSchema.parse({ ...base, class: cls, match: { message } }), 't');
    expect(() => p('(')).toThrow(/invalid message regex/);
    expect(() => p('(?<req>\\d+) only')).toThrow(/req and max/);
    expect(() => p('(?<req>\\d+) > (?<max>\\d+)', 'rate_limited')).toThrow(/context_overflow/);
  });
  it('rejects an unknown rule set name in a channel profile', () => {
    expect(() => testConfig('http://127.0.0.1:9', (raw) => (raw.channels[0].profile.errorRuleSets = ['nope']))).toThrow(/unknown rule set "nope"/);
  });
  it('applies inline channel rules before the referenced sets', () => {
    const cfg = testConfig('http://127.0.0.1:9', (raw) => {
      raw.channels[1].profile.errorRules = [{ id: 'local-1113', class: 'rate_limited', match: { code: ['1113'] }, source: 'test' }];
    });
    const ch = cfg.channelMap.get('plan')!;
    expect(classify(parseUpstreamError(429, zhipu(429, '1113', 'x')), ch.errorRules)?.rule.id).toBe('local-1113');
  });
  it('resolveConfig without a rules file option uses the shipped file', () => {
    const cfg = testConfig('http://127.0.0.1:9');
    expect(cfg.channelMap.get('deepseek')!.errorRules.at(-1)?.set).toBe('common');
    expect(typeof resolveConfig).toBe('function');
  });
});

describe('responses by class', () => {
  const cfg = testConfig('http://127.0.0.1:9');
  const ds = cfg.channelMap.get('deepseek')!;
  const zp = cfg.channelMap.get('plan')!;
  const ctx = (channel: ResolvedChannel, switched = false) => ({ channel, switched, historyMessage: () => 'HISTORY' });

  it('quota exhausted: same status and original message, billing_error type, x-should-retry false', () => {
    const f = fx('zhipu-api/error-1113-insufficient-balance.json');
    const d = decideUpstreamError(f.status, f.body, {}, ctx(zp));
    expect(d.errorClass).toBe('quota_exhausted');
    expect(d.status).toBe(429);
    expect(d.headers).toEqual({ 'x-should-retry': 'false' });
    const j = JSON.parse(d.body);
    const orig = JSON.parse(f.body);
    expect(j.error.type).toBe('billing_error');
    expect(j.error.message).toBe(orig.error.message);
    expect(j.error.code).toBe('1113');
    expect(j.request_id).toBe(orig.request_id);
  });

  it('quota exhausted with an envelope lacking type:error gets the Anthropic envelope', () => {
    const d = decideUpstreamError(403, ark(403, 'AccountOverdueError', 'overdue'), {}, ctx({ ...zp, errorRules: rulesFor('ark') }));
    expect(JSON.parse(d.body)).toMatchObject({ type: 'error', error: { type: 'billing_error', code: 'AccountOverdueError', message: 'overdue' } });
    expect(d.status).toBe(403);
  });

  it('rate limited / overloaded stay retryable and get retry-after only when upstream gave none', () => {
    const body = zhipu(429, '1302', '您的账户已达到速率限制');
    const d = decideUpstreamError(429, body, {}, ctx(zp));
    expect(d).toMatchObject({ errorClass: 'rate_limited', status: 429, body, headers: { 'retry-after': '5' }, bodyRewritten: false });
    expect(decideUpstreamError(429, body, { 'retry-after': '30' }, ctx(zp)).headers).toEqual({});
    expect(decideUpstreamError(529, zhipu(529, '1305', '访问量过大'), {}, ctx(zp)).headers).toEqual({ 'retry-after': '10' });
  });

  it('non-retryable classes keep the body and only add x-should-retry: false', () => {
    const body = zhipu(429, '1311', '当前订阅套餐暂未开放 glm-5.3 权限');
    const d = decideUpstreamError(429, body, {}, ctx(zp));
    expect(d).toMatchObject({ errorClass: 'model_unavailable', status: 429, body, headers: { 'x-should-retry': 'false' }, bodyRewritten: false });
    const a = fx('deepseek/error-auth-invalid.json');
    expect(decideUpstreamError(a.status, a.body, {}, ctx(ds))).toMatchObject({ errorClass: 'auth_failed', body: a.body, headers: { 'x-should-retry': 'false' } });
  });

  it('context overflow: rewritten with numbers, plain when the original has none, untouched when cc already recognizes it', () => {
    const f = fx('deepseek/error-overlong.json');
    expect(JSON.parse(decideUpstreamError(f.status, f.body, {}, ctx(ds)).body).error.message).toBe('prompt is too long: 1132004 tokens > 1048576 maximum');
    expect(JSON.parse(decideUpstreamError(400, zhipu(400, '1261', 'Prompt 超长', 'invalid_request_error'), {}, ctx(zp)).body).error.message).toBe('prompt is too long');
    const cc = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 3 tokens > 2 maximum' } });
    expect(decideUpstreamError(400, cc, {}, ctx(ds))).toMatchObject({ errorClass: 'context_overflow', body: cc, bodyRewritten: false, headers: {} });
  });

  it('history incompatible is rewritten only after a user switch', () => {
    const f = fx('deepseek/error-thinking-must-be-passed-back.json');
    expect(decideUpstreamError(f.status, f.body, {}, ctx(ds, false))).toMatchObject({ errorClass: 'history_incompatible', body: f.body, bodyRewritten: false });
    expect(JSON.parse(decideUpstreamError(f.status, f.body, {}, ctx(ds, true)).body).error.message).toBe('HISTORY');
  });

  it('unknown errors pass through byte for byte with no added headers', () => {
    const body = '{"error":{"code":"9999","message":"something new"}}';
    expect(decideUpstreamError(429, body, {}, ctx(zp))).toMatchObject({ errorClass: 'unknown', ruleId: null, status: 429, body, headers: {}, bodyRewritten: false });
  });

  it('diagnostics carry class, rule, status and code but no message text', () => {
    const f = fx('zhipu-api/error-1113-insufficient-balance.json');
    const d = decideUpstreamError(f.status, f.body, {}, ctx(zp));
    expect(d.diag.detail).toBe('class=quota_exhausted rule=zhipu/zhipu-1113-insufficient-balance status=429 code=1113 type=rate_limit_error');
    expect(d.diag.detail).not.toContain('余额');
  });
});
