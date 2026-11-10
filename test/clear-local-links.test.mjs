import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('adapter cleanup preserves the host plugin, other packages, source, and profile data', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-local-link-cleanup-'))
  const profile = join(home, 'profiles', 'web')
  const modules = join(profile, 'node_modules')
  const source = join(home, 'source')
  const hostSource = join(home, 'host-source')
  const script = fileURLToPath(new URL('../scripts/clear-local-links.mjs', import.meta.url))
  try {
    for (const path of [source, hostSource, join(profile, 'speech-provider-adapter'), join(modules, 'dsh-speech-provider-adapter_tmp_123_1')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(source, 'source.txt'), 'source')
    writeFileSync(join(profile, 'speech-provider-adapter', 'providers.json'), 'data')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-speech-provider-adapter': 'link:../source', 'dsh-xiaomi-tts': '5.2.1', other: '1.0.0' } }, null, 2))
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), "overrides:\n  dsh-speech-provider-adapter: link:../source\n  dsh-xiaomi-tts: link:../host-source\n  other: 1.0.0\n")
    symlinkSync(source, join(modules, 'dsh-speech-provider-adapter'), 'junction')
    symlinkSync(hostSource, join(modules, 'dsh-xiaomi-tts'), 'junction')
    execFileSync(process.execPath, [script], { env: { ...process.env, DSH_HOME: home } })
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, { 'dsh-xiaomi-tts': '5.2.1', other: '1.0.0' })
    assert.equal(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), 'overrides:\n  dsh-xiaomi-tts: link:../host-source\n  other: 1.0.0\n')
    assert.equal(existsSync(join(modules, 'dsh-speech-provider-adapter')), false)
    assert.equal(existsSync(join(modules, 'dsh-speech-provider-adapter_tmp_123_1')), false)
    assert.equal(existsSync(join(modules, 'dsh-xiaomi-tts')), true)
    assert.equal(readFileSync(join(source, 'source.txt'), 'utf8'), 'source')
    assert.equal(readFileSync(join(profile, 'speech-provider-adapter', 'providers.json'), 'utf8'), 'data')
    assert.equal(readdirSync(profile).filter(name => name.startsWith('local-link-cleanup-backup-')).length, 1)
    execFileSync(process.execPath, [script], { env: { ...process.env, DSH_HOME: home } })
    assert.equal(readdirSync(profile).filter(name => name.startsWith('local-link-cleanup-backup-')).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('local link cleanup leaves an empty workspace override map valid', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-local-link-cleanup-'))
  const profile = join(home, 'profiles', 'web')
  const script = fileURLToPath(new URL('../scripts/clear-local-links.mjs', import.meta.url))
  try {
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{}\n')
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'overrides:\n  dsh-speech-provider-adapter: link:../source\n')
    execFileSync(process.execPath, [script], { env: { ...process.env, DSH_HOME: home } })
    assert.equal(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), 'overrides: {}\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('adapter cleanup removes a residual package directory and its installation record', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-local-link-cleanup-'))
  const profile = join(home, 'profiles', 'web')
  const adapter = join(profile, 'node_modules', 'dsh-speech-provider-adapter')
  const script = fileURLToPath(new URL('../scripts/clear-local-links.mjs', import.meta.url))
  try {
    mkdirSync(adapter, { recursive: true })
    writeFileSync(join(adapter, 'stale.txt'), 'stale')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-speech-provider-adapter': '^0.1.0' }, dsh: { profile: { bundles: ['dsh-speech-provider-adapter', 'dsh-xiaomi-tts'] } } }))
    execFileSync(process.execPath, [script], { env: { ...process.env, DSH_HOME: home } })
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['dsh-speech-provider-adapter'], undefined)
    assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-xiaomi-tts'])
    assert.equal(existsSync(adapter), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
