#!/bin/sh
# 服务器上的 cgw 命令（安装为 /usr/local/bin/cgw）：以服务用户 cgw 运行，避免 root 写出 cgw 无法读写的 SQLite 文件。
set -eu
CONFIG="${CGW_CONFIG:-/etc/claude-gateway/gateway.yaml}"
exec runuser -u cgw -- env CGW_CONFIG="$CONFIG" \
  /usr/bin/node --disable-warning=ExperimentalWarning /opt/claude-gateway/dist/cli/cgw.js "$@"
