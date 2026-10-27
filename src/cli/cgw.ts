#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfigFile, type GatewayConfig } from '../config/load.js';
import { KeyStore } from '../auth/keys.js';
import { openDb } from '../store/db.js';
import { ccLaunchEnv, ccSettings, desktopInferenceConfig } from '../clients/generate.js';
import { DEFAULT_CONFIG_PATH } from '../server/main.js';

const USAGE = `cgw — claude-gateway 管理命令

  cgw check-config                       校验配置（能力字段、对外 ID、档位）
  cgw key create --name <名称> [--expires-days N] [--models a,b] [--quiet]
  cgw key list
  cgw key revoke <id|前缀>
  cgw status                             在途 / 排队 / 最近请求统计
  cgw desktop print-config [--base-url URL]
  cgw desktop backup [--dir 目录]         备份桌面端 3P 配置（configLibrary）
  cgw desktop apply --key-env VAR [--base-url URL] [--name 名称]
                                          以当前生效配置为底，新建一份网关配置并设为生效（改前自动备份）
  cgw desktop restore <备份目录>           从备份恢复 configLibrary
  cgw print-cc-settings [--for-desktop] [--api-key-helper 路径] [--base-url URL]
  cgw cc [claude 参数...]                 只给子进程注入环境变量启动 claude（key 取自 CGW_KEY）

通用参数：--config <路径>（默认 $CGW_CONFIG 或 ${DEFAULT_CONFIG_PATH}）`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (argv: string[], name: string): boolean => argv.includes(name);

function loadCfg(argv: string[]): GatewayConfig {
  return loadConfigFile(arg(argv, '--config') ?? process.env.CGW_CONFIG ?? DEFAULT_CONFIG_PATH, process.env);
}

