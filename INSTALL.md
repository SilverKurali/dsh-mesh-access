# Install / 安装

## Requirement

- DSH `>= 0.2.1-rc.2` (`dsh --version`)
- Node `>= 22` (whatever DSH already runs on)
- An initialized `web` profile (`~/.dsh/profiles/web` exists — DSH creates it on first `dsh web`)

## From npm (once published)

```bash
dsh plugin --profile web add dsh-plugin-mesh
```

## From a local checkout

```bash
git clone https://github.com/SilverKurali/dsh-plugin-mesh
dsh plugin --profile web add link:"$PWD/dsh-plugin-mesh"
```

`link:` installs the directory itself; pnpm prints a peer-resolution warning that is expected for
link installs and harmless here (the plugin has no peer for `@deepseek-ai/dsh` beyond the host).

## From a git URL

```bash
dsh plugin --profile web add git+https://github.com/SilverKurali/dsh-plugin-mesh.git
```

## Verify

```bash
# 1. the profile now lists the plugin
grep -n 'dsh-plugin-mesh' ~/.dsh/profiles/web/package.json

# 2. restart the profile, then ask the host directly
curl -s http://127.0.0.1:3080/api/dsh-mesh/status | head -20
```

A healthy answer looks like:

```json
{
  "ok": true,
  "host": { "upstream": "127.0.0.1", "port": 3080 },
  "mesh": [{ "iface": "StarVPN", "address": "192.168.188.1", "netmask": "255.255.255.0" }],
  "proxy": { "running": false, "port": 3081, "url": null }
}
```

Then open the **组网访问** panel and press *在组网地址上开端口*, or:

```bash
curl -s -X POST -H 'content-type: application/json' \
     -d '{"action":"start","port":3081}' \
     http://127.0.0.1:3080/api/dsh-mesh/proxy
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-mesh
```

Nothing is written outside the profile directory and `~/.dsh`; there is no service, no autostart,
no firewall rule. Stopping the proxy (or restarting the profile) closes the mesh port.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `没找到组网网卡` | The mesh client is not connected, or the interface is named differently. Run `ip -br addr` / `ifconfig` and set `interfacePattern` to match, and check `addressPrefix`. |
| Panel shows the proxy running but the phone times out | Something between the phone and this host drops it — on Linux check `firewall-cmd --zone=<mesh zone> --list-ports`, on Windows the inbound rule for the port. |
| Phone gets the page but every API call fails | The page was opened on a stale token/cookie; open a fresh `?token=` URL once. |
| `listen EADDRINUSE` | Another process owns the port (a previous `dsh web` or the kit's script). Stop it, or start this proxy on a different port. |
| Port opens, phone sees `401` | Expected: no cookie yet. `?token=` once. |
