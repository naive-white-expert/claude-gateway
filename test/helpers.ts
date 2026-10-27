import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type GatewayConfig } from '../src/config/load.js';
import { KeyStore } from '../src/auth/keys.js';
import { Logger } from '../src/observability/log.js';
import { RequestLog } from '../src/observability/requestLog.js';
import { SessionStore, ThinkingLedger } from '../src/router/session.js';
import { openDb, type Db } from '../src/store/db.js';
import { Gateway } from '../src/server/app.js';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const fixture = (p: string): string => readFileSync(join(FIXTURES, p), 'utf8');

export interface UpstreamCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  aborted: boolean;
}

export type UpstreamHandler = (call: UpstreamCall, req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

export async function mockUpstream(handler: UpstreamHandler): Promise<{ url: string; calls: UpstreamCall[]; close: () => Promise<void>; setHandler: (h: UpstreamHandler) => void }> {
  const calls: UpstreamCall[] = [];
  let h = handler;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const call: UpstreamCall = { method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : null, aborted: false };
      res.on('close', () => {
        if (!res.writableFinished) call.aborted = true;
      });
      calls.push(call);
      void h(call, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setHandler: (nh) => (h = nh),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function testConfig(upstreamUrl: string, overrides: (raw: any) => void = () => {}): GatewayConfig {
  const timeouts = { connectMs: 2000, firstByteMs: 5000, idleMs: 5000 };
  const raw: any = {
    server: { host: '127.0.0.1', port: 1, publicBaseUrl: 'https://gateway.example.com', stateDir: '/tmp/unused', pingIntervalMs: 0 },
    security: { authFailure: { banAfter: 5, windowSec: 300, banSec: [600] } },
    channels: [
      {
        id: 'deepseek',
        protocol: 'anthropic_messages',
        baseUrl: upstreamUrl + '/anthropic',
        billing: 'payg',
        apiKeyEnv: 'TEST_DS_KEY',
        concurrency: null,
        profile: { authHeader: 'x-api-key', betaStrip: [], thinkingReplay: 'passthrough', redactedThinking: 'unsupported', timeouts, countTokens: 'upstream' },
      },
      {
        id: 'plan',
        protocol: 'anthropic_messages',
        baseUrl: upstreamUrl + '/plan',
        billing: 'coding-plan',
        interactiveOnly: true,
        apiKeyEnv: 'TEST_PLAN_KEY',
        concurrency: 2,
        profile: { authHeader: 'bearer', betaStrip: ['context-1m-2025-08-07'], thinkingReplay: 'strip-foreign', redactedThinking: 'unsupported', timeouts, countTokens: 'upstream' },
      },
    ],
    models: {
      'claude-gw-dsflash': { displayName: 'DeepSeek V4.1 Flash（官方）', channel: 'deepseek', upstreamModel: 'deepseek-flash', contextWindow: 1048576, maxOutputTokens: 393216, inputModalities: ['text', 'image'], thinking: 'optional', maxEffort: 'max' },
      'claude-gw-zp53flash-plan': { displayName: 'GLM-5.3-Flash（智谱 Coding Plan）', channel: 'plan', upstreamModel: 'glm-5.3-flash', contextWindow: 1000000, maxOutputTokens: 131072, inputModalities: ['text', 'image'], thinking: 'always-on', maxEffort: 'max' },
    },
    clients: { tiers: { sonnet: 'claude-gw-dsflash', haiku: 'claude-gw-dsflash', opus: 'claude-gw-zp53flash-plan' } },
  };
  overrides(raw);
  return resolveConfig(raw, { TEST_DS_KEY: 'sk-upstream-ds-0000000000', TEST_PLAN_KEY: 'plan-upstream-0000000000' }, { requireKeys: true });
}

export interface Harness {
  url: string;
  key: string;
  gw: Gateway;
  db: Db;
  logs: string[];
  close: () => Promise<void>;
}

export async function startGateway(cfg: GatewayConfig): Promise<Harness> {
  const db = openDb(':memory:');
  const keys = new KeyStore(db, 0);
  const { key } = keys.create('test');
  const logs: string[] = [];
  const logger = new Logger('debug', (l) => logs.push(l));
  const gw = new Gateway(cfg, { keys, logger, sessions: new SessionStore(db), ledger: new ThinkingLedger(db), requestLog: new RequestLog(db) });
  const server = http.createServer(gw.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    key,
    gw,
    db,
    logs,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          r();
        });
      }),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
