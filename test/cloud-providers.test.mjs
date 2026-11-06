import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preset, synthesize, streamPcm, discover, pcmWav } from '../protocols.mjs'
import { AdapterStore, normalizeConfig, catalog } from '../store.mjs'
import { createProvider } from '../index.mjs'

const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
const signal = () => new AbortController().signal
const profile = protocol => ({ ...preset(protocol), id: protocol, apiKey: 'private-key',
  ...(protocol === 'tencent' ? { secretId: 'private-id' } : { baseURL: 'https://workspace.cn-beijing.maas.aliyuncs.com' }) })
const configuration = p => ({ profiles: [p], activeId: p.id, takeoverEnabled: true })
const event = (audio = '', finish = null) => `data: ${JSON.stringify({ output: { finish_reason: finish, audio: { data: audio, url: 'https://never-fetch.test/audio.wav?secret=signed' } } })}\r\n\r\n`
const streamResponse = text => {
  const bytes = Buffer.from(text)
  return new Response(new ReadableStream({ start(controller) {
    // Split UTF-8, CRLF boundaries and JSON across arbitrary network chunks.
    for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.subarray(index, index + 17))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}

test('Bailian sends native workspace SSE parameters and produces ordered PCM, WAV and MP3 without fetching final URLs', async () => {
  const p = profile('aliyun')
  for (const format of ['wav', 'mp3', 'pcm']) {
    let calls = 0
    const requestSignal = signal()
    const transport = async (url, init) => {
      calls++
      assert.equal(url, `${p.baseURL}/api/v1/services/audio/tts/SpeechSynthesizer`)
      assert.equal(init.signal, requestSignal)
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, `Bearer ${p.apiKey}`)
      assert.equal(init.headers['x-dashscope-sse'], 'enable')
      const body = JSON.parse(init.body)
      assert.equal(body.model, p.selection.model)
      assert.equal(body.input.voice, p.selection.voice)
      assert.equal(body.input.text, '你好')
      assert.equal(body.input.format, format === 'mp3' ? 'mp3' : 'pcm')
      assert.equal(body.input.sample_rate, 24000)
      assert.equal(body.input.rate, 1)
      assert.equal(body.input.instruction, '温柔地说')
      const audio = format === 'mp3' ? Buffer.from('ID3example') : pcm
      return streamResponse(event(audio.subarray(0, 3).toString('base64')) + event(audio.subarray(3).toString('base64')) + event('', 'stop'))
    }
    const request = { text: '你好', signal: requestSignal, speechInstruction: '温柔地说' }
    if (format === 'pcm') {
      const chunks = []
      for await (const chunk of streamPcm(p, request, transport)) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), pcm)
    } else {
      const result = await synthesize(p, { ...request, format }, transport)
      assert.equal(result.format, format)
      if (format === 'wav') {
        assert.equal(result.data.readUInt32LE(24), 24000)
        assert.equal(result.data.readUInt16LE(22), 1)
        assert.equal(result.data.readUInt16LE(34), 16)
        assert.deepEqual(result.data.subarray(44), pcm)
      } else assert.equal(result.data.toString(), 'ID3example')
    }
    assert.equal(calls, 1, 'the signed complete-audio URL must never be fetched')
  }
})

test('Bailian normalizes /api/v1 roots and rejects incomplete, oversized and invalid streams', async () => {
  const p = { ...profile('aliyun'), baseURL: 'https://example.test/proxy/api/v1/' }
  for (const [body, code] of [
    [event(pcm.toString('base64')), 'external-stream-incomplete'],
    [event('@@==') + event('', 'stop'), 'invalid-audio-format'],
    [event(Buffer.from('RIFF').toString('base64')) + event('', 'stop'), 'invalid-audio-format'],
    [event(Buffer.from([1]).toString('base64')) + event('', 'stop'), 'external-stream-incomplete'],
    [`data: ${'x'.repeat(2 * 1024 * 1024 + 1)}\n\n`, 'stream-buffer-limit'],
    ['data: {"code":"InvalidApiKey","message":"private upstream details"}\n\n', 'api-key-rejected'],
  ]) {
    await assert.rejects(synthesize(p, { text: 'Hi', format: 'wav', signal: signal() }, async url => {
      assert.equal(url, 'https://example.test/proxy/api/v1/services/audio/tts/SpeechSynthesizer')
      return streamResponse(body)
    }), error => error.code === code && !error.message.includes('private'))
  }
})

