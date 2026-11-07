/** Small DOM primitives with shadcn/ui-inspired styling; no framework runtime is required. */
export function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value)
    else if (key === 'class') element.className = value
    else if (key in element && !key.startsWith('aria')) element[key] = value
    else element.setAttribute(key, value)
  }
  element.append(...children.map(child => typeof child === 'string' ? document.createTextNode(child) : child))
  return element
}

export function icon(kind) {
  const paths = { chevrons: ['m8 9 4-4 4 4', 'm8 15 4 4 4-4'], check: ['m5 12 4 4L19 6'], plus: ['M12 5v14', 'M5 12h14'] }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', 'data-icon': 'inline-end' })) svg.setAttribute(name, value)
  for (const d of paths[kind] ?? []) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path) }
  return svg
}

export function tabs(items, value, onChange, label, disabled = false) {
  const list = node('div', { class: 'tabs-list', role: 'tablist', 'aria-label': label })
  const choose = id => { if (!disabled) onChange(id) }
  for (const item of items) list.append(node('button', {
    type: 'button', role: 'tab', id: `tab-${item.id}`, 'aria-controls': `panel-${item.id}`, 'aria-selected': String(value === item.id),
    tabIndex: value === item.id ? 0 : -1, disabled, 'data-focus-key': `tab:${item.id}`, onclick: () => choose(item.id),
    onkeydown: event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = items.findIndex(option => option.id === item.id)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
      const root = list.getRootNode()
      choose(items[next].id)
      root.querySelector(`#tab-${items[next].id}`)?.focus()
    },
  }, item.name))
  return list
}

export function stepper(items, onSelect, label, disabled = false) {
  const list = node('ol', { class: 'stepper', 'aria-label': label })
  for (const [index, item] of items.entries()) {
    const state = item.current ? 'current' : item.done ? 'done' : 'upcoming'
    const attrs = { type: 'button', class: 'stepper-step', 'data-state': state, disabled, 'data-focus-key': `step:${item.id}`, onclick: () => { if (!disabled) onSelect(item.id) } }
    if (item.current) attrs['aria-current'] = 'step'
    const marker = node('span', { class: 'stepper-marker', 'aria-hidden': 'true' }, item.done ? '✓' : String(index + 1))
    const step = node('button', attrs, marker, node('span', { class: 'stepper-copy' }, node('strong', {}, item.name)))
    list.append(node('li', { class: 'stepper-item' }, step, ...(index < items.length - 1 ? [node('span', { class: 'stepper-link', 'aria-hidden': 'true' })] : [])))
  }
  return list
}

let nextId = 0

export function combobox({ value, items, label, placeholder, searchLabel, emptyText, moreText, disabled, focusKey, onChange }) {
  const id = `speech-choice-${++nextId}`
  const current = items.find(item => item.id === value)
  const trigger = node('button', { type: 'button', id, class: 'combobox-trigger', disabled: disabled || !items.length,
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': `${id}-popup`, 'data-focus-key': focusKey,
    title: current ? `${current.name} · ${current.id}` : placeholder },
  node('span', { class: current ? '' : 'muted-foreground' }, current?.name || placeholder), icon('chevrons'))
  const popup = node('div', { id: `${id}-popup`, class: 'combobox-popup', popover: 'auto', role: 'dialog', 'aria-label': label })
  const search = node('input', { type: 'search', class: 'combobox-search', placeholder: searchLabel, 'aria-label': searchLabel,
    role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': `${id}-list`, autocomplete: 'off' })
  const list = node('div', { id: `${id}-list`, class: 'combobox-options', role: 'listbox', 'aria-label': label })
  const more = node('button', { type: 'button', class: 'quiet combobox-more' }, moreText)
  const wrapper = node('div', { class: 'combobox', 'data-control-id': id }, trigger, popup)
  popup.append(search, list, more)
  let filtered = items, highlighted = 0, limit = 100, openEvents, disposed = false

  function highlight(index) {
    highlighted = index
    const options = [...list.children]
    options.forEach((option, position) => { option.dataset.highlighted = String(position === highlighted) })
    const option = options[highlighted]
    if (option?.getAttribute('role') === 'option') search.setAttribute('aria-activedescendant', option.id)
    else search.removeAttribute('aria-activedescendant')
    if (option) {
      const top = option.offsetTop - list.offsetTop
      if (top < list.scrollTop) list.scrollTop = top
      else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight
    }
  }
  function pick(item) {
    popup.hidePopover()
    trigger.focus({ preventScroll: true })
    onChange(item.id)
  }
  function renderOptions() {
    const needle = search.value.trim().toLocaleLowerCase()
    filtered = items.filter(item => !needle || `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle))
    const shown = filtered.slice(0, limit)
    list.replaceChildren(...shown.map((item, index) => node('div', {
      id: `${id}-option-${index}`, class: 'combobox-option', role: 'option', 'aria-selected': String(item.id === value),
      onpointerdown: event => event.preventDefault(), onpointermove: () => highlight(index), onclick: () => pick(item),
    }, node('span', { class: 'choice-copy' }, node('span', {}, item.name), node('small', {}, item.id)),
    ...(item.id === value ? [icon('check')] : []))))
    if (!shown.length) list.append(node('p', { class: 'combobox-empty', role: 'status' }, emptyText))
    more.hidden = shown.length >= filtered.length
    highlight(Math.min(highlighted, Math.max(0, shown.length - 1)))
  }
  function position() {
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 24)
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const height = Math.min(360, Math.max(below, above))
    Object.assign(popup.style, { width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      maxHeight: `${height}px`, top: `${below >= Math.min(280, above) ? rect.bottom + 6 : Math.max(12, rect.top - Math.min(popup.scrollHeight, height) - 6)}px` })
  }
  trigger.onclick = () => { if (popup.matches(':popover-open')) popup.hidePopover(); else popup.showPopover() }
  popup.addEventListener('toggle', event => {
    const open = event.newState === 'open'
    trigger.setAttribute('aria-expanded', String(open))
    openEvents?.abort()
    if (!open || disposed || !popup.isConnected) return
    search.value = ''; limit = 100; highlighted = Math.max(0, items.findIndex(item => item.id === value))
    if (highlighted >= limit) limit = highlighted + 1
    renderOptions(); position(); search.focus({ preventScroll: true })
    openEvents = new AbortController()
    window.addEventListener('resize', position, { signal: openEvents.signal })
    window.addEventListener('scroll', event => { if (!popup.contains(event.target)) position() }, { capture: true, passive: true, signal: openEvents.signal })
  })
  search.oninput = () => { highlighted = 0; limit = 100; renderOptions(); position() }
  search.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popup.hidePopover(); trigger.focus({ preventScroll: true }) }
    else if (event.key === 'Enter') { event.preventDefault(); if (filtered[highlighted]) pick(filtered[highlighted]) }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && filtered.length) {
      event.preventDefault()
      highlight((highlighted + (event.key === 'ArrowDown' ? 1 : -1) + Math.min(limit, filtered.length)) % Math.min(limit, filtered.length))
    }
  }
  more.onclick = () => { limit += 100; renderOptions(); position(); search.focus({ preventScroll: true }) }
  popup.addEventListener('focusout', () => queueMicrotask(() => {
    if (popup.isConnected && popup.matches(':popover-open') && !popup.contains(popup.getRootNode().activeElement)) popup.hidePopover()
  }))
  wrapper.dispose = () => { disposed = true; openEvents?.abort(); if (popup.isConnected && popup.matches(':popover-open')) popup.hidePopover() }
  return wrapper
}
