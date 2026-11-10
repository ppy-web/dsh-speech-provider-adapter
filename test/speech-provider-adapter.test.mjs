import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { AdapterStore, normalizeConfig } from '../store.mjs'
import { createProvider, apply, ROOT } from '../index.mjs'
import { preset, endpoint, synthesize, streamPcm, discover, modelFeatures } from '../protocols.mjs'
import { TtsProviderError } from '../host-api.mjs'
import { createManagerApi } from '../ui/api.js'
const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const profile = protocol => ({ ...preset(protocol), id: protocol, apiKey: 'private-test-key' })
const config = p => ({ profiles: [p], activeId: p.id, takeoverEnabled: true })
const request = extra => ({ text: 'hello', format: 'wav', signal: new AbortController().signal, ...extra })
async function temporary(work) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-speech-adapter-'))
  try { await work(new AdapterStore(join(dir, 'providers.json')), dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('adapter URL normalization supports service roots, /v1, and reverse-proxy prefixes', () => {
  assert.equal(endpoint('https://example.test', 't2a_v2'), 'https://example.test/v1/t2a_v2')
  assert.equal(endpoint('https://example.test/proxy/v1/', 'audio/speech'), 'https://example.test/proxy/v1/audio/speech')
  assert.equal(endpoint('https://example.test', 'models?mode=tts'), 'https://example.test/v1/models?mode=tts')
  for (const url of ['file:///tmp/key', 'https://user:pass@example.test', 'https://example.test?key=secret']) assert.throws(() => endpoint(url, 'speech'), { code: 'adapter-url-invalid' })
})

for (const protocol of ['senseaudio', 'minimax', 'openai']) test(`${protocol}: full WAV and MP3 requests use configured credentials, model and voice`, async () => {
  const p = profile(protocol)
  const calls = []
  const transport = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, ...init, body })
    const format = protocol === 'openai' ? body.response_format : body.audio_setting.format
    const bytes = format === 'pcm' ? pcm : Buffer.from('ID3mp3')
    return protocol === 'openai' ? new Response(bytes) : json({ data: { audio: bytes.toString('hex') }, base_resp: { status_code: 0 } })
  }
  const wav = await synthesize(p, request(), transport)
  assert.equal(wav.data.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.data.readUInt32LE(24), 24000)
  assert.equal(wav.data.readUInt16LE(22), 1)
  assert.equal(wav.data.readUInt16LE(34), 16)
  assert.deepEqual(wav.data.subarray(44), pcm)
  const mp3 = await synthesize(p, request({ format: 'mp3' }), transport)
  assert.equal(mp3.data.toString(), 'ID3mp3')
  assert.equal(calls[0].headers.authorization, 'Bearer private-test-key')
  assert.equal(calls[0].redirect, 'error')
  assert.equal(calls[0].body.model, p.selection.model)
  assert.equal(protocol === 'openai' ? calls[0].body.voice : calls[0].body.voice_setting.voice_id, p.selection.voice)
})

test('protocols map free-form instructions and restricted emotions without changing playback speed', async () => {
  for (const protocol of ['openai', 'minimax']) {
    const p = profile(protocol)
    let body
    await synthesize(p, request({ speechInstruction: protocol === 'openai' ? 'Speak softly' : 'happy' }), async (_url, init) => {
      body = JSON.parse(init.body)
      return protocol === 'openai' ? new Response(pcm) : json({ data: { audio: pcm.toString('hex') } })
    })
    assert.equal(protocol === 'openai' ? body.instructions : body.voice_setting.emotion, protocol === 'openai' ? 'Speak softly' : 'happy')
    if (protocol === 'minimax') assert.equal(body.voice_setting.speed, 1)
    else assert.equal(body.speed, undefined)
  }
  assert.equal(modelFeatures('senseaudio', { id: 'sensenova-tts-2.0' }).speechInstruction, false)
  assert.equal(modelFeatures('openai', { id: 'tts-1' }).speechInstruction, false)
  assert.equal(modelFeatures('minimax', { id: 'speech-2.8-hd' }).instructions.some(item => item.id === 'whisper'), false)
})

