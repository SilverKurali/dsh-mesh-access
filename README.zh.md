# dsh-phone-tunnel

把**正在运行**的 DeepSeek Harness 网页界面挂到组网网卡上——在服务进程内部完成，不需要第二个实例，
不需要 SSH，也不碰路由器。

`[English](README.md) | [中文](#它做什么)`

## 它做什么

`dsh web --host` 只接受一个具体的网卡地址，而且拒绝通配。所以只在 `127.0.0.1:3080` 上服务的实例，
手机看不见；开机之后才出现的 TAP（星空组网 `StarVPN`）或 `utun` 网卡，也不会自动成为它的监听地址。

这个插件在**已经在跑的那个进程里**多开一个组网端口：

```
手机 ──▶ 192.168.188.1:3081 ──▶ (插件反代) ──▶ 127.0.0.1:3080（你正在用的这个 dsh）
```

一个实例、一份会话列表：不会出现 `task-board ledger is already owned by …`，也不会出现两边状态不同步。

## 安装

```bash
dsh plugin --profile web add dsh-phone-tunnel
# 或者从本地目录装：
dsh plugin --profile web add link:/绝对路径/dsh-phone-tunnel
```

重启 profile 后，左侧导航多出「组网访问」：

| 功能块 | 内容 |
|---|---|
| 当前状态 | 反代是否在跑、DSH 自己的监听端口、找到几个组网网卡 |
| 动作 | 在组网地址上开端口 / 关闭 / 刷新 |
| 手机地址 | 给手机打开的地址，带复制按钮 |
| 第一次用星空组网？ | 邀请注册链接 + 成员账号规则 |

## 配置（可选）

写在 profile 的 patch 层里，全部有默认值：

```yaml
- id: mesh
  name: dsh-phone-tunnel
  config:
    interfacePattern: '^(StarVPN|utun\d+|tap\d+|tun\d+|wg\d+|gpd\d+|ppp\d+|ipsec\d+)$'
    addressPrefix: '192.168.'
    proxyPort: 3081
    upstream: 127.0.0.1
```

`addressPrefix` 的作用是别把 `tun*` 上的公网地址当成组网地址。

## 为什么 cookie 能一直用

带 `?token=` 的请求返回 `303` 并种下 `dsh-auth-*`（`HttpOnly`、`SameSite=Strict`、
`Max-Age=2592000`）。cookie 里写死了签发时的 authority，签名密钥存在持久的凭据记录里
（不是每进程随机），所以重启也还在。反代每次都把 `Host` 改写成上游 authority，于是 cookie 里的
authority 与服务端期望的一致——这就是换个端口访问还能继续用同一份 cookie 的原因。

反过来也成立：换了组网 IP 或端口，就得重新点一次 token 链接。

## 限制

- 插件动不了自己进程的监听地址：组网端口是反代，不是把主服务再绑一次。
- 只考虑 IPv4 组网地址。
- 仍然依赖隧道本身的质量。星空组网走中继时实测单向约 0.4 MB/s，`[SN-RTT]` 会抖到几秒，
  长回答可能中途停住，刷新即可接回。
- 还没发到 npm；现在用 `link:` 或 git 地址装。

## 配套

另一套是命令行版：[dsh-mesh-kit](https://github.com/SilverKurali/dsh-mesh-kit)，负责在
DSH 还没启动时、或没有 Node 插件环境的机器上，把第二个实例绑到组网 IP，并配防火墙与二维码。

MIT。
