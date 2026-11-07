import { node, stepper, icon } from './components.js'
import { createManagerApi } from './api.js'

const root = new URL('./', import.meta.url)
const protocols = [{ id: 'senseaudio', name: 'SenseAudio（商汤）' }, { id: 'openai', name: 'OpenAI compatible（OpenAI 兼容）' }, { id: 'minimax', name: 'MiniMax（稀宇科技）' },
  { id: 'siliconflow', name: 'SiliconFlow（硅基流动）' }, { id: 'elevenlabs', name: 'ElevenLabs' }, { id: 'fish', name: 'Fish Audio' },
  { id: 'aliyun', name: 'Alibaba Cloud Bailian（阿里云百炼）' }, { id: 'tencent', name: 'Tencent Cloud（腾讯云）' },
  { id: 'xiaomi', name: 'Xiaomi MiMo TTS（小米）' }, { id: 'doubao', name: '豆包 Seed TTS（火山引擎）' }, { id: 'breeze', name: 'Breeze Blue TTS' },
  { id: 'custom', name: '自定义本地模型（Custom local model）' }]
const DEFAULT_CUSTOM = {
  method: 'POST', path: 'audio/speech', bodyType: 'json',
  headers: [{ name: 'Authorization', value: 'Bearer {{apiKey}}' }],
  body: { model: '{{model}}', input: '{{text}}', voice: '{{voice}}', response_format: '{{format}}', instructions: '{{instruction}}' },
  response: 'binary', audioPath: 'data.audio', audioFormat: 'wav', sampleRate: 24000,
}
const manualCatalog = profile => ['aliyun', 'tencent', 'custom'].includes(profile.protocol)
// API Key / signup references, taken from README's official documentation links.
const API_KEY_LINKS = {
  senseaudio: 'https://docs.senseaudio.cn/api-reference/endpoint/tts/synthesize.md',
  openai: 'https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create',
  minimax: 'https://platform.minimax.io/docs/api-reference/speech-t2a-http',
  siliconflow: 'https://docs.siliconflow.cn/docs/api/audio-speech-post',
  elevenlabs: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert',
  fish: 'https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech',
  aliyun: 'https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api',
  tencent: 'https://cloud.tencent.com/document/api/1073/37995',
  xiaomi: 'https://ppy-web.github.io/dsh-plugin-xiaomi-mimo-tts/',
  doubao: 'https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh',
  breeze: 'https://breezeblue.ai/zh/voice-library',
}
const STEPS = ['connect', 'models', 'voices', 'finish']
const STEP_KEYS = { connect: 'stepConnect', models: 'stepModels', voices: 'stepVoices', finish: 'stepFinish' }

