# 更新日志

## 0.1.0 — 2026-11-07

第一个版本。已发布到 npm：`dsh-phone-tunnel@0.1.0`。

- **宿主半边**：组网网卡探测（`192.168.*` 上的 `StarVPN`、`utun*`、`tap*`、`tun*`、`wg*`、`gpd*`、
  `ppp*`、`ipsec*`）、进程内反代并改写 `Host`、WebSocket / upgrade 转发、
  `GET /api/dsh-phone-tunnel/status`、`POST /api/dsh-phone-tunnel/proxy`。
- **客户端半边**：`sidebar.panellist` + `main` 两个槽位的面板（状态、开/关端口、手机地址与复制、
  首次使用星空组网的提示），每 5 秒轮询一次。
- **没有构建步骤**：两边都是普通的 ESM / 浏览器 JS，所以发布出去的包就是源码本身。
