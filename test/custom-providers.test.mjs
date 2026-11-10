import assert from 'node:assert/strict'
import test from 'node:test'
import { preset, synthesize, streamPcm, discover, modelFeatures, pcmWav } from '../protocols.mjs'
import { normalizeConfig } from '../store.mjs'
import { credentialsReady } from '../cloud-providers.mjs'
import { createProvider } from '../index.mjs'

const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
const signal = () => new AbortController().signal
const profile = extra => {
  const base = preset('custom')
  return { ...base, id: 'custom', ...extra, custom: { ...base.custom, ...(extra?.custom ?? {}) } }
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

test('custom preset normalizes without an API key and exposes one audio format', () => {
  const saved = normalizeConfig({ profiles: [profile()], activeId: 'custom', takeoverEnabled: true })
  assert.equal(saved.profiles[0].custom.audioFormat, 'wav')
  assert.equal(saved.profiles[0].custom.response, 'binary')
  assert.equal(credentialsReady(saved.profiles[0]), true)
  const mono = createProvider({ active: () => saved.profiles[0], state: { profiles: [{ id: 'custom', name: 'custom' }] }, revision: 1 })
  assert.deepEqual(mono.getSnapshot().formats, ['wav'])
  assert.equal(mono.getSnapshot().ready, true)
  const mp3 = profile({ custom: { audioFormat: 'mp3' } })
  const mp3Provider = createProvider({ active: () => mp3, state: { profiles: [{ id: 'custom', name: 'custom' }] }, revision: 1 })
  assert.deepEqual(mp3Provider.getSnapshot().formats, ['mp3'])
})

test('custom config rejects unsafe or malformed request settings before persistence', () => {
  const bad = [
    profile({ custom: { method: 'PUT' } }),
    profile({ custom: { headers: [{ name: 'X-Test', value: 'a\r\nb' }] } }),
    profile({ custom: { headers: [{ name: 'Host', value: 'x' }] } }),
    profile({ custom: { body: { input: '{{unknown}}' } } }),
    profile({ custom: { body: [] } }),
    profile({ custom: { audioFormat: 'ogg' } }),
    profile({ custom: { path: 'http://evil.test/x' } }),
    profile({ custom: { path: '//evil.test/x' } }),
    profile({ custom: { sampleRate: 96000 } }),
    profile({ custom: { bodyType: 'xml' } }),
  ]
  for (const value of bad) assert.throws(() => normalizeConfig({ profiles: [value], activeId: 'custom', takeoverEnabled: false }), { code: 'adapter-config-invalid' })
})

test('custom binary PCM is wrapped as WAV at the configured sample rate', async () => {
  const p = profile({ apiKey: 'secret', custom: { audioFormat: 'pcm', sampleRate: 16000, response: 'binary' } })
  const calls = []
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(pcm) }
  const result = await synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, transport)
  assert.equal(result.format, 'wav')
  assert.equal(result.data.toString('ascii', 8, 12), 'WAVE')
  assert.equal(result.data.readUInt32LE(24), 16000)
  assert.deepEqual(result.data.subarray(44), pcm)
  assert.equal(calls[0].url, 'http://127.0.0.1:8880/v1/audio/speech')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
  assert.equal(calls[0].body.input, 'hi')
  assert.equal(calls[0].body.voice, 'default')
  assert.equal(calls[0].body.response_format, 'pcm')
})

test('custom WAV and MP3 responses pass through with format validation', async () => {
  const wav = await synthesize(profile({ custom: { audioFormat: 'wav' } }), { text: 'hi', format: 'wav', signal: signal() }, async () => new Response(pcmWav(pcm)))
  assert.equal(wav.data.toString('ascii', 8, 12), 'WAVE')
  const mp3 = await synthesize(profile({ custom: { audioFormat: 'mp3' } }), { text: 'hi', format: 'mp3', signal: signal() }, async () => new Response(Buffer.from('ID3mp3')))
  assert.equal(mp3.data.toString(), 'ID3mp3')
  await assert.rejects(synthesize(profile({ custom: { audioFormat: 'wav' } }), { text: 'hi', format: 'wav', signal: signal() }, async () => new Response(Buffer.from('ID3mp3'))), { code: 'invalid-audio-format' })
})

test('custom JSON responses extract Base64 and hex audio at the configured path', async () => {
  const wav = pcmWav(pcm)
  const base64 = profile({ custom: { response: 'json-base64', audioPath: 'result.audio.data' } })
  const first = await synthesize(base64, { text: 'hi', format: 'wav', signal: signal() }, async () => json({ result: { audio: { data: wav.toString('base64') } } }))
  assert.equal(first.data.toString('ascii', 8, 12), 'WAVE')
  const hex = profile({ custom: { response: 'json-hex', audioPath: 'audio' } })
  const second = await synthesize(hex, { text: 'hi', format: 'wav', signal: signal() }, async () => json({ audio: wav.toString('hex') }))
  assert.equal(second.data.toString('ascii', 8, 12), 'WAVE')
  await assert.rejects(synthesize(hex, { text: 'hi', format: 'wav', signal: signal() }, async () => json({ other: 'x' })), { code: 'invalid-audio-format' })
})

