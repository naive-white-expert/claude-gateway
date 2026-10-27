import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkDesktopModelId } from '../src/config/desktopModelId.js';
import { ConfigError, loadConfigFile, resolveConfig } from '../src/config/load.js';
import { CONCURRENCY_HINT_TEXT, CONCURRENCY_LIMIT_MESSAGE, HISTORY_INCOMPATIBLE_MESSAGE } from '../src/config/texts.js';
import { ccSettings, desktopInferenceConfig } from '../src/clients/generate.js';
import { testConfig } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');

describe('desktop model id check', () => {
  it.each(['claude-gw-dsflash', 'claude-gw-dsflash-haiku', 'claude-gw-zp53flash-plan', 'claude-gw-dsv4pro-hs', 'claude-sonnet-4-6', 'sonnet', 'opus-4'])('accepts %s', (id) => {
    expect(checkDesktopModelId(id).ok).toBe(true);
  });
  it.each(['deepseek-v4-pro', 'claude-deepseek-v4', 'claude-gw-ds-pro', 'glm-5.3', 'claude-gw-kimi', 'gw-flash', 'claude-gw-seed-2'])('rejects %s', (id) => {
    expect(checkDesktopModelId(id).ok).toBe(false);
  });
});

describe('confirmed texts', () => {
  it('match the documented originals word for word', () => {
    const plan = readFileSync(join(ROOT, 'docs/方案-v0.1.md'), 'utf8');
    const session = readFileSync(join(ROOT, 'docs/会话管理与模型切换.md'), 'utf8');
    expect(plan).toContain(CONCURRENCY_LIMIT_MESSAGE);
    expect(plan).toContain(CONCURRENCY_HINT_TEXT);
    expect(session).toContain(HISTORY_INCOMPATIBLE_MESSAGE);
  });
});

describe('config loading', () => {
  it('loads the example config', () => {
    const cfg = loadConfigFile(join(ROOT, 'config/gateway.example.yaml'), {});
    expect([...cfg.exposed.keys()].slice(0, 3)).toEqual(['claude-gw-dsflash', 'claude-gw-zp53flash-plan', 'claude-gw-dsflash-haiku']);
    expect(cfg.exposed.get('claude-gw-dsflash-haiku')?.model.id).toBe('claude-gw-dsflash');
    expect(cfg.warnings.length).toBeGreaterThan(0);
  });

  it('rejects a model missing a capability field', () => {
    const raw = parse(readFileSync(join(ROOT, 'config/gateway.example.yaml'), 'utf8'));
    delete raw.models['claude-gw-dsflash'].maxOutputTokens;
    expect(() => resolveConfig(raw, {})).toThrow(/models\.claude-gw-dsflash\.maxOutputTokens/);
  });

  it('rejects an external id the desktop app would drop', () => {
    const raw = parse(readFileSync(join(ROOT, 'config/gateway.example.yaml'), 'utf8'));
    raw.models['claude-gw-ds-pro'] = raw.models['claude-gw-dsv4pro'];
    expect(() => resolveConfig(raw, {})).toThrow(ConfigError);
  });

  it('rejects an unknown profile field and a missing profile field', () => {
    const raw = parse(readFileSync(join(ROOT, 'config/gateway.example.yaml'), 'utf8'));
    delete raw.channels[0].profile.thinkingReplay;
    expect(() => resolveConfig(raw, {})).toThrow(/thinkingReplay/);
  });

  it('requires upstream keys when asked', () => {
    const raw = parse(readFileSync(join(ROOT, 'config/gateway.example.yaml'), 'utf8'));
    expect(() => resolveConfig(raw, {}, { requireKeys: true })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('rejects plain http upstreams that are not loopback', () => {
    const raw = parse(readFileSync(join(ROOT, 'config/gateway.example.yaml'), 'utf8'));
    raw.channels[0].baseUrl = 'http://api.deepseek.com/anthropic';
    expect(() => resolveConfig(raw, {})).toThrow(/https/);
  });

  it('expands ${ENV} in tls paths', () => {
    const raw = parse(readFileSync(join(ROOT, 'config/gateway.example.yaml'), 'utf8'));
    raw.server.tls.keyFile = '${CREDENTIALS_DIRECTORY}/server.key';
    const cfg = resolveConfig(raw, { CREDENTIALS_DIRECTORY: '/run/credentials/x' });
    expect(cfg.server.tls.keyFile).toBe('/run/credentials/x/server.key');
  });
});

describe('client config generation', () => {
  const cfg = testConfig('http://127.0.0.1:9');
  it('desktop entries carry tiers, 1M and effort, with a haiku tier alias', () => {
    const d = desktopInferenceConfig(cfg) as any;
    expect(d.inferenceProvider).toBe('gateway');
    expect(d.inferenceGatewayApiKey).toBe('<gateway-key>');
    expect(d.inferenceModels).toEqual([
      { name: 'claude-gw-dsflash', labelOverride: 'DeepSeek V4.1 Flash（官方）', maxEffort: 'max', supports1m: true, prefer1m: true, anthropicFamilyTier: 'sonnet', isFamilyDefault: true },
      { name: 'claude-gw-zp53flash-plan', labelOverride: 'GLM-5.3-Flash（智谱 Coding Plan）', maxEffort: 'max', supports1m: true, prefer1m: true, anthropicFamilyTier: 'opus', isFamilyDefault: true },
      { name: 'claude-gw-dsflash-haiku', labelOverride: 'DeepSeek V4.1 Flash（官方）', maxEffort: 'max', supports1m: true, prefer1m: true, anthropicFamilyTier: 'haiku', isFamilyDefault: true },
    ]);
  });
  it('cc settings pin every tier and derive compaction windows from the same metadata', () => {
    const s = ccSettings(cfg) as any;
    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-gw-dsflash-haiku');
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-gw-zp53flash-plan');
    expect(s.env.ANTHROPIC_MODEL).toBe('claude-gw-dsflash');
    expect(s.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBe('1');
    expect(s.modelSettings['claude-gw-dsflash'].autoCompactWindow).toBe(786432);
    expect(s.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toBeUndefined();
  });
  it('max tool-use concurrency follows the sonnet tier limit minus one', () => {
    const c = testConfig('http://127.0.0.1:9', (raw) => (raw.clients.tiers.sonnet = 'claude-gw-zp53flash-plan'));
    expect((ccSettings(c) as any).env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toBe('1');
  });
});