test('Bailian aborting after the first PCM chunk cancels the reader and does not yield queued audio', async () => {
  const controller = new AbortController()
  let cancelled = false
  let count = 0
  const response = new Response(new ReadableStream({ start(stream) {
    stream.enqueue(Buffer.from(event(pcm.toString('base64')) + event(pcm.toString('base64')) + event('', 'stop')))
  }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(async () => {
    for await (const chunk of streamPcm(profile('aliyun'), { text: 'Hi', signal: controller.signal }, async () => response)) {
      assert.deepEqual(chunk, pcm)
      count++
      controller.abort()
    }
  }, { name: 'AbortError' })
  assert.equal(count, 1)
  assert.equal(cancelled, true)
})

test('Tencent signs its transmitted body with TC3 and preserves native 16 kHz WAV and MP3', async () => {
  const p = profile('tencent')
  const wav = pcmWav(pcm)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28)
  for (const format of ['wav', 'mp3']) {
    const requestSignal = signal()
    const bytes = format === 'wav' ? wav : Buffer.from('ID3example')
    const result = await synthesize(p, { text: '你好', format, signal: requestSignal }, async (url, init) => {
      assert.equal(url, 'https://tts.tencentcloudapi.com/')
      assert.equal(init.signal, requestSignal)
      assert.equal(init.redirect, 'error')
      const body = JSON.parse(init.body)
      assert.equal(body.Text, '你好')
      assert.ok(body.SessionId)
      assert.equal(body.ModelType, 1)
      assert.equal(body.VoiceType, Number(p.selection.voice))
      assert.equal(body.SampleRate, 16000)
      assert.equal(body.Codec, format)
      assert.equal(body.Speed, 0)
      assert.equal(body.Volume, 0)
      const headers = init.headers
      assert.equal(headers['x-tc-action'], 'TextToVoice')
      assert.equal(headers['x-tc-version'], '2019-08-23')
      const timestamp = Number(headers['x-tc-timestamp'])
      const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
      const sha = value => createHash('sha256').update(value).digest('hex')
      const sign = (key, text) => createHmac('sha256', key).update(text).digest()
      const names = ['content-type', 'host', 'x-tc-action']
      const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().toLowerCase()}\n`).join('')
      const canonicalRequest = ['POST', '/', '', canonicalHeaders, names.join(';'), sha(init.body)].join('\n')
      const scope = `${date}/tts/tc3_request`
      const key = sign(sign(sign(`TC3${p.apiKey}`, date), 'tts'), 'tc3_request')
      const signature = sign(key, ['TC3-HMAC-SHA256', String(timestamp), scope, sha(canonicalRequest)].join('\n')).toString('hex')
      assert.equal(headers.authorization, `TC3-HMAC-SHA256 Credential=${p.secretId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`)
      return new Response(JSON.stringify({ Response: { Audio: bytes.toString('base64') } }))
    })
    assert.deepEqual(result.data, bytes)
    assert.equal(result.format, format)
  }
})

test('Tencent refuses unsupported streaming, options, voice cloning and oversized text before requesting synthesis', async () => {
  const p = profile('tencent')
  const neverFetch = async () => assert.fail('unsupported input must not call paid synthesis')
  for (const [overrides, code] of [
    [{ speechInstruction: 'happy' }, 'external-option-unsupported'],
    [{ model: 'other' }, 'external-selection-invalid'],
    [{ voice: '200000000' }, 'external-selection-invalid'],
    [{ text: '你'.repeat(151) }, 'text-too-long'],
    [{ format: 'ogg' }, 'audio-format-unsupported'],
  ]) await assert.rejects(synthesize(p, { text: 'Hi', format: 'wav', signal: signal(), ...overrides }, neverFetch), { code })
  await assert.rejects(async () => { for await (const _ of streamPcm(p, { text: 'Hi', signal: signal() }, neverFetch)) {} }, { code: 'external-streaming-unsupported' })
  for (const [upstream, code] of [['AuthFailure.SignatureFailure', 'api-key-rejected'], ['RequestLimitExceeded', 'rate-limited'], ['FailedOperation.NoFreeAccount', 'external-quota-exceeded']]) {
    await assert.rejects(synthesize(p, { text: 'Hi', format: 'wav', signal: signal() }, async () => new Response(JSON.stringify({ Response: { Error: { Code: upstream, Message: p.apiKey } } }))),
      error => error.code === code && !error.message.includes(p.apiKey))
  }
})

test('Tencent cancellation releases a late response without returning audio', async () => {
  const controller = new AbortController()
  let cancelled = false
  await assert.rejects(synthesize(profile('tencent'), { text: 'Hi', format: 'wav', signal: controller.signal }, async () => {
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('{"Response":{}')) }, cancel() { cancelled = true } }))
    controller.abort()
    return response
  }), { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('cloud credentials and capability snapshots preserve secret masking and manual catalogs never imply authenticated connectivity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cloud-providers-'))
  try {
    const store = new AdapterStore(join(dir, 'providers.json'))
    const p = profile('tencent')
    p.streaming = true; p.maxTextLength = 500
    p.models[0].streaming = true; p.models[0].speechInstruction = true
    await store.save(configuration(p), 0)
    const state = store.publicState()
    assert.equal(state.profiles[0].apiKey, undefined)
    assert.equal(state.profiles[0].secretId, undefined)
    assert.equal(state.profiles[0].keyConfigured, true)
    assert.equal(state.profiles[0].secretIdConfigured, true)
    await store.save(state, store.revision)
    assert.equal(store.active().apiKey, p.apiKey)
    assert.equal(store.active().secretId, p.secretId)
    const provider = createProvider(store)
    assert.equal(provider.getSnapshot().ready, true)
    assert.equal(provider.getSnapshot().maxTextLength, 150)
    assert.equal(catalog(store.active())[0].streaming, false)
    assert.equal(catalog(store.active())[0].speechInstruction, false)
    assert.equal(JSON.stringify(provider.getSnapshot()).includes(p.secretId), false)
    await store.save({ ...store.publicState(), profiles: [{ ...store.publicState().profiles[0], secretId: '' }] }, store.revision)
    assert.equal(provider.getSnapshot().ready, false)
    const aliyun = { ...preset('aliyun'), id: 'aliyun', apiKey: p.apiKey }
    store.state = normalizeConfig(configuration(aliyun))
    assert.equal(provider.getSnapshot().ready, false, 'a placeholder workspace cannot be ready')
    for (const protocol of ['aliyun', 'tencent']) {
      const result = await discover(profile(protocol), async () => assert.fail('catalog probes must not generate speech'))
      assert.equal(result.connected, false)
      assert.ok(result.errors.every(error => error.code === 'external-catalog-unavailable'))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
