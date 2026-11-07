/**
 * dsh-mesh-access —— 浏览器半边。
 *
 * 手写 loader 模块，不需要 TS / JSX / 打包器：DSH 的 client loader 只要求
 * `window.__ModuleLoader__.load({ id, factory })` 里返回 `{ apply, inject }`。
 * 组件用 react.createElement 拼，避免引入构建链。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mesh-access',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const PANEL_ID = 'mesh'
    const S = {
      wrap: { padding: '24px 28px', maxWidth: 860, color: 'inherit', font: 'inherit', height: '100%', boxSizing: 'border-box', overflowY: 'auto' },
      h1: { fontSize: 20, fontWeight: 600, margin: '0 0 4px' },
      sub: { opacity: 0.62, fontSize: 13, margin: '0 0 20px' },
      card: { border: '1px solid rgba(127,127,127,.28)', borderRadius: 12, padding: '16px 18px', marginBottom: 14 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, letterSpacing: '.02em', opacity: 0.55, textTransform: 'uppercase', marginBottom: 8 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 },
      btn: { padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      link: {
    padding: '6px 14px',
    borderRadius: 8,
    background: 'transparent',
    border: '1px solid var(--vscode-panel-border, #3a3f4b)',
    color: 'var(--vscode-textLink-foreground, #6cb6ff)',
    textDecoration: 'none',
    fontSize: 13,
    cursor: 'pointer',
    display: 'inline-block',
  },
  btnPrimary: { padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(127,127,127,.4)', background: 'rgba(127,127,127,.16)', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
      pill: (on) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid rgba(127,127,127,.35)', opacity: on ? 1 : 0.6 }),
      dot: (on) => ({ width: 7, height: 7, borderRadius: 999, background: on ? '#3fb950' : '#8b949e' }),
      err: { color: '#f85149', fontSize: 13, marginTop: 8 },
      hint: { fontSize: 12, opacity: 0.6, marginTop: 10, lineHeight: 1.6 },
      input: {
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        width: 200,
      },
      label: { fontSize: 12, opacity: 0.7, marginBottom: 4, display: 'block' },
    }

    /** 带硬超时的 fetch：超时就 abort，绝不让调用方永远挂着。
     *  面板上「处理中…」卡死过一次（请求发出去了但响应没回来），
     *  所以这里用 AbortController 兜底，而不是只 Promise.race。 */
    const fetchJson = (url, options = {}, ms = 8000) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), ms)
      return fetch(url, { ...options, credentials: 'same-origin', signal: ctrl.signal })
        .then((r) => r.json())
        .finally(() => clearTimeout(timer))
    }

    const api = {
      status: () => fetchJson('/api/dsh-mesh-access/status', {}, 6000),
      tunnel: () => fetchJson('/api/dsh-mesh-access/tunnel', {}, 8000),
      auth: () => fetchJson('/api/dsh-mesh-access/auth', {}, 8000),
      authPost: (body) => fetchJson('/api/dsh-mesh-access/auth', { method: 'POST', body: JSON.stringify(body) }, 20000),
      tunnelAction: (action) =>
        fetchJson('/api/dsh-mesh-access/tunnel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(typeof action === 'string' ? { action } : action),
        }, 20000),
      action: (action, port) =>
        fetchJson('/api/dsh-mesh-access/proxy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, port }),
        }, 20000),
    }

    function Icon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18M12 3c2.6 2.4 2.6 15.6 0 18M12 3c-2.6 2.4-2.6 15.6 0 18' }),
      )
    }

    function Card({ title, children }) {
      return h('div', { style: S.card }, h('div', { style: S.label }, title), children)
    }

    function Panel() {
      const [state, setState] = react.useState(null)
      const [tunnel, setTunnel] = react.useState(null)
      const [auth, setAuth] = react.useState(null)
      const [authBusy, setAuthBusy] = react.useState(false)
      const [authErr, setAuthErr] = react.useState(null)
      const [authForm, setAuthForm] = react.useState({ username: '', password: '' })
      const [authMsg, setAuthMsg] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [tunnelBusy, setTunnelBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const [tunnelErr, setTunnelErr] = react.useState(null)
      const [copied, setCopied] = react.useState(false)
      const [formOpen, setFormOpen] = react.useState(false)
      const [form, setForm] = react.useState({})

      const refresh = react.useCallback(() => {
        api
          .status()
          .then((s) => {
            setState(s)
            setErr(s && s.ok === false ? s.error ?? '未知错误' : null)
          })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
        api
          .tunnel()
          .then((t) => setTunnel(t))
          .catch(() => {})
        api
          .auth()
          .then((a) => setAuth(a))
          .catch(() => {})
      }, [])

      react.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 5000)
        return () => clearInterval(t)
      }, [refresh])

      const runTunnel = (action) => {
        setTunnelBusy(true)
        setTunnelErr(null)
        api
          .tunnelAction(action)
          .then((t) => {
            if (t && t.ok === false) setTunnelErr(t.error ?? '操作失败')
            else setTunnelErr(t && t.error ? t.error : null)
            setTunnel(t && t.tunnel ? t.tunnel : t)
            refresh()
          })
          .catch((e) => setTunnelErr(String(e && e.message ? e.message : e)))
          .finally(() => setTunnelBusy(false))
      }

      const runConfig = () => {
        const payload = Object.assign({ action: 'config' }, form)
        setTunnelBusy(true)
        setTunnelErr(null)
        api
          .tunnelAction(payload)
          .then((t) => {
            if (t && t.ok === false) {
              setTunnelErr(t.error ?? '保存失败')
              return null
            }
            setFormOpen(false)
            setForm({})
            refresh()
            // 存完顺手起隧道；起不来也只报错，不静默
            return api.tunnelAction('start')
          })
          .then((t) => {
            if (!t) return
            if (t && t.ok === false) setTunnelErr(t.error ?? '隧道没起来')
            else if (t && t.error) setTunnelErr(t.error)
            refresh()
          })
          .catch((e) => setTunnelErr(String(e && e.message ? e.message : e)))
          .finally(() => setTunnelBusy(false))
      }

      const openForm = () => {
        const tn0 = tunnel || (state && state.tunnel) || {}
        setForm({
          serverAddr: tn0.serverAddr || '',
          serverPort: String(tn0.serverPort || 7000),
          remotePort: String(tn0.remotePort || 21081),
          localPort: String(tn0.localPort || (state && state.proxy && state.proxy.port) || 3081),
          localIP: tn0.localIP || (state && state.mesh && state.mesh[0] && state.mesh[0].address) || '127.0.0.1',
          domain: tn0.domain || '',
          token: '',
        })
        setFormOpen(true)
      }

      const setField = (k) => (e) => setForm(Object.assign({}, form, { [k]: e.target.value }))

      const run = (action) => {
        setBusy(true)
        setErr(null)
        const started = Date.now()
        const watch = setInterval(() => {
          if (Date.now() - started < 22000) return
          clearInterval(watch)
          setBusy(false)
          setErr('这次请求超过 22 秒没有回音，已自动解除；如果端口状态和预期不符，点一下「刷新」')
        }, 1000)
        api.action(action)
          .then((s) => {
            if (s && s.ok === false) setErr(s.error ?? '操作失败')
            else setState(s)
          })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
          .finally(() => {
            clearInterval(watch)
            setBusy(false)
          })
      }

      const copy = (text) => {
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {})
        else done()
      }

      const mesh = (state && state.mesh) || []
      const proxy = (state && state.proxy) || { running: false }
      const host = (state && state.host) || {}
      const url = proxy.url
      const referral = (state && state.referral) || 'https://starvpn.cn/register.html?referralCode=Kurali'
      const tn = tunnel || (state && state.tunnel) || {}

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.h1 }, '组网访问'),
        h('div', { style: S.sub }, '用手机远程控制：手机浏览器打开就是你在电脑上用的那个 DSH——同一实例、同一份会话，不用第二个实例，不用 SSH。'),

        h(
          Card, { title: '当前状态' },
          h('div', { style: S.row },
            h('span', { style: S.pill(proxy.running) }, h('span', { style: S.dot(proxy.running) }), proxy.running ? '反代运行中' : '反代未启动'),
            h('span', { style: S.pill(Boolean(host.port)) }, h('span', { style: S.dot(Boolean(host.port)) }), host.port ? 'DSH 监听 127.0.0.1:' + host.port : 'DSH 端口未知'),
            h('span', { style: S.pill(mesh.length > 0) }, h('span', { style: S.dot(mesh.length > 0) }), mesh.length > 0 ? '组网网卡 ' + mesh.length + ' 个' : '未发现组网网卡'),
          ),
          h('div', { style: S.hint }, mesh.length > 0
            ? '组网：' + mesh.map((m) => m.iface + ' → ' + m.address).join('，')
            : '没找到 StarVPN / utun / tap / tun / wg 网卡上的 192.168.* 地址。先把星空组网（或 Tailscale / WireGuard）连上再刷新。'),
        ),

        h(
          Card, { title: '动作' },
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, disabled: busy || proxy.running, onClick: () => run('start') }, busy ? '处理中…' : '在组网地址上开端口'),
            h('button', { style: S.btn, disabled: busy || !proxy.running, onClick: () => run('stop') }, '关闭'),
            h('button', { style: S.btn, disabled: busy, onClick: refresh }, '刷新'),
          ),
          err ? h('div', { style: S.err }, err) : null,
          h('div', { style: S.hint },
            '开端口 = 在组网 IP 上再监听一个端口（默认 3081），把你现在的请求转给本进程的 127.0.0.1:' + (host.port || '3080') + '。',
            '组网里的任何设备因此都是同一个实例、同一份会话列表。',
          ),
        ),

        url
          ? h(
              Card, { title: '访问地址' },
              h('div', { style: S.row },
                h('code', { style: { ...S.mono, wordBreak: 'break-all' } }, url),
                h('button', { style: S.btn, onClick: () => copy(url) }, copied ? '已复制' : '复制'),
              ),
              h('div', { style: S.hint },
                '这条地址已经带上本进程的 token，直接点开就能进；它会种下 30 天 cookie，之后裸地址也进得去。',
                ' cookie 里的 authority 是发给这个地址的 —— 换端口或换 IP，回到这里重新复制一次。',
              ),
            )
          : null,

        h(
          Card, { title: '公网隧道（自己的 VPS，可选的第二条路）' },
          h('div', { style: S.row },
            h('span', { style: S.pill(Boolean(tn.running || tn.external)) }, h('span', { style: S.dot(Boolean(tn.running || tn.external)) }),
              tn.running ? 'frpc 运行中（本插件）' : tn.external ? 'frpc 运行中（外部进程）' : 'frpc 未运行'),
            h('span', { style: S.pill(Boolean(tn.reachable)) }, h('span', { style: S.dot(Boolean(tn.reachable)) }), tn.reachable ? '公网可达' : '公网不可达'),
            h('span', { style: S.pill(Boolean(tn.url)) }, h('span', { style: S.dot(Boolean(tn.url)) }), tn.domain ? '域名 ' + tn.domain : tn.remotePort ? '端口 ' + tn.remotePort : '未配置'),
            (tn.reachable && tn.webAuth
              ? h('span', { style: S.pill(tn.webAuth !== 'none') }, h('span', { style: S.dot(tn.webAuth !== 'none') }),
                  tn.webAuth === 'basic' ? '有登录弹窗（Basic）' : tn.webAuth === 'none' ? '无登录弹窗' : '有访问控制')
              : null),
          ),
          h('div', { style: S.row, marginTop: 12 },
            h('button', {
              style: S.btnPrimary,
              disabled: tunnelBusy || Boolean(tn.running) || Boolean(tn.external) || !tn.configFound,
              onClick: () => runTunnel('start'),
            }, tunnelBusy ? '处理中…' : tn.external ? '外部进程已在跑' : '启动隧道'),
            h('button', {
              style: S.btn,
              disabled: tunnelBusy || !tn.running,
              title: tn.external && !tn.running ? '这个 frpc 是外部进程（systemd 单元），请用 systemctl --user stop dsh-frpc' : '',
              onClick: () => runTunnel('stop'),
            }, '停止'),
            h('button', { style: S.btn, disabled: tunnelBusy, onClick: refresh }, '刷新'),
            h('button', { style: S.btn, disabled: tunnelBusy, onClick: formOpen ? () => setFormOpen(false) : openForm }, formOpen ? '收起' : tn.configFound ? '改配置' : '填服务器信息'),
          ),
          formOpen
            ? h('div', { style: { marginTop: 12, padding: 12, borderRadius: 8, border: '1px dashed rgba(127,127,127,.35)' } },
                h('div', { style: S.hint, marginTop: 0, opacity: 0.8 },
                  '这里填的是你自己的服务器。服务器那一头（frps + nginx + 证书）插件够不着，两个办法：'),
                h('div', { style: { ...S.hint, marginTop: 6, paddingLeft: 12, opacity: 0.85 } },
                  '① 把服务器交给 AI：把 docs/AI-SETUP.md 一起丢给它，让它上去跑 tools/frps-setup.sh（一条命令全装好）；'),
                h('div', { style: { ...S.hint, marginTop: 4, paddingLeft: 12, opacity: 0.85 } },
                  '② 自己 SSH 上去跑：sudo ./tools/frps-setup.sh --port 7000 --http-port 21081 --domain 你的域名。域名和 https 也是这条命令带 --domain 就顺手配好的。'),
                h('div', { style: S.row, marginTop: 10, gap: 10 },
                  h('div', null, h('label', { style: S.label }, '服务器地址（IP 或域名）'),
                    h('input', { style: S.input, value: form.serverAddr || '', placeholder: '1.2.3.4', onChange: setField('serverAddr') })),
                  h('div', null, h('label', { style: S.label }, '绑定端口 bindPort'),
                    h('input', { style: S.input, value: form.serverPort || '', placeholder: '7000', onChange: setField('serverPort') })),
                  h('div', null, h('label', { style: S.label }, '公网端口 remotePort'),
                    h('input', { style: S.input, value: form.remotePort || '', placeholder: '21081', onChange: setField('remotePort') })),
                ),
                h('div', { style: S.row, marginTop: 10, gap: 10 },
                  h('div', null, h('label', { style: S.label }, '域名（可选，填了就用 https）'),
                    h('input', { style: S.input, value: form.domain || '', placeholder: 'dsh.example.com', onChange: setField('domain') })),
                  h('div', null, h('label', { style: S.label }, '本地端口（组网 IP 上那个）'),
                    h('input', { style: S.input, value: form.localPort || '', placeholder: '3081', onChange: setField('localPort') })),
                  h('div', null, h('label', { style: S.label }, 'token' + (tn.tokenSet ? '（已存，留空不变）' : '')),
                    h('input', {
                      style: S.input,
                      type: 'password',
                      value: form.token || '',
                      placeholder: tn.tokenSet ? '••••••••（保持不变）' : '服务端 /etc/frp/frps.toml 里的 auth.token',
                      onChange: setField('token'),
                    })),
                ),
                h('div', { style: S.row, marginTop: 12 },
                  h('button', { style: S.btnPrimary, disabled: tunnelBusy, onClick: runConfig }, tunnelBusy ? '保存中…' : '保存并启动'),
                  h('button', { style: S.btn, disabled: tunnelBusy, onClick: () => setFormOpen(false) }, '取消'),
                ),
                h('div', { style: S.hint }, '保存会写 ~/.config/frp/frpc.toml（600）和同目录的 dsh-mesh-access.json（只存域名）。'),
              )
            : null,
          tunnelErr ? h('div', { style: S.err }, tunnelErr) : null,
          tn.urlSigned
            ? h('div', { style: S.row, marginTop: 12 },
                h('code', { style: { ...S.mono, wordBreak: 'break-all' } }, tn.urlSigned),
                h('button', { style: S.btn, onClick: () => copy(tn.urlSigned) }, copied ? '已复制' : '复制'),
              )
            : null,
          h('div', { style: S.hint },
            tn.configFound
              ? 'frpc 配置：' + tn.configPath + (tn.serverAddr ? '（' + tn.serverAddr + '，本地 ' + tn.localPort + ' → 远端 ' + tn.remotePort + '）' : '')
              : '还没填服务器信息（点上面的「填服务器信息」）。服务器那头先装 frps：sudo ./tools/frps-setup.sh，想连域名 https 一起配就加 --domain 你的域名 —— 这一步在服务器上跑，面板替不了；本机这头填完表单保存就行。',
            tn.external && !tn.running
              ? ' 现在这个隧道是你自己的外部进程在跑（多半是 systemd 单元 dsh-frpc），所以这里显示为「外部进程」并且不让重复启动，免得抢同一个 remotePort。想停：systemctl --user stop dsh-frpc。'
              : '',
            ' 组网走中继时 RTT 800–990 ms（最坏 3.7 s），长连接会被心跳判死；你自己的服务器通常 30–60 ms。',
            tn.reachable && tn.webAuth === 'none'
              ? ' 注意：这个入口现在没有登录弹窗，知道地址的人都能打开你的 DSH 登录页。给入口加登录：SSH 到服务器跑 tools/frps-setup.sh --domain 你的域名（会生成随机账号密码并打印出来）；已有账号想改密码：sudo htpasswd /etc/nginx/.dsh_htpasswd dsh。账号密码是服务器端的东西，面板这里只负责告诉你状态，改要上服务器。'
              : tn.webAuth === 'basic'
                ? ' 打开地址时浏览器会先弹账号密码框（nginx Basic 认证）。账号密码是你在服务器上跑 tools/frps-setup.sh 时它打印给你的（默认账号 dsh）；忘了就上服务器 sudo htpasswd /etc/nginx/.dsh_htpasswd dsh 重设。'
                : '',
          ),
          tn.log && tn.log.length
            ? h('div', { style: { ...S.hint, ...S.mono, marginTop: 8, whiteSpace: 'pre-wrap', opacity: 0.5 } }, tn.log.slice(-4).join('\n'))
            : null,
        ),

        h(
          Card, { title: '入口登录（公网地址的门锁）' },
          (() => {
            const a = auth || {}
            const runAuth = (body, okMsg) => {
              setAuthBusy(true); setAuthErr(null); setAuthMsg(null)
              api.authPost(body)
                .then((r) => {
                  setAuthBusy(false)
                  if (r && r.ok === false) { setAuthErr(r.error || '失败'); return }
                  setAuth(r); if (okMsg) setAuthMsg(okMsg)
                })
                .catch((e) => { setAuthBusy(false); setAuthErr(String(e && e.message ? e.message : e)) })
            }
            const setMode = (mode) => runAuth({ mode },
              mode === 'key' ? '已切到密钥模式：手机打开下面带 meshkey 的地址一次，30 天内免登录、无弹窗'
              : mode === 'basic' ? '已切到账号密码模式：弹窗登录一次，24 小时内该设备免登录'
              : '已关闭入口登录：任何知道地址的人都能打开，请确认你接受')
            const firstUrl = (tn.url || tn.urlPlain) && a.key ? (tn.url || tn.urlPlain) + '?meshkey=' + encodeURIComponent(a.key) : null
            const modes = [
              { m: 'key', label: '密钥' },
              { m: 'basic', label: '账号密码' },
              { m: 'off', label: '关闭' },
            ]
            const segItem = (m, label, active) => h('div', {
              style: {
                padding: '6px 16px', borderRadius: 999, cursor: 'pointer', fontSize: 13,
                background: active ? 'rgba(88,166,255,.9)' : 'transparent',
                color: active ? '#fff' : 'inherit',
                fontWeight: active ? 600 : 400,
                transition: 'all .15s ease', userSelect: 'none',
              },
              onClick: () => { if (!authBusy && !active) setMode(m) },
            }, label)
            const modeNames = { key: '密钥', basic: '账号密码', off: '已关闭' }
            return h('div', null,
              h('div', { style: S.hint }, '门锁模式（三选一，点选切换；同一时间只有一种生效，当前：' + (modeNames[a.mode] || a.mode) + '）：'),
              h('div', {
                style: {
                  display: 'inline-flex', gap: 4, padding: 4, borderRadius: 999,
                  border: '1px solid rgba(127,127,127,.4)', background: 'rgba(127,127,127,.12)',
                  marginBottom: 4,
                },
              },
                modes.map(x => segItem(x.m, x.label, a.mode === x.m)),
              ),
              h('div', { style: { ...S.hint, marginTop: 6 } },
                '密钥＝无弹窗（手机用带密钥的地址认证一次，30 天免登录） · ',
                '账号密码＝浏览器弹窗（登录一次 24 小时内仅该设备免登录） · ',
                '关闭＝无门锁（任何拿到地址的人都能进，不建议）',
              ),
              authMsg ? h('div', { style: { ...S.hint, color: '#7ee787', marginTop: 8 } }, authMsg) : null,
              a.mode === 'key'
                ? h('div', { style: { marginTop: 10 } },
                    h('div', { style: S.hint }, '密钥（只读，可复制；怀疑泄露就点重置，旧密钥立即作废）：'),
                    h('div', { style: S.row, marginTop: 6 },
                      h('input', { style: { ...S.input, ...S.mono, flex: 1 }, readOnly: true, value: a.key || '', onFocus: (e) => e.target.select() }),
                      h('button', { style: S.btn, onClick: () => copy(a.key) }, copied ? '已复制' : '复制'),
                      h('button', { style: S.btn, disabled: authBusy, onClick: () => { if (window.confirm('重置后旧密钥立刻作废，所有用旧密钥的设备都要重新认证。继续？')) runAuth({ resetKey: true }, '已重置：用新地址重新认证各设备') } }, '重置'),
                    ),
                    firstUrl ? h('div', { style: { marginTop: 8 } },
                      h('div', { style: S.hint }, '手机首次打开（认证一次，30 天内该设备免登录、无弹窗）：'),
                      h('div', { style: S.row, marginTop: 6 },
                        h('code', { style: { ...S.mono, wordBreak: 'break-all', flex: 1 } }, firstUrl),
                        h('button', { style: S.btn, onClick: () => copy(firstUrl) }, copied ? '已复制' : '复制'),
                      ),
                    ) : null,
                  )
                : null,
              a.mode === 'basic'
                ? h('div', { style: { marginTop: 10 } },
                    h('div', { style: S.row, gap: 10 },
                      h('div', null, h('label', { style: S.label }, '账号'),
                        h('input', { style: S.input, value: authForm.username, placeholder: a.username || 'dsh', onChange: (e) => setAuthForm(Object.assign({}, authForm, { username: e.target.value })) })),
                      h('div', null, h('label', { style: S.label }, '新密码（6 位起）'),
                        h('input', { style: S.input, type: 'password', value: authForm.password, onChange: (e) => setAuthForm(Object.assign({}, authForm, { password: e.target.value })) })),
                    ),
                    h('div', { style: S.row, marginTop: 8 },
                      h('button', {
                        style: S.btnPrimary, disabled: authBusy || !authForm.password,
                        onClick: () => {
                          if (authForm.password.length < 6) { setAuthErr('密码至少 6 位'); return }
                          runAuth({ username: authForm.username || a.username, password: authForm.password }, '已保存，立即生效；所有已登录设备被踢下线')
                          setAuthForm({ username: '', password: '' })
                        },
                      }, '保存（立即生效）'),
                    ),
                    h('div', { style: S.hint }, '弹窗输一次账密，这台设备 24 小时内免登录；其他设备仍要各自登录。改密码会把所有设备踢下线。'),
                  )
                : null,
              a.mode === 'off' ? h('div', { style: { ...S.hint, marginTop: 8, color: '#f85149' } }, '入口登录已关闭：只剩 DSH 自己的 token 一层，任何拿到地址的人都能看到登录页。') : null,
              authErr ? h('div', { style: S.err, marginTop: 8 }, authErr) : null,
            )
          })(),
        ),
        h(
          Card, { title: '第一次用星空组网？' },
          h('div', { style: S.hint }, '三步走，不用记 IP，也不用改任何配置。'),
          h('div', { style: S.row },
            h('a', { href: referral, target: '_blank', rel: 'noopener noreferrer', style: S.link }, '① 注册星空组网'),
            h('a', { href: 'https://doc.starvpn.cn/#/download', target: '_blank', rel: 'noopener noreferrer', style: S.link }, '② 下载并安装客户端'),
            h('button', { style: S.btn, disabled: busy || !mesh.length || proxy.running, onClick: () => run('start') }, proxy.running ? '③ 端口已开' : '③ 回到上面开端口'),
          ),
          h('div', { style: S.hint },
            '注册后进控制台「设备管理 → 成员列表」，给每台设备建一个成员账号（子账号），客户端用子账号登录。',
            ' 同一个账号同时登两台会互相顶掉；虚拟 IP 属于成员账号，不是在客户端里手填的。',
          ),
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      const disposers = []
      try {
        disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '组网访问' }, Icon),
          ),
        )
        disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel)))
      } catch (error) {
        console.warn('[dsh-mesh-access] 面板注册失败：', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }, 'dsh-mesh-access: ui')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
