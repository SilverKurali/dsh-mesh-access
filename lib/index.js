/**
 * dsh-mesh-access — 把运行中的 DSH Web 暴露到组网网卡上（进程内反代）。
 *
 * 为什么是插件：`dsh web --host` 只接受一个具体网卡地址，插件改不了自己进程的监听，
 * 但插件可以在组网地址上再开一个监听，把请求转给自己进程已经在跑的那个端口 —— 
 * 于是手机和电脑是同一个实例、同一份会话状态。
 *
 * 宿主侧只做三件事：
 *   1. 找出组网网卡（StarVPN / utun* / tap* / tun* / wg* / gpd* / ppp*）上的 IPv4
 *   2. GET /api/dsh-mesh-access/status   看状态
 *   3. POST /api/dsh-mesh-access/proxy   启停反代（{action:'start'|'stop', port?}）
 *   4. GET/POST /api/dsh-mesh-access/tunnel  公网隧道（frpc）状态与启停
 *
 * 组网只适合「两端都能连上同一个虚拟网」的场景；校园网/蜂窝网络下走中继，
 * 心跳撑不住长连接。所以额外支持「自己的 VPS + frp」：这里只管 spawn/停止 frpc，
 * 公网地址与证书交给 VPS 上已有的 nginx。
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'

export const name = 'dsh-mesh-access'
export const inject = ['webServer', 'connection']

const REFERRAL = 'https://starvpn.cn/register.html?referralCode=Kurali'

/** 可调项（写在 profile 的 cordis.patch.yml 里，缺省值如下；不引入 schema 依赖）：
 *
 *   - id: mesh
 *     name: dsh-mesh-access
 *     config:
 *       interfacePattern: '^(StarVPN|utun\\d+|tap\\d+|tun\\d+|wg\\d+|gpd\\d+|ppp\\d+|ipsec\\d+)$'
 *       addressPrefix: '192.168.'
 *       proxyPort: 3081
 *       upstream: 127.0.0.1
 */

const asText = (v, fallback) => (typeof v === 'string' && v.length > 0 ? v : fallback)
const asPort = (v, fallback) => {
  const n = Number(typeof v === 'object' && v !== null && 'value' in v ? v.value : v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/** 找出组网候选地址。 */
function findMesh(pattern, prefix) {
  let re
  try {
    re = new RegExp(pattern)
  } catch {
    re = /^(StarVPN|utun\d+)$/
  }
  const found = []
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4
      if (!v4 || a.internal) continue
      if (!re.test(iface)) continue
      if (prefix && !a.address.startsWith(prefix)) continue
      found.push({ iface, address: a.address, netmask: a.netmask })
    }
  }
  return found
}

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) return req.destroy()
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * 进程内反代：监听组网地址，把请求转给本进程的 Web 服务器。
 * Host 改写成上游 authority —— dsh 的 /api 信任栅栏比对的是 Host，
 * 而 cookie 里的 authority 也按这个 Host 签发，两边一致才不会互相打架。
 */
