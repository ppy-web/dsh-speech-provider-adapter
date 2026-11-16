import assert from 'node:assert/strict'
import test from 'node:test'
import { preset, synthesize, streamPcm, discover } from '../protocols.mjs'
import { normalizeConfig, catalog } from '../store.mjs'
import { createProvider } from '../index.mjs'

const profile = { ...preset('inworld'), id: 'inworld', apiKey: 'encoded-key' }
const pcm = Buffer.from([1, 0, 2, 0, 3, 0])
const json = value => new Response(JSON.stringify(value))
const signal = () => new AbortController().signal

test('Inworld complete audio uses Basic authentication, selected voice and model, and correct formats', async () => {
  for (const format of ['wav', 'mp3']) {
    const output = format === 'wav' ? pcm : Buffer.from('ID3test')
    const result = await synthesize(profile, { text: '你好', format, speechInstruction: 'speak softly', signal: signal() }, async (url, init) => {
      assert.equal(url, 'https://api.inworld.ai/tts/v1/voice')
      assert.equal(init.headers.authorization, 'Basic encoded-key')
      assert.deepEqual(JSON.parse(init.body), { text: '[speak softly] 你好', voiceId: 'Ashley', modelId: 'inworld-tts-2', audioConfig: { audioEncoding: format === 'wav' ? 'PCM' : 'MP3', sampleRateHertz: 24000 } })
      return json({ audioContent: output.toString('base64') })
    })
    assert.deepEqual(format === 'wav' ? result.data.subarray(44) : result.data, output)
    if (format === 'wav') assert.equal(result.data.readUInt32LE(24), 24000)
  }
  await assert.rejects(synthesize(profile, { text: 'x'.repeat(2001), format: 'wav', signal: signal() }), { code: 'text-too-long' })
  await assert.rejects(synthesize(profile, { text: 'hello', format: 'wav', model: 'inworld-tts-2-flash', speechInstruction: 'softly', signal: signal() }), { code: 'external-option-unsupported' })
  await assert.rejects(synthesize(profile, { text: 'hello', format: 'wav', signal: signal() }, async () => json({ audioContent: '!!!' })), { code: 'invalid-audio-format' })
})

test('Inworld streams split NDJSON records and reports in-band errors', async () => {
  const records = JSON.stringify({ result: { audioContent: pcm.subarray(0, 2).toString('base64') } }) + '\n' + JSON.stringify({ result: { audioContent: pcm.subarray(2).toString('base64') } })
  const transport = async (url, init) => {
    assert.equal(url, 'https://api.inworld.ai/tts/v1/voice:stream')
    assert.equal(init.headers.authorization, 'Basic encoded-key')
    return new Response(new ReadableStream({ start(c) { const bytes = new TextEncoder().encode(records); c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17)); c.close() } }))
  }
  const chunks = []
  for await (const chunk of streamPcm(profile, { text: 'Hi', signal: signal() }, transport)) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), pcm)
  await assert.rejects(async () => { for await (const _ of streamPcm(profile, { text: 'Hi', signal: signal() }, async () => new Response('{"error":{"code":13}}\n'))) {} }, { code: 'external-upstream-failed' })
})

test('Inworld cancellation releases the reader', async () => {
  const controller = new AbortController()
  let canceled = false
  const transport = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ result: { audioContent: pcm.toString('base64') } }) + '\n')) }, cancel() { canceled = true } }))
  await assert.rejects(async () => { for await (const _ of streamPcm(profile, { text: 'Hi', signal: controller.signal }, transport)) controller.abort() }, { name: 'AbortError' })
  assert.equal(canceled, true)
})

test('Inworld discovers paginated workspace voices without treating presets as an authenticated connection', async () => {
  const result = await discover(profile, async (url, init) => {
    assert.equal(init.headers.authorization, 'Basic encoded-key')
    const target = new URL(url)
    assert.equal(target.pathname, '/voices/v1/voices')
    return target.searchParams.has('pageToken') ? json({ voices: [{ voiceId: 'custom', displayName: 'Custom' }] }) : json({ voices: [{ voiceId: 'Ashley', displayName: 'Ashley' }], nextPageToken: 'next' })
  })
  assert.equal(result.connected, true)
  assert.deepEqual(result.voices.map(x => x.id), ['Ashley', 'custom'])
  const rejected = await discover(profile, async () => new Response('', { status: 401 }))
  assert.equal(rejected.connected, false)
  assert.equal(rejected.errors[0].code, 'api-key-rejected')
})

test('Inworld profile exposes correct model capabilities and conservative maximum', () => {
  const state = normalizeConfig({ profiles: [profile], activeId: 'inworld', takeoverEnabled: true })
  assert.equal(catalog(state.profiles[0]).find(x => x.id === 'inworld-tts-2').speechInstruction, true)
  assert.equal(catalog(state.profiles[0]).find(x => x.id === 'inworld-tts-2-flash').speechInstruction, false)
  state.profiles[0].maxTextLength = 10000
  const provider = createProvider({ state, active: () => state.profiles[0] })
  assert.equal(provider.getSnapshot().maxTextLength, 2000)
})
