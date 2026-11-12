// node --test native/scripts/signal-parity-reference.test.mjs   (Node 24 or newer, from the repository root)
//
// The Swift parity test (SignalBundleParityTests) compares Swift's signal counts with
// Fixtures/signal-parity.json, the web app's own counts. Both read the frozen fixture
// bundle, so a monthly refresh of public/seed/osm-signals must leave it green (#193).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const repo = resolve(import.meta.dirname, '../..')
const script = join(repo, 'native/scripts/signal-parity-reference.mjs')
const committed = readFileSync(join(repo, 'native/RouteIQCore/Tests/RouteIQKitTests/Fixtures/signal-parity.json'), 'utf8')
const run = (cwd) => execFileSync(process.execPath, [script], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

test('the committed reference is exactly what the web app counts on the frozen bundle', () => {
  assert.equal(run(repo), committed)
})

test('a refresh of the shipped bundle does not change the reference', () => {
  // A checkout whose public/seed/osm-signals is a later, different bundle: a day newer, and
  // every signal in every tile gone. Everything else is the real repository.
  const root = mkdtempSync(join(tmpdir(), 'routeiq-parity-'))
  try {
    for (const name of ['src', 'tests', 'native', 'node_modules', 'package.json']) {
      symlinkSync(join(repo, name), join(root, name))
    }
    const from = join(repo, 'public/seed/osm-signals')
    const to = join(root, 'public/seed/osm-signals')
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from).filter((n) => n.endsWith('.json'))) {
      const file = JSON.parse(readFileSync(join(from, name), 'utf8'))
      if (name === 'index.json') file.dataDate += 86_400_000
      else file.nodes = []
      writeFileSync(join(to, name), JSON.stringify(file))
    }
    assert.equal(run(root), committed)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
