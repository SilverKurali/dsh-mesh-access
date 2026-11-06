# 安装

[中文](INSTALL.md) | [English](INSTALL.en.md)

## 前置条件

- DSH `>= 0.2.1-rc.2`（`dsh --version`）
- Node `>= 22`（DSH 本身就在用的那个即可）
- 已经初始化过 `web` profile（`~/.dsh/profiles/web` 存在 —— 第一次 `dsh web` 时 DSH 会创建）

## 一、从 npm 装（一条命令）

```bash
dsh plugin --profile web add dsh-phone-tunnel
```

已于 2026-11-07 发布：`dsh-phone-tunnel@0.1.0`。

> **国内镜像的坑**：如果你的 npm 指向 `registry.npmmirror.com`，镜像可能只同步了一半元数据，
> pnpm 会报
> `numeric field was not a number: when getting size for package`。
> 这时显式给官方源：
>
> ```bash
> dsh plugin --profile web add dsh-phone-tunnel@0.1.0 --registry=https://registry.npmjs.org
> ```

## 二、从 Release 的 tgz 装（不需要 npm 账号，任何镜像都行）

```bash
dsh plugin --profile web add \
  https://github.com/SilverKurali/dsh-phone-tunnel/releases/download/v0.1.0/dsh-phone-tunnel-0.1.0.tgz
```

## 三、从本地检出装（改代码时用）

```bash
git clone https://github.com/SilverKurali/dsh-phone-tunnel
dsh plugin --profile web add link:"$PWD/dsh-phone-tunnel"
```

`link:` 装的是目录本身。pnpm 会打印一条 peer 依赖解析的警告，`link:` 装法必然出现，
这里无害（本插件对 `@deepseek-ai/dsh` 没有运行时依赖，只是声明了 peer）。

## 四、从 git 地址装

```bash
dsh plugin --profile web add git+https://github.com/SilverKurali/dsh-phone-tunnel.git
```

## 验证

```bash
# 1. profile 里已经有这个插件
grep -n 'dsh-phone-tunnel' ~/.dsh/profiles/web/package.json

# 2. 重启 profile，然后直接问宿主
curl -s http://127.0.0.1:3080/api/dsh-phone-tunnel/status | head -20
```

正常的样子：

```json
{
  "ok": true,
  "host": { "upstream": "127.0.0.1", "port": 3080 },
  "mesh": [{ "iface": "StarVPN", "address": "192.168.188.1", "netmask": "255.255.255.0" }],
  "proxy": { "running": false, "port": 3081, "url": null }
}
```

然后打开**「组网访问」**面板点「在组网地址上开端口」，或者：

```bash
curl -s -X POST -H 'content-type: application/json' \
     -d '{"action":"start","port":3081}' \
     http://127.0.0.1:3080/api/dsh-phone-tunnel/proxy
```

## 卸载

```bash
dsh plugin --profile web remove dsh-phone-tunnel
```

除了 profile 目录和 `~/.dsh` 之外什么都没写：没有系统服务、没有开机自启、没有防火墙规则。
关掉反代（或重启 profile）组网端口就关了。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 面板显示「没找到组网网卡」 | 组网客户端没连上，或者网卡名字不在默认正则里。用 `ip -br addr` 或 `ifconfig` 看真实名字，改配置里的 `interfacePattern`，并检查 `addressPrefix`。 |
| 面板说反代在跑，但手机超时 | 手机到这台机器之间被拦了。Linux 上查 `firewall-cmd --zone=<组网域> --list-ports`，Windows 上查该端口的入站规则。 |
| 手机能打开页面，但每个接口都失败 | 页面用的是过期 token/cookie。重新点一次带 `?token=` 的地址。 |
| `listen EADDRINUSE` | 端口被别的进程占了（上一次的 `dsh web`，或者 kit 脚本起的实例）。先停掉它，或换个端口起反代。 |
| 端口开了，手机看到 `401` | 正常：还没有 cookie。用带 `?token=` 的地址访问一次。 |
