# dsh-phone-tunnel

Expose the **running** DeepSeek Harness web UI on a mesh/VPN interface — from inside the server,
without a second instance, without SSH, without touching the router.

[English](#what-it-does) | [中文](README.md)

## What it does

`dsh web --host` binds exactly one concrete interface address, and it rejects wildcards. So a
server that serves `127.0.0.1:3080` is invisible to your mesh, and a TAP (`StarVPN`) or `utun`
interface created *after* boot is not where it listens.

This plugin adds a mesh port **inside the running process**:

```
phone ──▶ 192.168.188.1:3081 ──▶ (plugin proxy) ──▶ 127.0.0.1:3080  (the same dsh you are using)
```

One instance. One session list. No `task-board ledger is already owned by …` warning, no
half-synced state between two servers.

## Install

```bash
dsh plugin --profile web add dsh-phone-tunnel
```

No npm / behind a China mirror? Use the release tarball:

```bash
dsh plugin --profile web add \
  https://github.com/SilverKurali/dsh-phone-tunnel/releases/download/v0.1.0/dsh-phone-tunnel-0.1.0.tgz
```

From a checkout: `dsh plugin --profile web add link:/absolute/path/to/dsh-phone-tunnel`.
Full matrix (npm / tarball / checkout / git URL), verification and troubleshooting: [INSTALL.en.md](INSTALL.en.md).

Restart the profile. A **组网访问 / Mesh access** entry appears in the left rail:

| Block | What it shows |
|---|---|
| 当前状态 | proxy state, DSH's own listen port, how many mesh interfaces were found |
| 动作 | open the mesh port / close it / refresh |
| 手机地址 | the URL to open on the phone, with a copy button |
| 第一次用星空组网？ | the referral sign-up link and the member-account rule |

## HTTP surface

The panel is a view over two routes kept deliberately small:

```
GET  /api/dsh-phone-tunnel/status     → { host:{upstream,port}, interfaces[], mesh[], proxy{...}, referral }
POST /api/dsh-phone-tunnel/proxy      → {action:'start'|'stop', port?}
```

`curl -s localhost:3090/api/dsh-phone-tunnel/status` is enough to debug without a browser.

## Configuration

Optional, written in the profile's patch layer; every key has a default:

```yaml
- id: mesh
  name: dsh-phone-tunnel
  config:
    interfacePattern: '^(StarVPN|utun\d+|tap\d+|tun\d+|wg\d+|gpd\d+|ppp\d+|ipsec\d+)$'
    addressPrefix: '192.168.'
    proxyPort: 3081
    upstream: 127.0.0.1
```

`addressPrefix` exists so a public address on a `tun*` interface is never mistaken for a mesh
address.

## Why the cookie survives

A request with `?token=` answers `303` and sets `dsh-auth-*` (`HttpOnly`, `SameSite=Strict`,
`Max-Age=2592000`). The cookie payload embeds the **authority it was issued for**, signed with a
secret kept in a persistent credential record — not a per-process random — so it outlives a
restart. The proxy rewrites `Host` to the upstream authority on every request, which keeps the
baked-in authority equal to what the server expects, which is why the same cookie keeps working
through the mesh port.

Corollary: change the mesh IP or the port and you must open a fresh token URL once.

## Limitations

- It cannot move *its own* server's listener; a plugin runs inside a process that is already
  listening. The mesh port is a proxy, not a second bind of the primary server.
- Only IPv4 mesh addresses are considered.
- Still requires the phone to reach the mesh address — the tunnel's own quality applies. On
  StarVPN's relay path expect ~0.4 MB/s and occasional multi-second RTT spikes, which can stall a
  long streaming answer; reload resumes it.

## Companion

The shell-script edition (Linux/macOS/Windows launchers that start a *second* dsh instance bound
to the mesh IP, with firewall rules and QR codes) is
[dsh-mesh-kit](https://github.com/SilverKurali/dsh-mesh-kit). Use this plugin when you want one
instance; use that kit when DSH is not running yet, or on a machine without a Node plugin install.

MIT.
