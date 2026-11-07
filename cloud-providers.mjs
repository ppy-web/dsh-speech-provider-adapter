import { createHash, createHmac, randomUUID } from 'node:crypto'
import { TtsProviderError } from './host-api.mjs'

const MAX_AUDIO = 32 * 1024 * 1024
const MAX_RECORD = 2 * 1024 * 1024
const fail = (code, status = 502) => { throw new TtsProviderError(code, undefined, status) }
const hash = value => createHash('sha256').update(value).digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value).digest()

export function credentialsReady(profile) {
  if (!profile) return false
  // A local/custom endpoint may be unauthenticated; only the Base URL is required.
  if (profile.protocol === 'custom') return !!String(profile.baseURL ?? '').trim()
  if (!profile.apiKey || (profile.protocol === 'tencent' && !profile.secretId)) return false
  return profile.protocol !== 'aliyun' || !/your_workspace_id/iu.test(profile.baseURL)
}

function baseURL(profile) {
  let url
  try { url = new URL(profile.baseURL) } catch { return fail('adapter-url-invalid', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('adapter-url-invalid', 400)
  return url
}

function configured(profile) {
  if (!profile.apiKey) return fail('api-key-not-configured', 409)
  if (profile.protocol === 'tencent' && !profile.secretId) return fail('secret-id-not-configured', 409)
  if (!credentialsReady(profile)) return fail('adapter-workspace-required', 409)
}

async function send(url, options, transport) {
  options.signal.throwIfAborted()
  const response = await transport(url.href, { ...options, method: 'POST', redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return fail([401, 403].includes(response.status) ? 'api-key-rejected' : response.status === 429 ? 'rate-limited'
      : response.status === 402 ? 'external-quota-exceeded' : 'external-upstream-failed', response.status === 429 ? 429 : 502)
  }
  return response
}

function base64Audio(value) {
  if (typeof value !== 'string' || !value || value.length % 4) return fail('invalid-audio-format')
  if (value.length > Math.ceil(MAX_AUDIO / 3) * 4) return fail('audio-too-large', 413)
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return fail('invalid-audio-format')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > MAX_AUDIO) return fail('audio-too-large', 413)
  return bytes
}

function json(value) {
  let parsed
  try { parsed = JSON.parse(value) } catch { return fail('external-response-invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('external-response-invalid')
  return parsed
}

/** TC3 signs the exact UTF-8 request body and UTC date used in the HTTP request. */
function tencentHeaders(profile, url, body, timestamp = Math.floor(Date.now() / 1000)) {
  const contentType = 'application/json; charset=utf-8'
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalHeaders = `content-type:${contentType}\nhost:${url.host}\nx-tc-action:texttovoice\n`
  const canonical = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hash(body)}`
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/tts/tc3_request`
  const signingKey = hmac(hmac(hmac(`TC3${profile.apiKey}`, date), 'tts'), 'tc3_request')
  const signature = createHmac('sha256', signingKey).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex')
  return { 'content-type': contentType, host: url.host, 'x-tc-action': 'TextToVoice', 'x-tc-version': '2019-08-23', 'x-tc-timestamp': String(timestamp),
    authorization: `TC3-HMAC-SHA256 Credential=${profile.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }
}

export async function tencentSynthesize(profile, { text, format, signal }, selection, transport) {
  configured(profile)
  signal.throwIfAborted()
  if (!['wav', 'mp3'].includes(format)) return fail('audio-format-unsupported', 400)
  if (selection.speechInstruction) return fail('external-option-unsupported', 400)
  if (selection.model !== 'TextToVoice' || !/^\d{1,9}$/u.test(selection.voice) || Number(selection.voice) === 200000000) return fail('external-selection-invalid', 400)
  if ([...text].length > Math.min(profile.maxTextLength, 150)) return fail('text-too-long', 400)
  const url = baseURL(profile)
  // Cloud API 3.0 signs '/' even when a reverse proxy exposes a path prefix.
  url.pathname = url.pathname.replace(/\/+$/u, '') + '/'
  const body = JSON.stringify({ Text: text, SessionId: randomUUID(), ModelType: 1, VoiceType: Number(selection.voice), SampleRate: 16000, Codec: format, Volume: 0, Speed: 0 })
  const response = await send(url, { signal, body, headers: tencentHeaders(profile, url, body) }, transport)
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const parts = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.length
      if (size > Math.ceil(MAX_AUDIO / 3) * 4 + 65536) return fail('audio-too-large', 413)
      parts.push(chunk.value)
    }
    signal.throwIfAborted()
    const result = json(Buffer.concat(parts).toString('utf8')).Response
    if (!result || typeof result !== 'object') return fail('external-response-invalid')
    if (result.Error) {
      const code = String(result.Error.Code ?? '')
      return fail(/AuthFailure|UnauthorizedOperation|InvalidCredential/iu.test(code) ? 'api-key-rejected'
        : /LimitExceeded|RequestLimitExceeded/iu.test(code) ? 'rate-limited'
          : /NoFreeAccount|Balance|Arrears|ResourceInsufficient/iu.test(code) ? 'external-quota-exceeded' : 'external-upstream-failed')
    }
    const data = base64Audio(result.Audio)
    if (format === 'wav' && (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE')) return fail('invalid-audio-format')
    return { data, format }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Always request SSE, including complete audio, so signed download URLs are never fetched. */
export async function* aliyunAudio(profile, { text, signal }, selection, format, transport) {
  configured(profile)
  const url = baseURL(profile)
  const prefix = url.pathname.replace(/\/+$/u, '').replace(/\/(?:api\/)?v1$/u, '')
  url.pathname = `${prefix}/api/v1/services/audio/tts/SpeechSynthesizer`
  const response = await send(url, { signal,
    headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json', 'x-dashscope-sse': 'enable' },
    body: JSON.stringify({ model: selection.model, input: { text, voice: selection.voice, format, sample_rate: 24000, rate: 1,
      ...(selection.speechInstruction ? { instruction: selection.speechInstruction } : {}) } }),
  }, transport)
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const decoder = new TextDecoder()
  let pending = '', fragments = [], fragmentLength = 0, size = 0, received = 0, finished = false, prefixBytes = Buffer.alloc(0), checked = format !== 'pcm'
  const parse = record => {
    const data = record.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return null
    if (finished) return fail('external-response-invalid')
    const event = json(data)
    if (event.code) return fail(/InvalidApiKey|AccessDenied|Unauthorized/iu.test(event.code) ? 'api-key-rejected'
      : /Throttl|LimitExceeded/iu.test(event.code) ? 'rate-limited' : /Arrear|Quota/iu.test(event.code) ? 'external-quota-exceeded' : 'external-upstream-failed')
    if (!event.output || typeof event.output !== 'object') return fail('external-response-invalid')
    if (event.output.finish_reason === 'stop') finished = true
    // Ignore the complete-audio URL in the final event; chunks are the sole audio source.
    return event.output.audio?.data ? base64Audio(event.output.audio.data) : null
  }
  try {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return fail('external-response-invalid')
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      received += chunk.value?.length ?? 0
      if (received > MAX_AUDIO * 2) return fail('audio-too-large', 413)
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let boundary
      while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
        signal.throwIfAborted()
        if (fragmentLength + boundary.index > MAX_RECORD) return fail('stream-buffer-limit', 413)
        const bytes = parse(fragments.join('') + pending.slice(0, boundary.index))
        fragments = []; fragmentLength = 0
        pending = pending.slice(boundary.index + boundary[0].length)
        if (!bytes) continue
        size += bytes.length
        if (size > MAX_AUDIO) return fail('audio-too-large', 413)
        if (!checked) {
          prefixBytes = Buffer.concat([prefixBytes, bytes])
          if (prefixBytes.length < 4) continue
          if (prefixBytes.toString('ascii', 0, 4) === 'RIFF' || prefixBytes.toString('ascii', 0, 3) === 'ID3') return fail('invalid-audio-format')
          checked = true
          yield prefixBytes
          prefixBytes = Buffer.alloc(0)
        } else yield bytes
      }
      // Retain only the delimiter overlap for the next scan; join record fragments once.
      if (pending.length > 3) {
        fragments.push(pending.slice(0, -3))
        fragmentLength += pending.length - 3
        pending = pending.slice(-3)
      }
      if (fragmentLength + pending.length > MAX_RECORD + 3) return fail('stream-buffer-limit', 413)
      if (chunk.done || finished) break
    }
    signal.throwIfAborted()
    if (!finished || (fragments.join('') + pending).trim() || !size || (format === 'pcm' && size % 2)) return fail('external-stream-incomplete')
    if (prefixBytes.length) yield prefixBytes
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
