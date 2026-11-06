/**
 * dsh-phone-tunnel —— 浏览器半边。
 *
 * 手写 loader 模块，不需要 TS / JSX / 打包器：DSH 的 client loader 只要求
 * `window.__ModuleLoader__.load({ id, factory })` 里返回 `{ apply, inject }`。
 * 组件用 react.createElement 拼，避免引入构建链。
 */
window.__ModuleLoader__.load({
  id: 'dsh-phone-tunnel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const PANEL_ID = 'mesh'
    const S = {
      wrap: { padding: '24px 28px', maxWidth: 860, color: 'inherit', font: 'inherit' },
      h1: { fontSize: 20, fontWeight: 600, margin: '0 0 4px' },
      sub: { opacity: 0.62, fontSize: 13, margin: '0 0 20px' },
      card: { border: '1px solid rgba(127,127,127,.28)', borderRadius: 12, padding: '16px 18px', marginBottom: 14 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, letterSpacing: '.02em', opacity: 0.55, textTransform: 'uppercase', marginBottom: 8 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 },
      btn: { padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      btnPrimary: { padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(127,127,127,.4)', background: 'rgba(127,127,127,.16)', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
      pill: (on) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid rgba(127,127,127,.35)', opacity: on ? 1 : 0.6 }),
      dot: (on) => ({ width: 7, height: 7, borderRadius: 999, background: on ? '#3fb950' : '#8b949e' }),
      err: { color: '#f85149', fontSize: 13, marginTop: 8 },
      hint: { fontSize: 12, opacity: 0.6, marginTop: 10, lineHeight: 1.6 },
    }

    const api = {
      status: () => fetch('/api/dsh-phone-tunnel/status', { credentials: 'same-origin' }).then((r) => r.json()),
      action: (action, port) =>
        fetch('/api/dsh-phone-tunnel/proxy', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, port }),
        }).then((r) => r.json()),
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
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState(null)
      const [copied, setCopied] = react.useState(false)

      const refresh = react.useCallback(() => {
        api
          .status()
          .then((s) => {
            setState(s)
            setErr(s && s.ok === false ? s.error ?? '未知错误' : null)
          })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
      }, [])

      react.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 5000)
        return () => clearInterval(t)
      }, [refresh])

      const run = (action) => {
        setBusy(true)
        setErr(null)
        api
          .action(action)
          .then((s) => {
            if (s && s.ok === false) setErr(s.error ?? '操作失败')
            else setState(s)
          })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
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

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.h1 }, '组网访问'),
        h('div', { style: S.sub }, '把当前这个 DSH 实例搬到组网网卡上，手机浏览器直接打开，不用第二个实例、不用 SSH。'),

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
            '手机和电脑因此是同一个实例、同一份会话列表。',
          ),
        ),

        url
          ? h(
              Card, { title: '手机地址' },
              h('div', { style: S.row },
                h('code', { style: { ...S.mono, wordBreak: 'break-all' } }, url),
                h('button', { style: S.btn, onClick: () => copy(url) }, copied ? '已复制' : '复制'),
              ),
              h('div', { style: S.hint },
                '第一次打开会 303 跳转并种下 cookie（30 天，HttpOnly），之后裸地址直接进。',
                ' cookie 里的 authority 是发给这个地址的，换端口或换 IP 要重新点一次 token 链接。',
              ),
            )
          : null,

        h(
          Card, { title: '第一次用星空组网？' },
          h('div', { style: S.hint },
            '用邀请链接注册，' + referral + ' —— 链接里的 referralCode 才是归属凭据，直接输域名注册不算邀请。',
            ' 装好客户端后，每台设备用各自的成员账号（子账号）登录；同一个账号同时登两台会互相顶掉。',
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
        console.warn('[dsh-phone-tunnel] 面板注册失败：', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }, 'dsh-phone-tunnel: ui')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
