import { TtsProviderError } from './host-api.mjs'

/** Common local TTS/LLM service ports, probed on loopback only. */
export const LOCAL_PROBE_PORTS = [18083, 8880, 8000, 8080, 1234, 7860, 5000, 8001, 3000, 5001]
const MAX_PORTS = 32
const PROBE_TIMEOUT = 1500
const MAX_HEALTH_BYTES = 64 * 1024

const invalid = () => { throw new TtsProviderError('adapter-config-invalid', undefined, 400) }

/** Probe loopback HTTP ports server-side so browser CORS never blocks detection. */
export async function probeLocalPorts(transport = fetch, ports, signal) {
  const list = ports === undefined ? LOCAL_PROBE_PORTS : ports
  if (!Array.isArray(list) || list.length > MAX_PORTS) invalid()
  const unique = [...new Set(list)]
  for (const port of unique) if (!Number.isSafeInteger(port) || port < 1 || port > 65535) invalid()
  signal?.throwIfAborted()
  const results = await Promise.all(unique.map(port => probePort(transport, port, signal)))
  return { host: '127.0.0.1', ports: results }
}

async function probePort(transport, port, signal) {
  for (const path of ['/health', '/']) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT)
    const relay = () => controller.abort()
    signal?.addEventListener('abort', relay, { once: true })
    try {
      const response = await transport(`http://127.0.0.1:${port}${path}`, {
        method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json, text/plain, */*' },
      })
      let service
      if (path === '/health' && response.ok) {
        try { service = detectService(JSON.parse(await boundedText(response))) } catch { await response.body?.cancel().catch(() => {}) }
      } else await response.body?.cancel().catch(() => {})
      return { port, reachable: true, status: response.status, ...(service ? { service } : {}) }
    } catch (error) {
      if (signal?.aborted) throw error
      // Try the next path; a reset on /health may still answer on /.
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay) }
  }
  return { port, reachable: false }
}

async function boundedText(response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_HEALTH_BYTES) break
      parts.push(value)
    }
    return Buffer.concat(parts).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function detectService(value) {
  if (!value || typeof value !== 'object') return undefined
  const text = JSON.stringify(value)
  if (/MOSS-TTS-Nano|MOSS-Audio-Tokenizer/iu.test(text)) return 'MOSS-TTS-Nano'
  return undefined
}
