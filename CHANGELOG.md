# Changelog

## 0.1.0 — 2026-11-07

First release.

- Host half: mesh interface discovery (`StarVPN`, `utun*`, `tap*`, `tun*`, `wg*`, `gpd*`, `ppp*`,
  `ipsec*` on `192.168.*`), in-process reverse proxy with `Host` rewrite, WebSocket/upgrade
  forwarding, `GET /api/dsh-mesh/status`, `POST /api/dsh-mesh/proxy`.
- Client half: `sidebar.panellist` + `main` slot panel (status, start/stop, phone URL + copy,
  first-run referral note), polling every 5 s.
- No build step: both halves are plain ESM/browser JS, so the published package is the source.
