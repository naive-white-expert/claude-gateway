# 部署

目标：一台 Linux 服务器（Node.js ≥ 22.13，systemd），网关以专用低权限用户 `cgw` 运行。公网入口方式见[方案 §8.5](../docs/方案-v0.1.md#85-部署)。

| 文件 | 用途 |
|---|---|
| `deploy.sh` | 本机执行：测试、构建、rsync 到服务器 `/opt/claude-gateway`、服务器 `npm ci --omit=dev`、校验配置、重启 |
| `server-setup.sh` | 服务器上执行（`deploy.sh` 会调用，幂等）：建用户 `cgw`、目录、安装 systemd unit 与 `/usr/local/bin/cgw` |
| `claude-gateway.service` | systemd unit：开机自启、崩溃重启、日志进 journald、内存上限、加固项；TLS 文件经 `LoadCredential=` 读取，保持 root 0600 |
| `cgw-wrapper.sh` | 服务器上的 `cgw` 命令，以 `cgw` 用户运行 |
| `nginx-reverse-proxy.example.conf` | 经反代部署时反代机的 nginx 示例 |

## 服务器上的文件

| 路径 | 权限 | 内容 |
|---|---|---|
| `/opt/claude-gateway/` | root，只读 | 构建产物与生产依赖 |
| `/etc/claude-gateway/gateway.yaml` | root:cgw 0640 | 运行配置（不含密钥）；TLS 路径写 `${CREDENTIALS_DIRECTORY}/server.crt` 等 |
| `/etc/claude-gateway/secrets.env` | root 0600 | 上游 key，例如 `DEEPSEEK_API_KEY=...` |
| `/etc/claude-gateway/tls/` | root 0600 | 服务端证书、私钥、客户端 CA |
| `/var/lib/claude-gateway/` | cgw 0750 | SQLite（网关 key 哈希、请求日志元数据、会话状态）与 `status.json` |

## 首次部署

1. 在服务器上写好 `/etc/claude-gateway/gateway.yaml`（参考 `config/gateway.example.yaml`）和 `secrets.env`。
2. 本机执行 `deploy/deploy.sh <ssh 主机>`。
3. 服务器上签发网关 key：`cgw key create --name <设备名>`（明文只显示一次）。
4. 验证：无 key 访问 `/v1/models` 返回 401；带 key 返回模型列表。

## 日常

- 升级：`deploy/deploy.sh <ssh 主机>`。
- 改配置后热加载：`systemctl reload claude-gateway`（监听地址、端口、TLS 的改动需要 `restart`）。
- 状态：`cgw status`；日志：`journalctl -u claude-gateway -f`。
- 吊销 key：`cgw key revoke <id 或前缀>`（5 秒内生效）。
