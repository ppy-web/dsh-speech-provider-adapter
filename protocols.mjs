import { TtsProviderError } from './host-api.mjs'

const MAX_AUDIO = 32 * 1024 * 1024
const fail = (code, status = 502) => { throw new TtsProviderError(code, undefined, status) }
export const PROTOCOLS = ['senseaudio', 'openai', 'minimax']
const emotions = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']
const interjections = ['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes']

export function modelFeatures(protocol, model) {
  const instruction = protocol === 'openai' ? /^gpt-4o-mini-tts(?:-|$)/u.test(model.id) : protocol === 'minimax' && /^speech-(?:2\.[68]|0[12])-/u.test(model.id)
  return {
    streaming: model.streaming !== false,
    speechInstruction: model.speechInstruction ?? instruction,
    ...(protocol === 'minimax' && instruction ? { instructions: [...emotions, ...(/^speech-2\.6-/u.test(model.id) ? ['fluent', 'whisper'] : [])].map(id => ({ id, name: id })) } : {}),
    ...(protocol === 'senseaudio' ? { audioTags: [{ value: '<break time=500>', name: '停顿 500 ms / Pause 500 ms' }] }
      : protocol === 'minimax' && /^speech-2\.8-/u.test(model.id) ? { audioTags: interjections.map(id => ({ value: `(${id})`, name: id })) } : {}),
  }
}

export function preset(protocol = 'senseaudio') {
  const models = protocol === 'senseaudio' ? ['sensenova-tts-2.0', 'senseaudio-tts-1.5-260319']
    : protocol === 'minimax' ? ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'] : ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']
  const voices = protocol === 'openai' ? ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
    : protocol === 'senseaudio' ? ['female_0033_b', 'male_0004_a'] : ['English_expressive_narrator']
  return {
    protocol, name: protocol === 'senseaudio' ? 'SenseAudio' : protocol === 'openai' ? 'OpenAI compatible' : 'MiniMax',
    baseURL: protocol === 'senseaudio' ? 'https://api.senseaudio.cn' : protocol === 'minimax' ? 'https://api.minimax.io' : 'https://api.openai.com/v1',
    apiKey: '', streaming: true, maxTextLength: protocol === 'openai' ? 4096 : 9999,
    models: models.map(id => ({ id, name: id })), voices: voices.map(id => ({ id, name: id })),
    selection: { model: models[0], voice: voices[0], speechInstruction: '' },
  }
}