for (const protocol of ['senseaudio', 'minimax']) test(`${protocol}: SSE split across byte boundaries produces each PCM chunk once`, async () => {
  const frames = [pcm.subarray(0, 3), pcm.subarray(3)]
  const content = frames.map((data, index) => `data: ${JSON.stringify({ data: { audio: data.toString('hex'), status: index ? 2 : 1 }, base_resp: { status_code: 0 } })}\r\n\r\n`).join('')
  let sent
  const transport = async (_url, init) => {
    sent = JSON.parse(init.body)
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < content.length; i += 7) controller.enqueue(Buffer.from(content.slice(i, i + 7)))
      controller.close()
    } }))
  }
  const result = []
  for await (const frame of streamPcm(profile(protocol), request(), transport)) result.push(frame)
  assert.deepEqual(Buffer.concat(result), pcm)
  assert.equal(sent.stream, true)
  assert.equal(sent.audio_setting.format, 'pcm')
  assert.equal(sent.audio_setting.sample_rate, 24000)
  assert.equal(sent.stream_options.exclude_aggregated_audio, true)
})

test('OpenAI PCM streaming releases the upstream reader on cancellation', async () => {
  const controller = new AbortController()
  let cancelled = false
  const transport = async (_url, init) => {
    assert.equal(init.signal, controller.signal)
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(pcm) }, cancel() { cancelled = true } }))
  }
  await assert.rejects(async () => {
    for await (const frame of streamPcm(profile('openai'), request({ signal: controller.signal }), transport)) { assert.deepEqual(Buffer.from(frame), pcm); controller.abort() }
  }, { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('SSE providers stop queued audio records immediately after cancellation', async () => {
  for (const protocol of ['senseaudio', 'minimax']) {
    const controller = new AbortController()
    let cancelled = false
    let delivered = 0
    const frame = status => `data: ${JSON.stringify({ data: { audio: pcm.toString('hex'), status }, base_resp: { status_code: 0 } })}\n\n`
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from(frame(1) + frame(2))) }, cancel() { cancelled = true } }))
    await assert.rejects(async () => {
      for await (const bytes of streamPcm(profile(protocol), { text: 'Hi', signal: controller.signal }, async () => response)) {
        assert.deepEqual(bytes, pcm)
        delivered++
        controller.abort()
      }
    }, { name: 'AbortError' })
    assert.equal(delivered, 1)
    assert.equal(cancelled, true)
  }
})

test('malformed, truncated, oversized and wrong-format upstream audio fail with stable codes', async () => {
  for (const [response, code] of [
    [json({ data: { audio: 'zz' } }), 'invalid-audio-format'],
    [json({ data: { audio: '0100' }, extra_info: { audio_sample_rate: 32000 } }), 'invalid-audio-format'],
    [json({ base_resp: { status_code: 1004, status_msg: 'secret provider url/key' } }), 'api-key-rejected'],
    [new Response('data: {"data":{"audio":"0100","status":1}}\n\n'), 'external-stream-incomplete'],
    [new Response(`data: ${'x'.repeat(2 * 1024 * 1024 + 1)}`), 'stream-buffer-limit'],
  ]) {
    const work = code === 'external-stream-incomplete' || code === 'stream-buffer-limit'
      ? async () => { for await (const _ of streamPcm(profile('senseaudio'), request(), async () => response)) {} }
      : () => synthesize(profile('senseaudio'), request(), async () => response)
    await assert.rejects(work, error => { assert.equal(error.code, code); assert.equal(error.message.includes('secret'), false); return true })
  }
})

test('discovery fetches TTS models and all voice categories; partial failures preserve usable results', async () => {
  const urls = []
  const found = await discover(profile('senseaudio'), async (url, init) => {
    urls.push(url)
    if (url.includes('models')) return json({ data: [{ id: 'speech', display_name: 'Speech', mode: 'tts' }, { id: 'chat', mode: 'llm' }] })
    assert.equal(JSON.parse(init.body).voice_type, 'all')
    return json({ system_voice: [{ voice_id: 'one', voice_name: 'One' }], voice_cloning: [{ voice_id: 'clone' }], voice_generation: [{ voice_id: 'design' }] })
  })
  assert.equal(urls.some(url => url.endsWith('/v1/models?mode=tts')), true)
  assert.deepEqual(found.models.map(item => item.id), ['speech'])
  assert.deepEqual(found.voices.map(item => item.id), ['one', 'clone', 'design'])
  const partial = await discover(profile('minimax'), async url => url.endsWith('/models') ? new Response('', { status: 404 }) : json({ system_voice: [] }))
  assert.deepEqual(partial.voices, [])
  assert.equal(partial.errors[0].kind, 'models')
  assert.equal(partial.models, undefined)
})

