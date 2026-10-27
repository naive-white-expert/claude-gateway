#!/usr/bin/env bash
# 一次性服务器准备（幂等），在服务器上以 root 运行：
#   - 创建无登录 shell 的系统用户 cgw
#   - 建 /opt/claude-gateway（代码，root 所有、cgw 只读）与 /etc/claude-gateway（root:cgw 0750）
#   - 安装 systemd unit 与 /usr/local/bin/cgw
# 不修改 SSH、防火墙和已有的 TLS 文件（证书由 systemd LoadCredential 以 root 读取）。
set -euo pipefail
SRC="${1:-/opt/claude-gateway}"

id cgw >/dev/null 2>&1 || useradd --system --home-dir /var/lib/claude-gateway --no-create-home --shell /usr/sbin/nologin cgw
install -d -o root -g root -m 0755 /opt/claude-gateway
install -d -o root -g cgw -m 0750 /etc/claude-gateway
[ -f /etc/claude-gateway/secrets.env ] || install -o root -g root -m 0600 /dev/null /etc/claude-gateway/secrets.env
chmod 0600 /etc/claude-gateway/secrets.env
[ -f /etc/claude-gateway/gateway.yaml ] && chown root:cgw /etc/claude-gateway/gateway.yaml && chmod 0640 /etc/claude-gateway/gateway.yaml
install -o root -g root -m 0644 "$SRC/deploy/claude-gateway.service" /etc/systemd/system/claude-gateway.service
install -o root -g root -m 0755 "$SRC/deploy/cgw-wrapper.sh" /usr/local/bin/cgw
systemctl daemon-reload
systemctl enable claude-gateway.service >/dev/null
echo "server setup done"
