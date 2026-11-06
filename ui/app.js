import { node, tabs, combobox, icon } from './components.js'

const root = new URL('./', import.meta.url)
const protocols = [{ id: 'senseaudio', name: 'SenseAudio（商汤）' }, { id: 'openai', name: 'OpenAI compatible（OpenAI 兼容）' }, { id: 'minimax', name: 'MiniMax（稀宇科技）' },
  { id: 'siliconflow', name: 'SiliconFlow（硅基流动）' }, { id: 'elevenlabs', name: 'ElevenLabs' }, { id: 'fish', name: 'Fish Audio' },
  { id: 'aliyun', name: 'Alibaba Cloud Bailian（阿里云百炼）' }, { id: 'tencent', name: 'Tencent Cloud（腾讯云）' }]
const manualCatalog = profile => ['aliyun', 'tencent'].includes(profile.protocol)

/** Mount in the host settings surface; disposal aborts requests and removes window listeners. */
export function mountManager(surface) {
  const controller = new AbortController()
  const { signal } = controller
  let language = localStorage.getItem('dsh-speech-adapter-language') ?? (navigator.language.startsWith('zh') ? 'zh' : 'en')
  if (!['zh', 'en'].includes(language)) language = 'en'
  let words = {}, state, accepted, selected = '', busy = true, busyKind = 'loading', dirty = false, deleteId = null
  let catalogKind = 'models', catalogSearch = '', visibleLimit = 40
  const expandedEntries = new Set(), tabByProfile = new Map(), controls = new Set()
  let editorTab = 'connection', profileSearch = ''
  const $ = id => surface.getElementById(id)
  const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), typeof words[key] === 'string' ? words[key] : key)
  const copy = value => structuredClone(value)
  const protocolName = id => protocols.find(item => item.id === id)?.name ?? id

  const button = (label, onclick, attrs = {}) => node('button', { type: 'button', onclick, disabled: busy, 'data-focus-key': attrs['aria-label'] ?? label, ...attrs }, label)
  function message(value = '', error = false) {
    if (signal.aborted) return
    $('message').textContent = value
    $('message').dataset.error = String(error)
    $('message').setAttribute('role', error ? 'alert' : 'status')
  }
  function toolbar() {
    $('save').disabled = busy || !dirty
    $('save').textContent = t(busy && busyKind === 'saving' ? 'saving' : 'save')
    $('discard').disabled = busy || !dirty
    $('add').disabled = busy || !state
    $('provider-search').disabled = busy || !state?.profiles.length
    $('add').replaceChildren(icon('plus'), document.createTextNode(t('add')))
    $('profile-select').disabled = busy || !state?.profiles.length
    $('takeover').disabled = busy || !state?.profiles.length
    $('status').textContent = t(busy ? busyKind : dirty ? 'dirty' : 'upToDate')
    $('status').dataset.dirty = String(dirty)
    $('status').dataset.busy = String(busy)
    const active = accepted?.profiles.find(item => item.id === accepted.activeId)
    $('takeover-status').textContent = !accepted ? t('loading') : accepted.takeoverError ? `${t('failed')} ${t(accepted.takeoverError)}`
      : accepted.takeoverActive ? t(accepted.ready ? 'servingProvider' : 'notReadyProvider', { name: active?.name ?? '' }) : t('inactive')
  }
  function changed() { dirty = true; toolbar() }
  async function api(action, body) {
    const response = await fetch(new URL(`api/${action}`, root), { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal })
    const result = await response.json()
    signal.throwIfAborted()
    if (!response.ok) throw new Error(result.error ?? 'external-upstream-failed')
    return result
  }
  async function action(work, kind = 'working') {
    if (busy || !state) return
    busy = true; busyKind = kind; message(); render()
    try { await work() } catch (error) { message(`${t('failed')} ${t(error.message)}`, true) }
    finally { busy = false; render() }
  }
  async function load() {
    const result = await api('state')
    accepted = copy(result); state = copy(result); dirty = false
    if (!state.profiles.some(item => item.id === selected)) selected = state.activeId || state.profiles[0]?.id || ''
    const profile = state.profiles.find(item => item.id === selected)
    editorTab = tabByProfile.get(selected) ?? (profile?.keyConfigured && profile.models.length && profile.voices.length ? 'selection' : 'connection')
    render()
  }
  function field(label, control, hint = '', full = false) {
    control.dataset.focusKey ??= label
    const controlId = control.dataset.controlId || control.id || undefined
    if (!controlId) control.id = 'field-' + (++fieldSequence)
    return node('div', { class: full ? 'field full' : 'field', 'data-disabled': String(control.disabled === true) },
      node('label', { htmlFor: controlId || control.id }, label), control,
      ...(hint ? [node('p', { class: 'field-description' }, hint)] : []))
  }
  let fieldSequence = 0
  function choice(value, items, update, label, placeholder, focusKey) {
    const control = combobox({ value, items, label, placeholder, searchLabel: t('searchCatalog'), emptyText: t('noMatches'), moreText: t('showMore'), disabled: busy, focusKey,
      onChange: id => { update(id); changed(); render() } })
    controls.add(control.dispose)
    return control
  }
  function input(value, update, attrs = {}) { return node('input', { value, disabled: busy, oninput: event => { update(event.target.value); changed() }, ...attrs }) }
  function check(label, checked, update, focusKey = label) {
    return node('label', { class: 'check' }, node('input', { type: 'checkbox', checked, disabled: busy, 'data-focus-key': focusKey, onchange: event => { update(event.target.checked); changed() } }), node('span', {}, label))
  }
  function select(value, options, update, placeholder = '') {
    const choices = options.map(item => node('option', { value: item.id }, item.name))
    if (placeholder && !options.some(item => item.id === value)) choices.unshift(node('option', { value: '', disabled: true }, placeholder))
    const control = node('select', { disabled: busy || !options.length, title: options.find(item => item.id === value)?.name ?? '', onchange: event => { update(event.target.value); changed(); render() } }, ...choices)
    control.value = options.some(item => item.id === value) ? value : ''
    return control
  }
  function chooseProfile(id) {
    selected = id; deleteId = null; catalogSearch = ''; visibleLimit = 40
    const profile = state.profiles.find(item => item.id === id)
    editorTab = tabByProfile.get(id) ?? (profile?.keyConfigured && profile.models.length && profile.voices.length ? 'selection' : 'connection')
    message(); render()
  }
  function renderProfiles() {
    const scrollTop = $('profiles').scrollTop
    const options = []
    $('profiles').replaceChildren()
    for (const profile of state?.profiles ?? []) {
      const serving = accepted?.takeoverActive && accepted.activeId === profile.id
      const current = state.activeId === profile.id
      const stateLabel = serving ? t('serving') : current ? t(state.activeId !== accepted?.activeId ? 'currentPending' : 'current') : ''
      if (!profileSearch.trim() || (profile.name + ' ' + protocolName(profile.protocol)).toLocaleLowerCase().includes(profileSearch.trim().toLocaleLowerCase())) $('profiles').append(node('button', { type: 'button', class: 'profile', disabled: busy, 'data-focus-key': `profile:${profile.id}`, 'aria-pressed': String(selected === profile.id), onclick: () => chooseProfile(profile.id) },
        node('strong', {}, profile.name || t('unnamed')), node('span', { class: 'profile-meta' }, protocolName(profile.protocol)),
        ...(stateLabel ? [node('span', { class: 'profile-state' }, stateLabel)] : [])))
      options.push(node('option', { value: profile.id }, `${profile.name || t('unnamed')}${stateLabel ? ` · ${stateLabel}` : ''}`))
    }
    if (!$('profiles').childElementCount) $('profiles').append(node('p', { class: 'sidebar-empty' }, t(state?.profiles.length ? 'noMatches' : 'noProfiles')))
    if (!options.length) options.push(node('option', { value: '' }, t('noProfiles')))
    $('profile-select').replaceChildren(...options)
    $('profile-select').value = selected
    $('profiles').scrollTop = scrollTop
  }
  function modelSupports(profile, model) {
    if (profile.protocol === 'tencent') return false
    const supported = profile.protocol === 'openai' ? /^gpt-4o-mini-tts(?:-|$)/u.test(model.id)
      : profile.protocol === 'aliyun' ? /^qwen-audio-3\.[01]-tts-(?:flash|plus)$/u.test(model.id)
        : profile.protocol === 'siliconflow' ? /CosyVoice2/iu.test(model.id) : profile.protocol === 'minimax' && /^speech-(?:2\.[68]|0[12])-/u.test(model.id)
    return model.speechInstruction ?? supported
  }
  function instructionOptions(profile, model) {
    if (profile.protocol !== 'minimax') return null
    return ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', ...(/^speech-2\.6-/u.test(model?.id ?? '') ? ['fluent', 'whisper'] : [])].map(id => ({ id, name: id || t('automatic') }))
  }
  function compatibleVoices(profile) { return profile.voices.filter(voice => !voice.modelIds?.length || voice.modelIds.includes(profile.selection.model)) }
  function sectionHeading(title, hint = '', actions = []) {
    return node('div', { class: 'card-header' }, node('div', {}, node('h3', { class: 'card-title' }, title), ...(hint ? [node('p', { class: 'hint' }, hint)] : [])),
      ...(actions.length ? [node('div', { class: 'actions' }, ...actions)] : []))
  }
  function selectionFields(profile) {
    const model = profile.models.find(item => item.id === profile.selection.model)
    const supported = !!model && modelSupports(profile, model)
    const options = instructionOptions(profile, model)
    const fields = node('div', { class: 'field-group fields card-content' },
      field(t('model'), choice(profile.selection.model, profile.models, id => {
        profile.selection.model = id
        const voices = compatibleVoices(profile)
        if (!voices.some(voice => voice.id === profile.selection.voice)) profile.selection.voice = voices[0]?.id ?? ''
        profile.selection.speechInstruction = ''
      }, t('model'), t('chooseModel'), 'model-choice')),
      field(t('voice'), choice(profile.selection.voice, compatibleVoices(profile), id => { profile.selection.voice = id }, t('voice'), t('chooseVoice'), 'voice-choice')))
    if (supported) fields.append(field(t('instruction'), options ? select(profile.selection.speechInstruction ?? '', options, value => { profile.selection.speechInstruction = value })
      : node('textarea', { value: profile.selection.speechInstruction ?? '', maxLength: 4096, disabled: busy, 'data-focus-key': 'speech-instruction', oninput: event => { profile.selection.speechInstruction = event.target.value; changed() } }), '', true))
    else fields.append(node('p', { class: 'hint selection-note' }, t('unsupported')))
    if (!profile.models.length || !compatibleVoices(profile).length) fields.append(node('p', { class: 'hint selection-note' }, t(profile.protocol === 'fish' && !profile.voices.length ? 'fishVoiceHint' : 'missingCatalog')))
    if (manualCatalog(profile)) fields.append(node('p', { class: 'hint selection-note' }, t('manualCatalogHint')))
    return node('section', { class: 'card form-section', id: 'selection-fields' },
      sectionHeading(t('selection'), t('selectionHint'), [button(t('refresh'), () => query(profile, true), { disabled: busy || manualCatalog(profile), 'data-focus-key': 'refresh-catalog' })]), fields)
  }
  function refreshSelectionFields(profile) { $('selection-fields')?.replaceWith(selectionFields(profile)) }
  function entryOptions(profile, kind, item, index) {
    const key = `${profile.id}:${kind}:${index}`
    const details = node('details', { class: 'entry-options', open: expandedEntries.has(key), ontoggle: event => {
      if (!event.currentTarget.isConnected) return
      if (event.currentTarget.open) expandedEntries.add(key)
      else expandedEntries.delete(key)
    } }, node('summary', {}, t(kind === 'models' ? 'modelCapabilities' : 'voiceScope')))
    if (kind === 'models' && profile.protocol === 'tencent') details.append(node('p', { class: 'hint' }, t('tencentHint')))
    else if (kind === 'models') details.append(node('div', { class: 'model-features' },
      check(t('modelStreaming'), item.streaming !== false, value => { item.streaming = value }, `${key}:streaming`),
      check(t('instructions'), modelSupports(profile, item), value => { item.speechInstruction = value; if (!value && profile.selection.model === item.id) profile.selection.speechInstruction = ''; refreshSelectionFields(profile) }, `${key}:instructions`)))
    else details.append(field(t('voiceModels'), input((item.modelIds ?? []).join(', '), value => {
      item.modelIds = value.split(',').map(id => id.trim()).filter(Boolean); refreshSelectionFields(profile)
    }, { 'data-focus-key': `${key}:models` })))
    return details
  }
  function catalogs(profile) {
    const details = node('section', { class: 'card catalog-card' }, sectionHeading(t('catalogs'), t(manualCatalog(profile) ? 'manualCatalogHint' : 'catalogHint')),
      node('p', { class: 'catalog-count' }, t('catalogCount', { models: profile.models.length, voices: profile.voices.length })))
    const list = profile[catalogKind]
    const kinds = node('div', { class: 'catalog-kinds', role: 'group', 'aria-label': t('catalogKind') }, ...['models', 'voices'].map(kind => button(t(kind), () => {
      catalogKind = kind; catalogSearch = ''; visibleLimit = 40; render()
    }, { 'aria-pressed': String(catalogKind === kind), 'data-focus-key': `catalog-kind:${kind}` })))
    const search = node('input', { type: 'search', value: catalogSearch, disabled: busy, placeholder: t('searchCatalog'), 'aria-label': t('searchCatalog'), 'data-focus-key': 'catalog-search', oninput: event => {
      catalogSearch = event.target.value; visibleLimit = 40; render()
    } })
    const add = button(t(catalogKind === 'models' ? 'addModel' : 'addVoice'), () => {
      list.unshift({ id: '', name: '' }); catalogSearch = ''; visibleLimit = 40; expandedEntries.clear(); changed(); render()
      const first = [...surface.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === `${profile.id}:${catalogKind}:0:id`)
      first?.focus({ preventScroll: true })
      first?.scrollIntoView({ block: 'nearest' })
    }, { 'data-focus-key': 'add-catalog-entry' })
    details.append(node('div', { class: 'catalog-toolbar' }, kinds, node('div', { class: 'catalog-tools' }, search, add)))
    const needle = catalogSearch.trim().toLocaleLowerCase()
    const matching = list.map((item, index) => ({ item, index })).filter(({ item }) => !needle || `${item.id} ${item.name}`.toLocaleLowerCase().includes(needle))
    const shown = matching.slice(0, visibleLimit)
    const rows = node('div', { class: 'catalog-list', id: 'catalog-list' })
    if (shown.length) details.append(node('div', { class: 'catalog-column-labels', 'aria-hidden': 'true' }, node('span', {}, t('id')), node('span', {}, t('displayName')), node('span', {}, t('remove'))))
    for (const { item, index } of shown) {
      const key = `${profile.id}:${catalogKind}:${index}`
      const kind = catalogKind
      const row = node('div', { class: 'catalog-row' }, node('div', { class: 'catalog-row-main' },
        input(item.id, value => {
          if (profile.selection[kind === 'models' ? 'model' : 'voice'] === item.id) profile.selection[kind === 'models' ? 'model' : 'voice'] = value
          if (kind === 'models') for (const voice of profile.voices) if (voice.modelIds) voice.modelIds = voice.modelIds.map(id => id === item.id ? value : id)
          item.id = value; refreshSelectionFields(profile)
        }, { 'aria-label': `${t(kind)} ${index + 1} ${t('id')}`, placeholder: t('id'), 'data-focus-key': `${key}:id` }),
        input(item.name, value => { item.name = value; refreshSelectionFields(profile) }, { 'aria-label': `${t(kind)} ${index + 1} ${t('displayName')}`, placeholder: t('displayName'), 'data-focus-key': `${key}:name` }),
        button(t('remove'), () => { list.splice(index, 1); expandedEntries.clear(); changed(); render() }, { class: 'quiet danger', 'aria-label': `${t('remove')} ${item.name || item.id || index + 1}`, 'data-focus-key': `${key}:remove` })),
        entryOptions(profile, kind, item, index))
      rows.append(row)
    }
    if (!shown.length) rows.append(node('div', { class: 'catalog-empty' }, node('p', { class: 'hint' }, t(needle ? 'noMatches' : 'emptyCatalog')),
      ...(needle ? [button(t('clearSearch'), () => { catalogSearch = ''; render() })] : [])))
    details.append(rows)
    const footer = node('div', { class: 'catalog-footer' }, node('span', {}, t('shownEntries', { shown: shown.length, total: matching.length })))
    if (shown.length < matching.length) footer.append(button(t('showMore'), () => { visibleLimit += 40; render() }, { 'data-focus-key': 'catalog-more' }))
    details.append(footer)
    return details
  }
  async function query(profile, refresh) {
    await action(async () => {
      const result = await api(refresh ? 'refresh' : 'test', { profile, revision: state.revision })
      if (refresh) {
        for (const kind of ['models', 'voices']) {
          const map = new Map(profile[kind].map(item => [item.id, item]))
          for (const item of result[kind] ?? []) if (!map.has(item.id)) map.set(item.id, item)
          profile[kind] = [...map.values()]
        }
        if (result.models?.length || result.voices?.length) changed()
        // New providers may start with an empty voice catalog. Fill only absent choices.
        if (!profile.selection.model) profile.selection.model = profile.models[0]?.id ?? ''
        if (!profile.selection.voice) profile.selection.voice = compatibleVoices(profile)[0]?.id ?? ''
      }
      message(result.errors.length ? `${t('partial')} ${result.errors.map(item => `${t(item.kind)}: ${t(item.code)}`).join('; ')}` : t(refresh ? 'refreshed' : 'tested'), !result.connected)
    }, refresh ? 'refreshing' : 'testing')
  }
  function credentialField(profile, property, configured, label) {
    const cleared = `_${property}Cleared`
    const keyInput = input(profile[property] ?? '', value => { if (value || profile[cleared]) profile[property] = value; else delete profile[property] }, { type: 'password', autocomplete: 'new-password', placeholder: t(profile[configured] ? 'keyKept' : 'keyEmpty'), 'data-focus-key': property, id: `${property}-input` })
    const visibility = button(t('showKey'), () => {
      const visible = keyInput.type === 'password'
      keyInput.type = visible ? 'text' : 'password'
      visibility.textContent = t(visible ? 'hideKey' : 'showKey')
      visibility.setAttribute('aria-pressed', String(visible))
      visibility.setAttribute('aria-label', `${t(visible ? 'hideKey' : 'showKey')} ${label}`)
    }, { class: 'input-addon', 'aria-pressed': 'false', 'aria-label': `${t('showKey')} ${label}`, 'data-focus-key': `visibility-${property}` })
    const clear = profile[configured] ? button(t('clearKey'), () => { profile[property] = ''; profile[configured] = false; profile[cleared] = true; changed(); render() }, { class: 'quiet danger', 'data-focus-key': `clear-${property}` }) : null
    return node('div', { class: 'field full' }, node('label', { htmlFor: keyInput.id }, label),
      node('div', { class: 'input-group' }, keyInput, visibility), node('div', { class: 'key-hint' }, node('p', { class: 'field-description' }, t(profile[configured] ? 'keyKept' : 'keyEmpty')), ...(clear ? [clear] : [])))
  }
  function connectionFields(profile) {
    const tencent = profile.protocol === 'tencent'
    return node('section', { class: 'card form-section' }, sectionHeading(t('connection'), t('connectionHint')),
      node('div', { class: 'field-group fields card-content' },
        field(t('name'), input(profile.name, value => { profile.name = value; $('profile-name').textContent = value || t('unnamed'); renderProfiles() }, { maxLength: 120 })),
        field(t('protocol'), select(profile.protocol, protocols, id => { profile.protocol = id; profile.selection.speechInstruction = '' }), t('protocolHint')),
        field(t('baseURL'), input(profile.baseURL, value => { profile.baseURL = value }, { type: 'url', maxLength: 2048, spellcheck: false }), t(profile.protocol === 'aliyun' ? 'aliyunBaseHint' : tencent ? 'tencentBaseHint' : 'baseHint'), true),
        ...(tencent ? [credentialField(profile, 'secretId', 'secretIdConfigured', 'SecretId')] : []),
        credentialField(profile, 'apiKey', 'keyConfigured', tencent ? 'SecretKey' : t('apiKey'))),
      node('div', { class: 'card-footer' }, node('p', { class: 'field-description' }, t(manualCatalog(profile) ? 'manualCatalogHint' : 'testHint')),
        button(t('test'), () => query(profile, false), { disabled: busy || manualCatalog(profile), 'data-focus-key': 'test-connection' })))
  }
  function advancedFields(profile) {
    const streaming = check(t('streaming'), profile.protocol !== 'tencent' && profile.streaming, value => { profile.streaming = value })
    streaming.querySelector('input').setAttribute('role', 'switch')
    if (profile.protocol === 'tencent') streaming.querySelector('input').disabled = true
    const settings = node('section', { class: 'card form-section' }, sectionHeading(t('advanced'), t('advancedHint')),
      node('fieldset', { class: 'field-group fields card-content' }, node('legend', { class: 'sr-only' }, t('advanced')),
        field(t('maxTextLength'), input(profile.maxTextLength, value => { profile.maxTextLength = Number(value) }, { type: 'number', min: 1, max: profile.protocol === 'tencent' ? 150 : 10000 }), profile.protocol === 'tencent' ? t('tencentHint') : ''),
        node('div', { class: 'field switch-field' }, streaming)))
    const deleteButton = button(t(deleteId === profile.id ? 'confirmDelete' : 'delete'), () => {
      if (deleteId !== profile.id) { deleteId = profile.id; render(); return }
      state.profiles = state.profiles.filter(item => item.id !== profile.id)
      if (state.activeId === profile.id) { state.activeId = ''; state.takeoverEnabled = false }
      selected = state.profiles[0]?.id ?? ''; deleteId = null; catalogSearch = ''; visibleLimit = 40; changed(); render()
    }, { class: deleteId === profile.id ? 'destructive' : 'outline-danger', 'data-focus-key': 'delete-profile' })
    return node('div', { class: 'panel-stack' }, settings, node('section', { class: 'card danger-card' }, sectionHeading(t('delete'), t('deleteHint')),
      node('div', { class: 'card-footer' }, node('div', { class: 'actions' }, ...(deleteId === profile.id ? [button(t('cancel'), () => { deleteId = null; render() })] : []), deleteButton))))
  }
  function render() {
    if (signal.aborted) return
    const active = surface.activeElement
    const focused = active?.dataset?.focusKey
    const caret = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null
    const scrollTop = $('catalog-list')?.scrollTop ?? 0
    for (const dispose of controls) dispose()
    controls.clear()
    for (const element of surface.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n)
    const languageTarget = surface.host ?? document.documentElement
    languageTarget.lang = language === 'zh' ? 'zh-CN' : 'en'
    $('language').value = language
    $('profile-select').setAttribute('aria-label', t('editingProvider'))
    $('provider-search').placeholder = t('searchProviders')
    $('editor').setAttribute('aria-label', t('editor'))
    $('editor').setAttribute('aria-busy', String(busy))
    renderProfiles()
    $('takeover').checked = state?.takeoverEnabled ?? false
    const profile = state?.profiles.find(item => item.id === selected)
    if (!profile) {
      $('editor').replaceChildren(node('div', { class: 'empty' }, node('h2', {}, t(state ? 'emptyTitle' : 'loading')), node('p', { class: 'hint' }, t('empty')),
        node('div', { class: 'actions' }, ...protocols.map(protocol => button(protocol.name, () => addProfile(protocol.id), { disabled: busy || !state })))))
    } else {
      const current = state.activeId === profile.id
      const header = node('div', { class: 'profile-heading' }, node('div', {}, node('h2', { id: 'profile-name' }, profile.name || t('unnamed')), node('p', { class: 'profile-context' }, t(current ? 'editingCurrent' : 'editingOther'))),
        button(t(current ? state.activeId !== accepted?.activeId ? 'currentPending' : 'current' : 'activate'), () => { state.activeId = profile.id; changed(); render() }, { disabled: busy || current, 'data-focus-key': 'activate-profile' }))
      const items = ['connection', 'selection', 'catalogs', 'advanced'].map(id => ({ id, name: t(id) }))
      const navigation = tabs(items, editorTab, id => { editorTab = id; tabByProfile.set(profile.id, id); render() }, t('editorSections'), busy)
      const content = editorTab === 'selection' ? selectionFields(profile) : editorTab === 'catalogs' ? catalogs(profile) : editorTab === 'advanced' ? advancedFields(profile) : connectionFields(profile)
      const panel = node('div', { class: 'tab-panel', role: 'tabpanel', id: 'panel-' + editorTab, 'aria-labelledby': 'tab-' + editorTab, tabIndex: 0 }, content)
      $('editor').replaceChildren(header, navigation, panel)
    }
    toolbar()
    if ($('catalog-list')) $('catalog-list').scrollTop = scrollTop
    if (focused) {
      const next = [...surface.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focused && !element.disabled)
      next?.focus({ preventScroll: true })
      if (next && caret) { try { next.setSelectionRange(...caret) } catch { /* Not every input type has a text selection. */ } }
    }
  }
  function addProfile(protocol) {
    return action(async () => {
      const profile = await api('preset', { protocol })
      profile.id = crypto.randomUUID(); state.profiles.push(profile); selected = profile.id; editorTab = 'connection'; tabByProfile.set(profile.id, editorTab)
      if (!state.activeId) state.activeId = profile.id
      catalogSearch = ''; visibleLimit = 40; deleteId = null; profileSearch = ''; $('provider-search').value = ''
      $('templates').hidden = true; $('add').setAttribute('aria-expanded', 'false')
      changed()
    }, 'adding')
  }
  $('save').onclick = () => action(async () => {
    const next = await api('save', state)
    accepted = copy(next); state = copy(next); dirty = false
    message(next.takeoverError ? `${t('failed')} ${t(next.takeoverError)}` : t('saved'), !!next.takeoverError)
  }, 'saving')
  $('discard').onclick = () => action(async () => { await load(); message() }, 'loading')
  $('takeover').onchange = event => {
    state.takeoverEnabled = event.target.checked
    if (state.takeoverEnabled && !state.activeId) state.activeId = selected
    changed(); render()
  }
  $('provider-search').oninput = event => { profileSearch = event.target.value; renderProfiles() }
  $('profile-select').dataset.focusKey = 'profile-select'
  $('profile-select').onchange = event => chooseProfile(event.target.value)
  $('add').onclick = () => {
    $('templates').hidden = !$('templates').hidden
    $('add').setAttribute('aria-expanded', String(!$('templates').hidden))
  }
  for (const template of surface.querySelectorAll('[data-protocol]')) template.onclick = () => addProfile(template.dataset.protocol)
  $('language').onchange = event => {
    language = event.target.value; localStorage.setItem('dsh-speech-adapter-language', language)
    loadWords().then(() => { message(); render() }).catch(() => {})
  }
  async function loadWords() {
    const requested = language
    const next = await fetch(new URL(`locale/${requested}.json`, root), { signal }).then(response => response.json())
    if (requested === language) words = next
  }
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } }, { signal })
  window.addEventListener('focus', async () => {
    if (busy) return
    try {
      const next = await api('state')
      if (next.revision === state?.revision) return
      if (dirty) { message(t('conflict'), true); return }
      accepted = copy(next); state = copy(next); render()
    } catch { /* A failed background read must not discard a draft. */ }
  }, { signal })
  void (async () => {
    try { await loadWords(); signal.throwIfAborted(); render(); await load() }
    catch (error) { message(`${t('failed')} ${t(error.message)}`, true) }
    finally { busy = false; render() }
  })()
  return () => { for (const dispose of controls) dispose(); controls.clear(); controller.abort() }
}
