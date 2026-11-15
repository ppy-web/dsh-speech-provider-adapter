import assert from 'node:assert/strict'
import test from 'node:test'
import { preset, synthesize, streamPcm, discover } from '../protocols.mjs'
import { normalizeConfig } from '../store.mjs'
import { createProvider } from '../index.mjs'

const pcm = Buffer.from([1, 0, 2, 0, 3, 0])
const profile = () => ({ ...preset('deepseek'), id: 'ds', apiKey: 'test-key' })

test('DeepSeek sends documented requests and returns WAV and PCM', async () => {
  const p = profile(), signal = new AbortController().signal
  const transport = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/tts')
    assert.equal(init.signal, signal)
    assert.equal(init.headers.authorization, 'Bearer test-key')
    assert.deepEqual(JSON.parse(init.body), { text: '你好', voice_id: 'tide', format: 'pcm', filter_markdown: false })
    return new Response(pcm, { headers: { 'content-type': 'audio/pcm' } })
  }
  const wav = await synthesize(p, { text: '你好', voice: 'tide', format: 'wav', signal }, transport)
  assert.equal(wav.data.readUInt32LE(24), 24000)
  assert.deepEqual(wav.data.subarray(44), pcm)
  const chunks = []
  for await (const chunk of streamPcm(p, { text: '你好', voice: 'tide', signal }, transport)) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), pcm)
})

test('DeepSeek exposes only supported formats and does not claim catalog verification', async () => {
  const p = profile()
  const state = normalizeConfig({ profiles: [p], activeId: p.id, takeoverEnabled: true })
  const snapshot = createProvider({ state, active: () => state.profiles[0] }).getSnapshot()
  assert.deepEqual(snapshot.formats, ['wav'])
  assert.equal(snapshot.ready, true)
  assert.equal(snapshot.models[0].speechInstruction, false)
  const result = await discover(p, () => { throw new Error('unexpected request') })
  assert.equal(result.connected, false)
  assert.ok(result.errors.every(item => item.code === 'external-catalog-unavailable'))
  await assert.rejects(synthesize(p, { text: 'test', format: 'mp3', signal: AbortSignal.timeout(1000) }), { code: 'audio-format-unsupported' })
  await assert.rejects(synthesize(p, { text: '你'.repeat(5001), format: 'wav', signal: AbortSignal.timeout(1000) }), { code: 'text-too-long' })
})

test('DeepSeek streaming cancellation closes the response and propagates abort', async () => {
  const controller = new AbortController()
  let cancelled = false
  const transport = async () => new Response(new ReadableStream({ start(c) { c.enqueue(pcm) }, cancel() { cancelled = true } }))
  await assert.rejects(async () => {
    for await (const chunk of streamPcm(profile(), { text: 'hello', signal: controller.signal }, transport)) {
      assert.deepEqual(Buffer.from(chunk), pcm)
      controller.abort()
    }
  }, { name: 'AbortError' })
  assert.equal(cancelled, true)
})
