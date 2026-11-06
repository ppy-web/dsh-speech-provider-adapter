import assert from 'node:assert/strict'
import test from 'node:test'
import { preset, endpoint, synthesize, streamPcm, discover } from '../protocols.mjs'
import { normalizeConfig } from '../store.mjs'

const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
test('provider API versions retain reverse-proxy prefixes without duplicating /v1', () => {
  assert.equal(endpoint('https://example.test/proxy/v1', 'voices?page_size=100', 'v2'), 'https://example.test/proxy/v2/voices?page_size=100')
  assert.equal(endpoint('https://example.test/proxy/v1', 'model', ''), 'https://example.test/proxy/model')
})
function profile(protocol) {
  const value = { ...preset(protocol), id: protocol, apiKey: 'private-test-key' }
  if (protocol === 'fish') { value.voices = [{ id: 'my-reference-voice', name: 'My voice' }]; value.selection.voice = value.voices[0].id }
  return value
}

for (const protocol of ['siliconflow', 'elevenlabs', 'fish']) {
  test(`${protocol}: complete WAV/MP3 use provider-specific credentials and format parameters`, async () => {
    const p = profile(protocol)
    const signal = new AbortController().signal
    const calls = []
    const transport = async (url, init) => {
      assert.equal(init.signal, signal)
      assert.equal(init.redirect, 'error')
      const body = JSON.parse(init.body)
      calls.push({ url: new URL(url), body, headers: init.headers })
      const format = protocol === 'elevenlabs' ? new URL(url).searchParams.get('output_format') : body.response_format ?? body.format
      return new Response(format.startsWith('pcm') ? pcm : Buffer.from('ID3test'))
    }
    const wav = await synthesize(p, { text: 'Hello', format: 'wav', signal }, transport)
    assert.equal(wav.data.toString('ascii', 8, 12), 'WAVE')
    assert.equal(wav.data.readUInt32LE(24), 24000)
    assert.equal(wav.data.readUInt16LE(22), 1)
    assert.equal(wav.data.readUInt16LE(34), 16)
    assert.deepEqual(wav.data.subarray(44), pcm)
    const mp3 = await synthesize(p, { text: 'Hello', format: 'mp3', signal }, transport)
    assert.equal(mp3.data.toString(), 'ID3test')
    const { url, body, headers } = calls[0]
    if (protocol === 'elevenlabs') {
      assert.equal(headers['xi-api-key'], p.apiKey)
      assert.equal(headers.authorization, undefined)
      assert.equal(url.pathname, `/v1/text-to-speech/${p.selection.voice}`)
      assert.equal(url.searchParams.get('output_format'), 'pcm_24000')
      assert.equal(body.model_id, p.selection.model)
    } else {
      assert.equal(headers.authorization, `Bearer ${p.apiKey}`)
      assert.equal(body.sample_rate, 24000)
      assert.equal(url.pathname, protocol === 'fish' ? '/v1/tts' : '/v1/audio/speech')
      assert.equal(protocol === 'fish' ? headers.model : body.model, p.selection.model)
      assert.equal(protocol === 'fish' ? body.reference_id : body.voice, p.selection.voice)
    }
  })

  test(`${protocol}: PCM chunks remain ordered and cancellation releases the response reader`, async () => {
    const controller = new AbortController()
    let cancelled = false
    const transport = async (_url, init) => {
      assert.equal(init.signal, controller.signal)
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(pcm.subarray(0, 3)); stream.enqueue(pcm.subarray(3)) }, cancel() { cancelled = true } }))
    }
    await assert.rejects(async () => {
      for await (const bytes of streamPcm(profile(protocol), { text: 'Hello', signal: controller.signal }, transport)) {
        assert.deepEqual(Buffer.from(bytes), pcm)
        controller.abort()
      }
    }, { name: 'AbortError' })
    assert.equal(cancelled, true)
  })
}

test('SiliconFlow maps speech instructions into its documented input prefix', async () => {
  await synthesize(profile('siliconflow'), { text: 'Hello', format: 'wav', speechInstruction: 'Speak happily', signal: new AbortController().signal }, async (_url, init) => {
    assert.equal(JSON.parse(init.body).input, 'Speak happily<|endofprompt|>Hello')
    assert.equal(JSON.parse(init.body).instructions, undefined)
    return new Response(pcm)
  })
})

test('ElevenLabs discovers only TTS models and follows account voice pagination at v2', async () => {
  const result = await discover(profile('elevenlabs'), async (url, init) => {
    assert.equal(init.headers['xi-api-key'], 'private-test-key')
    const endpoint = new URL(url)
    if (endpoint.pathname === '/v1/models') return json([{ model_id: 'tts-model', can_do_text_to_speech: true }, { model_id: 'stt-model', can_do_text_to_speech: false }])
    assert.equal(endpoint.pathname, '/v2/voices')
    return endpoint.searchParams.has('next_page_token') ? json({ voices: [{ voice_id: 'second', name: 'Second' }], has_more: false })
      : json({ voices: [{ voice_id: 'first', name: 'First' }], has_more: true, next_page_token: 'next' })
  })
  assert.deepEqual(result.models.map(row => row.id), ['tts-model'])
  assert.deepEqual(result.voices.map(row => row.id), ['first', 'second'])
  assert.equal(result.connected, true)
})

test('Fish voice references remain distinct from synthesis models; static models cannot validate a rejected key', async () => {
  const p = profile('fish')
  const result = await discover(p, async url => {
    const endpoint = new URL(url)
    assert.equal(endpoint.pathname, '/model')
    assert.equal(endpoint.searchParams.get('self'), 'true')
    return json({ items: [{ _id: 'workspace-reference', title: 'My voice' }], total: 1, has_more: false })
  })
  assert.equal(result.voices[0].id, 'workspace-reference')
  assert.ok(result.models.every(model => model.id !== 'workspace-reference'))
  const rejected = await discover(p, async () => new Response('', { status: 401 }))
  assert.equal(rejected.connected, false)
  assert.equal(rejected.errors[0].code, 'api-key-rejected')
  const empty = { ...preset('fish'), id: 'fish' }
  const saved = normalizeConfig({ profiles: [empty], activeId: 'fish', takeoverEnabled: false })
  assert.equal(saved.profiles[0].selection.voice, '')
})

test('binary protocols reject compressed audio when PCM was requested', async () => {
  for (const protocol of ['siliconflow', 'elevenlabs', 'fish']) await assert.rejects(synthesize(profile(protocol), {
    text: 'Hello', format: 'wav', signal: new AbortController().signal,
  }, async () => new Response('ID3compressed', { headers: { 'content-type': 'audio/mpeg' } })), { code: 'invalid-audio-format' })
})
