#!/usr/bin/env bash
# frps-setup.sh —— 在你**自己的**服务器上装 frps（公网入口），给 dsh-mesh-access 用。
#
# 用法（在服务器上、用 root 或能 sudo 的账号执行）：
#   sudo ./frps-setup.sh --port 7000 --http-port 21081
#   sudo ./frps-setup.sh --port 7000 --http-port 21081 --domain dsh.example.com --email you@example.com
#
# 它会：
#   1. 装 frps（v0.72.0，从 GitHub 取；失败可加 --mirror 用 gh-proxy）
#   2. 写 /etc/frp/frps.toml（随机 token，权限 600）
#   3. 建 systemd 单元并启动（开机自启）
#   4. 放行 firewalld / ufw 的 bindPort 与 http-port（有才放）
#   5. 给了 --domain 且本机有 nginx：写反代 + 申请 Let's Encrypt 证书 + Basic 认证
#
# 结束时打印：token、bindPort、remotePort、以及本机要执行的 frpc-setup 命令。
set -uo pipefail

FRP_VERSION="${FRP_VERSION:-0.72.0}"
BIND_PORT=7000
HTTP_PORT=21081
DOMAIN=""
EMAIL=""
TOKEN=""
MIRROR=0
BASIC_USER="dsh"
BASIC_PASS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) BIND_PORT="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --mirror) MIRROR=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑（sudo ./frps-setup.sh …）"
command -v systemctl >/dev/null || die "没有 systemd，这个脚本不支持你的发行版"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) FRP_ARCH=amd64 ;;
  aarch64|arm64) FRP_ARCH=arm64 ;;
  armv7l) FRP_ARCH=arm ;;
  *) die "不认识的架构：$ARCH" ;;
esac

say "[1/5] 装 frps v${FRP_VERSION} (${FRP_ARCH})"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
NAME="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${NAME}"
fetch() {
  local u="$1"
  if command -v curl >/dev/null; then curl -fL --retry 3 --connect-timeout 10 -o "$TMP/$NAME" "$u"
  else wget -q -O "$TMP/$NAME" "$u"; fi
}
if ! fetch "$URL"; then
  warn "直连 GitHub 失败，改用加速镜像"
  fetch "https://gh-proxy.com/${URL}" || die "下载 frp 失败：$URL"
fi
# 只认 tar 里真有两个二进制，避免拿到半截文件（GitHub 偶发截断）
tar -xzf "$TMP/$NAME" -C "$TMP" || die "解包失败，包可能不完整"
BIN="$(find "$TMP" -maxdepth 2 -type f -name frps | head -1)"
[ -n "$BIN" ] || die "包里没有 frps"
install -m 755 "$BIN" /usr/local/bin/frps
ok "frps → /usr/local/bin/frps（$(/usr/local/bin/frps --version 2>/dev/null || echo '版本未知')）"

say "[2/5] 写 /etc/frp/frps.toml"
mkdir -p /etc/frp /var/log/frp
[ -n "$TOKEN" ] || TOKEN="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
umask 077
cat > /etc/frp/frps.toml <<EOF
# 由 frps-setup.sh 生成。token 是这台服务器的唯一凭据，别公开。
bindPort = ${BIND_PORT}

auth.method = "token"
auth.token = "${TOKEN}"

log.to = "/var/log/frp/frps.log"
log.level = "info"
log.maxDays = 7

# 本机管理面板，只监听回环
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "admin"
EOF
chmod 600 /etc/frp/frps.toml
ok "配置写入 /etc/frp/frps.toml（600）"

say "[3/5] systemd 单元"
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server (dsh-mesh-access public entry)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now frps.service >/dev/null 2>&1 || warn "frps 启动失败，看 journalctl -u frps -n 50"
sleep 1
if systemctl is-active --quiet frps.service; then ok "frps 已运行"; else warn "frps 没起来，看 journalctl -u frps -n 50"; fi
ss -Hltn 2>/dev/null | grep -q ":${BIND_PORT}\b" && ok "监听 :${BIND_PORT}" || warn "没看到 :${BIND_PORT} 在监听"