/** Mount in the host settings surface; disposal aborts requests and removes window listeners. */
export function mountManager(surface) {
  const controller = new AbortController()
  const { signal } = controller
  const api = createManagerApi(root, signal)
  let language = localStorage.getItem('dsh-speech-adapter-language') ?? (navigator.language.startsWith('zh') ? 'zh' : 'en')
  if (!['zh', 'en'].includes(language)) language = 'en'
  let words = {}, state, accepted, selected = '', busy = true, busyKind = 'loading', dirty = false, deleteId = null
  let probeResults = null
  let step = 'connect', modelSearch = '', modelLimit = 40, voiceSearch = '', voiceLimit = 40
  const expandedEntries = new Set(), stepByProfile = new Map()
  let profileSearch = ''
  let fieldSequence = 0
  const $ = id => surface.getElementById(id)
  const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), typeof words[key] === 'string' ? words[key] : key)
  const copy = value => structuredClone(value)
  const protocolName = id => protocols.find(item => item.id === id)?.name ?? id
  const stepLabel = id => t(STEP_KEYS[id] ?? id)

  const button = (label, onclick, attrs = {}) => node('button', { type: 'button', onclick, disabled: busy, 'data-focus-key': attrs['data-focus-key'] ?? attrs['aria-label'] ?? label, ...attrs }, label)
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
    $('status').textContent = t(busy ? busyKind : dirty ? 'dirty' : 'upToDate')
    $('status').dataset.dirty = String(dirty)
    $('status').dataset.busy = String(busy)
  }
  function changed() { dirty = true; toolbar() }
  async function action(work, kind = 'working') {
    if (busy || !state) return
    busy = true; busyKind = kind; message(); render()
    try { await work() } catch (error) { message(`${t('failed')} ${t(error.message)}`, true) }
    finally { busy = false; render() }
  }

  function connectionReady(profile) {
    if (!profile) return false
    if (profile.protocol === 'custom') return !!(profile.name && profile.baseURL && profile.custom)
    const secret = profile.protocol === 'tencent' ? !!(profile.secretId || profile.secretIdConfigured) : true
    return !!(profile.name && profile.baseURL && (profile.apiKey || profile.keyConfigured) && secret)
  }
  function compatibleVoices(profile) { return profile.voices.filter(voice => !voice.modelIds?.length || voice.modelIds.includes(profile.selection.model)) }
  function modelSupports(profile, model) {
    if (profile.protocol === 'tencent') return false
    if (profile.protocol === 'custom') return model.speechInstruction === true
    const supported = profile.protocol === 'openai' ? /^gpt-4o-mini-tts(?:-|$)/u.test(model.id)
      : profile.protocol === 'aliyun' ? /^qwen-audio-3\.[01]-tts-(?:flash|plus)$/u.test(model.id)
        : profile.protocol === 'siliconflow' ? /CosyVoice2/iu.test(model.id) : profile.protocol === 'minimax' && /^speech-(?:2\.[68]|0[12])-/u.test(model.id)
    return model.speechInstruction ?? supported
  }
  function instructionOptions(profile, model) {
    if (profile.protocol !== 'minimax') return null
    return ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', ...(/^speech-2\.6-/u.test(model?.id ?? '') ? ['fluent', 'whisper'] : [])].map(id => ({ id, name: id || t('automatic') }))
  }
  function stepDone(profile, id) {
    if (!profile) return false
    const ready = connectionReady(profile)
    if (id === 'connect') return ready
    const modelsReady = ready && profile.models.some(item => item.id === profile.selection.model)
    if (id === 'models') return modelsReady
    const voicesReady = modelsReady && compatibleVoices(profile).some(item => item.id === profile.selection.voice)
    if (id === 'voices') return voicesReady
    return voicesReady && !dirty
  }
  function defaultStep(profile) {
    if (!connectionReady(profile)) return 'connect'
    if (!profile.models.some(item => item.id === profile.selection.model)) return 'models'
    if (!compatibleVoices(profile).some(item => item.id === profile.selection.voice)) return 'voices'
    return 'finish'
  }
  function takeoverStatusText() {
    if (!accepted) return t('loading')
    if (accepted.takeoverError) return `${t('failed')} ${t(accepted.takeoverError)}`
    if (!accepted.takeoverActive) return t('inactive')
    const active = accepted.profiles.find(item => item.id === accepted.activeId)
    return accepted.ready ? t('servingProvider', { name: active?.name ?? '' }) : t('notReadyProvider', { name: active?.name ?? '' })
  }

  async function load() {
    const result = await api('state')
    accepted = copy(result); state = copy(result); dirty = false
    if (!state.profiles.some(item => item.id === selected)) selected = state.activeId || state.profiles[0]?.id || ''
    const profile = state.profiles.find(item => item.id === selected)
    step = stepByProfile.get(selected) ?? defaultStep(profile)
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
    selected = id; deleteId = null; modelSearch = ''; voiceSearch = ''; modelLimit = 40; voiceLimit = 40; probeResults = null
    const profile = state.profiles.find(item => item.id === id)
    step = stepByProfile.get(id) ?? defaultStep(profile)
    message(); render()
  }
  function goStep(profile, id) {
    step = id; stepByProfile.set(profile.id, id); message(); render()
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
  function sectionHeading(title, hint = '', actions = []) {
    return node('div', { class: 'card-header' }, node('div', {}, node('h3', { class: 'card-title' }, title), ...(hint ? [node('p', { class: 'hint' }, hint)] : [])),
      ...(actions.length ? [node('div', { class: 'actions' }, ...actions)] : []))
  }
  function stepNav(profile, back, next, nextLabel) {
    return node('div', { class: 'step-nav' },
      back ? button(t('prevStep'), () => goStep(profile, back), { class: 'quiet', 'data-focus-key': `nav-back-${back}` }) : node('span', {}),
      next ? button(nextLabel || t('nextStep'), () => goStep(profile, next), { class: 'primary', 'data-focus-key': `nav-next-${next}` }) : node('span', {}))
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
    const manual = manualCatalog(profile)
    const keyLink = API_KEY_LINKS[profile.protocol]
      ? node('a', { class: 'api-key-link', href: API_KEY_LINKS[profile.protocol], target: '_blank', rel: 'noopener noreferrer', 'data-focus-key': 'get-api-key' }, t('getApiKey'))
      : null
    return node('section', { class: 'card form-section' }, sectionHeading(t('stepConnect'), t('connectionHint'), keyLink ? [keyLink] : []),
      node('div', { class: 'field-group fields card-content' },
        field(t('name'), input(profile.name, value => { profile.name = value; const heading = $('profile-name'); if (heading) heading.textContent = value || t('unnamed'); renderProfiles() }, { maxLength: 120 })),
        field(t('protocol'), select(profile.protocol, protocols, id => { profile.protocol = id; profile.selection.speechInstruction = ''; if (id === 'custom' && !profile.custom) profile.custom = structuredClone(DEFAULT_CUSTOM) }), t('protocolHint')),
        field(t('baseURL'), input(profile.baseURL, value => { profile.baseURL = value }, { type: 'url', maxLength: 2048, spellcheck: false }), t(profile.protocol === 'aliyun' ? 'aliyunBaseHint' : tencent ? 'tencentBaseHint' : profile.protocol === 'doubao' ? 'doubaoBaseHint' : profile.protocol === 'breeze' ? 'breezeBaseHint' : profile.protocol === 'xiaomi' ? 'xiaomiBaseHint' : profile.protocol === 'custom' ? 'customBaseHint' : 'baseHint'), true),
        ...(profile.protocol === 'custom' ? [probeField(profile)] : []),
        ...(tencent ? [credentialField(profile, 'secretId', 'secretIdConfigured', 'SecretId')] : []),
        credentialField(profile, 'apiKey', 'keyConfigured', tencent ? 'SecretKey' : profile.protocol === 'custom' ? `${t('apiKey')}（${t('optional')}）` : t('apiKey')),
        ...(profile.protocol === 'custom' ? [customAdvanced(profile)] : [])),
      node('div', { class: 'card-footer' }, node('p', { class: 'field-description' }, t(manual ? 'manualCatalogHint' : 'connectHint')),
        node('div', { class: 'actions' },
          button(t('test'), () => query(profile, false), { disabled: busy || manual, 'data-focus-key': 'test-connection' }),
          button(t('pullCatalogs'), () => query(profile, true, 'models'), { class: 'primary', disabled: busy || manual, 'data-focus-key': 'fetch-connection' }))))
  }
  function connectionStep(profile) { return node('div', { class: 'step-body' }, connectionFields(profile), stepNav(profile, null, 'models')) }

  function probeField(profile) {
    const results = probeResults
    return node('div', { class: 'field full probe-field' },
      node('div', { class: 'actions' }, button(t('probe'), () => probeLocal(profile), { 'data-focus-key': 'probe-local' })),
      node('p', { class: 'field-description' }, t('probeHint')),
      ...(results && results.length ? [node('div', { class: 'probe-results' },
        ...results.map(item => button(`${item.service ? `${item.service} · ` : ''}127.0.0.1:${item.port}`, () => {
          profile.baseURL = `http://127.0.0.1:${item.port}`
          changed(); render()
        }, { class: 'quiet', 'data-focus-key': `probe-port-${item.port}`, 'aria-label': `${t('usePort')} 127.0.0.1:${item.port}` })))] : []))
  }
  async function probeLocal(profile) {
    await action(async () => {
      const result = await api('probe', {})
      const reachable = (result.ports ?? []).filter(item => item.reachable)
      probeResults = reachable
      if (reachable.length === 1) profile.baseURL = `http://127.0.0.1:${reachable[0].port}`
      changed()
      message(reachable.length ? t('probeFound', { count: reachable.length }) : t('probeNone'), !reachable.length)
    }, 'probing')
  }

  /** Advanced, fully custom request mapping for local model endpoints. */
  function customAdvanced(profile) {
    const custom = profile.custom
    const headerRows = node('div', { class: 'custom-headers' })
    const paintHeaders = () => headerRows.replaceChildren(...custom.headers.map((header, index) => node('div', { class: 'custom-header-row' },
      input(header.name, value => { header.name = value }, { 'aria-label': t('customHeaderName'), placeholder: t('customHeaderName'), 'data-focus-key': `custom-header-name-${index}` }),
      input(header.value, value => { header.value = value }, { 'aria-label': t('customHeaderValue'), placeholder: t('customHeaderValue'), 'data-focus-key': `custom-header-value-${index}` }),
      button(t('remove'), () => { custom.headers.splice(index, 1); changed(); paintHeaders() }, { class: 'quiet danger', 'aria-label': `${t('remove')} ${header.name || index + 1}` }))))
    paintHeaders()
    const bodyArea = node('textarea', { rows: 8, spellcheck: false, disabled: busy, 'data-focus-key': 'custom-body', value: JSON.stringify(custom.body ?? {}, null, 2),
      oninput: event => { try { const parsed = JSON.parse(event.target.value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { custom.body = parsed; changed() } } catch { /* keep last valid body */ } } })
    const methodOptions = [{ id: 'POST', name: 'POST' }, { id: 'GET', name: 'GET' }]
    const formatOptions = [{ id: 'pcm', name: 'PCM (16-bit)' }, { id: 'wav', name: 'WAV' }, { id: 'mp3', name: 'MP3' }]
    const responseOptions = [{ id: 'binary', name: 'Binary' }, { id: 'json-base64', name: 'JSON Base64' }, { id: 'json-hex', name: 'JSON Hex' }]
    return node('details', { class: 'entry-options custom-advanced', open: true },
      node('summary', {}, t('customAdvanced')),
      node('div', { class: 'field-group fields' },
        field(t('customMethod'), select(custom.method, methodOptions, value => { custom.method = value }), '', true),
        field(t('customPath'), input(custom.path, value => { custom.path = value }, { maxLength: 2048, spellcheck: false }), t('customPathHint'), true),
        field(t('customAudioFormat'), select(custom.audioFormat, formatOptions, value => { custom.audioFormat = value })),
        field(t('customResponse'), select(custom.response, responseOptions, value => { custom.response = value })),
        ...(custom.response === 'binary' ? [] : [field(t('customAudioPath'), input(custom.audioPath, value => { custom.audioPath = value }, { maxLength: 512, spellcheck: false }))]),
        ...(custom.audioFormat === 'pcm' ? [field(t('customSampleRate'), input(custom.sampleRate, value => { custom.sampleRate = Number(value) }, { type: 'number', min: 8000, max: 48000 }))] : []),
        field(t('customHeaders'), node('div', {}, headerRows, node('div', { class: 'actions' },
          button(t('customAddHeader'), () => { custom.headers.push({ name: '', value: '' }); changed(); paintHeaders() }, { class: 'quiet' }))), '', true),
        field(t('customBodyType'), select(custom.bodyType, [{ id: 'json', name: 'JSON' }, { id: 'form', name: 'Form (x-www-form-urlencoded)' }], value => { custom.bodyType = value }), t('customBodyTypeHint')),
        field(t('customBody'), bodyArea, t('customBodyHint'), true)))
  }

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
      check(t('instructions'), modelSupports(profile, item), value => { item.speechInstruction = value; if (!value && profile.selection.model === item.id) profile.selection.speechInstruction = '' }, `${key}:instructions`)))
    else details.append(field(t('voiceModels'), input((item.modelIds ?? []).join(', '), value => {
      const ids = value.split(',').map(id => id.trim()).filter(Boolean)
      if (ids.length) item.modelIds = ids
      else delete item.modelIds
    }, { 'data-focus-key': `${key}:models` })))
    return details
  }
  function updateEntryId(profile, kind, item, value) {
    const selectionKey = kind === 'models' ? 'model' : 'voice'
    if (profile.selection[selectionKey] === item.id) profile.selection[selectionKey] = value
    if (kind === 'models') for (const voice of profile.voices) if (voice.modelIds) voice.modelIds = voice.modelIds.map(id => id === item.id ? value : id)
    item.id = value
  }
  function chooseEntry(profile, kind, id) {
    if (kind === 'models') {
      profile.selection.model = id
      profile.selection.speechInstruction = ''
      if (!compatibleVoices(profile).some(voice => voice.id === profile.selection.voice)) profile.selection.voice = compatibleVoices(profile)[0]?.id ?? ''
    } else profile.selection.voice = id
    changed(); render()
  }
  function removeEntry(profile, kind, index) {
    const [removed] = profile[kind].splice(index, 1)
    if (kind === 'models') {
      if (profile.selection.model === removed.id) profile.selection.model = ''
      for (const voice of profile.voices) if (voice.modelIds) {
        voice.modelIds = voice.modelIds.filter(id => id !== removed.id)
        if (!voice.modelIds.length) delete voice.modelIds
      }
      if (!profile.selection.model) profile.selection.model = profile.models[0]?.id ?? ''
      if (!compatibleVoices(profile).some(voice => voice.id === profile.selection.voice)) profile.selection.voice = compatibleVoices(profile)[0]?.id ?? ''
    } else if (profile.selection.voice === removed.id) {
      profile.selection.voice = compatibleVoices(profile)[0]?.id ?? ''
    }
    expandedEntries.clear(); changed(); render()
  }
  function addEntry(profile, kind) {
    profile[kind].unshift({ id: '', name: '' })
    if (kind === 'models') { modelSearch = ''; modelLimit = 40 } else { voiceSearch = ''; voiceLimit = 40 }
    expandedEntries.clear(); changed(); render()
    const first = [...surface.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === `${profile.id}:${kind}:0:id`)
    first?.focus({ preventScroll: true })
    first?.scrollIntoView({ block: 'nearest' })
  }
  function catalogRow(profile, kind, item, index) {
    const isModels = kind === 'models'
    const key = `${profile.id}:${kind}:${index}`
    const selectedId = isModels ? profile.selection.model : profile.selection.voice
    const compatible = isModels || !item.modelIds?.length || item.modelIds.includes(profile.selection.model)
    const radio = node('input', { type: 'radio', name: `choose-${kind}-${profile.id}`, checked: selectedId === item.id, disabled: busy || !compatible,
      'aria-label': `${t('useColumn')} ${item.name || item.id || index + 1}`, 'data-focus-key': `${key}:use`, onchange: () => chooseEntry(profile, kind, item.id) })
    const fields = node('div', { class: 'catalog-fields' },
      input(item.id, value => { updateEntryId(profile, kind, item, value) }, { 'aria-label': `${t(isModels ? 'model' : 'voice')} ${index + 1} ${t('id')}`, placeholder: t('id'), 'data-focus-key': `${key}:id` }),
      input(item.name, value => { item.name = value }, { 'aria-label': `${t(isModels ? 'model' : 'voice')} ${index + 1} ${t('displayName')}`, placeholder: t('displayName'), 'data-focus-key': `${key}:name` }))
    const row = node('div', { class: 'catalog-row' },
      node('div', { class: 'catalog-row-main' },
        node('label', { class: 'catalog-use', title: t('useColumn') }, radio),
        fields,
        button(t('remove'), () => removeEntry(profile, kind, index), { class: 'quiet danger', 'aria-label': `${t('remove')} ${item.name || item.id || index + 1}`, 'data-focus-key': `${key}:remove` })),
      entryOptions(profile, kind, item, index))
    if (!compatible) row.append(node('p', { class: 'hint scope-note' }, t('notForCurrentModel')))
    return row
  }
  function catalogStep(profile, kind) {
    const isModels = kind === 'models'
    const manual = manualCatalog(profile)
    const list = profile[kind]
    const searchOf = () => (isModels ? modelSearch : voiceSearch)
    const setSearch = value => { if (isModels) modelSearch = value; else voiceSearch = value }
    const limitOf = () => (isModels ? modelLimit : voiceLimit)
    const setLimit = value => { if (isModels) modelLimit = value; else voiceLimit = value }
    const rows = node('div', { class: 'catalog-list', id: 'catalog-list' })
    const footer = node('div', { class: 'catalog-footer' })
    function paint() {
      const needle = searchOf().trim().toLocaleLowerCase()
      const matching = list.map((item, index) => ({ item, index })).filter(({ item }) => !needle || `${item.id} ${item.name}`.toLocaleLowerCase().includes(needle))
      const shown = matching.slice(0, limitOf())
      rows.replaceChildren(...shown.map(({ item, index }) => catalogRow(profile, kind, item, index)))
      if (!shown.length) rows.append(node('div', { class: 'catalog-empty' }, node('p', { class: 'hint' }, t(needle ? 'noMatches' : 'emptyCatalog')),
        ...(needle ? [button(t('clearSearch'), () => { setSearch(''); search.value = ''; paint() })] : [])))
      footer.replaceChildren(node('span', {}, t('shownEntries', { shown: shown.length, total: matching.length })))
      if (shown.length < matching.length) footer.append(button(t('showMore'), () => { setLimit(limitOf() + 40); paint() }, { 'data-focus-key': `${kind}-more` }))
    }
    const search = node('input', { type: 'search', value: searchOf(), disabled: busy, placeholder: t('searchCatalog'), 'aria-label': t('searchCatalog'), 'data-focus-key': `${kind}-search`,
      oninput: event => { setSearch(event.target.value); setLimit(40); paint() } })
    const fetchButton = button(t(isModels ? 'pullModels' : 'pullVoices'), () => query(profile, true), { disabled: busy || manual, 'data-focus-key': `fetch-${kind}` })
    const addButton = button(t(isModels ? 'addModel' : 'addVoice'), () => addEntry(profile, kind), { 'data-focus-key': `add-${kind}` })
    paint()
    const card = node('section', { class: 'card step-card' },
      sectionHeading(t(isModels ? 'stepModels' : 'stepVoices'), t(isModels ? 'modelsStepHint' : 'voicesStepHint'), [fetchButton]),
      node('p', { class: 'catalog-count' }, t('catalogCount', { models: profile.models.length, voices: profile.voices.length })),
      ...(manual ? [node('p', { class: 'hint manual-note' }, t('manualCatalogHint'))] : []),
      ...(!isModels && !profile.selection.model ? [node('p', { class: 'hint manual-note' }, t('chooseModelFirst'))] : []),
      node('div', { class: 'catalog-toolbar' }, node('div', { class: 'catalog-tools' }, search, addButton)),
      rows, footer)
    return node('div', { class: 'step-body' }, card, stepNav(profile, isModels ? 'connect' : 'models', isModels ? 'voices' : 'finish'))
  }

  function summaryItem(label, value, sub) {
    return node('div', { class: 'summary-item' }, node('span', { class: 'summary-label' }, label), node('strong', { class: 'summary-value' }, value),
      ...(sub ? [node('small', { class: 'summary-sub' }, sub)] : []))
  }
  function switchRow(label, control, hint) {
    return node('div', { class: 'overview-switch' },
      node('div', { class: 'switch-text' }, node('span', { class: 'switch-label' }, label), ...(hint ? [node('small', {}, hint)] : [])), control)
  }
  function finishStep(profile) {
    const model = profile.models.find(item => item.id === profile.selection.model)
    const voice = profile.voices.find(item => item.id === profile.selection.voice)
    const supported = !!model && modelSupports(profile, model)
    const options = instructionOptions(profile, model)
    const fields = node('div', { class: 'field-group fields' })
    if (supported) fields.append(field(t('instruction'), options ? select(profile.selection.speechInstruction ?? '', options, value => { profile.selection.speechInstruction = value })
      : node('textarea', { value: profile.selection.speechInstruction ?? '', maxLength: 4096, disabled: busy, 'data-focus-key': 'speech-instruction', oninput: event => { profile.selection.speechInstruction = event.target.value; changed() } }), '', true))
    else fields.append(node('p', { class: 'hint selection-note' }, t('unsupported')))
    fields.append(field(t('maxTextLength'), input(profile.maxTextLength, value => { profile.maxTextLength = Number(value) }, { type: 'number', min: 1, max: profile.protocol === 'tencent' ? 150 : profile.protocol === 'custom' ? 4096 : 10000 })))
    const streamingSupported = profile.protocol !== 'tencent' && !(profile.protocol === 'custom' && !(profile.custom?.audioFormat === 'pcm' && profile.custom?.sampleRate === 24000))
    const streamingInput = node('input', { type: 'checkbox', role: 'switch', checked: streamingSupported && profile.streaming, disabled: busy || !streamingSupported, 'aria-label': t('streaming'), 'data-focus-key': 'streaming-switch',
      onchange: event => { profile.streaming = event.target.checked; changed() } })
    const takeoverInput = node('input', { type: 'checkbox', role: 'switch', checked: state.takeoverEnabled, disabled: busy, 'aria-label': t('takeover'), 'data-focus-key': 'takeover-switch',
      onchange: event => { state.takeoverEnabled = event.target.checked; if (event.target.checked && !state.activeId) state.activeId = profile.id; changed(); render() } })
    const deleteButton = button(t(deleteId === profile.id ? 'confirmDelete' : 'delete'), () => {
      if (deleteId !== profile.id) { deleteId = profile.id; render(); return }
      state.profiles = state.profiles.filter(item => item.id !== profile.id)
      if (state.activeId === profile.id) { state.activeId = ''; state.takeoverEnabled = false }
      selected = state.profiles[0]?.id ?? ''
      deleteId = null; modelSearch = ''; voiceSearch = ''; modelLimit = 40; voiceLimit = 40
      const nextProfile = state.profiles.find(item => item.id === selected)
      step = stepByProfile.get(selected) ?? defaultStep(nextProfile)
      changed(); render()
    }, { class: deleteId === profile.id ? 'destructive' : 'outline-danger', 'data-focus-key': 'delete-profile' })
    const card = node('section', { class: 'card overview-card' },
      sectionHeading(t('overview')),
      node('div', { class: 'overview-body' },
        node('div', { class: 'summary-grid' },
          summaryItem(t('model'), model?.name ?? t('missingValue'), model?.id),
          summaryItem(t('voice'), voice?.name ?? t('missingValue'), voice?.id),
          summaryItem(t('catalog'), t('catalogCount', { models: profile.models.length, voices: profile.voices.length }))),
        fields,
        node('div', { class: 'overview-switches' },
          switchRow(t('streaming'), streamingInput),
          switchRow(t('takeover'), takeoverInput, takeoverStatusText()))),
      node('div', { class: 'card-footer overview-actions' },
        node('div', { class: 'actions' }, ...(deleteId === profile.id ? [button(t('cancel'), () => { deleteId = null; render() })] : []), deleteButton),
        node('div', { class: 'actions' },
          button(t(state.activeId === profile.id ? 'currentProvider' : 'activate'), () => activate(profile), { disabled: busy || state.activeId === profile.id, 'data-focus-key': 'finish-activate' }),
          button(t(busy && busyKind === 'saving' ? 'saving' : 'save'), () => persist(), { class: 'primary', disabled: busy || !dirty, 'data-focus-key': 'finish-save' }))))
    return node('div', { class: 'step-body' }, card, stepNav(profile, 'voices', null))
  }

  async function persist() {
    await action(async () => {
      const next = await api('save', state)
      accepted = copy(next); state = copy(next); dirty = false
      message(next.takeoverError ? `${t('failed')} ${t(next.takeoverError)}` : t('saved'), !!next.takeoverError)
    }, 'saving')
  }
  async function activate(profile) {
    if (state.activeId === profile.id) return
    state.activeId = profile.id
    changed()
    await persist()
  }
  async function query(profile, refresh, advanceTo) {
    await action(async () => {
      const result = await api(refresh ? 'refresh' : 'test', { profile, revision: state.revision })
      let added = null
      if (refresh) {
        // Pull appends only entries whose ID is not already present; existing and edited entries are never overwritten.
        added = { models: 0, voices: 0 }
        for (const kind of ['models', 'voices']) {
          const seen = new Set(profile[kind].map(item => item.id))
          for (const item of result[kind] ?? []) {
            const id = typeof item?.id === 'string' ? item.id.trim() : ''
            if (!id || seen.has(id)) continue
            seen.add(id); profile[kind].push({ ...item, id }); added[kind] += 1
          }
        }
        if (added.models || added.voices) changed()
        // New providers may start with an empty voice catalog. Fill only absent choices.
        if (!profile.selection.model) profile.selection.model = profile.models[0]?.id ?? ''
        if (!compatibleVoices(profile).some(voice => voice.id === profile.selection.voice)) profile.selection.voice = compatibleVoices(profile)[0]?.id ?? ''
      }
      message(result.errors.length ? `${t('partial')} ${result.errors.map(item => `${t(item.kind)}: ${t(item.code)}`).join('; ')}` : refresh ? t('pulled', added) : t('tested'), !result.connected)
    }, refresh ? 'refreshing' : 'testing')
    if (advanceTo && !signal.aborted && state?.profiles.some(item => item.id === profile.id) && profile.models.length) {
      step = advanceTo; stepByProfile.set(profile.id, advanceTo); render()
    }
  }

  function render() {
    if (signal.aborted) return
    const active = surface.activeElement
    const focused = active?.dataset?.focusKey
    const caret = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null
    const scrollTop = $('catalog-list')?.scrollTop ?? 0
    for (const element of surface.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n)
    const languageTarget = surface.host ?? document.documentElement
    languageTarget.lang = language === 'zh' ? 'zh-CN' : 'en'
    $('language').value = language
    $('profile-select').setAttribute('aria-label', t('editingProvider'))
    $('provider-search').placeholder = t('searchProviders')
    $('editor').setAttribute('aria-label', t('editor'))
    $('editor').setAttribute('aria-busy', String(busy))
    renderProfiles()
    const profile = state?.profiles.find(item => item.id === selected)
    if (!profile) {
      $('editor').replaceChildren(node('div', { class: 'empty' }, node('h2', {}, t(state ? 'emptyTitle' : 'loading')), node('p', { class: 'hint' }, t('empty')),
        node('div', { class: 'actions' }, ...protocols.map(protocol => button(protocol.name, () => addProfile(protocol.id), { disabled: busy || !state })))))
    } else {
      if (!STEPS.includes(step)) step = defaultStep(profile)
      const current = state.activeId === profile.id
      const header = node('div', { class: 'profile-heading' }, node('div', {}, node('h2', { id: 'profile-name' }, profile.name || t('unnamed')),
        node('p', { class: 'profile-context' }, t(current ? 'editingCurrent' : 'editingOther'))))
      const stepItems = STEPS.map(id => ({ id, name: stepLabel(id), done: stepDone(profile, id), current: step === id }))
      const bar = stepper(stepItems, id => goStep(profile, id), t('stepProgress'), busy)
      const content = step === 'connect' ? connectionStep(profile) : step === 'models' ? catalogStep(profile, 'models') : step === 'voices' ? catalogStep(profile, 'voices') : finishStep(profile)
      $('editor').replaceChildren(header, bar, content)
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
      profile.id = crypto.randomUUID(); state.profiles.push(profile); selected = profile.id; step = 'connect'; stepByProfile.set(profile.id, step)
      if (!state.activeId) state.activeId = profile.id
      modelSearch = ''; voiceSearch = ''; modelLimit = 40; voiceLimit = 40; deleteId = null; profileSearch = ''; probeResults = null; $('provider-search').value = ''
      $('templates').hidden = true; $('add').setAttribute('aria-expanded', 'false')
      changed()
    }, 'adding')
  }
  $('save').onclick = () => persist()
  $('discard').onclick = () => action(async () => { await load(); message() }, 'loading')
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
  return () => { controller.abort() }
}
