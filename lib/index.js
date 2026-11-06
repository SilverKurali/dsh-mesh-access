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
 */
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'

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
function createProxy({ listenAddress, listenPort, upstream, upstreamPort }) {
  const target = `${upstream}:${upstreamPort}`
  // DSH 会校验 Origin 与 Host 是否一致（不一致直接 403），所以我们转发时把 Host 改写成
  // 上游地址，就必须把 Origin 一起改写成上游的 origin；否则浏览器的 WebSocket 升级
  // 永远 403，界面上表现成「一直重新连接中」。
  const upstreamOrigin = `http://${target}`
  const rewrite = (headers) => {
    const h = { ...headers }
    const incomingHost = headers.host ?? ''
    h.host = target
    h['x-forwarded-host'] = incomingHost
    h['x-forwarded-proto'] = 'http'
    if (headers.origin) h.origin = upstreamOrigin
    return h
  }

  const server = http.createServer((req, res) => {
    const up = http.request(
      { host: upstream, port: upstreamPort, method: req.method, path: req.url, headers: rewrite(req.headers) },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
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
  }

  const state = { server: null, address: null, port: null, startedAt: null, error: null }

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
    }
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
      return await starting
    } finally {
      starting = null
    }
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
      state.server = await createProxy({ listenAddress: address, listenPort, upstream: cfg.upstream, upstreamPort: target })
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
    if (!server) return { ok: true, ...snapshot() }
    await closeServer(server)
    state.error = null
    return { ok: true, ...snapshot() }
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
    ]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const d of disposers) d()
      void stop()
    }
  }, 'dsh-mesh-access: routes + proxy')
}
