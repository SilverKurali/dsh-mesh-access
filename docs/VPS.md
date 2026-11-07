# 用自己的服务器做公网入口（可选）

插件默认只把 DSH 挂到**组网网卡**上——手机、平板、另一台电脑在同一个星空组网里就能打开。
这条路的代价是流量要过组网中继：实测 RTT 800–990 ms（最坏 3.7 s），长连接会被心跳判死，表现为手机页面
一直「重新连接中」。

如果你**自己有一台带公网 IP 的服务器**（阿里云轻量、腾讯云、搬瓦工、家里的固定 IP 都行），可以让它当公网入口，
延迟通常 30–60 ms，稳定得多。插件不是要你用别人的服务器——这一步完全是你自己的机器，你自己掌握账号密码。

```
手机 / 平板 / 公司电脑
        │  https://你的域名  （可选，走 nginx + 证书）
        ▼
你自己的服务器   frps  ←── 公网，只开一个 7000
        │  隧道（frp，token 认证 + 加密）
        ▼
你的电脑        frpc  →  192.168.188.1:3081（插件在组网地址上开出来的那个口）
        │
        ▼
            DSH 本体 127.0.0.1:3080
```

## 一句话版本

```bash
# 1) 在你自己的服务器上（root）
sudo ./tools/frps-setup.sh --port 7000 --http-port 21081
#    想直接上 HTTPS：加 --domain dsh.example.com --email you@example.com

# 2) 在你跑 DSH 的电脑上
./tools/frpc-setup.sh --server <服务器IP> --port 7000 \
  --token <第 1 步打印的 token> --remote-port 21081 [--domain dsh.example.com]

# 3) 回到 DSH 左侧「组网访问」面板 → 公网隧道卡片 → 启动隧道
```

第 1 步结束会打印 token、端口和给你复制粘贴的第 2 步命令。两个脚本都可以重复跑（幂等）。

## 前置条件

| 项 | 要求 |
|---|---|
| 服务器 | Linux（systemd），1 核 512 MB 够用，公网 IP |
| 端口 | 云控制台安全组放行 **7000/tcp**（frp 控制）和 **21081/tcp**（网页入口） |
| 域名 | 可选。要用 https 才需要，且要先把 A 记录指到服务器 |
| 本机 | 已经能在面板上「在组网地址上开端口」；`~/.local/bin` 在 PATH 上 |

## 两个脚本各自做什么

`tools/frps-setup.sh`（服务器上，root）：

1. 装 frp v0.72.0 的 `frps` 到 `/usr/local/bin/frps`（GitHub 不通时自动走 `gh-proxy.com`）
2. 写 `/etc/frp/frps.toml`：`bindPort`、`auth.token`（没给就随机生成 24 位）、日志、本机管理面板 `127.0.0.1:7500`
3. 建 `frps.service` 并 enable + start，核对 `:7000` 真的在听
4. firewalld / ufw 有就放行 7000
5. 给了 `--domain` 且有 nginx：写 ACME 探针、申请 Let's Encrypt 证书、写 443 反代（认证由插件面板「入口登录」接管，服务器不再配账密）

`tools/frpc-setup.sh`（你的电脑上，普通用户）：

1. 没 `frpc` 就装到 `~/.local/bin/frpc`
2. 写 `~/.config/frp/frpc.toml`（600）：`serverAddr`、`serverPort`、token、`[[proxies]]` 映射
   `192.168.188.1:3081 → 服务器:21081`，开 `transport.useEncryption`
3. 检查组网端口是否已经在听（不对就去面板点「在组网地址上开端口」）
4. 写 `~/.config/systemd/user/dsh-frpc.service`（**不 enable**，按需启动；插件自己也能拉起 frpc）

## 认证是两层

1. **DSH 自己的 token**：面板里「访问地址」那一行就是带 `?token=` 的完整地址，换完 cookie 30 天有效。
2. **入口认证**（推荐，1.4.0+）：装好插件后，在面板「入口登录」卡片里选模式：
   - 密钥（推荐）：面板给出带 `?meshkey=` 的一次性地址，手机打开一次，30 天内免登录、无弹窗；可随时重置。
   - 账号密码：浏览器弹窗登录一次，24 小时内仅该设备免登录；改密码会踢掉所有已登录设备。
   认证状态存本机侧车文件，服务器零配置。

想更硬一点：把 nginx 换成 mTLS（客户端证书）或者只允许公司 IP 访问（`allow`/`deny`），这些都在 nginx 那一层做，
插件不用改。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板显示「frpc 未运行」但公网能打开 | 你自己的 systemd 单元在跑 frpc | 正常。面板会显示「外部进程已在跑」，不让重复启动 |
| 面板「公网不可达」 | 安全组没放行、frps 没起、`remotePort` 冲突 | 服务器上 `ss -Hltn \| grep 21081`、`journalctl -u frps -n 50` |
| 隧道起来了，打开是 502 | 本机 `192.168.188.1:3081` 没监听 | 回面板点「在组网地址上开端口」；`ss -Hltn \| grep 3081` |
| https 打开 500 | `/etc/nginx/.dsh_htpasswd` 权限不对 | `chown root:<nginx组>` + `chmod 640`（600 会让 worker 读不到） |
| 页面能开但一直「重新连接中」 | WebSocket 没被转发 | nginx 里必须有 `Upgrade`/`Connection "upgrade"`，且 `proxy_http_version 1.1` |
| `frpc` 报 `start error: port already used` | 同一 `remotePort` 被占 | 换 `--remote-port`，或在 frps 上 `allowPorts` 收窄 |

## 只想临时用一下

```bash
# 本机前台跑，Ctrl+C 就停
~/.local/bin/frpc -c ~/.config/frp/frpc.toml
```

## 卸载

```bash
# 本机
systemctl --user disable --now dsh-frpc 2>/dev/null
rm -f ~/.config/systemd/user/dsh-frpc.service ~/.config/frp/frpc.toml ~/.local/bin/frpc

# 服务器
systemctl disable --now frps
rm -f /etc/systemd/system/frps.service /etc/frp/frps.toml /usr/local/bin/frps
rm -f /etc/nginx/conf.d/dsh-https.conf /etc/nginx/conf.d/dsh-acme.conf
```
