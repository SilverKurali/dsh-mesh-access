#!/usr/bin/env bash
# frpc-setup.sh —— 在**你自己的电脑**（跑 DSH 的那台）上装 frpc，把面板开出来的
# 组网端口（默认 192.168.188.1:3081）挂到你自己服务器的公网入口上。
#
# 用法：
#   ./tools/frpc-setup.sh --server 1.2.3.4 --token <token> [--port 7000] [--remote-port 21081]
#                         [--local 192.168.188.1:3081] [--domain dsh.example.com] [--no-service]
#
# 不带参数跑会进入问答模式。写完之后 DSH 面板的「公网隧道」卡片会自动认到这份配置。
set -uo pipefail

FRP_VERSION="${FRP_VERSION:-0.72.0}"
SERVER=""
BIND_PORT=7000
REMOTE_PORT=21081
TOKEN=""
LOCAL="192.168.188.1:3081"
DOMAIN=""
SERVICE=1
BIN_DIR="${HOME}/.local/bin"
CONF="${HOME}/.config/frp/frpc.toml"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --port) BIND_PORT="$2"; shift 2 ;;
    --remote-port) REMOTE_PORT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --local) LOCAL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

ask() { # ask <变量名> <提示> [默认值]
  local __var="$1" __prompt="$2" __def="${3:-}" __ans=""
  if [ -t 0 ]; then
    printf '%s%s: ' "$__prompt" "${__def:+（默认 $__def）}"
    read -r __ans
  fi
  [ -n "$__ans" ] || __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

[ -n "$SERVER" ] || ask SERVER "服务器地址（IP 或域名）"
[ -n "$TOKEN" ]  || ask TOKEN  "token（服务端 /etc/frp/frps.toml 里的 auth.token）"
[ -n "$SERVER" ] || die "服务器地址不能为空"
[ -n "$TOKEN" ]  || die "token 不能为空"

LOCAL_IP="${LOCAL%%:*}"
LOCAL_PORT="${LOCAL##*:}"

say "[1/4] 装 frpc v${FRP_VERSION}"
case "$(uname -m)" in
  x86_64|amd64) FRP_ARCH=amd64 ;;
  aarch64|arm64) FRP_ARCH=arm64 ;;
  armv7l) FRP_ARCH=arm ;;
  *) die "不认识的架构：$(uname -m)" ;;
esac
if command -v frpc >/dev/null; then
  ok "已有 frpc：$(command -v frpc)（$(frpc --version 2>/dev/null || echo 版本未知)）"
else
  mkdir -p "$BIN_DIR"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  NAME="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
  URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${NAME}"
  fetch() {
    if command -v curl >/dev/null; then curl -fL --retry 3 --connect-timeout 10 -o "$TMP/$NAME" "$1"
    else wget -q -O "$TMP/$NAME" "$1"; fi
  }
  fetch "$URL" || { warn "直连 GitHub 失败，改用加速镜像"; fetch "https://gh-proxy.com/${URL}" || die "下载 frpc 失败"; }
  tar -xzf "$TMP/$NAME" -C "$TMP" || die "解包失败，包可能不完整"
  B="$(find "$TMP" -maxdepth 2 -type f -name frpc | head -1)"
  [ -n "$B" ] || die "包里没有 frpc"
  install -m 755 "$B" "$BIN_DIR/frpc"
  ok "frpc → $BIN_DIR/frpc"
fi

say "[2/4] 写 $CONF"
mkdir -p "$(dirname "$CONF")"
umask 077
cat > "$CONF" <<EOF
# 由 frpc-setup.sh 生成
serverAddr = "${SERVER}"
serverPort = ${BIND_PORT}

auth.method = "token"
auth.token = "${TOKEN}"

log.to = "${HOME}/.config/frp/frpc.log"
log.level = "info"

[[proxies]]
name = "dsh-mesh"
type = "tcp"
localIP = "${LOCAL_IP}"
localPort = ${LOCAL_PORT}
remotePort = ${REMOTE_PORT}
transport.useEncryption = true
EOF
chmod 600 "$CONF"
ok "配置写入 $CONF（600）"

say "[3/4] 校验组网端口在听"
if ss -Hltn 2>/dev/null | grep -q "${LOCAL_IP}:${LOCAL_PORT}\b"; then
  ok "${LOCAL_IP}:${LOCAL_PORT} 在监听"
else
  warn "${LOCAL_IP}:${LOCAL_PORT} 还没监听 —— 先去 DSH 面板点「在组网地址上开端口」，再回来启动 frpc"
fi

if [ "$SERVICE" = "1" ] && command -v systemctl >/dev/null; then
  say "[4/4] systemd 用户单元（不 enable，只按需 start；插件自己也能拉起 frpc）"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/dsh-frpc.service" <<EOF
[Unit]
Description=frpc for dsh-mesh-access

[Service]
Type=simple
ExecStart=${BIN_DIR}/frpc -c ${CONF}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload 2>/dev/null || true
  ok "单元已写：dsh-frpc.service（systemctl --user start dsh-frpc）"
else
  say "[4/4] 跳过 systemd（--no-service 或没有 systemctl）"
fi

say "搞定"
cat <<EOF
  手动启动（前台看日志）: ${BIN_DIR}/frpc -c ${CONF}
  或后台              : systemctl --user start dsh-frpc
  公网地址            : ${DOMAIN:+https://${DOMAIN}/}${DOMAIN:-http://${SERVER}:${REMOTE_PORT}/}

之后在 DSH 左侧「组网访问」面板看「公网隧道」卡片：状态应是 frpc 运行中 + 公网可达。
EOF
