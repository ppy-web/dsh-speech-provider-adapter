import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { TtsProviderError } from './host-api.mjs'

const MAX_AUDIO = 32 * 1024 * 1024
const fail = (code, status = 502) => { throw new TtsProviderError(code, undefined, status) }

export const XIAOMI_TOKEN_PLAN_BASE = 'https://token-plan-cn.xiaomimimo.com/v1'
export const BREEZE_MODEL = 'breeze-tts-2'
export const DOUBAO_TTS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
export const DOUBAO_AGENT_PLAN_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection'

function httpFail(status) {
  fail(status === 401 || status === 403 ? 'api-key-rejected' : status === 402 ? 'external-quota-exceeded'
    : status === 429 ? 'rate-limited' : 'external-upstream-failed', status === 429 ? 429 : 502)
}
function upstreamCode(message) {
  if (/resource|not.*open|资源|未开通/iu.test(message)) return 'external-quota-exceeded'
  if (/auth|token|api.?key|permission|鉴权|密钥|认证|未授权/iu.test(message)) return 'api-key-rejected'
  if (/speaker|voice|音色|发音人/iu.test(message)) return 'external-selection-invalid'
  if (/limit|quota|concurr|too many|限流|并发|配额|频率/iu.test(message)) return 'rate-limited'
  return 'external-upstream-failed'
}
function validAudio(bytes, format) {
  if (!bytes.length) return false
  return format === 'wav'
    ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
    : bytes.length >= 2 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
}
function base64Audio(value, format) {
  if (typeof value !== 'string' || !value || /[^A-Za-z0-9+/=]/u.test(value)) return fail('invalid-audio-format')
  const bytes = Buffer.from(value, 'base64')
  if (!validAudio(bytes, format)) return fail('invalid-audio-format')
  return bytes
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

// --- Xiaomi MiMo (OpenAI-compatible chat/completions) ---
function xiaomiEndpoint(profile) {
  const base = String(profile.apiKey ?? '').trim().startsWith('tp-') ? XIAOMI_TOKEN_PLAN_BASE
    : String(profile.baseURL ?? '').replace(/\/+$/u, '')
  return `${base}/chat/completions`
}
function xiaomiModel(selection) { return selection.model === 'mimo-v2.5-tts-voicedesign' ? 'mimo-v2.5-tts-voicedesign' : 'mimo-v2.5-tts' }
function xiaomiMessages(selection, text) {
  const instruction = String(selection.speechInstruction ?? '').trim()
  const messages = []
  if (instruction) messages.push({ role: 'user', content: instruction })
  messages.push({ role: 'assistant', content: text })
  return messages
}

export async function synthesizeXiaomi(profile, text, format, selection, signal, transport = fetch) {
  const model = xiaomiModel(selection)
  const body = JSON.stringify({ model, messages: xiaomiMessages(selection, text), audio: model === 'mimo-v2.5-tts-voicedesign' ? { format } : { format, voice: selection.voice }, stream: false })
  signal.throwIfAborted()
  const response = await transport(xiaomiEndpoint(profile), {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${String(profile.apiKey).trim()}`, 'content-type': 'application/json', accept: 'application/json' }, body,
  })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return httpFail(response.status) }
  const bytes = await readBounded(response, signal, 4 * Math.ceil(MAX_AUDIO / 3) + 1024 * 1024)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return fail('external-response-invalid') }
  const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message
  if (typeof message === 'string' && message) return fail(upstreamCode(message))
  return { data: base64Audio(parsed?.choices?.[0]?.message?.audio?.data, format), format }
}

export async function* streamXiaomi(profile, text, selection, signal, transport = fetch) {
  if (xiaomiModel(selection) === 'mimo-v2.5-tts-voicedesign') return fail('external-streaming-unsupported', 400)
  const body = JSON.stringify({ model: 'mimo-v2.5-tts', messages: xiaomiMessages(selection, text), audio: { format: 'pcm16', voice: selection.voice }, stream: true })
  signal.throwIfAborted()
  const response = await transport(xiaomiEndpoint(profile), {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${String(profile.apiKey).trim()}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body,
  })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return httpFail(response.status) }
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const decoder = new TextDecoder()
  let pending = '', received = false, size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let boundary
      while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
        const record = pending.slice(0, boundary.index)
        pending = pending.slice(boundary.index + boundary[0].length)
        const data = record.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        let event
        try { event = JSON.parse(data) } catch { return fail('external-response-invalid') }
        const errorMessage = typeof event?.error === 'string' ? event.error : event?.error?.message
        if (typeof errorMessage === 'string' && errorMessage) return fail(upstreamCode(errorMessage))
        const value = event?.choices?.[0]?.delta?.audio?.data
        if (typeof value !== 'string' || !value) continue
        const bytes = Buffer.from(value, 'base64')
        size += bytes.length
        if (size > MAX_AUDIO) return fail('audio-too-large', 413)
        if (bytes.length) { received = true; yield bytes }
      }
      if (chunk.done) break
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (!received) return fail('external-stream-incomplete')
}

// --- Breeze Blue TTS (ElevenLabs-style binary) ---
function breezeBase(profile) { return String(profile.baseURL ?? '').replace(/\/+$/u, '') || 'https://api.breeze.blue/v1' }
function breezeBody(selection, text) {
  const instruction = String(selection.speechInstruction ?? '').trim()
  return JSON.stringify({ text, model_id: BREEZE_MODEL, ...(instruction ? { instructions: instruction } : {}), voice_settings: { speed: 1 } })
}
function breezeUrl(profile, selection, format, stream) {
  return `${breezeBase(profile)}/text-to-speech/${encodeURIComponent(String(selection.voice).trim())}${stream ? '/stream' : ''}?output_format=${format}`
}

export async function synthesizeBreeze(profile, text, format, selection, signal, transport = fetch) {
  signal.throwIfAborted()
  const response = await transport(breezeUrl(profile, selection, format, false), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'xi-api-key': String(profile.apiKey).trim(), 'content-type': 'application/json', accept: format === 'wav' ? 'audio/wav' : 'audio/mpeg' },
    body: breezeBody(selection, text),
  })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return httpFail(response.status) }
  const bytes = await readBounded(response, signal, MAX_AUDIO)
  if (!validAudio(bytes, format)) return fail('invalid-audio-format')
  return { data: bytes, format }
}

export async function* streamBreeze(profile, text, selection, signal, transport = fetch) {
  signal.throwIfAborted()
  const response = await transport(breezeUrl(profile, selection, 'pcm', true), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'xi-api-key': String(profile.apiKey).trim(), 'content-type': 'application/json', accept: 'audio/pcm' },
    body: breezeBody(selection, text),
  })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return httpFail(response.status) }
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  let pending = null, size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.byteLength) continue
      let chunk = pending === null ? Buffer.from(value) : Buffer.concat([pending, Buffer.from(value)])
      pending = null
      if (chunk.length % 2) { pending = Buffer.from(chunk.subarray(chunk.length - 1)); chunk = chunk.subarray(0, chunk.length - 1) }
      if (chunk.length) { size += chunk.length; if (size > MAX_AUDIO) return fail('audio-too-large', 413); yield chunk }
    }
    if (pending) yield Buffer.from([pending[0], 0])
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

// --- Doubao Seed TTS (WebSocket bidirectional protocol) ---
const DoubaoEvent = {
  StartConnection: 1, FinishConnection: 2,
  ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52,
  StartSession: 100, CancelSession: 101, FinishSession: 102,
  SessionStarted: 150, SessionCanceled: 151, SessionFinished: 152, SessionFailed: 153,
  TaskRequest: 200, TTSSentenceStart: 350, TTSSentenceEnd: 351, TTSResponse: 352, TTSSubtitle: 364,
}
const CONNECTION_EVENTS = new Set([1, 2, 50, 51, 52])
const CONNECTION_RESPONSES = new Set([50, 51, 52])
const MAX_FRAME = 16 * 1024 * 1024

export function encodeDoubaoFrame(event, payload = {}, sessionId = '') {
  const data = Buffer.from(JSON.stringify(payload))
  const id = Buffer.from(sessionId)
  const session = !CONNECTION_EVENTS.has(event)
  const frame = Buffer.alloc(4 + 4 + (session ? 4 + id.length : 0) + 4 + data.length)
  frame.set([0x11, 0x14, 0x10, 0])
  frame.writeInt32BE(event, 4)
  let offset = 8
  if (session) {
    frame.writeUInt32BE(id.length, offset)
    offset += 4
    id.copy(frame, offset)
    offset += id.length
  }
  frame.writeUInt32BE(data.length, offset)
  data.copy(frame, offset + 4)
  return frame
}

export function decodeDoubaoFrame(data) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const invalid = () => fail('external-response-invalid')
  if (bytes.length < 4 || bytes.length > MAX_FRAME || bytes[0] >> 4 !== 1) throw invalid()
  let offset = (bytes[0] & 15) * 4
  if (offset < 4 || offset > bytes.length) throw invalid()
  const type = bytes[1] >> 4
  const flags = bytes[1] & 15
  const compression = bytes[2] & 15
  const serialization = bytes[2] >> 4
  if (![1, 9, 11, 15].includes(type) || compression > 1 || serialization > 1) throw invalid()
  const integer = (signed = false) => {
    if (offset + 4 > bytes.length) throw invalid()
    const value = signed ? bytes.readInt32BE(offset) : bytes.readUInt32BE(offset)
    offset += 4
    return value
  }
  const field = () => {
    const length = integer()
    if (length > MAX_FRAME || offset + length > bytes.length) throw invalid()
    const result = bytes.subarray(offset, offset + length)
    offset += length
    return result
  }
  let errorCode
  if (type === 15) errorCode = integer()
  else if ((flags & 3) === 1 || (flags & 3) === 3) integer(true)
  const event = flags & 4 ? integer(true) : 0
  const sessionId = flags & 4 && !CONNECTION_EVENTS.has(event) ? field().toString('utf8') : ''
  const connectId = CONNECTION_RESPONSES.has(event) ? field().toString('utf8') : ''
  let payload = field()
  if (offset !== bytes.length) throw invalid()
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: MAX_FRAME })
  return { type, event, sessionId, connectId, ...(errorCode === undefined ? {} : { errorCode }), payload }
}

function doubaoEndpoint(profile) {
  const key = String(profile.apiKey ?? '').trim()
  if (key.startsWith('ark-') && (!profile.baseURL || profile.baseURL === DOUBAO_TTS_ENDPOINT)) return DOUBAO_AGENT_PLAN_ENDPOINT
  return profile.baseURL || DOUBAO_TTS_ENDPOINT
}
function wrapPcmWav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
function doubaoRequestParams(selection, audioFormat) {
  const instruction = String(selection.speechInstruction ?? '').trim()
  return {
    speaker: selection.voice,
    ...(selection.model === 'seed-icl-2.0' ? { model: 'seed-tts-2.0-standard' } : {}),
    ...(selection.model === 'seed-tts-2.0' && instruction ? { additions: JSON.stringify({ context_texts: [instruction] }) } : {}),
    audio_params: { format: audioFormat, sample_rate: 24000, speech_rate: 0 },
  }
}

/** Run one Doubao bidirectional session, delivering even-sized audio chunks to onAudio. */
export function runDoubao(profile, text, selection, audioFormat, signal, onAudio) {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID()
    const connectId = randomUUID()
    const headers = { 'X-Api-Key': String(profile.apiKey).trim(), 'X-Api-Resource-Id': selection.model, 'X-Api-Connect-Id': connectId }
    const requestParams = doubaoRequestParams(selection, audioFormat)
    let state = 'connecting', audioBytes = 0, pcmTail = null, settled = false, timer
    const socket = new WebSocket(doubaoEndpoint(profile), { headers, maxPayload: MAX_FRAME, handshakeTimeout: 10000, followRedirects: false })
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    const settleFail = (code, status = 502) => {
      if (settled) return
      settled = true; cleanup()
      try { socket.terminate() } catch { /* already closed */ }
      reject(new TtsProviderError(code, undefined, status))
    }
    const arm = (ms = 20000) => { clearTimeout(timer); timer = setTimeout(() => settleFail('tts-timeout', 504), ms) }
    const send = (event, payload = {}) => { try { socket.send(encodeDoubaoFrame(event, payload, sessionId)) } catch { settleFail('external-upstream-failed') } }
    const onAbort = () => settleFail('tts-canceled', 499)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return }
    arm(12000)
    socket.on('open', () => { if (state !== 'connecting') return; state = 'connection'; send(DoubaoEvent.StartConnection) })
    socket.on('unexpected-response', (_request, response) => {
      response.resume()
      const status = response.statusCode ?? 502
      settleFail(status === 401 || status === 403 ? 'api-key-rejected' : status === 429 ? 'rate-limited' : 'external-upstream-failed', status === 429 ? 429 : 502)
    })
    socket.on('error', () => settleFail('external-upstream-failed', 502))
    socket.on('close', () => { if (!settled) settleFail('external-stream-incomplete', 502) })
    socket.on('message', (data, isBinary) => {
      if (settled) return
      try {
        if (!isBinary) throw new TtsProviderError('external-response-invalid')
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = decodeDoubaoFrame(bytes)
        let detail = {}
        if (frame.type !== 11) { try { detail = JSON.parse(frame.payload.toString()) } catch { /* plain-text error packet */ } }
        const status = detail.status_code ?? detail.code
        if (frame.errorCode !== undefined || frame.event === DoubaoEvent.ConnectionFailed || frame.event === DoubaoEvent.SessionFailed || (status !== undefined && status !== 0 && status !== 20000000)) {
          const message = typeof detail.message === 'string' ? detail.message : ''
          const code = upstreamCode(message)
          settleFail(code, code === 'api-key-rejected' ? 403 : code === 'rate-limited' ? 429 : 502); return
        }
        if (frame.event === DoubaoEvent.ConnectionStarted && state === 'connection') {
          state = 'starting'
          send(DoubaoEvent.StartSession, { user: { uid: 'dsh-tts' }, event: DoubaoEvent.StartSession, namespace: 'BidirectionalTTS', req_params: requestParams })
        } else if (frame.event === DoubaoEvent.SessionStarted && state === 'starting') {
          state = 'ready'
          send(DoubaoEvent.TaskRequest, { user: { uid: 'dsh-tts' }, event: DoubaoEvent.TaskRequest, namespace: 'BidirectionalTTS', req_params: { ...requestParams, text } })
          send(DoubaoEvent.FinishSession)
          arm()
        } else if (frame.event === DoubaoEvent.TTSResponse && frame.type === 11 && state === 'ready') {
          if (!frame.payload.length) return
          let audio = frame.payload
          if (audioFormat === 'pcm') {
            if (pcmTail !== null) { audio = Buffer.concat([pcmTail, audio]); pcmTail = null }
            if (audio.length % 2) { pcmTail = Buffer.from([audio[audio.length - 1]]); audio = audio.subarray(0, audio.length - 1) }
          }
          if (audio.length) { audioBytes += audio.length; if (audioBytes > MAX_AUDIO) { settleFail('audio-too-large', 413); return } onAudio(audio) }
          arm()
        } else if (frame.event === DoubaoEvent.SessionFinished && state === 'ready') {
          state = 'closing'; send(DoubaoEvent.FinishConnection); arm(12000)
        } else if (frame.event === DoubaoEvent.ConnectionFinished && state === 'closing') {
          state = 'done'; settled = true; cleanup()
          try { socket.close() } catch { /* already closed */ }
          if (!audioBytes) reject(new TtsProviderError('external-stream-incomplete', undefined, 502)); else resolve()
        }
      } catch (error) { settleFail(error instanceof TtsProviderError ? error.code : 'external-response-invalid', error?.status ?? 502) }
    })
  })
}

export async function synthesizeDoubao(profile, text, format, selection, signal) {
  const audioFormat = format === 'wav' ? 'pcm' : 'mp3'
  const chunks = []
  await runDoubao(profile, text, selection, audioFormat, signal, bytes => { chunks.push(bytes) })
  const audio = Buffer.concat(chunks)
  if (!audio.length) return fail('external-stream-incomplete')
  if (format === 'wav') { if (audio.length % 2) return fail('invalid-audio-format'); return { data: wrapPcmWav(audio), format } }
  if (!validAudio(audio, 'mp3')) return fail('invalid-audio-format')
  return { data: audio, format }
}

/** Bridge the callback-based Doubao session into an async iterable of PCM chunks. */
function doubaoStream(profile, text, selection, signal) {
  const queue = []
  let done = false, error = null, notify = null
  const wake = () => { const current = notify; notify = null; if (current) current() }
  void runDoubao(profile, text, selection, 'pcm', signal, bytes => { queue.push(bytes); wake() })
    .then(() => { done = true; wake() }, failure => { error = failure; done = true; wake() })
  return (async function* () {
    while (true) {
      if (queue.length) { yield queue.shift(); continue }
      if (error) throw error
      if (done) return
      await new Promise(resolve => { notify = resolve })
    }
  })()
}

export async function* streamDoubao(profile, text, selection, signal) {
  let received = false
  for await (const chunk of doubaoStream(profile, text, selection, signal)) { received = true; yield chunk }
  if (!received) return fail('external-stream-incomplete')
}
