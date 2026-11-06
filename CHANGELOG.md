# Changelog

## 0.1.0 — 2026-11-07

First release. Published to npm as `dsh-phone-tunnel@0.1.0`.

- Host half: mesh interface discovery (`StarVPN`, `utun*`, `tap*`, `tun*`, `wg*`, `gpd*`, `ppp*`,
  `ipsec*` on `192.168.*`), in-process reverse proxy with `Host` rewrite, WebSocket/upgrade
  forwarding, `GET /api/dsh-phone-tunnel/status`, `POST /api/dsh-phone-tunnel/proxy`.
- Client half: `sidebar.panellist` + `main` slot panel (status, start/stop, phone URL + copy,
  first-run referral note), polling every 5 s.
- No build step: both halves are plain ESM/browser JS, so the published package is the source.
