import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { preset, synthesize, streamPcm, modelFeatures, pcmWav } from '../protocols.mjs'
import { decodeDoubaoFrame } from '../native-providers.mjs'

const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
const wav = pcmWav(pcm)
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const profile = protocol => ({ ...preset(protocol), id: protocol, apiKey: 'test-key' })
const signal = () => new AbortController().signal

test('Xiaomi MiMo synthesizes WAV through chat/completions and switches to token-plan for tp- keys', async () => {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })
    return jsonResponse({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] })
  }
  const result = await synthesize(profile('xiaomi'), { text: '你好', format: 'wav', signal: signal() }, transport)
  assert.equal(result.format, 'wav')
  assert.equal(result.data.toString('ascii', 8, 12), 'WAVE')
  assert.equal(calls[0].url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(calls[0].body.model, 'mimo-v2.5-tts')
  assert.equal(calls[0].body.audio.voice, '冰糖')
  assert.equal(calls[0].auth, 'Bearer test-key')
  await synthesize({ ...profile('xiaomi'), apiKey: 'tp-abc' }, { text: 'x', format: 'wav', signal: signal() }, transport)
  assert.equal(calls[1].url, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions')
})

test('Breeze Blue synthesizes binary WAV from the fixed text-to-speech endpoint', async () => {
  let call
  const transport = async (url, init) => { call = { url, body: JSON.parse(init.body), key: init.headers['xi-api-key'] }; return new Response(wav, { headers: { 'content-type': 'audio/wav' } }) }
  const result = await synthesize(profile('breeze'), { text: '你好', format: 'wav', signal: signal() }, transport)
  assert.equal(result.data.toString('ascii', 8, 12), 'WAVE')
  assert.equal(call.url, 'https://api.breeze.blue/v1/text-to-speech/voc_rh6e8hdbraz6?output_format=wav')
  assert.equal(call.body.model_id, 'breeze-tts-2')
  assert.equal(call.key, 'test-key')
})

test('Doubao model features mark only seed-tts-2.0 as instruction-capable and both as streaming', () => {
  const models = preset('doubao').models
  assert.deepEqual(models.map(model => [model.id, modelFeatures('doubao', model).streaming, modelFeatures('doubao', model).speechInstruction]),
    [['seed-tts-2.0', true, true], ['seed-icl-2.0', true, false]])
})

const CONNECTION_EVENTS = new Set([1, 2, 50, 51, 52])
const CONNECTION_RESPONSES = new Set([50, 51, 52])
function frame(event, payloadBytes, sessionId, type) {
  const id = Buffer.from(sessionId)
  const session = !CONNECTION_EVENTS.has(event)
  const buf = Buffer.alloc(4 + 4 + (session ? 4 + id.length : 0) + (CONNECTION_RESPONSES.has(event) ? 4 : 0) + 4 + payloadBytes.length)
  buf[0] = 0x11; buf[1] = (type << 4) | 4; buf[2] = 0x10; buf[3] = 0
  buf.writeInt32BE(event, 4)
  let offset = 8
  if (session) { buf.writeUInt32BE(id.length, offset); offset += 4; id.copy(buf, offset); offset += id.length }
  if (CONNECTION_RESPONSES.has(event)) { buf.writeUInt32BE(0, offset); offset += 4 }
  buf.writeUInt32BE(payloadBytes.length, offset); payloadBytes.copy(buf, offset + 4)
  return buf
}
const control = (event, payload, sessionId) => frame(event, Buffer.from(JSON.stringify(payload)), sessionId, 9)
const audio = (sessionId, bytes) => frame(352, bytes, sessionId, 11)

async function withDoubaoServer(work) {
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    socket.on('message', raw => {
      const decoded = decodeDoubaoFrame(raw)
      if (decoded.event === 1) socket.send(control(50, { ok: true }, ''))
      else if (decoded.event === 100) socket.send(control(150, { ok: true }, decoded.sessionId))
      else if (decoded.event === 200) {
        socket.send(audio(decoded.sessionId, pcm))
        socket.send(control(152, { ok: true }, decoded.sessionId))
      } else if (decoded.event === 2) socket.send(control(52, { ok: true }, ''))
    })
  })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  try {
    const target = { ...profile('doubao'), baseURL: `ws://127.0.0.1:${httpServer.address().port}`, apiKey: 'plain-key' }
    await work(target)
  } finally {
    for (const client of wss.clients) client.terminate()
    wss.close(); httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve))
  }
}

test('Doubao bidirectional session collects PCM audio and wraps it as WAV', async () => {
  await withDoubaoServer(async target => {
    const result = await synthesize(target, { text: '你好', format: 'wav', signal: signal() })
    assert.equal(result.format, 'wav')
    assert.equal(result.data.toString('ascii', 8, 12), 'WAVE')
    assert.deepEqual(result.data.subarray(44), pcm)
  })
})

test('Doubao bidirectional session streams PCM16 chunks', async () => {
  await withDoubaoServer(async target => {
    const chunks = []
    for await (const chunk of streamPcm(target, { text: '你好', signal: signal() })) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), pcm)
  })
})
