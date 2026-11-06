# 更新日志

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

第一个版本。已发布到 npm：`dsh-phone-tunnel@0.1.0`。

- **宿主半边**：组网网卡探测（`192.168.*` 上的 `StarVPN`、`utun*`、`tap*`、`tun*`、`wg*`、`gpd*`、
  `ppp*`、`ipsec*`）、进程内反代并改写 `Host`、WebSocket / upgrade 转发、
  `GET /api/dsh-phone-tunnel/status`、`POST /api/dsh-phone-tunnel/proxy`。
- **客户端半边**：`sidebar.panellist` + `main` 两个槽位的面板（状态、开/关端口、手机地址与复制、
  首次使用星空组网的提示），每 5 秒轮询一次。
- **没有构建步骤**：两边都是普通的 ESM / 浏览器 JS，所以发布出去的包就是源码本身。
