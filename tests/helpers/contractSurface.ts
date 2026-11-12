import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path/posix'

// The contract surface (PLAN step 10, #7): the type declarations the Swift port and the
// iPhone shell depend on, read straight from the source, each with every type it refers to,
// normalized (comments and layout dropped) and hashed. tests/contracts.test.ts compares the
// result with docs/contracts/core-contract.json, so a change of shape fails until
// CORE_CONTRACT_VERSION is bumped and the snapshot regenerated.
//
// TypeScript 7 ships no JavaScript compiler API, so this is a small tokenizer of its own. It
// knows the declaration forms this codebase uses: `interface X { … }` and `type X = …` at the
// top level of a file, exported or not.

/** The files declarations are read from. src/core whole, plus the provider and shell shapes on the wire. */
export const CONTRACT_SOURCES: readonly string[] = [
  ...readdirSync('src/core')
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join('src/core', f)),
  'src/providers/osm/adapter.ts',
  'src/providers/osm/bundle.ts',
  'src/device/native/plugin.ts',
]

/** The shapes named in the contract (docs/contracts.md); everything they refer to comes along. */
export const CONTRACT_ROOTS: readonly string[] = [
  // Routes, as the Directions adapter makes them and everything downstream reads them.
  'RouteCandidate',
  'RouteSignal',
  // Signal tiles and the bundle index (public/seed/osm-signals).
  'OsmSignalTile',
  'OsmBundleIndex',
  // The place book (localStorage routeiq.places.v1).
  'PlaceBook',
  // The reroute engine.
  'RerouteOptions',
  'RerouteState',
  'RerouteObservation',
  'RerouteDecision',
  // The live drive state machine.
  'LiveOptions',
  'LiveState',
  'LiveEvent',
  'LiveEffect',
  // The iPhone shell's native plugin: fix, locationError, tick, appState, httpGet.
  'RouteIQNativePlugin',
]

/** JSON Schemas that are part of the contract too (their text is hashed with the declarations). */
export const CONTRACT_SCHEMAS: readonly string[] = readdirSync('docs/contracts/schemas')
  .filter((f) => f.endsWith('.schema.json'))
  .sort()
  .map((f) => join('docs/contracts/schemas', f))

type Token = { readonly text: string; readonly line: number }

/** Tokens of TypeScript source with comments dropped; strings and template literals kept whole. */
export function tokenize(source: string): Token[] {
  const out: Token[] = []
  let i = 0
  let line = 1
  const n = source.length
  while (i < n) {
    const c = source[i]!
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      for (let k = i; k < stop; k++) if (source[k] === '\n') line++
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let k = i + 1
      while (k < n && source[k] !== c) k += source[k] === '\\' ? 2 : 1
      out.push({ text: source.slice(i, k + 1), line })
      i = k + 1
      continue
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let k = i
      while (k < n && /[A-Za-z_$0-9.]/.test(source[k]!)) k++
      out.push({ text: source.slice(i, k), line })
      i = k
      continue
    }
    if (c === '=' && source[i + 1] === '>') {
      out.push({ text: '=>', line })
      i += 2
      continue
    }
    if (c === '.' && source.startsWith('...', i)) {
      out.push({ text: '...', line })
      i += 3
      continue
    }
    out.push({ text: c, line })
    i++
  }
  return out
}

const OPEN = new Set(['{', '[', '(', '<'])
const CLOSE = new Set(['}', ']', ')', '>'])
/** A token that cannot end a type: the type goes on past a line break after it. */
const CONTINUES_AFTER = new Set(['=', '|', '&', ',', ':', '?', '=>', 'extends', 'keyof', 'typeof', 'readonly', '...'])
/** A token that cannot start a statement: the type goes on past the line break before it. */
const CONTINUES_BEFORE = new Set(['|', '&', '?', ':', '=>', 'extends', '[', '.'])

