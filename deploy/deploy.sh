#!/usr/bin/env bash
# 从本机部署到服务器：本机测试与构建 → rsync 构建产物 → 服务器 npm ci（生产依赖）→ 重启 → 健康检查。
# 用法：deploy/deploy.sh <ssh 主机> [--skip-tests]
# 服务器上的运行配置 /etc/claude-gateway/gateway.yaml 与 secrets.env 不在仓库中，由部署者自行维护。
set -euo pipefail
HOST="${1:?usage: deploy/deploy.sh <ssh-host> [--skip-tests]}"
SKIP_TESTS="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -o ConnectTimeout=10 "$HOST")

cd "$ROOT"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "need Node.js >= 22 locally (found $(node -v))" >&2; exit 1; }
npm ci --no-audit --no-fund
[ "$SKIP_TESTS" = "--skip-tests" ] || npm test
npm run build

rsync -az --delete -e "ssh -o ConnectTimeout=10" \
  --include='/dist/***' --include='/deploy/***' --include='/config/' --include='/config/gateway.example.yaml' --include='/config/error-rules.yaml' \
  --include='/package.json' --include='/package-lock.json' --include='/.npmrc' --include='/LICENSE' \
  --exclude='*' ./ "$HOST:/opt/claude-gateway/"

"${SSH[@]}" bash -s <<'EOF'
set -euo pipefail
cd /opt/claude-gateway
bash deploy/server-setup.sh /opt/claude-gateway
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com >/dev/null
chown -R root:root /opt/claude-gateway
if [ ! -s /etc/claude-gateway/gateway.yaml ]; then
  echo "missing /etc/claude-gateway/gateway.yaml — create it (see config/gateway.example.yaml), then: systemctl restart claude-gateway" >&2
  exit 1
fi
CGW_CONFIG=/etc/claude-gateway/gateway.yaml \
  runuser -u cgw -- node --disable-warning=ExperimentalWarning dist/cli/cgw.js check-config
systemctl restart claude-gateway
sleep 2
systemctl is-active claude-gateway
journalctl -u claude-gateway -n 5 --no-pager -o cat
EOF