export function endpoint(base, resource) {
  let url
  try { url = new URL(base) } catch { return fail('adapter-url-invalid', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('adapter-url-invalid', 400)
  const prefix = url.pathname.replace(/\/+$/u, '')
  url.pathname = `${prefix.endsWith('/v1') ? prefix : `${prefix}/v1`}/`
  return new URL(resource, url).href
}

async function request(profile, resource, body, signal, transport = fetch) {
  signal.throwIfAborted()
  const response = await transport(endpoint(profile.baseURL, resource), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${profile.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    fail(response.status === 401 || response.status === 403 ? 'api-key-rejected' : response.status === 429 ? 'rate-limited' : 'external-upstream-failed', response.status === 429 ? 429 : 502)
  }
  return response
}

async function boundedBody(response, signal, maximum = MAX_AUDIO) {
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

function checkedJson(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { return fail('external-response-invalid') }
  const status = value?.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    fail(status === 1002 ? 'rate-limited' : status === 1004 || status === 2049 ? 'api-key-rejected' : status === 1008 ? 'external-quota-exceeded' : 'external-upstream-failed')
  }
  if (!value || typeof value !== 'object') return fail('external-response-invalid')
  return value
}

function hexAudio(value) {
  if (typeof value !== 'string' || !value.length || value.length % 2 || !/^[a-f\d]+$/iu.test(value)) return fail('invalid-audio-format')
  if (value.length > MAX_AUDIO * 2) return fail('audio-too-large', 413)
  return Buffer.from(value, 'hex')
}

function checkAudioInfo(value, format) {
  const info = value.extra_info
  if (!info) return
  if ((info.audio_format && info.audio_format !== format) || (format === 'pcm' && ((info.audio_sample_rate && info.audio_sample_rate !== 24000)
    || (info.audio_channel && info.audio_channel !== 1)))) return fail('invalid-audio-format')
}

function checkPcm(bytes) {
  if (bytes.toString('ascii', 0, 4) === 'RIFF' || bytes.toString('ascii', 0, 3) === 'ID3') return fail('invalid-audio-format')
  return bytes
}

export function pcmWav(data) {
  if (!data.length || data.length % 2) return fail('invalid-audio-format')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function payload(profile, text, format, streaming, selection) {
  if (profile.protocol === 'openai') return {
    model: selection.model, voice: selection.voice, input: text, response_format: format,
    ...(selection.speechInstruction ? { instructions: selection.speechInstruction } : {}),
  }
  return {
    model: selection.model, text, stream: streaming,
    ...(profile.protocol === 'minimax' ? { output_format: 'hex', language_boost: 'auto' } : {}),
    voice_setting: { voice_id: selection.voice, speed: 1, vol: 1, pitch: 0,
      ...(selection.speechInstruction ? { emotion: selection.speechInstruction } : {}) },
    audio_setting: { format, sample_rate: 24000, channel: 1, ...(format === 'mp3' ? { bitrate: 128000 } : {}) },
    ...(streaming ? { stream_options: { exclude_aggregated_audio: true } } : {}),
  }
}

export async function synthesize(profile, { text, format, signal, ...overrides }, transport = fetch) {
  const selection = { ...profile.selection, ...overrides }
  // PCM avoids upstream WAV variants and guarantees the host's required PCM WAV format.
  const upstream = format === 'wav' ? 'pcm' : 'mp3'
  const response = await request(profile, profile.protocol === 'openai' ? 'audio/speech' : 't2a_v2', payload(profile, text, upstream, false, selection), signal, transport)
  const bytes = await boundedBody(response, signal, profile.protocol === 'openai' ? MAX_AUDIO : MAX_AUDIO * 2 + 65536)
  const parsed = profile.protocol === 'openai' ? null : checkedJson(bytes)
  if (parsed) checkAudioInfo(parsed, upstream)
  if (profile.protocol === 'openai' && response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
  const data = profile.protocol === 'openai' ? bytes : hexAudio(parsed.data?.audio)
  signal.throwIfAborted()
  return { data: format === 'wav' ? pcmWav(checkPcm(data)) : data, format }
}

/** Parses complete SSE records across arbitrary byte boundaries, with bounded buffering. */
export async function* streamPcm(profile, { text, signal, ...overrides }, transport = fetch) {
  const response = await request(profile, profile.protocol === 'openai' ? 'audio/speech' : 't2a_v2', payload(profile, text, 'pcm', true, { ...profile.selection, ...overrides }), signal, transport)
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const decoder = new TextDecoder()
  let pending = '', size = 0, done = false
  try {
    if (profile.protocol === 'openai' && response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (profile.protocol === 'openai') {
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_AUDIO) return fail('audio-too-large', 413)
        yield chunk.value
        continue
      }
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      if (pending.length > 2 * 1024 * 1024) return fail('stream-buffer-limit', 413)
      let boundary
      while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
        const record = pending.slice(0, boundary.index)
        pending = pending.slice(boundary.index + boundary[0].length)
        const data = record.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        if (done) return fail('external-response-invalid')
        const event = checkedJson(Buffer.from(data))
        checkAudioInfo(event, 'pcm')
        if (event.data?.audio) {
          const bytes = hexAudio(event.data.audio)
          size += bytes.length
          if (size > MAX_AUDIO) return fail('audio-too-large', 413)
          yield bytes
        }
        if (event.data?.status === 2) done = true
      }
      if (chunk.done) break
    }
    signal.throwIfAborted()
    if (!size || (profile.protocol !== 'openai' && (!done || pending.trim()))) return fail('external-stream-incomplete')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function discover(profile, transport = fetch, signal = AbortSignal.timeout(20000)) {
  const jobs = [request(profile, `models${profile.protocol === 'senseaudio' ? '?mode=tts' : ''}`, undefined, signal, transport)
    .then(response => boundedBody(response, signal, 2 * 1024 * 1024)).then(checkedJson).then(value => {
      if (!Array.isArray(value.data)) return fail('external-response-invalid')
      return value.data.filter(item => typeof item.id === 'string' && (profile.protocol === 'senseaudio' ? item.mode === 'tts' : /tts|speech-/iu.test(item.id)))
        .map(item => ({ id: item.id, name: item.display_name || item.id }))
    })]
  if (profile.protocol !== 'openai') jobs.push(request(profile, 'get_voice', { voice_type: 'all' }, signal, transport)
    .then(response => boundedBody(response, signal, 2 * 1024 * 1024)).then(checkedJson).then(value => {
      if (!['system_voice', 'voice_cloning', 'voice_generation'].some(key => Array.isArray(value[key]))) return fail('external-response-invalid')
      return ['system_voice', 'voice_cloning', 'voice_generation'].flatMap(key => value[key] ?? []).filter(item => typeof item.voice_id === 'string')
        .map(item => ({ id: item.voice_id, name: item.voice_name || item.voice_id }))
    }))
  const results = await Promise.allSettled(jobs)
  return { models: results[0].status === 'fulfilled' ? results[0].value : undefined,
    voices: results[1]?.status === 'fulfilled' ? results[1].value : undefined,
    errors: results.flatMap((result, index) => result.status === 'rejected' ? [{ kind: index ? 'voices' : 'models', code: result.reason instanceof TtsProviderError ? result.reason.code : 'external-upstream-failed' }] : []) }
}
