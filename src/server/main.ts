#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { loadConfigFile, type GatewayConfig } from '../config/load.js';
import { KeyStore } from '../auth/keys.js';
import { Logger } from '../observability/log.js';
import { RequestLog } from '../observability/requestLog.js';
import { SessionStore, ThinkingLedger } from '../router/session.js';
import { openDb, pruneDb } from '../store/db.js';
import { Gateway } from './app.js';

export const DEFAULT_CONFIG_PATH = '/etc/claude-gateway/gateway.yaml';

function configPath(argv: string[]): string {
  const i = argv.indexOf('--config');
  return i >= 0 ? argv[i + 1] : (process.env.CGW_CONFIG ?? DEFAULT_CONFIG_PATH);
}

export function createServer(cfg: GatewayConfig, gw: Gateway, logger: Logger): http.Server | https.Server {
  const tls = cfg.server.tls;
  const opts: http.ServerOptions = { requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 65_000 };
  if (!tls.enabled) return http.createServer(opts, gw.handler);
  const server = https.createServer(
    {
      ...opts,
      cert: readFileSync(tls.certFile!),
      key: readFileSync(tls.keyFile!),
      ca: tls.clientCa ? readFileSync(tls.clientCa) : undefined,
      requestCert: tls.requireClientCert,
      rejectUnauthorized: tls.requireClientCert,
      minVersion: 'TLSv1.2',
    },
    gw.handler,
  );
  if (tls.requireClientCert && tls.allowedClientCNs.length) {
    server.on('secureConnection', (socket: TLSSocket) => {
      const cn = socket.getPeerCertificate()?.subject?.CN;
      const cnStr = Array.isArray(cn) ? cn.join(',') : cn;
      if (!cnStr || !tls.allowedClientCNs.includes(cnStr)) {
        logger.warn('tls_client_cn_rejected', { ip: socket.remoteAddress, cn: cnStr ?? null });
        socket.destroy();
      }
    });
  }
  server.on('tlsClientError', (err, socket) => logger.debug('tls_client_error', { ip: socket.remoteAddress, err: err.message }));
  return server;
}

async function main(): Promise<void> {
  const path = configPath(process.argv);
  const logger = new Logger();
  let cfg = loadConfigFile(path, process.env);
  logger.setLevel(cfg.logging.level);
  for (const w of cfg.warnings) logger.warn('config_warning', { warning: w });

  const db = openDb(join(cfg.server.stateDir, 'gateway.db'));
  const keys = new KeyStore(db);
  const gw = new Gateway(cfg, { keys, logger, sessions: new SessionStore(db), ledger: new ThinkingLedger(db), requestLog: new RequestLog(db) });
  if (keys.list().filter((k) => !k.revokedAt).length === 0) logger.warn('no_gateway_keys', { hint: 'create one with: cgw key create --name <name>' });

  const server = createServer(cfg, gw, logger);
  server.listen(cfg.server.port, cfg.server.host, () =>
    logger.info('listening', { host: cfg.server.host, port: cfg.server.port, tls: cfg.server.tls.enabled, mtls: cfg.server.tls.requireClientCert, models: [...cfg.exposed.keys()] }),
  );

  const statusFile = join(cfg.server.stateDir, 'status.json');
  const writeStatus = (): void => {
    try {
      writeFileSync(statusFile + '.tmp', JSON.stringify(gw.snapshot(), null, 2), { mode: 0o640 });
      renameSync(statusFile + '.tmp', statusFile);
    } catch (e) {
      logger.warn('status_write_failed', { err: String(e) });
    }
  };
  const statusTimer = setInterval(writeStatus, 2000);
  const maintenance = setInterval(() => {
    try {
      pruneDb(db, Date.now(), gw.cfg.logging.retentionDays, gw.cfg.clients.sessionStateTtlHours);
    } catch (e) {
      logger.warn('prune_failed', { err: String(e) });
    }
    gw.guard.sweep();
  }, 3600_000);
  pruneDb(db, Date.now(), cfg.logging.retentionDays, cfg.clients.sessionStateTtlHours);

  process.on('SIGHUP', () => {
    try {
      const next = loadConfigFile(path, process.env);
      if (next.server.port !== cfg.server.port || next.server.host !== cfg.server.host || JSON.stringify(next.server.tls) !== JSON.stringify(cfg.server.tls))
        logger.warn('config_reload_partial', { note: 'server.host/port/tls changes need a restart' });
      cfg = next;
      void gw.reload(next);
      keys.reload();
      logger.setLevel(next.logging.level);
      logger.info('config_reloaded', { models: [...next.exposed.keys()] });
    } catch (e) {
      logger.error('config_reload_failed', { err: String((e as Error).message) });
    }
  });

  const shutdown = (sig: string): void => {
    logger.info('shutdown', { sig });
    clearInterval(statusTimer);
    clearInterval(maintenance);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server/main.js')) {
  main().catch((e) => {
    process.stderr.write(`claude-gateway failed to start: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
