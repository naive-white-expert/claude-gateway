#!/bin/sh
# 服务器上的 cgw 命令（安装为 /usr/local/bin/cgw）：以服务用户 cgw 运行，避免 root 写出 cgw 无法读写的 SQLite 文件。
set -eu
CONFIG="${CGW_CONFIG:-/etc/claude-gateway/gateway.yaml}"
# 配置里的 TLS 路径引用 ${CREDENTIALS_DIRECTORY}；cgw 不读证书，只需该变量存在
CREDS="${CREDENTIALS_DIRECTORY:-/etc/claude-gateway/tls}"
exec runuser -u cgw -- env CGW_CONFIG="$CONFIG" CREDENTIALS_DIRECTORY="$CREDS" \
  /usr/bin/node --disable-warning=ExperimentalWarning /opt/claude-gateway/dist/cli/cgw.js "$@"