test('adapter store persists selected model/voice, retains masked keys, checks revisions and readonly state', async () => temporary(async store => {
  await store.load()
  const initial = await store.save(config(profile('senseaudio')), 0)
  assert.equal(JSON.stringify(initial).includes('private-test-key'), false)
  const edited = copy(initial)
  edited.profiles[0].name = 'Custom provider'
  await store.save(edited, initial.revision)
  assert.equal(store.active().apiKey, 'private-test-key')
  await assert.rejects(store.save(initial, initial.revision), { code: 'adapter-config-changed' })
  const reloaded = await new AdapterStore(store.path).load()
  assert.equal(reloaded.active().name, 'Custom provider')
  assert.equal(reloaded.active().apiKey, 'private-test-key')
  store.canWrite = () => false
  await assert.rejects(store.save(store.publicState(), store.revision), { code: 'settings-read-only' })
}))
function copy(value) { return structuredClone(value) }

test('invalid catalog selection and unsupported emotion are rejected before persistence', () => {
  const p = profile('minimax')
  for (const selection of [{ model: 'missing', voice: p.selection.voice }, { ...p.selection, voice: 'missing' }, { ...p.selection, speechInstruction: 'arbitrary text' }]) {
    assert.throws(() => normalizeConfig(config({ ...p, selection })), { code: 'adapter-config-invalid' })
  }
})

test('registered provider persists model and voice through the public configure contract and notifies subscribers', async () => temporary(async store => {
  await store.save(config(profile('senseaudio')), 0)
  const provider = createProvider(store)
  const offStore = store.subscribe(() => provider.notify())
  let notified = false
  const off = provider.subscribe(() => { notified = true })
  try {
    const selection = { ...provider.getSnapshot().selection, voice: 'male_0004_a' }
    await provider.configure(selection, { signal: new AbortController().signal })
    assert.equal(store.active().selection.voice, selection.voice)
    assert.equal(provider.getSnapshot().selection.voice, selection.voice)
    assert.equal(notified, true)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(provider.configure({ ...selection, voice: 'female_0033_b' }, { signal: controller.signal }), { name: 'AbortError' })
    assert.equal(store.active().selection.voice, selection.voice)
  } finally { off(); offStore() }
}))

