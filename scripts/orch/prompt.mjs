#!/usr/bin/env node
// Renders a ready-to-send session prompt from a role template (docs/orchestrator.md, Roles).
//
//   node scripts/orch/prompt.mjs <role> [--name cloud-builder-84] [--issues 84,85] [--prs 127,141]
//                                       [--note "three lines of specifics"] [--dispatch] [--by <orchestrator>]
//   node scripts/orch/prompt.mjs --list
//
// The template is .claude/orch/roles/<role>.md: a small header in an HTML comment
// (`role`, `surface`, `started`, `params`; a `!` after a param marks it required) and a body
// with {{name}}, {{issues}}, {{prs}}, {{note}} and {{rules}}. {{rules}} is replaced by
// .claude/orch/rules.md, so the standing rules exist once. --dispatch prints the dispatch
// comment for #17 instead of the prompt.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROLES_DIR = join(ROOT, '.claude', 'orch', 'roles')
const RULES_FILE = join(ROOT, '.claude', 'orch', 'rules.md')
const KNOWN = ['name', 'issues', 'prs', 'note', 'rules']

/** Splits a template into its header fields and body. */
export function parseTemplate(text) {
  const m = /^<!-- role template\n([\s\S]*?)\n-->\n/.exec(text)
  if (!m) return { error: 'the template must start with a "<!-- role template" header' }
  const header = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim())
    if (kv) header[kv[1]] = kv[2]
  }
  for (const key of ['role', 'surface', 'started', 'params']) {
    if (!header[key]) return { error: `the header has no "${key}"` }
  }
  if (header.surface !== 'cloud' && header.surface !== 'local') return { error: `surface must be cloud or local, not "${header.surface}"` }
  const params = header.params.split(',').map((p) => p.trim()).filter(Boolean).map((p) => ({ name: p.replace(/!$/, ''), required: p.endsWith('!') }))
  for (const p of params) if (!KNOWN.includes(p.name)) return { error: `unknown param "${p.name}"` }
  const body = text.slice(m[0].length)
  const used = [...body.matchAll(/\{\{([a-z]+)\}\}/g)].map((x) => x[1])
  for (const u of used) if (!KNOWN.includes(u)) return { error: `unknown placeholder {{${u}}}` }
  if (!used.includes('rules')) return { error: 'the body must include {{rules}}' }
  return { role: header.role, surface: header.surface, started: header.started, params, body }
}

/** "84, #85" from "84,85" or "#84 #85"; [] for nothing. */
export function numberList(value) {
  if (!value) return []
  return String(value).split(/[\s,]+/).map((v) => v.replace(/^#/, '')).filter(Boolean).map((v) => {
    if (!/^\d+$/.test(v)) throw new Error(`not an issue or PR number: "${v}"`)
    return Number(v)
  })
}

/** Default session name: cloud-<role>[-<first issue>], or local-<role>. */
export function defaultName(tpl, issues) {
  const slug = tpl.role.replace(/[^a-z]+/gi, '-').toLowerCase()
  return `${tpl.surface === 'cloud' ? 'cloud' : 'local'}-${slug}${issues.length ? `-${issues[0]}` : ''}`
}

/** The rendered prompt, or { error }. Pure: the template and rules texts come in. */
export function renderPrompt(tpl, input, rulesText) {
  const issues = numberList(input.issues)
  const prs = numberList(input.prs)
  const name = input.name || defaultName(tpl, issues)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { error: `session name "${name}": lower case, digits and dashes only` }
  for (const p of tpl.params) {
    if (!p.required) continue
    if (p.name === 'name' && !input.name) return { error: `${tpl.role} needs --name` }
    if (p.name === 'issues' && issues.length === 0) return { error: `${tpl.role} needs --issues` }
    if (p.name === 'prs' && prs.length === 0) return { error: `${tpl.role} needs --prs` }
  }
  const note = (input.note || '').trim()
  if (note.split('\n').length > 6) return { error: 'keep --note to a few lines; anything longer belongs in the issue' }
  const values = {
    name,
    issues: issues.map((n) => `#${n}`).join(', '),
    prs: prs.length ? ` (start with ${prs.map((n) => `#${n}`).join(', ')})` : '',
    note: note ? `### Specifics for this run\n\n${note}` : '',
  }
  const rules = rulesText.replace(/\{\{name\}\}/g, name).trim()
  const text = tpl.body
    .replace(/\{\{rules\}\}/g, rules)
    .replace(/\{\{(name|issues|prs|note)\}\}/g, (_, k) => values[k])
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { name, text: `${text}\n` }
}

/** The dispatch comment for #17 (docs/orchestrator.md, Formats). */
export function dispatchComment(tpl, input) {
  const issues = numberList(input.issues)
  const name = input.name || defaultName(tpl, issues)
  return [
    `dispatch: ${name} (${tpl.surface})`,
    `role: ${tpl.role}`,
    `working on: ${issues.length ? issues.map((n) => `#${n}`).join(', ') : 'standing duties'}`,
    `by: ${input.by || 'orchestrator'}`,
    '',
  ].join('\n')
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dispatch' || a === '--list') out[a.slice(2)] = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const roles = readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort()
  if (args.list || args._.length !== 1) {
    console.log(`roles: ${roles.join(', ')}`)
    if (!args.list) process.exitCode = 2
    return
  }
  const role = args._[0]
  if (!roles.includes(role)) {
    console.error(`unknown role "${role}"; roles: ${roles.join(', ')}`)
    process.exitCode = 2
    return
  }
  const tpl = parseTemplate(readFileSync(join(ROLES_DIR, `${role}.md`), 'utf8'))
  if (tpl.error) throw new Error(`${role}.md: ${tpl.error}`)
  const result = renderPrompt(tpl, args, readFileSync(RULES_FILE, 'utf8'))
  if (result.error) {
    console.error(result.error)
    process.exitCode = 2
    return
  }
  process.stdout.write(args.dispatch ? dispatchComment(tpl, args) : result.text)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
