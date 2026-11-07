# 更新日志

## 1.1.0 — 把「自己的 VPS 隧道」做进面板

组网这条路在某些网络下注定要中继（校园网只能一台设备在线、手机蜂窝 CGNAT），TCP 中继 RTT 800–990 ms，长连接撑不住。所以面板多了一张「公网隧道」卡片，用你自己的服务器 + frp 走第二条路：

- 新增 `GET/POST /api/dsh-mesh-access/tunnel`：读 `~/.config/frp/frpc.toml`（`serverAddr` / `serverPort` / `localPort` / `remotePort`），面板显示公网地址与连通性；
- 「启动隧道」在本进程内 `spawn frpc -c frpc.toml`，等到 `start proxy success` 才算成功（8 秒超时，失败把 frpc 的日志贴到面板上）；
- 「公网可达」是**真连一次**面板域名/端口再判断，不是看进程在不在；
- 新增配置 `frpcBin` / `frpcConfig` / `tunnelDomain`（有域名就走 `https://域名/`，没有就退回 `http://IP:remotePort/`）；
- 新增 `tools/frps-setup.sh`：在你**自己的**服务器上一把装好 frps（systemd、随机 token、防火墙、可选 nginx + Let's Encrypt + Basic 认证），结尾打印本机要用的命令；
- 新增 `tools/frpc-setup.sh`：在本机装 frpc、写 `frpc.toml`、写（不 enable）用户单元，缺参数时交互提问；
- 新增 `docs/VPS.md`（给人看）与 `docs/AI-SETUP.md`（给 AI 执行：硬规则、运行顺序、四条验证、故障表）；
- 面板文案改成「用你自己的服务器」，并在检测到公网可达但 frpc 不是本进程拉起时禁用启动按钮（避免两个 frpc 抢同一个 remotePort）。

配套：`README` 增「用你自己的服务器（可选）」，`docker`/`systemd` 不是必需项。

## 1.0.4 — 把「性能与限制」写清楚

功能不变。补了一节实测表格与判断方法，用来回答「卡是不是插件的问题」：

- 同局域网 1–3 ms / P2P 30–80 ms / UDP 中继 60–150 ms / **TCP 中继 840–990 ms（最坏 3.7 s）**；
- 解释了 TCP 中继为什么慢（TCP 套 TCP），以及手机 CGNAT 换地址导致 P2P 被隔离的日志长什么样；
- 给出自查命令 `grep -E 'SN-RTT|path=SN-TCP|peer-info-address-changed' /usr/local/lib/stars/res/stars.log`；
- 明确：心跳超时不是插件能修的，要稳定远程就上公网 VPS 中转。

## 1.0.3 — 静态资源长缓存（给慢链路减负）

上游返回的 `/assets/*.js|css` **没有** `cache-control`，也没有 `etag` / `last-modified`，浏览器无法判断新鲜度，重载时只能整套重新下载（一套 1.5–3 MB）。在组网这种 250 KB/s、往返 500 ms 的链路上，一次重连就等于重传一遍，越重连越慢、越慢越容易再断。

- 反代对 `/assets/<带哈希>.(js|css|woff2|png|svg|webp)` 补上 `cache-control: public, max-age=31536000, immutable`；
- 文件名本身带内容哈希，所以长缓存是安全的（换版本 = 换文件名）。

## 1.0.2 — 把卖点改成「手机远程控制」

功能没变，只是把话说对：这东西最主要的用法是**用手机远程控制电脑上的 DSH**（同一个实例、同一份会话），
「笔记本 / NAS / 电视盒子也能开」降级成附加卖点。

- README 中英开头改成手机优先；
- npm 描述、市场条目中英描述同步；
- 面板副标题改成「用手机远程控制：手机浏览器打开就是你在电脑上用的那个 DSH」。

## 1.0.1 — 修「一直重新连接中」

`Origin` 没有跟着 `Host` 一起改写，DSH 的 WebSocket 升级被自己的同源校验挡成 **403**，
于是 HTTP 一切正常（页面能开、API 能通），但实时通道连不上，界面底部一直显示「重新连接中…」。这一版修掉它，并顺手把长连接的 TCP keepalive 打开。

- `rewrite()` 在改写 `Host` 的同时改写 `Origin`（`http://<upstream>`）；
- upgrade 路径两个 socket 都 `setNoDelay(true)` + `setKeepAlive(true, 30000)`，让中继上的空闲长连接不容易被悄悄丢掉。