const desktopDir = (): string => join(homedir(), 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
const backupRoot = (): string => join(homedir(), '.claude-gateway-backups');

function backupDesktop(dir?: string): string {
  const src = desktopDir();
  if (!existsSync(src)) throw new Error(`desktop config dir not found: ${src}`);
  const dst = dir ?? join(backupRoot(), `desktop-configLibrary-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(src)) if (statSync(join(src, f)).isFile()) copyFileSync(join(src, f), join(dst, f));
  return dst;
}

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o, null, 2) + '\n');
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub] = argv;
  switch (cmd) {
    case 'check-config': {
      const cfg = loadCfg(argv);
      for (const w of cfg.warnings) console.error(`warning: ${w}`);
      console.log(`ok: ${cfg.exposed.size} models exposed: ${[...cfg.exposed.keys()].join(', ')}`);
      return;
    }
    case 'key': {
      const cfg = loadCfg(argv);
      const db = openDb(join(cfg.server.stateDir, 'gateway.db'));
      const store = new KeyStore(db);
      if (sub === 'create') {
        const name = arg(argv, '--name');
        if (!name) throw new Error('--name is required');
        const days = arg(argv, '--expires-days');
        const models = arg(argv, '--models');
        const { key, record } = store.create(name, { expiresDays: days ? Number(days) : undefined, allowedModels: models?.split(',').filter(Boolean) });
        if (flag(argv, '--quiet')) process.stdout.write(key + '\n');
        else {
          console.error(`created key ${record.id} (${record.name}), prefix ${record.prefix}; plaintext is shown once below:`);
          process.stdout.write(key + '\n');
        }
      } else if (sub === 'list') {
        for (const k of store.list())
          console.log(
            [k.id, k.prefix, k.name, new Date(k.createdAt).toISOString(), k.expiresAt ? `expires ${new Date(k.expiresAt).toISOString()}` : 'no-expiry', k.revokedAt ? 'REVOKED' : 'active', k.allowedModels?.join(',') ?? 'all-models'].join('\t'),
          );
      } else if (sub === 'revoke') {
        const target = argv[2];
        if (!target) throw new Error('usage: cgw key revoke <id|prefix>');
        console.log(`revoked ${store.revoke(target)} key(s)`);
      } else throw new Error(USAGE);
      db.close();
      return;
    }
    case 'status': {
      const cfg = loadCfg(argv);
      const file = join(cfg.server.stateDir, 'status.json');
      if (existsSync(file)) {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        const age = Date.now() - Date.parse(s.updatedAt);
        console.log(`gateway pid ${s.pid}, started ${s.startedAt}, snapshot ${Math.round(age / 1000)}s ago${age > 10_000 ? ' (STALE: gateway not running?)' : ''}`);
        console.log(`requests ${s.stats.requests}, auth failures ${s.stats.authFailures}, errors ${s.stats.errors}, banned IPs ${s.bannedIps}`);
        console.log('model\tchannel\tin-flight\tqueued\tlimit');
        for (const [id, c] of Object.entries<any>(s.concurrency)) console.log(`${id}\t${c.channel}\t${c.inFlight}\t${c.queued}\t${c.limit ?? '-'}`);
      } else console.log('no status snapshot (gateway not running?)');
      const db = openDb(join(cfg.server.stateDir, 'gateway.db'));
      const rows = db
        .prepare(
          `SELECT model, COUNT(*) n, SUM(status >= 400) errs, CAST(AVG(ms) AS INT) avg_ms, SUM(input_tokens) inp, SUM(cache_read) cr, SUM(output_tokens) outp
           FROM request_log WHERE ts > ? GROUP BY model ORDER BY n DESC`,
        )
        .all(Date.now() - 3600_000) as any[];
      console.log('\nlast 1h: model\trequests\terrors\tavg_ms\tinput\tcache_read\toutput');
      for (const r of rows) console.log([r.model, r.n, r.errs, r.avg_ms, r.inp ?? 0, r.cr ?? 0, r.outp ?? 0].join('\t'));
      const fails = db.prepare('SELECT COUNT(*) n FROM auth_failures WHERE ts > ?').get(Date.now() - 3600_000) as any;
      console.log(`auth failures last 1h: ${fails.n}`);
      db.close();
      return;
    }
    case 'desktop': {
      if (sub === 'print-config') {
        const cfg = loadCfg(argv);
        out(desktopInferenceConfig(cfg, { baseUrl: arg(argv, '--base-url') }));
        return;
      }
      if (sub === 'backup') {
        console.log(`backed up to ${backupDesktop(arg(argv, '--dir'))}`);
        return;
      }
      if (sub === 'apply') {
        const cfg = loadCfg(argv);
        const keyEnv = arg(argv, '--key-env');
        const key = keyEnv ? process.env[keyEnv] : undefined;
        if (!key) throw new Error('--key-env <VAR> must name an environment variable holding the gateway key');
        const dir = desktopDir();
        const backup = backupDesktop();
        const meta = JSON.parse(readFileSync(join(dir, '_meta.json'), 'utf8')) as { appliedId?: string; entries?: { id: string; name: string }[] };
        const base = meta.appliedId && existsSync(join(dir, `${meta.appliedId}.json`)) ? JSON.parse(readFileSync(join(dir, `${meta.appliedId}.json`), 'utf8')) : {};
        const id = randomUUID();
        const entry = { ...base, ...desktopInferenceConfig(cfg, { baseUrl: arg(argv, '--base-url'), apiKey: key }) };
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(entry, null, 2), { mode: 0o600 });
        meta.entries = [...(meta.entries ?? []), { id, name: arg(argv, '--name') ?? 'claude-gateway' }];
        meta.appliedId = id;
        writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta), { mode: 0o600 });
        console.log(`applied new desktop config ${id}; previous files backed up to ${backup}. Restart Claude to take effect.`);
        return;
      }
      if (sub === 'restore') {
        const from = argv[2];
        if (!from || !existsSync(join(from, '_meta.json'))) throw new Error('usage: cgw desktop restore <backup dir containing _meta.json>');
        const safety = backupDesktop();
        for (const f of readdirSync(from)) copyFileSync(join(from, f), join(desktopDir(), f));
        console.log(`restored from ${from} (current files saved to ${safety} first). Restart Claude to take effect.`);
        return;
      }
      throw new Error(USAGE);
    }
    case 'print-cc-settings': {
      const cfg = loadCfg(argv);
      out(ccSettings(cfg, { baseUrl: arg(argv, '--base-url'), apiKeyHelper: arg(argv, '--api-key-helper'), forDesktop: flag(argv, '--for-desktop') }));
      return;
    }
    case 'cc': {
      const ci = argv.indexOf('--config');
      const rest = argv.slice(1).filter((_, i) => !(ci >= 1 && (i === ci - 1 || i === ci)));
      const cfg = loadCfg(argv);
      let key = process.env.CGW_KEY;
      if (!key && process.platform === 'darwin') {
        try {
          key = execFileSync('security', ['find-generic-password', '-s', 'claude-gateway', '-w'], { encoding: 'utf8' }).trim();
        } catch {
          /* 钥匙串里没有 */
        }
      }
      if (!key) throw new Error('set CGW_KEY, or store the key in the macOS keychain: security add-generic-password -s claude-gateway -a $USER -w');
      const env = { ...process.env, ...ccLaunchEnv(cfg, key, process.env.CGW_BASE_URL) };
      const child = spawn('claude', rest, { stdio: 'inherit', env });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
