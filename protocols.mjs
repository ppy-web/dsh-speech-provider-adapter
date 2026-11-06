import { TtsProviderError } from './host-api.mjs'

const MAX_AUDIO = 32 * 1024 * 1024
const fail = (code, status = 502) => { throw new TtsProviderError(code, undefined, status) }
export const PROTOCOLS = ['senseaudio', 'openai', 'minimax', 'siliconflow', 'elevenlabs', 'fish']
const BINARY_PROTOCOLS = new Set(['openai', 'siliconflow', 'elevenlabs', 'fish'])
const FISH_MODELS = ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1']
const emotions = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']
const interjections = ['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes']

export function modelFeatures(protocol, model) {
  const instruction = protocol === 'openai' ? /^gpt-4o-mini-tts(?:-|$)/u.test(model.id)
    : protocol === 'siliconflow' ? /CosyVoice2/iu.test(model.id) : protocol === 'minimax' && /^speech-(?:2\.[68]|0[12])-/u.test(model.id)
  return {
    streaming: model.streaming !== false,
    speechInstruction: model.speechInstruction ?? instruction,
    ...(protocol === 'minimax' && instruction ? { instructions: [...emotions, ...(/^speech-2\.6-/u.test(model.id) ? ['fluent', 'whisper'] : [])].map(id => ({ id, name: id })) } : {}),
    ...(protocol === 'senseaudio' ? { audioTags: [{ value: '<break time=500>', name: '停顿 500 ms / Pause 500 ms' }] }
      : protocol === 'minimax' && /^speech-2\.8-/u.test(model.id) ? { audioTags: interjections.map(id => ({ value: `(${id})`, name: id })) } : {}),
  }
}

export function preset(protocol = 'senseaudio') {
  if (!PROTOCOLS.includes(protocol)) return fail('adapter-config-invalid', 400)
  if (protocol === 'siliconflow') {
    const model = 'FunAudioLLM/CosyVoice2-0.5B'
    return { protocol, name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', apiKey: '', streaming: true, maxTextLength: 4096,
      models: [{ id: model, name: 'CosyVoice2 0.5B', speechInstruction: true }],
      voices: ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'].map(name => ({ id: `${model}:${name}`, name, modelIds: [model] })),
      selection: { model, voice: `${model}:alex`, speechInstruction: '' } }
  }
  if (protocol === 'elevenlabs') return {
    protocol, name: 'ElevenLabs', baseURL: 'https://api.elevenlabs.io/v1', apiKey: '', streaming: true, maxTextLength: 2000,
    models: [{ id: 'eleven_multilingual_v2', name: 'Multilingual v2' }, { id: 'eleven_flash_v2_5', name: 'Flash v2.5' }],
    voices: [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }],
    selection: { model: 'eleven_multilingual_v2', voice: 'JBFqnCBsd6RMkjVDRZzb', speechInstruction: '' },
  }
  if (protocol === 'fish') return {
    protocol, name: 'Fish Audio', baseURL: 'https://api.fish.audio', apiKey: '', streaming: true, maxTextLength: 4096,
    models: FISH_MODELS.map(id => ({ id, name: id })), voices: [],
    selection: { model: FISH_MODELS[0], voice: '', speechInstruction: '' },
  }
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

