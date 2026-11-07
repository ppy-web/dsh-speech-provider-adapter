import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Derive the npm release channel from a vX.Y.Z tag; prereleases go to `next`, stable to `latest`. */
export function releaseMetadata({ name, version }, tag) {
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} must match package version v${version}`)
  const prerelease = version.split('+')[0].includes('-')
  const npmTag = prerelease ? 'next' : 'latest'
  return { name, version, npmTag }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const { name, version, npmTag } = releaseMetadata(manifest, process.env.RELEASE_TAG)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `package_name=${name}\nversion=${version}\nnpm_tag=${npmTag}\n`)
  console.log(`${name}@${version} -> ${npmTag}`)
}