/** Every top-level `interface` and `type` declaration in a file, by name, as normalized text, and whether it is exported. */
export function declarationsOf(source: string): Map<string, { text: string; exported: boolean }> {
  const tokens = tokenize(source)
  const found = new Map<string, { text: string; exported: boolean }>()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.text
    const atTop = depth === 0
    // Statement nesting: braces and brackets only, since < and > are also comparisons in code.
    if (t === '{' || t === '[' || t === '(') depth++
    else if (t === '}' || t === ']' || t === ')') depth = Math.max(0, depth - 1)
    if (!atTop || (t !== 'interface' && t !== 'type')) continue
    const prev = tokens[i - 1]?.text
    if (prev !== undefined && prev !== 'export' && prev !== 'declare' && prev !== '}' && tokens[i - 1]!.line === tokens[i]!.line) continue
    const name = tokens[i + 1]?.text
    if (name === undefined || !/^[A-Z][A-Za-z0-9]*$/.test(name)) continue
    // `type` as a word inside an import (`import { type X }`) is not at the top level of a statement.
    if (prev === '{' || prev === ',') continue
    let k = i + 2
    let d = 0
    if (t === 'interface') {
      while (k < tokens.length && !(d === 0 && tokens[k]!.text === '{')) {
        if (OPEN.has(tokens[k]!.text)) d++
        else if (CLOSE.has(tokens[k]!.text)) d--
        k++
      }
      d = 0
      for (; k < tokens.length; k++) {
        const x = tokens[k]!.text
        if (OPEN.has(x)) d++
        else if (CLOSE.has(x)) d--
        if (d === 0) break
      }
    } else {
      for (; k < tokens.length; k++) {
        const x = tokens[k]!.text
        if (OPEN.has(x)) d++
        else if (CLOSE.has(x)) d--
        const next = tokens[k + 1]
        if (d !== 0 || next === undefined) continue
        if (x === ';') break
        if (next.line !== tokens[k]!.line && !CONTINUES_AFTER.has(x) && !CONTINUES_BEFORE.has(next.text)) break
      }
    }
    const text = tokens
      .slice(i, Math.min(k + 1, tokens.length))
      .map((x) => x.text)
      .filter((x) => x !== ';')
      .join(' ')
      // Layout only: a trailing comma before a closing bracket says nothing about the shape.
      .replace(/ , ([}\])>])/g, ' $1')
      // Nor does a leading bar or ampersand: `type U = | 'a' | 'b'` is `type U = 'a' | 'b'`.
      .replace(/([=(<,:]) [|&] /g, '$1 ')
    if (found.has(name)) throw new Error(`${name} is declared twice in one file`)
    found.set(name, { text, exported: prev === 'export' || (prev === 'declare' && tokens[i - 2]?.text === 'export') })
  }
  return found
}

interface Declaration {
  /** The key in the surface: the name, or `file#Name` for a type that is not exported. */
  readonly key: string
  readonly text: string
  readonly file: string
}

/**
 * Every declaration of the contract sources, and how a name used in a file resolves: to that
 * file's own declaration first, then to the one exported declaration of that name. Two exported
 * declarations of one name are an error: the contract must be unambiguous.
 */
export function allDeclarations(sources: readonly string[] = CONTRACT_SOURCES) {
  const byFile = new Map<string, Map<string, Declaration>>()
  const exported = new Map<string, Declaration>()
  for (const file of sources) {
    const own = new Map<string, Declaration>()
    for (const [name, { text, exported: isExported }] of declarationsOf(readFileSync(file, 'utf8'))) {
      const decl: Declaration = { key: isExported ? name : `${file}#${name}`, text, file }
      own.set(name, decl)
      if (!isExported) continue
      const seen = exported.get(name)
      if (seen !== undefined) throw new Error(`${name} is exported from both ${seen.file} and ${file}`)
      exported.set(name, decl)
    }
    byFile.set(file, own)
  }
  const resolve = (name: string, fromFile: string | null): Declaration | undefined =>
    (fromFile === null ? undefined : byFile.get(fromFile)?.get(name)) ?? exported.get(name)
  return { resolve }
}

/** The roots and every declaration they refer to, directly or not, by key, sorted. */
export function contractSurface(roots: readonly string[] = CONTRACT_ROOTS, sources: readonly string[] = CONTRACT_SOURCES): Record<string, string> {
  const { resolve } = allDeclarations(sources)
  const keep = new Map<string, string>()
  const queue: Declaration[] = roots.map((name) => {
    const decl = resolve(name, null)
    if (decl === undefined) throw new Error(`contract type ${name} is not exported from ${sources.join(', ')}`)
    return decl
  })
  while (queue.length > 0) {
    const decl = queue.shift()!
    if (keep.has(decl.key)) continue
    keep.set(decl.key, decl.text)
    for (const word of decl.text.split(' ').slice(2)) {
      const ref = resolve(word.split('.')[0]!, decl.file)
      if (ref !== undefined && !keep.has(ref.key)) queue.push(ref)
    }
  }
  return Object.fromEntries([...keep.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
/** The hash of the whole contract: every declaration of the surface and every schema file, in a fixed order. */
export function contractHash(surface: Record<string, string>, schemaFiles: readonly string[] = CONTRACT_SCHEMAS): string {
  const hash = createHash('sha256')
  for (const [name, text] of Object.entries(surface)) hash.update(`${name}\n${text}\n`)
  for (const file of schemaFiles) hash.update(`${file}\n${JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))}\n`)
  return hash.digest('hex')
}