export function endpoint(base, resource, version = 'v1') {
  let url
  try { url = new URL(base) } catch { return fail('adapter-url-invalid', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('adapter-url-invalid', 400)
  const prefix = url.pathname.replace(/\/+$/u, '').replace(/\/v[12]$/u, '')
  url.pathname = `${prefix}${version ? `/${version}` : ''}/`
  return new URL(resource, url).href
}

async function request(profile, resource, body, signal, transport = fetch, { version = 'v1', headers = {} } = {}) {
  signal.throwIfAborted()
  const response = await transport(endpoint(profile.baseURL, resource, version), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { ...(profile.protocol === 'elevenlabs' ? { 'xi-api-key': profile.apiKey } : { authorization: `Bearer ${profile.apiKey}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    fail(response.status === 401 || response.status === 403 ? 'api-key-rejected' : response.status === 402 ? 'external-quota-exceeded' : response.status === 429 ? 'rate-limited' : 'external-upstream-failed', response.status === 429 ? 429 : 502)
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
  if (profile.protocol === 'elevenlabs' || profile.protocol === 'fish') {
    if (selection.speechInstruction) return fail('external-option-unsupported', 400)
    return profile.protocol === 'elevenlabs' ? { text, model_id: selection.model, voice_settings: { speed: 1 } }
      : { text, reference_id: selection.voice, format, sample_rate: format === 'pcm' ? 24000 : 44100, ...(format === 'mp3' ? { mp3_bitrate: 128 } : {}) }
  }
  if (profile.protocol === 'siliconflow') return {
    model: selection.model, voice: selection.voice, input: selection.speechInstruction ? `${selection.speechInstruction}<|endofprompt|>${text}` : text,
    response_format: format, sample_rate: format === 'pcm' ? 24000 : 44100, stream: streaming,
  }
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

function speechResource(profile, selection, format, streaming) {
  if (profile.protocol === 'elevenlabs') {
    if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(selection.voice)) return fail('external-selection-invalid', 400)
    return `text-to-speech/${selection.voice}${streaming ? '/stream' : ''}?output_format=${format === 'pcm' ? 'pcm_24000' : 'mp3_44100_128'}`
  }
  if (profile.protocol === 'fish') return 'tts'
  return BINARY_PROTOCOLS.has(profile.protocol) ? 'audio/speech' : 't2a_v2'
}

function speechHeaders(profile, selection) { return profile.protocol === 'fish' ? { model: selection.model } : {} }

export async function synthesize(profile, { text, format, signal, ...overrides }, transport = fetch) {
  const selection = { ...profile.selection, ...overrides }
  // PCM avoids upstream WAV variants and guarantees the host's required PCM WAV format.
  const upstream = format === 'wav' ? 'pcm' : 'mp3'
  const binary = BINARY_PROTOCOLS.has(profile.protocol)
  const response = await request(profile, speechResource(profile, selection, upstream, false), payload(profile, text, upstream, false, selection), signal, transport, { headers: speechHeaders(profile, selection) })
  const bytes = await boundedBody(response, signal, binary ? MAX_AUDIO : MAX_AUDIO * 2 + 65536)
  const parsed = binary ? null : checkedJson(bytes)
  if (parsed) checkAudioInfo(parsed, upstream)
  if (binary && response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
  const data = binary ? bytes : hexAudio(parsed.data?.audio)
  if (binary && upstream === 'pcm' && /audio\/(?:mpeg|mp3|wav|wave|ogg|flac)/iu.test(response.headers.get('content-type') ?? '')) return fail('invalid-audio-format')
  signal.throwIfAborted()
  return { data: format === 'wav' ? pcmWav(checkPcm(data)) : data, format }
}

/** Parses complete SSE records across arbitrary byte boundaries, with bounded buffering. */
export async function* streamPcm(profile, { text, signal, ...overrides }, transport = fetch) {
  const selection = { ...profile.selection, ...overrides }
  const binary = BINARY_PROTOCOLS.has(profile.protocol)
  const response = await request(profile, speechResource(profile, selection, 'pcm', true), payload(profile, text, 'pcm', true, selection), signal, transport, { headers: speechHeaders(profile, selection) })
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const decoder = new TextDecoder()
  let pending = '', size = 0, done = false, prefix = Buffer.alloc(0), checked = false
  try {
    if (binary && response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
    if (binary && /audio\/(?:mpeg|mp3|wav|wave|ogg|flac)/iu.test(response.headers.get('content-type') ?? '')) return fail('invalid-audio-format')
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (binary) {
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_AUDIO) return fail('audio-too-large', 413)
        if (!checked) {
          prefix = Buffer.concat([prefix, chunk.value])
          if (prefix.length < 4) continue
          checked = true
          const first = prefix
          prefix = Buffer.alloc(0)
          yield checkPcm(first)
        } else yield chunk.value
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
    if (binary && !checked && prefix.length) yield checkPcm(prefix)
    if (!size || size % 2 || (!binary && (!done || pending.trim()))) return fail('external-stream-incomplete')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function catalogJson(profile, resource, signal, transport, version = 'v1') {
  return checkedJson(await boundedBody(await request(profile, resource, undefined, signal, transport, { version }), signal, 2 * 1024 * 1024))
}

function catalogRows(rows, idKey, nameKey) {
  return rows.filter(row => typeof row?.[idKey] === 'string' && row[idKey].trim() && row[idKey].length <= 200)
    .map(row => ({ id: row[idKey].trim(), name: (typeof row[nameKey] === 'string' && row[nameKey].trim() ? row[nameKey].trim() : row[idKey]).slice(0, 200) }))
}

/** Bound account catalogs and follow only locally constructed pagination URLs. */
async function accountVoices(profile, signal, transport) {
  const voices = new Map(), tokens = new Set()
  let token = ''
  for (let page = 1; page <= 40; page++) {
    signal.throwIfAborted()
    const eleven = profile.protocol === 'elevenlabs'
    const query = eleven ? new URLSearchParams({ page_size: '100', ...(token ? { next_page_token: token } : {}) })
      : new URLSearchParams({ page_size: '100', page_number: String(page), self: 'true' })
    const result = await catalogJson(profile, `${eleven ? 'voices' : 'model'}?${query}`, signal, transport, eleven ? 'v2' : '')
    const rows = eleven ? result.voices : result.items
    if (!Array.isArray(rows)) return fail('external-response-invalid')
    const previousSize = voices.size
    for (const voice of catalogRows(rows, eleven ? 'voice_id' : '_id', eleven ? 'name' : 'title')) voices.set(voice.id, voice)
    if (voices.size > 2000) return fail('external-catalog-limit', 413)
    const more = result.has_more ?? (typeof result.total === 'number' ? page * 100 < result.total : rows.length >= 100)
    if (!more) return [...voices.values()]
    if (!rows.length || (page > 1 && voices.size === previousSize)) return fail('external-response-invalid')
    if (eleven) {
      token = result.next_page_token
      if (typeof token !== 'string' || !token || token.length > 2000 || tokens.has(token)) return fail('external-response-invalid')
      tokens.add(token)
    }
  }
  return fail('external-catalog-limit', 413)
}

function discoveryResult(results, kinds) {
  return { ...Object.fromEntries(results.flatMap((result, index) => result.status === 'fulfilled' ? [[kinds[index], result.value]] : [])),
    connected: results.some(result => result.status === 'fulfilled'),
    errors: results.flatMap((result, index) => result.status === 'rejected' ? [{ kind: kinds[index], code: result.reason instanceof TtsProviderError ? result.reason.code : 'external-upstream-failed' }] : []),
  }
}

export async function discover(profile, transport = fetch, signal = AbortSignal.timeout(20000)) {
  if (profile.protocol === 'elevenlabs') {
    const results = await Promise.allSettled([
      catalogJson(profile, 'models', signal, transport).then(rows => {
        if (!Array.isArray(rows)) return fail('external-response-invalid')
        return catalogRows(rows.filter(row => row.can_do_text_to_speech === true), 'model_id', 'name')
      }), accountVoices(profile, signal, transport),
    ])
    return discoveryResult(results, ['models', 'voices'])
  }
  if (profile.protocol === 'fish') {
    const result = discoveryResult(await Promise.allSettled([accountVoices(profile, signal, transport)]), ['voices'])
    // Fish's /model lists voice references, not the model IDs required by its TTS header.
    return { ...result, models: preset('fish').models }
  }
  if (profile.protocol === 'siliconflow') {
    const results = await Promise.allSettled([catalogJson(profile, 'models', signal, transport).then(value => {
      if (!Array.isArray(value.data)) return fail('external-response-invalid')
      return catalogRows(value.data.filter(row => typeof row?.id === 'string' && /tts|speech-|cosyvoice|moss-ttsd/iu.test(row.id)), 'id', 'name')
    })])
    return discoveryResult(results, ['models'])
  }
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
  return discoveryResult(results, ['models', 'voices'])
}
