import { TtsProviderError } from './host-api.mjs'

const MAX_AUDIO = 32 * 1024 * 1024
const MAX_TEMPLATE = 64 * 1024
const fail = (code, status = 502) => { throw new TtsProviderError(code, undefined, status) }
const invalid = () => fail('adapter-config-invalid', 400)

export const CUSTOM_PLACEHOLDERS = new Set(['text', 'model', 'voice', 'format', 'sampleRate', 'instruction', 'apiKey'])
const OMIT_WHEN_EMPTY = new Set(['voice', 'instruction', 'apiKey'])
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u
const HEADER_DENY = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'])
const AUDIO_FORMATS = ['pcm', 'wav', 'mp3']
const RESPONSE_TYPES = ['binary', 'json-base64', 'json-hex']

function httpFail(status) {
  return fail(status === 401 || status === 403 ? 'api-key-rejected' : status === 402 ? 'external-quota-exceeded'
    : status === 429 ? 'rate-limited' : 'external-upstream-failed', status === 429 ? 429 : 502)
}

/** Resolve the profile's request URL, keeping the base URL path (unlike endpoint(), which injects a version). */
export function resolveCustomUrl(profile) {
  let base
  try { base = new URL(profile.baseURL) } catch { return fail('adapter-url-invalid', 400) }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return fail('adapter-url-invalid', 400)
  const path = profile.custom?.path
  if (typeof path !== 'string' || !path.length) return fail('adapter-config-invalid', 400)
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`
  let url
  try { url = new URL(path, root) } catch { return fail('adapter-url-invalid', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('adapter-url-invalid', 400)
  if (url.origin !== base.origin) return fail('adapter-url-invalid', 400)
  return url.href
}

export function validateCustomUrl(baseURL, path) {
  resolveCustomUrl({ baseURL, custom: { path } })
}

/** Validate and normalize the persisted custom request configuration. */
export function normalizeCustom(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const method = raw.method
  if (!['GET', 'POST'].includes(method)) invalid()
  const path = raw.path
  if (typeof path !== 'string' || !path.length || path.length > 2048 || path.includes('{{') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path) || path.startsWith('//')
    || !/^[A-Za-z0-9._~\-/]+(?:\?[A-Za-z0-9._~\-=&%]*)?$/u.test(path)) invalid()
  if (!Array.isArray(raw.headers) || raw.headers.length > 50) invalid()
  const headers = raw.headers.map(header => {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string') invalid()
    const name = header.name.trim()
    if (!HEADER_NAME.test(name) || HEADER_DENY.has(name.toLowerCase())) invalid()
    if (header.value.length > 8192 || /[\r\n]/u.test(header.value)) invalid()
    checkTemplate(header.value)
    return { name, value: header.value }
  })
  if (!RESPONSE_TYPES.includes(raw.response)) invalid()
  const audioPath = typeof raw.audioPath === 'string' ? raw.audioPath.trim() : invalid()
  if (audioPath.length > 512 || !/^[A-Za-z0-9_$.\-]*$/u.test(audioPath) || audioPath.split('.').length > 30) invalid()
  if (!AUDIO_FORMATS.includes(raw.audioFormat)) invalid()
  if (!Number.isSafeInteger(raw.sampleRate) || raw.sampleRate < 8000 || raw.sampleRate > 48000) invalid()
  const bodyType = raw.bodyType === undefined ? 'json' : raw.bodyType
  if (!['json', 'form'].includes(bodyType)) invalid()
  const body = raw.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid()
  if (JSON.stringify(body).length > MAX_TEMPLATE) invalid()
  checkTemplate(body)
  return { method, path, headers, body, bodyType, response: raw.response, audioPath, audioFormat: raw.audioFormat, sampleRate: raw.sampleRate }
}

/** Reject unknown or malformed placeholders and bound template depth/size. */
function checkTemplate(value, depth = 0) {
  if (depth > 8) invalid()
  if (typeof value === 'string') {
    if (value.length > 8192) invalid()
    for (const match of value.matchAll(/\{\{([^}]*)\}\}/gu)) if (!CUSTOM_PLACEHOLDERS.has(match[1])) invalid()
    if (value.replace(/\{\{\w+\}\}/gu, '').includes('{{') || value.replace(/\{\{\w+\}\}/gu, '').includes('}}')) invalid()
    return
  }
  if (Array.isArray(value)) { for (const item of value) checkTemplate(item, depth + 1); return }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) checkTemplate(item, depth + 1) }
}

function renderString(template, values) {
  return template.replace(/\{\{(\w+)\}\}/gu, (_match, key) => {
    if (!CUSTOM_PLACEHOLDERS.has(key)) invalid()
    return String(values[key] ?? '')
  })
}

function renderNode(node, values) {
  if (typeof node === 'string') {
    const whole = /^\{\{(\w+)\}\}$/u.exec(node)
    if (whole) {
      if (!CUSTOM_PLACEHOLDERS.has(whole[1])) invalid()
      return whole[1] === 'sampleRate' ? values.sampleRate : (values[whole[1]] ?? '')
    }
    return renderString(node, values)
  }
  if (Array.isArray(node)) return node.map(item => renderNode(item, values))
  if (node && typeof node === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        const whole = /^\{\{(\w+)\}\}$/u.exec(value)
        if (whole && OMIT_WHEN_EMPTY.has(whole[1]) && !values[whole[1]]) continue
      }
      result[key] = renderNode(value, values)
    }
    return result
  }
  return node
}

function renderHeaders(custom, values) {
  const headers = {}
  for (const { name, value } of custom.headers) {
    if (value.includes('{{apiKey}}') && !values.apiKey) continue
    headers[name] = renderString(value, values)
  }
  return headers
}

function requestValues(profile, selection, text) {
  const custom = profile.custom
  return { text, model: selection.model, voice: selection.voice, format: custom.audioFormat,
    sampleRate: custom.sampleRate, instruction: selection.speechInstruction ?? '', apiKey: profile.apiKey ?? '' }
}

function formEntries(body) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    params.append(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return params
}

async function buildRequest(profile, selection, text) {
  const custom = profile.custom
  if (!custom) invalid()
  const values = requestValues(profile, selection, text)
  const headers = renderHeaders(custom, values)
  const rendered = custom.body ? renderNode(custom.body, values) : undefined
  let url = resolveCustomUrl(profile)
  let body
  if (rendered && custom.method === 'GET') {
    // GET has no body; map the template to query parameters instead.
    const target = new URL(url)
    for (const [key, value] of formEntries(rendered)) target.searchParams.append(key, value)
    url = target.href
  } else if (rendered) {
    body = custom.bodyType === 'form' ? formEntries(rendered).toString() : JSON.stringify(rendered)
  }
  if (body !== undefined) {
    // Content-Type follows the body encoding; never inherit a conflicting header.
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key]
    headers['content-type'] = custom.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'
  }
  return { url, method: custom.method, headers, body, custom }
}

async function readBounded(response, signal, maximum = MAX_AUDIO) {
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const parts = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > maximum) return fail('audio-too-large', 413)
      parts.push(chunk.value)
    }
    return Buffer.concat(parts)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return fail('invalid-audio-format')
  if (value.length > Math.ceil(MAX_AUDIO / 3) * 4) return fail('audio-too-large', 413)
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > MAX_AUDIO) return fail('audio-too-large', 413)
  return bytes
}

function decodeHex(value) {
  if (typeof value !== 'string' || !value.length || value.length % 2 || !/^[a-f\d]+$/iu.test(value)) return fail('invalid-audio-format')
  if (value.length > MAX_AUDIO * 2) return fail('audio-too-large', 413)
  return Buffer.from(value, 'hex')
}

function readAudioPath(value, audioPath) {
  if (!audioPath) return value
  let current = value
  for (const segment of audioPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = Array.isArray(current) && /^\d+$/u.test(segment) ? current[Number(segment)] : current[segment]
  }
  return current
}

function checkPcm(bytes) {
  if (bytes.toString('ascii', 0, 4) === 'RIFF' || bytes.toString('ascii', 0, 3) === 'ID3') return fail('invalid-audio-format')
  return bytes
}

function validWav(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return fail('invalid-audio-format')
  return bytes
}

function validMp3(bytes) {
  if (bytes.length < 2 || (bytes.toString('ascii', 0, 3) !== 'ID3' && !(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return fail('invalid-audio-format')
  return bytes
}

function wrapPcmWav(pcm, sampleRate) {
  if (!pcm.length || pcm.length % 2) return fail('invalid-audio-format')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function extractAudio(bytes, custom, response) {
  if (custom.response === 'binary') {
    if (response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
    return bytes
  }
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return fail('external-response-invalid') }
  const value = readAudioPath(parsed, custom.audioPath)
  return custom.response === 'json-base64' ? decodeBase64(value) : decodeHex(value)
}

function finishAudio(audio, custom, format) {
  if (custom.audioFormat === 'pcm') {
    if (format !== 'wav') return fail('audio-format-unsupported', 400)
    return { data: wrapPcmWav(checkPcm(audio), custom.sampleRate), format: 'wav' }
  }
  if (custom.audioFormat === 'wav') {
    if (format !== 'wav') return fail('audio-format-unsupported', 400)
    return { data: validWav(audio), format: 'wav' }
  }
  if (custom.audioFormat === 'mp3') {
    if (format !== 'mp3') return fail('audio-format-unsupported', 400)
    return { data: validMp3(audio), format: 'mp3' }
  }
  return fail('adapter-config-invalid', 400)
}

export async function synthesizeCustom(profile, { text, format, signal, ...overrides }, transport = fetch) {
  const selection = { ...profile.selection, ...overrides }
  const custom = profile.custom
  if (!custom) invalid()
  const requested = custom.audioFormat === 'mp3' ? 'mp3' : 'wav'
  if (format !== requested) return fail('audio-format-unsupported', 400)
  signal.throwIfAborted()
  const { url, method, headers, body } = await buildRequest(profile, selection, text)
  const response = await transport(url, { method, redirect: 'error', signal, headers, ...(body === undefined ? {} : { body }) })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); httpFail(response.status) }
  const bytes = await readBounded(response, signal)
  signal.throwIfAborted()
  return finishAudio(extractAudio(bytes, custom, response), custom, format)
}

export async function* streamCustom(profile, { text, signal, ...overrides }, transport = fetch) {
  const custom = profile.custom
  if (!custom) invalid()
  if (!(custom.audioFormat === 'pcm' && custom.sampleRate === 24000 && custom.response === 'binary')) return fail('external-streaming-unsupported', 400)
  const selection = { ...profile.selection, ...overrides }
  signal.throwIfAborted()
  const { url, method, headers, body } = await buildRequest(profile, selection, text)
  const response = await transport(url, { method, redirect: 'error', signal, headers, ...(body === undefined ? {} : { body }) })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); httpFail(response.status) }
  if (response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  let prefix = Buffer.alloc(0), pending = null, size = 0, checked = false
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      let value = Buffer.from(chunk.value)
      size += value.length
      if (size > MAX_AUDIO) return fail('audio-too-large', 413)
      if (!checked) {
        prefix = Buffer.concat([prefix, value])
        if (prefix.length < 4) continue
        checked = true
        value = checkPcm(prefix)
        prefix = Buffer.alloc(0)
      }
      if (pending) { value = Buffer.concat([pending, value]); pending = null }
      if (value.length % 2) { pending = Buffer.from(value.subarray(value.length - 1)); value = value.subarray(0, value.length - 1) }
      if (value.length) yield value
    }
    signal.throwIfAborted()
    if (!checked) return fail('external-stream-incomplete')
    if (pending) yield Buffer.from([pending[0], 0])
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
