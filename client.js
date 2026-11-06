window.__ModuleLoader__.load({ id: 'dsh-speech-provider-adapter', factory: require => {
  const React = require('react')
  const root = new URL('plugins/speech-provider-adapter/', document.baseURI)
  function Manager() {
    const container = React.useRef(null)
    React.useEffect(() => {
      const controller = new AbortController()
      const shadow = container.current.shadowRoot ?? container.current.attachShadow({ mode: 'open' })
      let dispose
      shadow.textContent = navigator.language.startsWith('zh') ? '正在读取配置…' : 'Loading configuration…'
      const template = fetch(new URL('.', root).pathname.replace(/\/$/u, ''), { signal: controller.signal, cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error('manager-unavailable')
        return response.text()
      })
      Promise.all([template, import(new URL('app.js', root).href)]).then(([html, { mountManager }]) => {
        if (controller.signal.aborted) return
        const page = new DOMParser().parseFromString(html, 'text/html')
        const style = document.createElement('link')
        style.rel = 'stylesheet'; style.href = new URL('style.css', root).href
        const wrapper = document.createElement('section')
        wrapper.className = 'adapter-root embedded'
        wrapper.append(...page.body.children)
        shadow.replaceChildren(style, wrapper)
        dispose = mountManager(shadow)
      }).catch(() => {
        if (controller.signal.aborted) return
        shadow.textContent = navigator.language.startsWith('zh') ? '无法读取供应商适配器，请确认插件已启用后重新打开。' : 'Unable to load 供应商适配器. Enable the plugin and reopen its settings.'
      })
      return () => { controller.abort(); dispose?.(); shadow.replaceChildren() }
    }, [])
    return React.createElement('div', { ref: container })
  }
  function Settings({ view }) {
    if (view === 'summary') return React.createElement('span', null, navigator.language.startsWith('zh') ? '配置语音供应商、模型和音色' : 'Configure speech providers, models and voices')
    return React.createElement(Manager)
  }
  return { inject: ['slots'], apply(ctx) {
    ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-speech-provider-adapter' }, Settings)))
  } }
} })