test('custom template omits empty optional fields and keeps sample rate numeric', async () => {
  const p = profile({ apiKey: '', custom: { audioFormat: 'pcm', sampleRate: 22050, body: { model: '{{model}}', input: '{{text}}', voice: '{{voice}}', instructions: '{{instruction}}', rate: '{{sampleRate}}' } } })
  let body, headers
  await synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, async (_url, init) => { body = JSON.parse(init.body); headers = init.headers; return new Response(pcm) })
  assert.equal(body.voice, 'default')
  assert.equal('instructions' in body, false)
  assert.equal(body.rate, 22050)
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers['content-type'], 'application/json')
})

test('custom headers render placeholders including the API key', async () => {
  const p = profile({ apiKey: 'k', custom: { headers: [{ name: 'X-Key', value: '{{apiKey}}' }, { name: 'X-Model', value: 'm-{{model}}' }] } })
  let headers
  await synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, async (_url, init) => { headers = init.headers; return new Response(pcmWav(pcm)) })
  assert.equal(headers['X-Key'], 'k')
  assert.equal(headers['X-Model'], 'm-tts-1')
  assert.equal(headers['content-type'], 'application/json')
})

test('custom form bodies are URL-encoded with a form content type', async () => {
  const p = profile({ apiKey: '', custom: { bodyType: 'form', response: 'json-base64', audioPath: 'audio_base64', body: { text: '{{text}}', demo_id: '{{voice}}', instructions: '{{instruction}}' } } })
  let init
  const wav = pcmWav(pcm).toString('base64')
  await synthesize(p, { text: '你好 世界', format: 'wav', signal: signal() }, async (_url, options) => { init = options; return json({ audio_base64: wav }) })
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded')
  const params = new URLSearchParams(init.body)
  assert.equal(params.get('text'), '你好 世界')
  assert.equal(params.get('demo_id'), 'default')
  assert.equal(params.get('instructions'), null)
})

test('custom GET requests map the template into the query string', async () => {
  const p = profile({ custom: { method: 'GET', body: { q: '{{text}}', voice: '{{voice}}' } } })
  let url
  await synthesize(p, { text: 'hello world', format: 'wav', signal: signal() }, async (target) => { url = new URL(String(target)); return new Response(pcmWav(pcm)) })
  assert.equal(url.searchParams.get('q'), 'hello world')
  assert.equal(url.searchParams.get('voice'), 'default')
})

test('custom maps upstream failures and rejects JSON for binary responses', async () => {
  const p = profile()
  await assert.rejects(synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, async () => new Response('', { status: 401 })), { code: 'api-key-rejected' })
  await assert.rejects(synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, async () => new Response('', { status: 429 })), { code: 'rate-limited' })
  await assert.rejects(synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, async () => new Response('', { status: 500 })), { code: 'external-upstream-failed' })
  await assert.rejects(synthesize(p, { text: 'hi', format: 'wav', signal: signal() }, async () => new Response('{}', { headers: { 'content-type': 'application/json' } })), { code: 'external-response-invalid' })
})

test('custom PCM binary streams ordered chunks and releases the reader on cancellation', async () => {
  const p = profile({ custom: { audioFormat: 'pcm', sampleRate: 24000, response: 'binary' } })
  const controller = new AbortController()
  let cancelled = false
  const transport = async (_url, init) => {
    assert.equal(init.signal, controller.signal)
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(pcm.subarray(0, 3)); stream.enqueue(pcm.subarray(3)) }, cancel() { cancelled = true } }))
  }
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of streamPcm(p, { text: 'hi', signal: controller.signal }, transport)) { chunks.push(Buffer.from(chunk)); controller.abort() }
  }, { name: 'AbortError' })
  assert.deepEqual(Buffer.concat(chunks), pcm)
  assert.equal(cancelled, true)
})

test('custom streaming is unsupported for JSON or non-24k PCM responses', async () => {
  for (const custom of [{ audioFormat: 'wav' }, { response: 'json-base64' }, { audioFormat: 'pcm', sampleRate: 16000 }]) {
    const p = profile({ custom })
    await assert.rejects(async () => {
      for await (const _ of streamPcm(p, { text: 'hi', signal: signal() }, async () => new Response(''))) { /* unreachable */ }
    }, { code: 'external-streaming-unsupported' })
  }
})

test('custom has no catalog API and capabilities follow the response format', async () => {
  const result = await discover(profile())
  assert.equal(result.connected, false)
  assert.deepEqual(result.errors.map(item => item.kind).sort(), ['models', 'voices'])
  const pcmProfile = profile({ custom: { audioFormat: 'pcm', sampleRate: 24000 } })
  assert.equal(modelFeatures('custom', { id: 'm' }, pcmProfile).streaming, true)
  assert.equal(modelFeatures('custom', { id: 'm' }, profile({ custom: { audioFormat: 'wav' } })).streaming, false)
  assert.equal(modelFeatures('custom', { id: 'm', speechInstruction: true }, pcmProfile).speechInstruction, true)
})
