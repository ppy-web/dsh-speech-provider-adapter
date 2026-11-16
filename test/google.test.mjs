import assert from 'node:assert/strict'
import test from 'node:test'
import { preset, synthesize, streamPcm, discover, pcmWav } from '../protocols.mjs'
import { normalizeConfig, catalog } from '../store.mjs'
import { createProvider } from '../index.mjs'

const profile = { ...preset('google'), id: 'google', apiKey: 'test-key' }
const signal = () => new AbortController().signal
const json = value => new Response(JSON.stringify(value))
const wav = pcmWav(Buffer.from([1, 0, 2, 0]))

test('Google Cloud TTS sends the configured voice and language, credentials and output format', async () => {
  for (const format of ['wav', 'mp3']) {
    const audio = format === 'wav' ? wav : Buffer.from('ID3test')
    const result = await synthesize(profile, { text: '你好', format, signal: signal() }, async (url, init) => {
      assert.equal(url, 'https://texttospeech.googleapis.com/v1/text:synthesize')
      assert.equal(init.headers['x-goog-api-key'], 'test-key')
      assert.equal(init.headers.authorization, undefined)
      assert.deepEqual(JSON.parse(init.body), { input: { text: '你好' }, voice: { languageCode: 'cmn-CN', name: 'cmn-CN-Standard-A' }, audioConfig: { audioEncoding: format === 'wav' ? 'LINEAR16' : 'MP3', sampleRateHertz: 24000 } })
      return json({ audioContent: audio.toString('base64') })
    })
    assert.deepEqual(result.data, audio)
    assert.equal(result.format, format)
  }
  await synthesize({ ...profile, apiKey: 'Bearer oauth-test' }, { text: 'hello', format: 'wav', signal: signal() }, async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer oauth-test')
    assert.equal(init.headers['x-goog-api-key'], undefined)
    return json({ audioContent: wav.toString('base64') })
  })
})

test('Google voice discovery requests Chinese languages and preserves language and voice IDs', async () => {
  const requests = []
  const result = await discover(profile, async (url, init) => {
    const target = new URL(url)
    assert.equal(target.pathname, '/v1/voices')
    assert.equal(init.headers['x-goog-api-key'], 'test-key')
    const language = target.searchParams.get('languageCode')
    requests.push(language)
    return json(language === 'zh'
      ? { voices: [{ name: 'voice-one', languageCodes: ['cmn-CN', 'en-US'] }, { name: 'voice-one', languageCodes: ['cmn-CN'] }] }
      : { voices: [{ name: 'voice-two', languageCodes: ['yue-HK'] }] })
  })
  assert.deepEqual(requests.sort(), ['yue', 'zh'])
  assert.equal(result.connected, true)
  assert.deepEqual(result.voices.map(x => x.id), ['cmn-CN/voice-one', 'yue-HK/voice-two'])
  const bad = await discover(profile, async () => new Response('', { status: 401 }))
  assert.equal(bad.connected, false)
  assert.equal(bad.errors[0].code, 'api-key-rejected')
})

test('Google rejects overlong content, malformed output and unsupported streaming without sending a request', async () => {
  const never = () => { throw new Error('unexpected request') }
  await assert.rejects(synthesize(profile, { text: '中'.repeat(1667), format: 'wav', signal: signal() }, never), { code: 'text-too-long' })
  await assert.rejects(synthesize(profile, { text: 'hi', voice: 'invalid', format: 'wav', signal: signal() }, never), { code: 'external-selection-invalid' })
  await assert.rejects(synthesize(profile, { text: 'hi', format: 'wav', signal: signal() }, async () => json({ audioContent: Buffer.from('not wav').toString('base64') })), { code: 'invalid-audio-format' })
  await assert.rejects(async () => { for await (const _ of streamPcm(profile, { text: 'hi', signal: signal() }, never)) {} }, { code: 'external-streaming-unsupported' })
})

test('Google provider advertises synchronous playback and a conservative character limit', () => {
  const state = normalizeConfig({ profiles: [profile], activeId: 'google', takeoverEnabled: true })
  state.profiles[0].maxTextLength = 10000
  state.profiles[0].streaming = true
  const model = catalog(state.profiles[0])[0]
  assert.equal(model.streaming, false)
  assert.equal(model.speechInstruction, false)
  const provider = createProvider({ state, active: () => state.profiles[0] })
  assert.equal(provider.getSnapshot().maxTextLength, 1250)
})

test('Google forwards cancellation and releases the response reader', async () => {
  const controller = new AbortController()
  let cancelled = false
  const transport = async (_url, init) => {
    assert.equal(init.signal, controller.signal)
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); controller.abort() }, cancel() { cancelled = true } }))
  }
  await assert.rejects(synthesize(profile, { text: 'hello', format: 'wav', signal: controller.signal }, transport), { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('Google service and billing errors expose safe actionable codes without upstream text', async () => {
  for (const [reason, expected] of [['API_KEY_SERVICE_BLOCKED', 'google-service-blocked'], ['SERVICE_DISABLED', 'google-service-blocked'], ['BILLING_DISABLED', 'google-billing-disabled']]) {
    const transport = async () => new Response(JSON.stringify({ error: { message: 'private upstream details', details: [{ reason }] } }), { status: 403 })
    const result = await discover(profile, transport)
    assert.equal(result.connected, false)
    assert.deepEqual(result.errors, [{ kind: 'voices', code: expected }])
    await assert.rejects(synthesize(profile, { text: 'hello', format: 'wav', signal: signal() }, transport), { code: expected })
  }
})
