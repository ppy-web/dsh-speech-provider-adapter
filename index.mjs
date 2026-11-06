import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { TtsProviderError } from './host-api.mjs'
import { AdapterStore, catalog, normalizeConfig, validateSelection } from './store.mjs'
import { discover, preset, streamPcm, synthesize, PROTOCOLS } from './protocols.mjs'
import { credentialsReady } from './cloud-providers.mjs'

export const name = 'speech-provider-adapter'
export const inject = ['speechSynthesis', 'webServer', 'settings']
export const Config = z.object({ storagePath: z.string().default('') })
export const ROOT = '/plugins/speech-provider-adapter'

export function createProvider(store, transport = fetch) {
  const listeners = new Set()
  const provider = {
    apiVersion: 1, id: 'external:speech-provider-adapter',
    getSnapshot() {
      const profile = store.active()
      const models = profile ? catalog(profile) : []
      const ready = credentialsReady(profile) && models.some(model => model.id === profile.selection.model && model.voices.some(voice => voice.id === profile.selection.voice))
      return { name: profile?.name ?? 'Speech providers', ready, formats: ['wav', 'mp3'], maxTextLength: profile ? Math.min(profile.maxTextLength, profile.protocol === 'tencent' ? 150 : profile.protocol === 'openai' ? 4096 : profile.protocol === 'minimax' ? 9999 : 10000) : 1000,
        ...(!ready ? { unavailableReason: 'external-provider-not-ready' } : {}), models,
        ...(profile?.selection.model ? { selection: profile.selection, modelName: models.find(model => model.id === profile.selection.model)?.name,
          voiceName: profile.voices.find(voice => voice.id === profile.selection.voice)?.name } : {}), configurationId: profile?.id,
        configurations: store.state.profiles.map(({ id, name }) => ({ id, name })), managementPath: ROOT, managementBundle: 'dsh-speech-provider-adapter' }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    notify() { for (const listener of listeners) listener() },
    async configure(selection, { signal }) {
      const profile = store.active()
      if (!profile) throw new TtsProviderError('external-provider-unavailable', undefined, 409)
      const chosen = validateSelection(profile, selection)
      await store.save({ ...store.state, profiles: store.state.profiles.map(item => item.id === profile.id ? { ...item, selection: chosen } : item) }, store.revision, signal)
    },
    async selectConfiguration(configurationId, { signal }) {
      if (!store.state.profiles.some(item => item.id === configurationId)) throw new TtsProviderError('external-selection-invalid', undefined, 400)
      await store.save({ ...store.state, activeId: configurationId }, store.revision, signal)
    },
    synthesize(request) { return synthesize(store.active(), request, transport) },
    streamPcm(request) { return streamPcm(store.active(), request, transport) },
  }
  return provider
}

function reply(res, status, body) {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) { req.resume(); throw new TtsProviderError('request-body-too-large', undefined, 413) }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new TtsProviderError('adapter-config-invalid', undefined, 400) }
}

export function sameOrigin(req, mutation = false) {
  if (['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']))) return false
  if (req.headers.origin === undefined) {
    // The desktop shell validates the app origin, then forwards requests without
    // browser origin metadata. A dedicated header keeps origin-less writes
    // unavailable to cross-site HTML forms, which cannot set custom headers.
    return !mutation || (req.headers['sec-fetch-site'] === undefined && req.headers['x-dsh-speech-adapter'] === '1')
  }
  try { const origin = new URL(req.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host } catch { return false }
}

