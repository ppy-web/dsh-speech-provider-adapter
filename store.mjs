import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TtsProviderError } from './host-api.mjs'
import { PROTOCOLS, endpoint, modelFeatures } from './protocols.mjs'

const invalid = () => { throw new TtsProviderError('adapter-config-invalid', undefined, 400) }
const clone = value => structuredClone(value)
const text = (value, limit = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit

export function catalog(profile) {
  return profile.models.map(model => ({ id: model.id, name: model.name, ...modelFeatures(profile.protocol, model),
    streaming: profile.streaming && modelFeatures(profile.protocol, model).streaming,
    voices: profile.voices.filter(voice => !voice.modelIds?.length || voice.modelIds.includes(model.id)).map(({ id, name }) => ({ id, name })) }))
}

export function validateSelection(profile, selection) {
  const model = catalog(profile).find(item => item.id === selection?.model)
  if (!model || !model.voices.some(item => item.id === selection.voice) || (selection.speechInstruction !== undefined && (typeof selection.speechInstruction !== 'string' || selection.speechInstruction.length > 4096))) invalid()
  if (selection.speechInstruction && (!model.speechInstruction || (model.instructions && !model.instructions.some(item => item.id === selection.speechInstruction)))) invalid()
  return { model: selection.model, voice: selection.voice, speechInstruction: selection.speechInstruction ?? '' }
}

export function normalizeConfig(input, previous = { profiles: [] }) {
  if (!input || !Array.isArray(input.profiles) || input.profiles.length > 30 || typeof input.takeoverEnabled !== 'boolean' || typeof input.activeId !== 'string') invalid()
  const profiles = input.profiles.map(raw => {
    if (!raw || !text(raw.id, 100) || !/^[a-z0-9][a-z0-9._-]*$/u.test(raw.id) || !text(raw.name, 120)
      || !PROTOCOLS.includes(raw.protocol) || !text(raw.baseURL, 2048) || typeof raw.streaming !== 'boolean'
      || !Number.isSafeInteger(raw.maxTextLength) || raw.maxTextLength < 1 || raw.maxTextLength > 10000) invalid()
    endpoint(raw.baseURL, 't2a_v2')
    const old = previous.profiles.find(item => item.id === raw.id)
    const apiKey = raw.apiKey === undefined ? old?.apiKey ?? '' : raw.apiKey
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/u.test(apiKey)) invalid()
    const secretId = raw.secretId === undefined ? old?.secretId ?? '' : raw.secretId
    if (typeof secretId !== 'string' || secretId.length > 8192 || /[\r\n]/u.test(secretId)) invalid()
    const rows = (value, maximum) => {
      if (!Array.isArray(value) || value.length > maximum) invalid()
      const result = value.map(item => {
        if (!item || !text(item.id) || !text(item.name)) invalid()
        return { id: item.id.trim(), name: item.name.trim() }
      })
      if (new Set(result.map(item => item.id)).size !== result.length) invalid()
      return result
    }
    const models = rows(raw.models, 200).map((model, index) => ({ ...model,
      ...(typeof raw.models[index].streaming === 'boolean' ? { streaming: raw.models[index].streaming } : {}),
      ...(typeof raw.models[index].speechInstruction === 'boolean' ? { speechInstruction: raw.models[index].speechInstruction } : {}),
    }))
    const voices = rows(raw.voices, 2000).map((voice, index) => {
      const ids = raw.voices[index].modelIds
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !models.some(model => model.id === id)))) invalid()
      return { ...voice, ...(ids?.length ? { modelIds: [...new Set(ids)] } : {}) }
    })
    const profile = { id: raw.id, name: raw.name.trim(), protocol: raw.protocol, baseURL: raw.baseURL.trim(), apiKey: apiKey.trim(),
      ...(raw.protocol === 'tencent' || raw.secretId !== undefined || old?.secretId !== undefined ? { secretId: secretId.trim() } : {}),
      streaming: raw.streaming, maxTextLength: raw.maxTextLength, models, voices }
    // Empty catalogs can be saved while configuring, but cannot take over.
    profile.selection = models.length && voices.length ? validateSelection(profile, raw.selection) : { model: '', voice: '', speechInstruction: '' }
    return profile
  })
  if (new Set(profiles.map(item => item.id)).size !== profiles.length || (input.activeId && !profiles.some(item => item.id === input.activeId))) invalid()
  if (input.takeoverEnabled && !profiles.some(item => item.id === input.activeId)) invalid()
  return { takeoverEnabled: input.takeoverEnabled, activeId: input.activeId, profiles }
}

/** Revision-checked, atomic file replacement; no caller receives a secret-bearing snapshot. */
export class AdapterStore {
  state = { takeoverEnabled: false, activeId: '', profiles: [] }
  revision = 0
  listeners = new Set()
  queue = Promise.resolve()
  closed = false
  canWrite = () => true
  constructor(path) { this.path = path }
  async load() {
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8'))
      this.state = normalizeConfig(file)
      this.revision = Number.isSafeInteger(file.revision) ? file.revision : 1
    } catch (error) { if (error.code !== 'ENOENT') throw new TtsProviderError('adapter-storage-invalid', undefined, 500) }
    return this
  }
  active() { return clone(this.state.profiles.find(item => item.id === this.state.activeId)) }
  publicState() { return { ...clone(this.state), revision: this.revision, profiles: this.state.profiles.map(({ apiKey, secretId, ...profile }) => ({ ...clone(profile), keyConfigured: !!apiKey,
    ...(secretId !== undefined ? { secretIdConfigured: !!secretId } : {}) })) } }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  save(input, expectedRevision, signal) {
    const job = this.queue.then(async () => {
      signal?.throwIfAborted()
      if (this.closed) throw new TtsProviderError('speech-service-disposed', undefined, 503)
      if (!this.canWrite()) throw new TtsProviderError('settings-read-only', undefined, 403)
      if (expectedRevision !== this.revision) throw new TtsProviderError('adapter-config-changed', undefined, 409)
      const state = normalizeConfig(input, this.state)
      const revision = this.revision + 1
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify({ ...state, revision }, null, 2), { mode: 0o600, flag: 'wx' })
        signal?.throwIfAborted()
        if (this.closed) throw new TtsProviderError('speech-service-disposed', undefined, 503)
        await rename(temp, this.path)
      } finally { await unlink(temp).catch(() => {}) }
      this.state = state
      this.revision = revision
      for (const listener of this.listeners) listener()
      return this.publicState()
    })
    this.queue = job.catch(() => {})
    return job
  }
}
