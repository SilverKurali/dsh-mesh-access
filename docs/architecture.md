# 设计说明

## 约束一：`dsh web` 只绑一个地址

```
--host <host>   绑定地址：本机某张网卡上的一个具体 IPv4/IPv6 字面量；
                通配地址会被拒绝
```

由此产生三个后果：

- `0.0.0.0` **不是选项**，这是设计如此。用 socat/iptables 把它补回来不在范围内。
- 开机时启动的服务，绑的是开机那一刻存在的地址。之后才注册的 TAP（`StarVPN`）不在那一份里。
  在 Linux 上这件事曾经让**别的**守护进程连续几个月打印
  `error: Bind to port 22 on 192.168.188.1 failed: Cannot assign requested address`，
  而服务本身照样起来了、只是没有组网地址 —— 这正是 sshd 那个 guard 单元存在的原因，
  也是这些脚本每次运行都重新解析网卡的原因。
- 想在两个地址上可达，只有两条路：**两个进程**（拓扑 A）或者**一个进程加前面一层反代**（拓扑 B）。

## 约束二：token / cookie 这道栅栏

访问 `/` 时是这样判的：

| 请求 | 响应 |
|---|---|
| `GET /` 无 cookie | `401 dsh web authentication required` |
| `GET /?token=<t>` | `303 See Other`、`location: ./`、`set-cookie: dsh-auth-…` |
| `GET /` 带该 cookie | `200` |
| `/api/*`，`Host` 既不是服务器自己也不在 `--trusted-host` 里 | `403` |

cookie 载荷里写死了**它是为哪个 authority 签发的**：

```json
{"version":1,"authority":"192.168.188.1:3081","issuedAt":…,"expiresAt":…}
```

并用 HMAC-SHA256 对一个存在**持久凭据记录**里的密钥签名（不是每进程随机），
所以 cookie 能活过重启，而 token 不能。

这一条直接决定了反代怎么做：**cookie 里的 authority 必须等于浏览器看到的 origin。**
于是——

- 反代**另一个**实例：把 `Host` 改写成上游（`--target`）；
- 反代**同一个**实例：必须保留浏览器的 `Host`（`--keep-host`），并且实例本身要带
  `--public-url http://<组网IP>:<端口>/ --trusted-host <组网IP>:<端口>` 启动。

## 约束三：一个 home 目录只能有一份 ledger

第二个 `dsh web` 指向同一个 `~/.dsh` 时能正常启动，但会报：

```
ui-task-board … Error: task-board ledger is already owned by process <pid>
```

其它一切正常。两个实例还共享 `~/.dsh/sessions/`，所以会话**列表**是共用的、而**进程状态**不是：
同一个会话在两边同时打开就是自找麻烦。拓扑 A 里这是刻意的 —— 桌面那个实例是 DSH 自己拉起来的，
没法简单搬家 —— 也正是拓扑 B 的主要理由。

## 实测（中继路径，`path=SN`）

```
ping -c 40 -i 0.25 192.168.188.3
40 packets transmitted, 40 received, 0% packet loss
rtt min/avg/max/mdev = 57.540/66.685/78.079/4.580 ms

# 单流，dd | nc 穿过隧道
连续 20 秒约 400 KB/s，共 7.9 MB，无停顿

# 同一时段的客户端日志
[SN-RTT] Supernode 业务包往返偏慢: peerIP=192.168.188.3 rtt=1.054s path=SN
[SN-RTT] … rtt=3.481s …
[SN-RTT] … rtt=5.735s …
```

解读：隧道**能用**，但业务包 RTT 会抖到秒级，而 ICMP 一直很平。所以长连接（界面背后的 SSE / 长轮询）
偶尔会卡住，刷新就能重建。这不是配置能解决的问题 —— 它就是中继本身。
唯一的杠杆是打通直连（`transport=P2P` 加上可用的 STUN 路径）或者买「TCP 穿透」，
而这取决于两张网络能不能互相看见。

## 为什么当初先写脚本、后来又做成插件

`dsh` 的 profile 就是一叠 npm 插件包（`dsh plugin --profile web add <包>`），所以这件事**确实**可以由插件来做。
但脚本做的那几件事，插件永远做不到：

- 自己挑网卡、把**服务进程的监听**（重新）绑上去 —— 地址是 `dsh web` 自己的启动参数；
- 持有系统级的东西（systemd / launchd / Windows 防火墙规则）；
- 在 DSH **没运行**的时候还在。

而插件能做、并且严格优于脚本的，正是拓扑 B 的进程内版本：插件在自己的进程里开一个 `http` 服务绑到组网 IP，
反代到 profile 本来就在服务的那个端口，于是手机和桌面共用同一个实例、没有外部零件。
这就是现在这个包；`dsh-mesh-kit` 里的 `tools/mesh-proxy.mjs` 是同一套逻辑的原型。
