import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseMetadata } from '../tools/scripts/release-metadata.mjs'

test('releaseMetadata maps stable tags to latest and prereleases to next', () => {
  assert.deepEqual(releaseMetadata({ name: 'pkg', version: '0.1.0' }, 'v0.1.0'), { name: 'pkg', version: '0.1.0', npmTag: 'latest' })
  assert.equal(releaseMetadata({ name: 'pkg', version: '0.1.1-next.0' }, 'v0.1.1-next.0').npmTag, 'next')
})

test('releaseMetadata rejects mismatched tags', () => {
  assert.throws(() => releaseMetadata({ name: 'pkg', version: '0.1.0' }, 'v0.1.1'), /must match/u)
})
