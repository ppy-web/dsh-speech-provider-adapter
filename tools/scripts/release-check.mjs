import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Dependency-free release verification: syntax-check every ESM source file and
 * parse all JSON assets. Full unit tests run locally via `pnpm test` (they need
 * the 音色工坊 peer, which CI does not install for this example plugin).
 */
const root = fileURLToPath(new URL('../../', import.meta.url))
const jsFiles = [
  ...readdirSync(root).filter(name => name.endsWith('.mjs') || name === 'client.js'),
  ...readdirSync(join(root, 'ui')).filter(name => name.endsWith('.js')).map(name => join('ui', name)),
]
const jsonFiles = [
  'package.json',
  ...readdirSync(join(root, 'locale')).filter(name => name.endsWith('.json')).map(name => join('locale', name)),
]

let failed = false
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' })
  if (result.status !== 0) { failed = true; console.error(`syntax error: ${file}`) }
}
for (const file of jsonFiles) {
  try { JSON.parse(readFileSync(join(root, file), 'utf8')) } catch (error) { failed = true; console.error(`invalid JSON: ${file}: ${error.message}`) }
}
if (failed) process.exit(1)
console.log(`release check ok: ${jsFiles.length} scripts, ${jsonFiles.length} json files`)