export async function apply(ctx, config) {
  const path = config.storagePath || resolve(dirname(ctx.settings.documentPath), 'speech-provider-adapter', 'providers.json')
  const store = await new AdapterStore(path).load()
  store.canWrite = () => ctx.settings.writable
  const provider = createProvider(store)
  let unregister = null
  let takeoverError = null
  let disposed = false
  const requests = new Set()
  const update = () => {
    takeoverError = null
    if (!store.state.takeoverEnabled) { unregister?.(); unregister = null; return }
    if (unregister) { provider.notify(); return }
    try { unregister = ctx.speechSynthesis.registerProvider(provider) }
    catch (error) { takeoverError = error instanceof TtsProviderError ? error.code : 'external-provider-unavailable' }
  }
  ctx.effect(() => {
    const off = store.subscribe(update)
    update()
    return () => { disposed = true; store.closed = true; for (const controller of requests) controller.abort(); off(); unregister?.(); unregister = null }
  })
  const publicState = () => ({ ...store.publicState(), takeoverActive: unregister !== null, ready: unregister !== null && provider.getSnapshot().ready, takeoverError })
  const files = new Map([['', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/api.js', ['api.js', 'text/javascript; charset=utf-8']], ['/components.js', ['components.js', 'text/javascript; charset=utf-8']], ['/standalone.js', ['standalone.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/locale/zh.json', ['../locale/zh.json', 'application/json; charset=utf-8']], ['/locale/en.json', ['../locale/en.json', 'application/json; charset=utf-8']]])
  for (const [suffix, [file, type]] of files) {
    const data = await readFile(new URL(`./ui/${file}`, import.meta.url))
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROOT + suffix, handler(req, res) {
      if (!sameOrigin(req)) { reply(res, 403, { error: 'cross-origin-denied' }); return }
      if (req.method !== 'GET') { reply(res, 405, { error: 'method-not-allowed' }); return }
      res.setHeader('content-type', type); res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'")
      res.end(data)
    } }))
  }
  for (const action of ['state', 'save', 'refresh', 'test', 'preset']) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${ROOT}/api/${action}`, async handler(req, res) {
      const read = action === 'state'
      if (req.method !== (read ? 'GET' : 'POST')) { reply(res, 405, { error: 'method-not-allowed' }); return }
      if (!sameOrigin(req, !read)) { reply(res, 403, { error: 'cross-origin-denied' }); return }
      if (!read && !String(req.headers['content-type']).startsWith('application/json')) { reply(res, 415, { error: 'invalid-content-type' }); return }
      const controller = new AbortController()
      requests.add(controller)
      const cancel = () => { if (!res.writableEnded) controller.abort() }
      res.once('close', cancel)
      const timer = setTimeout(() => controller.abort(new TtsProviderError('tts-timeout', undefined, 504)), 25000)
      try {
        if (disposed) throw new TtsProviderError('speech-service-disposed', undefined, 503)
        if (read) { reply(res, 200, publicState()); return }
        const body = await readBody(req)
        if (action === 'preset') {
          if (!PROTOCOLS.includes(body.protocol)) throw new TtsProviderError('adapter-config-invalid', undefined, 400)
          reply(res, 200, preset(body.protocol)); return
        }
        if (body.revision !== store.revision) throw new TtsProviderError('adapter-config-changed', undefined, 409)
        if (action === 'save') {
          // Reject ownership conflicts before writing a takeover request to disk.
          if (body.takeoverEnabled && !unregister && ctx.speechSynthesis.currentProvider().startsWith('external:')) throw new TtsProviderError('external-provider-conflict', undefined, 409)
          await store.save(body, body.revision, controller.signal)
          reply(res, 200, publicState()); return
        }
        const normalized = normalizeConfig({ takeoverEnabled: false, activeId: body.profile?.id ?? '', profiles: [body.profile] }, store.state)
        const profile = normalized.profiles[0]
        if (!profile.apiKey) throw new TtsProviderError('api-key-not-configured', undefined, 409)
        const result = await discover(profile, fetch, controller.signal)
        reply(res, 200, result)
      } catch (error) { reply(res, error instanceof TtsProviderError ? error.status : controller.signal.aborted ? 504 : 502,
        { error: error instanceof TtsProviderError ? error.code : controller.signal.aborted ? 'tts-timeout' : 'external-upstream-failed' }) }
      finally { clearTimeout(timer); res.off('close', cancel); requests.delete(controller) }
    },
  }))
}