function createProxy({ listenAddress, listenPort, upstream, upstreamPort, authGate }) {
  const target = `${upstream}:${upstreamPort}`
  // DSH 会校验 Origin 与 Host 是否一致（不一致直接 403），所以我们转发时把 Host 改写成
  // 上游地址，就必须把 Origin 一起改写成上游的 origin；否则浏览器的 WebSocket 升级
  // 永远 403，界面上表现成「一直重新连接中」。
  const upstreamOrigin = `http://${target}`
  // 带内容哈希的静态资源（/assets/index-BXV-oxvX.js 这种）
  const CACHEABLE = /\/assets\/[^?]+\.(?:js|css|woff2?|png|svg|webp)$/

  const rewrite = (headers) => {
    const h = { ...headers }
    const incomingHost = headers.host ?? ''
    h.host = target
    h['x-forwarded-host'] = incomingHost
    h['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'http'
    if (headers.origin) h.origin = upstreamOrigin
    return h
  }

  const server = http.createServer((req, res) => {
    const gate = authGate(req)
    if (gate && gate.status) {
      res.writeHead(gate.status, gate.headers)
      res.end(gate.body || '')
      return
    }
    const extra = gate && gate.extraHeaders
    const up = http.request(
      { host: upstream, port: upstreamPort, method: req.method, path: req.url, headers: rewrite(req.headers) },
      (r) => {
        const headers = { ...r.headers }
        // 前端资源文件名带内容哈希，可以放心长缓存。上游没给 cache-control / etag，
        // 浏览器就只能每次重新下载（一套 1.5–3 MB），在组网这种慢链路上等于每次重连都重传一遍。
        if (r.statusCode === 200 && CACHEABLE.test(req.url || '')) {
          headers['cache-control'] = 'public, max-age=31536000, immutable'
        }
        if (extra) {
          for (const [k, v] of Object.entries(extra)) {
            if (k.toLowerCase() === 'set-cookie') {
              const prev = headers['set-cookie']
              headers['set-cookie'] = prev ? [].concat(prev, v) : v
            } else headers[k] = v
          }
        }
        res.writeHead(r.statusCode ?? 502, headers)
        r.pipe(res)
      },
    )
    up.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsh-mesh-access: 上游不可达（${target}）：${err.message}\n`)
    })
    req.pipe(up)
  })

  // WebSocket / HTTP upgrade：裸 socket 双向转发（DSH 的实时通道靠它）
  server.on('upgrade', (req, socket, head) => {
    const gate = authGate(req)
    if (gate && gate.status) {
      socket.write(`HTTP/1.1 ${gate.status} ${gate.status === 404 ? 'Not Found' : 'Unauthorized'}\r\n` +
        Object.entries(gate.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    const up = net.connect(upstreamPort, upstream, () => {
      up.setNoDelay(true)
      up.setKeepAlive(true, 30_000)
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [k, v] of Object.entries(rewrite(req.headers))) {
        if (v === undefined) continue
        for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
      }
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const bye = () => {
      up.destroy()
      socket.destroy()
    }
    up.on('error', bye)
    socket.on('error', bye)
    up.on('close', bye)
    socket.on('close', bye)
  })

  // 记下每一条连接：DSH 的实时通道是长连接，server.close() 会一直等它们，
  // 所以关闭时必须能主动把 socket 干掉，否则 stop()/start() 会永久挂住。
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.killConnections = () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, listenAddress, () => {
      server.removeListener('error', reject)
      server.on('error', () => {})
      resolve(server)
    })
  })
}

export function apply(ctx, config = {}) {
  const cfg = {
    interfacePattern: asText(config.interfacePattern, '^(StarVPN|utun\\d+|tap\\d+|tun\\d+|wg\\d+|gpd\\d+|ppp\\d+|ipsec\\d+)$'),
    addressPrefix: typeof config.addressPrefix === 'string' ? config.addressPrefix : '192.168.',
    proxyPort: asPort(config.proxyPort, 3081),
    upstream: asText(config.upstream, '127.0.0.1'),
    // 公网隧道（frp）。默认路径与 frp 官网安装脚本一致，用户换位置就在配置里覆盖。
    frpcBin: asText(config.frpcBin, `${os.homedir()}/.local/bin/frpc`),
    frpcConfig: asText(config.frpcConfig, `${os.homedir()}/.config/frp/frpc.toml`),
    frpcLog: asText(config.frpcLog, `${os.homedir()}/.config/frp/frpc.log`),
    // 隧道对外暴露的域名（有 TLS 时写域名，没有就留空 —— 会自动退回 http://serverAddr:remotePort）
    tunnelDomain: asText(config.tunnelDomain, ''),
  }

  const state = {
    server: null,
    address: null,
    port: null,
    startedAt: null,
    error: null,
    frpc: null,
    tunnelLog: [],
    tunnelError: null,
    tunnelStartedAt: null,
  }

  const upstreamPort = () => ctx.webServer?.port ?? null

  /**
   * 给组网地址补上本进程的 launch token。
   * 插件拿不到 token 明文，但 connection 服务公开了 authenticatedUrl()，正是
   * `dsh web` 打印地址时用的那一条，所以这里借用它，而不是自己造 token。
   */
  const signed = (baseUrl) => {
    if (!baseUrl) return null
    try {
      return ctx.connection?.authenticatedUrl?.(baseUrl) ?? baseUrl
    } catch {
      return baseUrl
    }
  }
  const snapshot = () => {
    const mesh = findMesh(cfg.interfacePattern, cfg.addressPrefix)
    const port = upstreamPort()
    const running = Boolean(state.server)
    const address = state.address ?? mesh[0]?.address ?? null
    const listenPort = state.port ?? cfg.proxyPort
    return {
      ok: true,
      now: Date.now(),
      host: { upstream: cfg.upstream, port },
      interfaces: Object.entries(os.networkInterfaces())
        .flatMap(([iface, addrs]) => (addrs ?? []).filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal).map((a) => ({ iface, address: a.address })))
        .filter((x) => !cfg.addressPrefix || x.address.startsWith(cfg.addressPrefix)),
      mesh,
      proxy: {
        running,
        address,
        port: listenPort,
        target: port ? `${cfg.upstream}:${port}` : null,
        url: running && address ? signed(`http://${address}:${listenPort}/`) : null,
        urlPlain: running && address ? `http://${address}:${listenPort}/` : null,
        startedAt: state.startedAt,
        error: state.error,
      },
      referral: REFERRAL,
      tunnel: tunnelSnapshot(),
    }
  }

  /* ---------------------------------------------------------------- 公网隧道 */
  // frp 的配置是 TOML，但这里只读几个扁平键，手写一个极简取值器就够 ——
  // 引入 TOML 解析库只为读 4 个字符串不划算（插件想保持零运行时依赖）。
  const tomlValue = (text, key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))
    if (!m) return null
    const raw = m[1].split('#')[0].trim()
    const quoted = raw.match(/^"(.*)"$/)
    if (quoted) return quoted[1]
    const num = Number(raw)
    return Number.isFinite(num) ? num : raw
  }

  const sidecarPath = () => `${path.dirname(cfg.frpcConfig)}/dsh-mesh-access.json`

  const readSidecar = () => {
    try {
      return JSON.parse(fs.readFileSync(sidecarPath(), 'utf8'))
    } catch {
      return {}
    }
  }

  const writeSidecar = (data) => {
    try {
      fs.mkdirSync(path.dirname(sidecarPath()), { recursive: true })
      fs.writeFileSync(sidecarPath(), JSON.stringify(data, null, 2) + '\n')
    } catch {
      /* 侧车只是记域名，写不进去就退回插件配置 */
    }
  }

  /**
   * 写 frpc.toml + 侧车（域名）。面板上的「设置」和 tools/frpc-setup.sh 产出的是同一种文件，
   * 所以用户先跑脚本、后来改用面板改，两边不会打架。
   */
  const writeTunnelConfig = (input) => {
    const str = (v) => (typeof v === 'string' ? v.trim() : '')
    const serverAddr = str(input.serverAddr)
    const domain = str(input.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '')
    const serverPort = Number(input.serverPort ?? 7000)
    const remotePort = Number(input.remotePort ?? 21081)
    const localPort = Number(input.localPort ?? cfg.proxyPort)
    const localIP = str(input.localIP) || '127.0.0.1'
    const token = str(input.token)

    if (!/^[A-Za-z0-9._-]+$/.test(serverAddr)) throw new Error('服务器地址只能填 IP 或域名')
    for (const [name, v] of [['绑定端口', serverPort], ['公网端口', remotePort], ['本地端口', localPort]]) {
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`${name}要填 1–65535 之间的整数`)
    }
    if (domain && !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(domain)) throw new Error('域名格式不对，例如 dsh.example.com')

    let oldToken = ''
    try {
      oldToken = String(tomlValue(fs.readFileSync(cfg.frpcConfig, 'utf8'), 'auth.token') || '')
    } catch {
      /* 没有旧配置就算了 */
    }
    const finalToken = token || oldToken
    if (!finalToken) throw new Error('token 不能为空（服务端 /etc/frp/frps.toml 里的 auth.token）')

    const text = `# 由 dsh-mesh-access 面板生成
serverAddr = "${serverAddr}"
serverPort = ${serverPort}

auth.method = "token"
auth.token = "${finalToken}"

log.to = "${cfg.frpcLog}"
log.level = "info"

[[proxies]]
name = "dsh-mesh"
type = "tcp"
localIP = "${localIP}"
localPort = ${localPort}
remotePort = ${remotePort}
transport.useEncryption = true
`
    fs.mkdirSync(path.dirname(cfg.frpcConfig), { recursive: true })
    fs.writeFileSync(cfg.frpcConfig, text, { mode: 0o600 })
    try {
      fs.chmodSync(cfg.frpcConfig, 0o600)
    } catch {
      /* ignore */
    }
    writeSidecar({ domain: domain || null, updatedAt: new Date().toISOString() })
    return true
  }

  const tunnelCfg = () => {
    let text = ''
    try {
      text = fs.readFileSync(cfg.frpcConfig, 'utf8')
    } catch {
      text = ''
    }
    const serverAddr = tomlValue(text, 'serverAddr')
    const serverPort = Number(tomlValue(text, 'serverPort') ?? 7000)
    const remotePort = Number(tomlValue(text, 'remotePort') ?? 0)
    const localPort = Number(tomlValue(text, 'localPort') ?? cfg.proxyPort)
    const localIP = String(tomlValue(text, 'localIP') || '127.0.0.1')
    const domain = readSidecar().domain || cfg.tunnelDomain || ''
    // 有域名就走 https://domain/（VPS 上 nginx 已经接管 TLS），否则直连 IP:remotePort
    const base = domain ? `https://${domain}/` : remotePort && serverAddr ? `http://${serverAddr}:${remotePort}/` : null
    return {
      configFound: Boolean(text),
      configPath: cfg.frpcConfig,
      binary: cfg.frpcBin,
      serverAddr,
      serverPort,
      remotePort,
      localPort,
      localIP,
      tokenSet: Boolean(tomlValue(text, 'auth.token')),
      domain: domain || null,
      url: base,
      urlSigned: signed(base),
    }
  }

  /** 探测「公网入口是否真的连得上」——比看进程在不在更接近用户感受。 */
  const probe = (host, port, ms = 1500) =>
    new Promise((resolve) => {
      if (!host || !port) return resolve(false)
      const socket = net.connect({ host, port })
      const done = (ok) => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(ms)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })

  const tunnelSnapshot = () => {
    const t = tunnelCfg()
    const running = Boolean(state.frpc)
    return {
      ...t,
      running,
      startedAt: state.tunnelStartedAt,
      error: state.tunnelError,
      log: state.tunnelLog.slice(-12),
      // 进程在跑 ≠ 公网通；反之进程没了但端口仍可连（外部 systemd 起的）也算可用。
      // 这里只给「本插件在看什么」，真正的连通性由 GET /tunnel 现测。
      mode: running ? 'plugin' : 'stopped',
    }
  }

  let startingTunnel = null
  // frpc 默认把日志写进配置里的 log.to，stdout 是空的 —— 所以既要抓管道，也要跟着日志文件读。
  function logFileOffset(logPath) {
    try {
      return fs.statSync(logPath).size
    } catch {
      return 0
    }
  }

  function startTunnel() {
    if (state.frpc) return Promise.resolve({ ok: true, ...snapshot() })
    if (startingTunnel) return startingTunnel
    startingTunnel = new Promise((resolve) => {
      const t = tunnelCfg()
      if (!t.configFound) {
        state.tunnelError = `没找到 frpc 配置：${cfg.frpcConfig}（先按 docs/VPS.md 装 frpc 并写好 frpc.toml）`
        return resolve({ ok: false, error: state.tunnelError })
      }
      let text = ''
      try {
        text = fs.readFileSync(cfg.frpcConfig, 'utf8')
      } catch {
        /* 读不到就当没有 log.to */
      }
      const logPath = tomlValue(text, 'log.to') || ''
      let child
      try {
        child = spawn(cfg.frpcBin, ['-c', cfg.frpcConfig], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        state.tunnelError = String(err?.message ?? err)
        return resolve({ ok: false, error: state.tunnelError })
      }
      state.frpc = child
      state.tunnelError = null
      state.tunnelStartedAt = Date.now()
      let settled = false
      let offset = logPath ? logFileOffset(logPath) : 0
      let stopTail = () => {}

      const settle = (ok, error) => {
        if (settled) return
        settled = true
        stopTail()
        if (!ok) {
          state.tunnelError = error ?? 'frpc 启动失败'
          try {
            child.kill('SIGTERM')
          } catch {
            /* ignore */
          }
          state.frpc = null
          state.tunnelStartedAt = null
        }
        resolve(ok ? { ok: true, ...snapshot() } : { ok: false, error: state.tunnelError })
      }

      const push = (line) => {
        if (!line.trim()) return
        state.tunnelLog.push(line.slice(0, 300))
        if (state.tunnelLog.length > 40) state.tunnelLog.splice(0, state.tunnelLog.length - 40)
        if (/start proxy success/i.test(line)) settle(true)
        else if (/start error|port already used|login to server failed/i.test(line)) settle(false, line.slice(0, 200))
      }

      const onLine = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) push(line)
      }
      child.stdout?.on('data', onLine)
      child.stderr?.on('data', onLine)

      const poll = () => {
        if (!logPath || settled) return
        let size = 0
        try {
          size = fs.statSync(logPath).size
        } catch {
          return
        }
        if (size <= offset) return
        try {
          const fd = fs.openSync(logPath, 'r')
          const len = size - offset
          const buf = Buffer.alloc(len)
          fs.readSync(fd, buf, 0, len, offset)
          fs.closeSync(fd)
          offset = size
          for (const line of buf.toString('utf8').split(/\r?\n/)) push(line)
        } catch {
          /* 文件被轮转之类，下一轮再说 */
        }
      }
      const timer = setInterval(poll, 150)
      stopTail = () => clearInterval(timer)

      child.on('error', (err) => settle(false, String(err?.message ?? err)))
      child.on('exit', (code, signal) => {
        state.frpc = null
        state.tunnelStartedAt = null
        if (!settled) settle(false, `frpc 退出（code=${code} signal=${signal}）`)
        else if (state.tunnelError === null) state.tunnelError = `frpc 已退出（code=${code} signal=${signal}）`
      })
      setTimeout(() => {
        if (!settled) settle(false, '等了 8 秒没收到「start proxy success」，看下面日志')
      }, 8000)
    }).finally(() => {
      startingTunnel = null
    })
    return startingTunnel
  }

  async function stopTunnel() {
    const child = state.frpc
    state.frpc = null
    state.tunnelStartedAt = null
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    state.tunnelError = null
    return { ok: true, ...snapshot() }
  }

  /** 关掉一个代理服务：先拒绝新连接，再强断旧连接，最多等 500ms，绝不挂死。 */
  async function closeServer(server) {
    if (!server) return
    const closed = new Promise((resolve) => server.close(() => resolve()))
    try {
      server.closeAllConnections?.()
      server.killConnections?.()
    } catch {
      /* 尽力而为 */
    }
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))])
  }

  async function start(port) {
    const target = upstreamPort()
    if (!target) return { ok: false, error: '上游端口未知：Web 服务器还没绑定？' }
    const mesh = findMesh(cfg.interfacePattern, cfg.addressPrefix)
    if (mesh.length === 0) {
      return { ok: false, error: `没找到组网网卡（正则 ${cfg.interfacePattern}，前缀 ${cfg.addressPrefix || '不限'}）。先把星空/Tailscale/WireGuard 连上。` }
    }
    const listenPort = port ?? state.port ?? cfg.proxyPort
    // 已经在这个端口上跑着，就直接返回现状 —— 重复点「开端口」不该重启监听，
    // 否则会先关后开，中间那一刀很容易把手机上的长连接切死。
    if (state.server && state.port === listenPort) return { ok: true, ...snapshot() }
    if (starting) return starting
    starting = run(listenPort, mesh, target)
    try {
      const out = await starting
      // 记住「上次开着的组网口」，dsh web 重启后自动恢复（1.5.3）
      if (out && out.ok) writeSidecar({ ...readSidecar(), meshPort: listenPort, meshPortAt: new Date().toISOString() })
      return out
    } finally {
      starting = null
    }
  }

  // ===== 公网入口认证（1.4.0）：关 / 账号密码 / 密钥，全在本机，面板改完即生效 =====
  const genKey = () => randomBytes(32).toString('base64url')
  const hashPassword = (pass) => {
    const salt = randomBytes(16).toString('hex')
    return 'scrypt:' + salt + ':' + scryptSync(String(pass), salt, 32).toString('hex')
  }
  const verifyPassword = (pass, stored) => {
    try {
      const [scheme, salt, hex] = String(stored).split(':')
      if (scheme !== 'scrypt' || !salt || !hex) return false
      const want = Buffer.from(hex, 'hex')
      const got = scryptSync(String(pass), salt, want.length)
      return want.length === got.length && timingSafeEqual(want, got)
    } catch {
      return false
    }
  }
  const readAuth = () => {
    const side = readSidecar()
    if (side && side.auth && side.auth.key) return side.auth
    const fresh = {
      mode: 'key',
      username: 'dsh',
      passwordHash: hashPassword(randomBytes(9).toString('base64url')),
      key: genKey(),
    }
    writeSidecar({ ...side, auth: fresh, authInitAt: new Date().toISOString() })
    return fresh
  }
  const writeAuth = (patch) => {
    const side = readSidecar()
    const next = { ...(side.auth || {}), ...patch }
    writeSidecar({ ...side, auth: next, authUpdatedAt: new Date().toISOString() })
    return next
  }
  const COOKIE = 'dshmeshkey'
  const SESSION_COOKIE = 'dshsession'
  const SESSION_TTL = 24 * 3600 * 1000
  const sessions = new Map() // sid -> expiresAt(ms)，进程内存；重启后各设备重登一次
  const sweepSessions = () => {
    const now = Date.now()
    for (const [sid, exp] of sessions) if (exp < now) sessions.delete(sid)
  }
  const bakeCookie = (key, secure) =>
    `${COOKIE}=${key}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  const parseCookies = (req) => {
    const out = {}
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=')
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    return out
  }
  // null=放行；{status,headers,body}=拦截
  const authGate = (req) => {
    const a = readAuth()
    if (!a.mode || a.mode === 'off') return null
    if (a.mode === 'basic') {
      const viaHttps = String(req.headers['x-forwarded-proto'] || '').includes('https')
      // 已有 24h 会话的设备直接放行（仅该设备；改密码或换模式会清空全部会话）
      sweepSessions()
      const sid = parseCookies(req)[SESSION_COOKIE]
      if (sid && sessions.has(sid)) return null
      const m = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''))
      if (m) {
        const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':')
        if (u === a.username && verifyPassword(rest.join(':'), a.passwordHash)) {
          const newSid = randomBytes(24).toString('base64url')
          sessions.set(newSid, Date.now() + SESSION_TTL)
          return {
            pass: true,
            extraHeaders: { 'set-cookie': `${SESSION_COOKIE}=${newSid}; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict${viaHttps ? '; Secure' : ''}` },
          }
        }
      }
      return { status: 401, headers: { 'www-authenticate': 'Basic realm="DSH"', 'content-type': 'text/plain; charset=utf-8' }, body: '401 unauthorized\n' }
    }
    // key 模式：?meshkey= 一次性换 cookie + 顺手注入 DSH token；cookie 常驻放行；其余 404 伪装成不存在
    const url = new URL(req.url, 'http://x')
    const viaHttps = String(req.headers['x-forwarded-proto'] || '').includes('https')
    const fromParam = url.searchParams.get('meshkey')
    const fromCookie = parseCookies(req)[COOKIE]
    if (fromCookie && fromCookie === a.key && !fromParam) return null
    if (fromParam && fromParam === a.key) {
      const base = `http://${req.headers.host || 'localhost'}${url.pathname}`
      const redirect = new URL(signed(base))
      redirect.searchParams.delete('meshkey')
      return {
        status: 302,
        headers: { location: redirect.pathname + (redirect.search || ''), 'set-cookie': bakeCookie(a.key, viaHttps) },
      }
    }
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not Found\n' }
  }

  let starting = null
  async function run(listenPort, mesh, target) {
    if (state.server) {
      const old = state.server
      state.server = null
      await closeServer(old)
    }
    const address = mesh[0].address
    try {
      state.server = await createProxy({ listenAddress: address, listenPort, upstream: cfg.upstream, upstreamPort: target, authGate })
      state.address = address
      state.port = listenPort
      state.startedAt = Date.now()
      state.error = null
      ctx.logger?.info?.(`dsh-mesh-access: ${address}:${listenPort} → ${cfg.upstream}:${target}`)
      return { ok: true, ...snapshot() }
    } catch (err) {
      state.server = null
      state.error = String(err?.message ?? err)
      return { ok: false, error: state.error }
    }
  }

  async function stop() {
    const server = state.server
    state.server = null
    state.startedAt = null
    // 手动关掉就不再自动恢复（1.5.3）
    const side = readSidecar()
    if (side.meshPort) writeSidecar({ ...side, meshPort: null, meshPortAt: null })
    if (!server) return { ok: true, ...snapshot() }
    await closeServer(server)
    state.error = null
    return { ok: true, ...snapshot() }
  }

  // ===== 自动恢复（1.5.3）：dsh web 重启后，把上次开着的组网口自动开回来 =====
  // 不阻塞启动：轮询等两件事就绪——上游端口绑定、组网网卡出现（开机时 TAP 可能晚几秒）。
  // 任何一次 start 失败（含网卡一直没出现）都静默放弃，等用户回面板手动开。
  {
    const wanted = readSidecar().meshPort
    if (wanted) {
      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        if (state.server || tries > 60) return clearInterval(timer) // 已开（手动）或等了 5 分钟
        if (!upstreamPort()) return
        start(Number(wanted))
          .then((out) => { if (out?.ok) { clearInterval(timer); ctx.logger?.info?.('dsh-mesh-access: 已自动恢复组网端口 ' + wanted) } })
          .catch(() => {})
      }, 5000)
    }
  }

  /* —— billion-context 临时停用（组网/远程卡顿时的减负开关）—— */
  const BC_MARKER = '# dsh-mesh-access managed (perf toggle)'
  const profileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const cordisPatch = () => path.join(profileRoot, 'cordis.patch.yml')
  const bcDisabled = () => {
    try { return fs.readFileSync(cordisPatch(), 'utf8').includes(BC_MARKER) } catch { return false }
  }
  const bcDaemonPids = () => {
    try {
      const out = execSync("pgrep -f 'billion-context/dist/index.js start' || true", { encoding: 'utf8' })
      return out.trim() ? out.trim().split('\n') : []
    } catch { return [] }
  }
  const bcDisable = () => {
    const f = cordisPatch()
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch { text = '' }
    if (!text.includes(BC_MARKER)) {
      text = text.replace(/\s+$/, '\n') + `\n${BC_MARKER}\n- id: billion-context\n  disabled: true\n`
      fs.writeFileSync(f, text)
    }
    for (const pid of bcDaemonPids()) { try { process.kill(Number(pid), 'SIGTERM') } catch {} }
    return { ok: true, disabled: true, note: '已写入停用补丁并结束 billion-context 守护；重启 dsh web 后彻底不加载' }
  }
  const bcEnable = () => {
    const f = cordisPatch()
    try {
      let text = fs.readFileSync(f, 'utf8')
      const re = new RegExp('\\n?' + BC_MARKER.replace(/[()]/g, '\\$&') + '\\n- id: billion-context\\n\\s+disabled: true\\n?', 'g')
      text = text.replace(re, '\n').replace(/\s+$/, '\n')
      fs.writeFileSync(f, text)
    } catch {}
    return { ok: true, disabled: false, note: '已移除停用补丁；重启 dsh web 后恢复加载' }
  }

  ctx.effect(() => {
    const routes = [
      {
        kind: 'exact',
        path: '/api/dsh-mesh-access/status',
        handler: (req, res) => json(res, 200, snapshot()),
      },
      {
        kind: 'exact',
        path: '/api/dsh-mesh-access/proxy',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
          let body = {}
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { ok: false, error: 'body 不是合法 JSON' })
          }
          const action = String(body.action ?? '')
          if (action === 'start') return json(res, 200, await start(body.port ? Number(body.port) : undefined))
          if (action === 'stop') return json(res, 200, await stop())
          return json(res, 400, { ok: false, error: "action 只能是 'start' 或 'stop'" })
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-mesh-access/perf',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            return json(res, 200, { ok: true, bcDisabled: bcDisabled(), bcDaemons: bcDaemonPids().length })
          }
          if (req.method === 'POST') {
            let body = {}
            try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }) }
            const action = String(body.action ?? '')
            if (action === 'disable-bc') return json(res, 200, bcDisable())
            if (action === 'enable-bc') return json(res, 200, bcEnable())
            return json(res, 400, { ok: false, error: "action 只能是 'disable-bc' 或 'enable-bc'" })
          }
          return json(res, 405, { ok: false, error: 'GET/POST only' })
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-mesh-access/auth',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const a = readAuth()
            return json(res, 200, { ok: true, mode: a.mode || 'off', username: a.username || '', key: a.key || '', hasPassword: Boolean(a.passwordHash) })
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST only' })
          let body = {}
          try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }) }
          const patch = {}
          const mode = String(body.mode ?? '')
          if (mode) {
            if (!['off', 'basic', 'key'].includes(mode)) return json(res, 400, { ok: false, error: 'mode 只能是 off / basic / key' })
            patch.mode = mode
          }
          if (body.username !== undefined) {
            const u = String(body.username).trim()
            if (!/^[A-Za-z0-9._-]{1,32}$/.test(u)) return json(res, 400, { ok: false, error: '账号只能字母数字点下划线连字符，1–32 位' })
            patch.username = u
          }
          if (body.password !== undefined) {
            const pw = String(body.password)
            if (pw.length < 6 || pw.length > 128) return json(res, 400, { ok: false, error: '密码 6–128 位' })
            patch.passwordHash = hashPassword(pw)
          }
          if (body.resetKey) patch.key = genKey()
          if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没给任何要改的字段' })
          const next = writeAuth(patch)
          sessions.clear()
          return json(res, 200, { ok: true, mode: next.mode, username: next.username, key: next.key, hasPassword: Boolean(next.passwordHash) })
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-mesh-access/tunnel',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const t = tunnelCfg()
            const host = t.domain || t.serverAddr
            const port = t.domain ? 443 : t.remotePort
            const snap = tunnelSnapshot()
            const reachable = await probe(host, port)
            let webAuth = null
            if (reachable) {
              try {
                const r = await fetch(`${t.domain ? 'https' : 'http'}://${host}${t.domain ? '' : ':' + t.remotePort}/`, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
                const www = r.headers.get('www-authenticate') || ''
                if (r.status === 401 && /basic/i.test(www)) webAuth = 'basic'
                else if (r.status === 401 || r.status === 403) webAuth = 'other'
                else webAuth = 'none'
              } catch { webAuth = null }
            }
            // external：公网已经通了，但 frpc 不是这个进程拉起来的（用户自己的 systemd 单元在跑）
            return json(res, 200, { ok: true, ...snap, reachable, webAuth, external: reachable && !snap.running })
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST only' })
          let body = {}
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return json(res, 400, { ok: false, error: 'body 不是合法 JSON' })
          }
          const action = String(body.action ?? '')
          if (action === 'start') return json(res, 200, await startTunnel())
          if (action === 'stop') return json(res, 200, await stopTunnel())
          if (action === 'auth') {
            try {
              const out = await setWebAuth(body)
              return json(res, out.ok ? 200 : 400, { ...out, action: 'auth' })
            } catch (e) {
              return json(res, 400, { ok: false, error: String(e?.message ?? e) })
            }
          }
          if (action === 'config') {
            try {
              writeTunnelConfig(body)
            } catch (err) {
              return json(res, 400, { ok: false, error: String(err?.message ?? err) })
            }
            return json(res, 200, { ok: true, ...tunnelSnapshot() })
          }
          return json(res, 400, { ok: false, error: "action 只能是 'start' 或 'stop'" })
        },
      },
    ]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const d of disposers) d()
      void stop()
      void stopTunnel()
    }
  }, 'dsh-mesh-access: routes + proxy + tunnel')
}