test('provider configuration switching persists the active profile without changing credentials or model selections', async () => temporary(async store => {
  const first = profile('senseaudio'), second = profile('openai')
  await store.save({ profiles: [first, second], activeId: first.id, takeoverEnabled: true }, 0)
  const provider = createProvider(store)
  const initial = JSON.stringify(store.state.profiles)
  assert.deepEqual(provider.getSnapshot().configurations, [first, second].map(({ id, name }) => ({ id, name })))
  await provider.selectConfiguration(second.id, { signal: new AbortController().signal })
  assert.equal(store.active().id, second.id)
  assert.equal(provider.getSnapshot().configurationId, second.id)
  assert.equal((await new AdapterStore(store.path).load()).active().id, second.id)
  assert.equal(JSON.stringify(store.state.profiles), initial)
  await assert.rejects(provider.selectConfiguration('missing', { signal: new AbortController().signal }), { code: 'external-selection-invalid' })
  store.canWrite = () => false
  await assert.rejects(provider.selectConfiguration(first.id, { signal: new AbortController().signal }), { code: 'settings-read-only' })
  assert.equal(store.active().id, second.id)
  store.canWrite = () => true
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.selectConfiguration(first.id, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(store.active().id, second.id)
}))

test('management routes enforce same origin, mask secrets, reject stale writes and release takeover on disable', async () => temporary(async (_store, dir) => {
  const routes = new Map(), cleanup = []
  let registered = null
  const service = {
    currentProvider: () => registered?.id ?? 'xiaomi',
    registerProvider(provider) {
      if (registered) throw new TtsProviderError('external-provider-conflict', undefined, 409)
      registered = provider
      return () => { if (registered === provider) registered = null }
    },
  }
  const ctx = { speechSynthesis: service, settings: { documentPath: join(dir, 'cordis.patch.yml'), writable: true },
    effect(fn) { cleanup.push(fn()) }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }
  await apply(ctx, {})
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (route) void route.handler(req, res)
    else { res.statusCode = 404; res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const post = (body, headers = { origin }) => fetch(origin + ROOT + '/api/save', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  try {
    assert.equal((await fetch(origin + ROOT)).status, 200)
    assert.equal((await fetch(origin + ROOT + '/api.js')).status, 200)
    for (const headers of [{}, { 'x-dsh-speech-adapter': 'wrong' }, { 'sec-fetch-site': 'same-origin' },
      ...['https://foreign.test', 'null', '', 'not-an-origin', 'dsh-app://app'].map(origin => ({ origin, 'x-dsh-speech-adapter': '1' })),
      ...['cross-site', 'same-site'].flatMap(site => [{ origin, 'sec-fetch-site': site, 'x-dsh-speech-adapter': '1' }, { 'sec-fetch-site': site, 'x-dsh-speech-adapter': '1' }])]) {
      for (const action of ['preset', 'save', 'refresh', 'test']) {
        const denied = await fetch(origin + ROOT + '/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
        assert.equal(denied.status, 403)
        assert.equal((await denied.json()).error, 'cross-origin-denied')
      }
    }
    const signal = new AbortController().signal
    const browser = createManagerApi(new URL(ROOT + '/', origin), signal, (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin } }))
    // forwardWebRequest in DSH desktop removes Origin and Sec-Fetch-Site.
    const desktop = createManagerApi(new URL(ROOT + '/', origin), signal)
    for (const api of [browser, desktop]) {
      const draft = await api('preset', { protocol: 'openai' })
      assert.equal(draft.protocol, 'openai')
      assert.equal(draft.models.some(model => model.id === draft.selection.model), true)
      assert.equal((await api('state')).profiles.length, 0)
    }
    const saved = await post({ ...config(profile('senseaudio')), revision: 0 })
    assert.equal(saved.status, 200)
    const state = await saved.json()
    assert.equal(state.takeoverActive, true)
    assert.equal(JSON.stringify(state).includes('private-test-key'), false)
    assert.equal((await post({ ...state, revision: 0 })).status, 409)
    await registered.configure({ ...registered.getSnapshot().selection, voice: 'male_0004_a' }, { signal: new AbortController().signal })
    const latest = await (await fetch(origin + ROOT + '/api/state')).json()
    assert.equal(latest.profiles[0].selection.voice, 'male_0004_a')
    const stopped = await post({ ...latest, takeoverEnabled: false })
    assert.equal(stopped.status, 200)
    assert.equal(service.currentProvider(), 'xiaomi')
    const disk = JSON.parse(await readFile(join(dir, 'speech-provider-adapter/providers.json'), 'utf8'))
    assert.equal(disk.profiles[0].selection.voice, 'male_0004_a')
    const draft = { ...await desktop('preset', { protocol: 'openai' }), id: 'desktop-provider' }
    const before = await desktop('state')
    const added = await desktop('save', { ...before, profiles: [...before.profiles, draft] })
    assert.equal(added.profiles.some(item => item.id === draft.id), true)
    assert.equal(added.takeoverActive, false)
    const restored = await new AdapterStore(join(dir, 'speech-provider-adapter/providers.json')).load()
    assert.equal(restored.state.profiles.find(item => item.id === draft.id).protocol, 'openai')
    assert.equal(restored.state.profiles.find(item => item.id === 'senseaudio').apiKey, 'private-test-key')
    await assert.rejects(desktop('save', before), { message: 'adapter-config-changed' })
    ctx.settings.writable = false
    await assert.rejects(desktop('save', added), { message: 'settings-read-only' })
    for (const action of ['refresh', 'test']) await assert.rejects(desktop(action, { revision: added.revision, profile: draft }), { message: 'api-key-not-configured' })
    const invalidType = await fetch(origin + ROOT + '/api/save', { method: 'POST', headers: { 'x-dsh-speech-adapter': '1', 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(invalidType.status, 415)
    assert.equal((await invalidType.json()).error, 'invalid-content-type')
  } finally {
    for (const dispose of cleanup.reverse()) await dispose?.()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}))

