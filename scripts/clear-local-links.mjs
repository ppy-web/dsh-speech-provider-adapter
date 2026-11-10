import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const names = ['dsh-speech-provider-adapter']
const local = value => typeof value === 'string' && /^(?:link:|file:|workspace:)/i.test(value)
const profile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web')
const manifestPath = join(profile, 'package.json')
const workspacePath = join(profile, 'pnpm-workspace.yaml')
const readOptional = path => {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

try {
  const manifestText = readOptional(manifestPath)
  if (manifestText === null) throw new Error(`未找到 web profile：${manifestPath}`)
  const manifest = JSON.parse(manifestText)
  const changes = []
  let manifestChanged = false
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of names) {
      if (Object.hasOwn(manifest[section] ?? {}, name)) {
        delete manifest[section][name]
        manifestChanged = true
        changes.push(`移除 ${section} 中的 ${name}`)
      }
    }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(names[0])) {
    manifest.dsh.profile.bundles = bundles.filter(name => name !== names[0])
    manifestChanged = true
    changes.push(`移除 profile 中的 ${names[0]} bundle`)
  }
  for (const name of names) {
    if (local(manifest.pnpm?.overrides?.[name])) {
      delete manifest.pnpm.overrides[name]
      manifestChanged = true
      changes.push(`移除 package.json 中的 ${name} 本地覆盖`)
    }
  }

  const workspaceText = readOptional(workspacePath)
  let updatedWorkspace = workspaceText
  if (workspaceText !== null) {
    const lines = workspaceText.split(/(?<=\n)/u)
    let inOverrides = false
    updatedWorkspace = lines.filter(line => {
      if (/^overrides:\s*(?:#.*)?\r?\n?$/u.test(line)) { inOverrides = true; return true }
      if (/^\S/u.test(line) && !/^#/u.test(line)) inOverrides = false
      if (!inOverrides) return true
      const match = line.match(/^  ['"]?(dsh-speech-provider-adapter)['"]?:\s*['"]?((?:link:|file:|workspace:)[^\r\n]*?)['"]?\s*(?:#.*)?\r?\n?$/iu)
      if (!match) return true
      changes.push(`移除 pnpm-workspace.yaml 中的 ${match[1]} 本地覆盖`)
      return false
    }).join('')
    if (updatedWorkspace !== workspaceText) {
      updatedWorkspace = updatedWorkspace.replace(/^overrides:(\s*(?:#.*)?\r?\n)((?:(?:[ \t]*|[ \t]*#.*)\r?\n)*)(?=\S|$)/mu, 'overrides: {}$1$2')
    }
  }

  const modulesPath = resolve(profile, 'node_modules')
  let entries = []
  try { entries = readdirSync(modulesPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const paths = entries.filter(name => name === names[0] || /^dsh-speech-provider-adapter_tmp_\d+_\d+$/u.test(name)).map(name => resolve(modulesPath, name))
  if (paths.some(path => dirname(path).toLowerCase() !== modulesPath.toLowerCase())) throw new Error('拒绝清理 profile 目录之外的路径')

  if (changes.length) {
    const backup = join(profile, `local-link-cleanup-backup-${Date.now()}`)
    mkdirSync(backup)
    writeFileSync(join(backup, 'package.json'), manifestText)
    if (workspaceText !== null) writeFileSync(join(backup, 'pnpm-workspace.yaml'), workspaceText)
    if (manifestChanged) {
      const indent = manifestText.match(/\n([ \t]+)"/)?.[1] || '  '
      const newline = manifestText.includes('\r\n') ? '\r\n' : '\n'
      writeFileSync(manifestPath, JSON.stringify(manifest, null, indent).replaceAll('\n', newline) + newline)
    }
    if (workspaceText !== updatedWorkspace) writeFileSync(workspacePath, updatedWorkspace)
    console.log(`已备份原配置：${backup}`)
  }
  for (const path of paths) {
    const item = lstatSync(path)
    if (item.isSymbolicLink()) {
      if (process.platform === 'win32') rmdirSync(path)
      else unlinkSync(path)
    } else if (item.isDirectory()) rmSync(path, { recursive: true, force: true })
    else unlinkSync(path)
    changes.push(`移除适配器残留：${path}`)
  }
  if (!changes.length) console.log('没有找到需要清理的本地链接。')
  else for (const change of changes) console.log(change)
  console.log('\n清理完成。重新安装时运行：')
  console.log('dsh plugin --profile web add dsh-speech-provider-adapter@latest')
} catch (error) {
  console.error(`清理失败：${error.message}`)
  process.exitCode = 1
}
