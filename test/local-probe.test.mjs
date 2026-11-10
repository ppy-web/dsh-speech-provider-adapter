import assert from 'node:assert/strict'
import test from 'node:test'
import { probeLocalPorts } from '../local-probe.mjs'

test('probeLocalPorts detects open ports, MOSS service and root-only services', async () => {
  const transport = async url => {
    const target = new URL(url)
    if (target.port === '18083' && target.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', checkpoint_path: 'OpenMOSS-Team/MOSS-TTS-Nano' }), { headers: { 'content-type': 'application/json' } })
    }
    if (target.port === '8880' && target.pathname === '/health') throw new Error('connection reset')
    if (target.port === '8880' && target.pathname === '/') return new Response('ok')
    throw new Error('connection refused')
  }
  const result = await probeLocalPorts(transport, [18083, 8880, 9999])
  assert.equal(result.host, '127.0.0.1')
  const byPort = Object.fromEntries(result.ports.map(item => [item.port, item]))
  assert.equal(byPort[18083].reachable, true)
  assert.equal(byPort[18083].service, 'MOSS-TTS-Nano')
  assert.equal(byPort[8880].reachable, true)
  assert.equal(byPort[9999].reachable, false)
})

test('probeLocalPorts rejects invalid or excessive port lists', async () => {
  await assert.rejects(probeLocalPorts(async () => new Response(''), [70000]), { code: 'adapter-config-invalid' })
  await assert.rejects(probeLocalPorts(async () => new Response(''), Array.from({ length: 40 }, (_, index) => index + 1)), { code: 'adapter-config-invalid' })
  await assert.rejects(probeLocalPorts(async () => new Response(''), [1.5]), { code: 'adapter-config-invalid' })
})
