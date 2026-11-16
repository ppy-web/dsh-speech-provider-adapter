window.__ModuleLoader__.load({ id: 'dsh-speech-provider-adapter', factory: require => {
  const React = require('react')
  const { Toast, IconWarningOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
  const root = new URL('plugins/speech-provider-adapter/', document.baseURI)
  function Manager() {
    const container = React.useRef(null)
    const sequence = React.useRef(0)
    const [notice, setNotice] = React.useState(null)
    React.useEffect(() => {
      const controller = new AbortController()
      const shadow = container.current.shadowRoot ?? container.current.attachShadow({ mode: 'open' })
      let dispose
      shadow.textContent = navigator.language.startsWith('zh') ? '正在读取配置…' : 'Loading configuration…'
      fetch(new URL('.', root).pathname.replace(/\/$/u, ''), { signal: controller.signal, cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error('manager-unavailable')
        return response.text()
      }).then(async html => {
        if (controller.signal.aborted) return
        const page = new DOMParser().parseFromString(html, 'text/html')
        const revision = page.querySelector('meta[name="adapter-ui-revision"]')?.content
        const versioned = file => {
          const url = new URL(file, root)
          if (revision) url.searchParams.set('v', revision)
          return url.href
        }
        const style = document.createElement('link')
        style.rel = 'stylesheet'; style.href = versioned('style.css')
        const wrapper = document.createElement('section')
        wrapper.className = 'adapter-root embedded'
        wrapper.hidden = true
        wrapper.append(...page.body.children)
        const loading = document.createElement('div')
        loading.setAttribute('role', 'status')
        loading.textContent = navigator.language.startsWith('zh') ? '正在读取配置…' : 'Loading configuration…'
        const styleReady = new Promise((resolve, reject) => {
          const finish = error => {
            clearTimeout(timer)
            style.removeEventListener('load', loaded)
            style.removeEventListener('error', failed)
            controller.signal.removeEventListener('abort', aborted)
            error ? reject(error) : resolve()
          }
          const loaded = () => finish()
          const failed = () => finish(new Error('manager-style-unavailable'))
          const aborted = () => finish(new Error('manager-aborted'))
          const timer = setTimeout(failed, 15000)
          style.addEventListener('load', loaded, { once: true })
          style.addEventListener('error', failed, { once: true })
          controller.signal.addEventListener('abort', aborted, { once: true })
        })
        shadow.replaceChildren(style, loading, wrapper)
        const [{ mountManager }] = await Promise.all([import(versioned('app.js')), styleReady])
        if (controller.signal.aborted) return
        dispose = mountManager(shadow, (text, error) => {
          if (!text) { setNotice(null); return }
          setNotice({ text, error, sequence: ++sequence.current })
        })
        loading.remove()
        wrapper.hidden = false
      }).catch(() => {
        if (controller.signal.aborted) return
        controller.abort()
        shadow.textContent = navigator.language.startsWith('zh') ? '无法读取供应商适配器，请确认插件已启用后重新打开。' : 'Unable to load 供应商适配器. Enable the plugin and reopen its settings.'
      })
      return () => { controller.abort(); dispose?.(); shadow.replaceChildren() }
    }, [])
    return React.createElement(React.Fragment, null,
      React.createElement('div', { ref: container }),
      notice && React.createElement(Toast, {
        key: notice.sequence,
        text: notice.text,
        ...(notice.error ? { icon: React.createElement(IconWarningOutlineRegular) } : { tone: 'success' }),
        holdMs: notice.error ? Math.max(6000, Math.min(12000, notice.text.length * 120)) : 3000,
        onDone: () => setNotice(current => current?.sequence === notice.sequence ? null : current),
      }))
  }
  function Settings({ view }) {
    if (view === 'summary') return React.createElement('span', null, navigator.language.startsWith('zh') ? '配置语音供应商、模型和音色' : 'Configure speech providers, models and voices')
    return React.createElement(Manager)
  }
  return { inject: ['slots'], apply(ctx) {
    ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-speech-provider-adapter' }, Settings)))
  } }
} })