## 1.0.0 — 改名（原名 dsh-phone-tunnel）

插件和「手机」没关系：它做的是把组网地址上的请求转给本进程。所以改了名，顺便把定位放宽。

- **包名 / 仓库名**：`dsh-phone-tunnel` → `dsh-mesh-access`（npm 上的旧名已 `deprecate`，仍可按旧名装到最后那版 0.1.5）；
- 面板文案、「不只手机」章节、npm 描述、市场条目描述都改成「组网里的任何设备」；
- API 路径 `/api/dsh-phone-tunnel/*` → `/api/dsh-mesh-access/*`；
- 挂载 id `mesh` → `mesh-access`；
- 命名空间变了，所以版本从 1.0.0 重新起（不是 0.1.6）。

从 0.1.5 升级：先 `dsh plugin --profile web remove dsh-phone-tunnel`，再 `add dsh-mesh-access@1.0.0`，然后重启 `dsh web`。

## 0.1.5

- **把定位从「手机」放宽到「组网里的任何设备」**：手机、平板、另一台电脑、带图形界面的 NAS（DSM / QTS / TrueNAS Scale）、电视盒子，只要能连到组网 IP 就能打开，对方设备**不需要装任何东西**；
- 面板文案跟着改：「手机地址」→「访问地址」，说明里写清「组网里的任何设备」；
- npm 描述与市场条目描述同步放宽，关键词补 `nas` / `remote-desktop`。

## 0.1.4

- 面板的请求改成**可中止**（`AbortController`）：动作请求 20 秒、状态轮询 6 秒，超时就 abort，不会再把界面吊死；
- 加了**看门狗**：按钮「处理中…」超过 22 秒会自动解除并提示，配合「刷新」按钮自愈；
- 说明一下：这两个数字是给「进程正忙」留的余量 —— DSH 正在推流生成回答时，同一个 Node 进程处理面板请求会明显变慢，看起来像卡住。

## 0.1.3

- **修「点第二次就卡死」**：`start()` 原来会 `await server.close()`，而 `close()` 要等所有连接结束 —— DSH 的实时通道是长连接，于是永远等不到。现在同端口重复点击直接返回现状，并发的点击单飞；
- 关闭改成「先拒绝新连接 → `closeAllConnections()` → 强制销毁自管 socket → 最多等 500ms」，不再阻塞；
- 面板：反代运行时「③ 回到上面开端口」变「③ 端口已开」并禁用；动作请求加 20 秒超时兜底，不会再永远「处理中…」。

## 0.1.2

- 面板直接给出**带 token 的完整地址**（借用 `connection` 服务的 `authenticatedUrl()`），复制到手机点开即可，不必再去终端里找 token。
- 「第一次用星空组网？」改成引导式三步按钮：注册 / 下载客户端 / 回到上面开端口。邀请链接只放在按钮的 `href` 里，不再把 URL 明文印在页面上。
- `inject` 增加 `connection`；`proxy.urlPlain` 保留不带 token 的裸地址。

## 0.1.1 — 2026-11-07

文档语言调整，功能与 0.1.0 完全一致。

- `README.md`、`INSTALL.md`、`CHANGELOG.md`、`docs/architecture.md` 改为**中文**（这个包主要面向中文用户）；
  英文原文保留在 `README.en.md`、`INSTALL.en.md`，两个 README 开头互相跳转。
- 修掉导航行被反引号包住、在 GitHub 上渲染成代码而点不动的问题。
- 包的 `files` 白名单显式列出四个文档文件；构建产物 `*.tgz` 不再进仓库。

## 0.1.0 — 2026-11-07

第一个版本。已发布到 npm：`dsh-mesh-access@0.1.0`。

- **宿主半边**：组网网卡探测（`192.168.*` 上的 `StarVPN`、`utun*`、`tap*`、`tun*`、`wg*`、`gpd*`、
  `ppp*`、`ipsec*`）、进程内反代并改写 `Host`、WebSocket / upgrade 转发、
  `GET /api/dsh-mesh-access/status`、`POST /api/dsh-mesh-access/proxy`。
- **客户端半边**：`sidebar.panellist` + `main` 两个槽位的面板（状态、开/关端口、手机地址与复制、
  首次使用星空组网的提示），每 5 秒轮询一次。
- **没有构建步骤**：两边都是普通的 ESM / 浏览器 JS，所以发布出去的包就是源码本身。