say "[4/5] 防火墙"
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=${BIND_PORT}/tcp >/dev/null && firewall-cmd --reload >/dev/null && ok "firewalld 放行 ${BIND_PORT}/tcp"
elif command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q active; then
  ufw allow ${BIND_PORT}/tcp >/dev/null && ok "ufw 放行 ${BIND_PORT}/tcp"
else
  warn "没有活动的 firewalld / ufw，跳过（云厂商安全组仍需自己放行）"
fi
warn "别忘了在云控制台「安全组 / 防火墙」放行 ${BIND_PORT}/tcp 和 ${HTTP_PORT}/tcp"

if [ -n "$DOMAIN" ]; then
  say "[5/5] nginx + TLS + Basic 认证（${DOMAIN}）"
  if ! command -v nginx >/dev/null; then
    warn "没装 nginx，跳过；先 dnf/apt install nginx 再重跑本脚本加 --domain"
  else
    mkdir -p /var/www/acme
    cat > /etc/nginx/conf.d/dsh-acme.conf <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
      if command -v certbot >/dev/null; then
        certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" --non-interactive --agree-tos \
          ${EMAIL:+--email "$EMAIL"} ${EMAIL:---register-unsafely-without-email} >/dev/null 2>&1 \
          && ok "证书已签发" || warn "certbot 失败，看 /var/log/letsencrypt/letsencrypt.log"
      else
        warn "没有 certbot：dnf install certbot / apt install certbot 后重跑本脚本"
      fi
    else
      ok "证书已存在，复用"
    fi
    BASIC_PASS="$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | head -c 14)"
    if command -v openssl >/dev/null; then
      printf '%s:%s\n' "$BASIC_USER" "$(openssl passwd -6 "$BASIC_PASS")" > /etc/nginx/.dsh_htpasswd
      # 属主必须是跑 nginx worker 的那个用户，否则 error log 报 Permission denied、页面 500
      chown "root:$(id -gn nginx 2>/dev/null || echo nginx)" /etc/nginx/.dsh_htpasswd 2>/dev/null || true
      chmod 640 /etc/nginx/.dsh_htpasswd
    fi
    cat > /etc/nginx/conf.d/dsh-https.conf <<EOF
server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    # 浏览器弹窗式登录：挡掉所有没带账号密码的请求
    # auth_basic 已由 dsh-mesh-access 插件面板接管（1.4.0+），服务器只做转发
    # 认证配置见插件面板「入口登录」

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:${HTTP_PORT};
        proxy_http_version 1.1;
        # WebSocket（DSH 的实时通道）
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host 127.0.0.1:${HTTP_PORT};
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx; ok "nginx 反代已生效"; else warn "nginx 配置校验失败：nginx -t"; fi
  fi
else
  say "[5/5] 跳过域名/TLS（没给 --domain）"
fi

say "记下来（本机 frpc 要用）"
printf '  服务器地址 : %s\n' "$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<你的公网IP>')"
printf '  bindPort   : %s\n' "$BIND_PORT"
printf '  remotePort : %s\n' "$HTTP_PORT"
printf '  token      : %s\n' "$TOKEN"
[ -n "$DOMAIN" ] && printf '  域名       : %s（https://%s/）\n' "$DOMAIN" "$DOMAIN"
[ -n "$BASIC_PASS" ] && printf '  网页账号   : %s / %s\n' "$BASIC_USER" "$BASIC_PASS"

say "下一步（在你自己的电脑上跑）"
cat <<EOF
  ./tools/frpc-setup.sh \\
    --server <上面那个服务器地址> --port ${BIND_PORT} \\
    --token ${TOKEN} --remote-port ${HTTP_PORT}${DOMAIN:+ --domain ${DOMAIN}}
EOF
echo "然后在 DSH 的「组网访问」面板点「启动隧道」。"
