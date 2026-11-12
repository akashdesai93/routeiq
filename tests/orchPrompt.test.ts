import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dispatchComment, parseTemplate, renderPrompt, type RoleTemplate } from '../scripts/orch/prompt.mjs'

// Role prompts for the fleet (docs/orchestrator.md, Roles). What matters to the owner: every
// dispatched session gets the standing rules, exactly once, with its own name in them, and a
// dispatch cannot go out with a hole in it (a missing issue number, a stray placeholder).

const ROLES = '.claude/orch/roles'
const rules = readFileSync('.claude/orch/rules.md', 'utf8')
const load = (role: string): RoleTemplate => {
  const tpl = parseTemplate(readFileSync(`${ROLES}/${role}.md`, 'utf8'))
  if ('error' in tpl) throw new Error(`${role}: ${tpl.error}`)
  return tpl
}
const roles = readdirSync(ROLES).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))

describe('role templates', () => {
  it('has a template for every role in docs/orchestrator.md', () => {
    expect(roles.sort()).toEqual(['builder', 'conductor', 'design-lead', 'findings', 'orchestrator', 'phone-lab', 'phone-pr-upkeep', 'reviewer', 'simplifier', 'understudy'])
  })

  it.each(roles)('%s renders with the standing rules once and no placeholder left', (role) => {
    const out = renderPrompt(load(role), { name: `cloud-${role}-1`, issues: '84', prs: '127' }, rules)
    if ('error' in out) throw new Error(out.error)
    expect(out.text).not.toMatch(/\{\{/)
    expect(out.text.split('## Standing rules').length - 1).toBe(1)
    expect(out.text).toContain(`claude-loop: claimed by cloud-${role}-1`)
    expect(out.text).toContain('Never** push to `main`')
  })
})

describe('renderPrompt', () => {
  const builder = () => load('builder')

  it('fills in the issues and the specifics', () => {
    const out = renderPrompt(builder(), { name: 'cloud-builder-84', issues: '84,#85', note: 'Stay out of src/live.css.' }, rules)
    if ('error' in out) throw new Error(out.error)
    expect(out.text).toContain('Your issues: #84, #85.')
    expect(out.text).toContain('### Specifics for this run\n\nStay out of src/live.css.')
  })

  it('refuses a builder with no issue or no name', () => {
    expect(renderPrompt(builder(), { name: 'cloud-builder' }, rules)).toEqual({ error: 'builder needs --issues' })
    expect(renderPrompt(builder(), { issues: '84' }, rules)).toEqual({ error: 'builder needs --name' })
  })

  it('refuses names the status parser could not read back', () => {
    expect(renderPrompt(builder(), { name: 'Cloud Builder', issues: '84' }, rules)).toHaveProperty('error')
    expect(() => renderPrompt(builder(), { name: 'cloud-b', issues: '84,abc' }, rules)).toThrow(/not an issue/)
  })

  it('refuses a long note: the details belong in the issue', () => {
    expect(renderPrompt(builder(), { name: 'cloud-b', issues: '1', note: 'a\nb\nc\nd\ne\nf\ng' }, rules)).toHaveProperty('error')
  })

  it('passes shell snippets in the rules through untouched ($&, $1, $$, $` and $\')', () => {
    const shell = "Run `gh api $R/pulls --jq '$&'`, then `echo $1 $$` and `x=$`y` and cost $'."
    const out = renderPrompt(builder(), { name: 'cloud-builder-84', issues: '84' }, shell)
    if ('error' in out) throw new Error(out.error)
    expect(out.text).toContain(shell)
    expect(out.text).not.toContain('{{rules}}')
  })

  it('gives standing roles their default names', () => {
    const out = renderPrompt(load('reviewer'), {}, rules)
    expect(out).toMatchObject({ name: 'cloud-reviewer' })
  })
})

describe('parseTemplate', () => {
  const header = '<!-- role template\nrole: x\nsurface: cloud\nstarted: now\nparams: name\n-->\n'
  it('rejects a template that would drop the standing rules', () => {
    expect(parseTemplate(`${header}Hello {{name}}`)).toEqual({ error: 'the body must include {{rules}}' })
  })
  it('rejects a misspelt placeholder that would reach the session as text', () => {
    expect(parseTemplate(`${header}Hello {{nmae}} {{rules}}`)).toEqual({ error: 'unknown placeholder {{nmae}}' })
  })
  it('rejects a template without a header', () => {
    expect(parseTemplate('Hello {{rules}}')).toHaveProperty('error')
  })
})

describe('dispatchComment', () => {
  it('is the dispatch format state.mjs reads', () => {
    expect(dispatchComment(load('builder'), { name: 'cloud-builder-84', issues: '84,85', by: 'local-orchestrator' })).toBe(
      'dispatch: cloud-builder-84 (cloud)\nrole: builder\nworking on: #84, #85\nby: local-orchestrator\n',
    )
  })
})

// The owner's PC checks the repo out with CRLF (core.autocrlf), and prompt.mjs refused every
// template there: "the template must start with a role template header".
describe('a Windows checkout (CRLF)', () => {
  const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n')

  it.each(roles)('%s parses and renders the same from CRLF files', (role) => {
    const text = readFileSync(`${ROLES}/${role}.md`, 'utf8')
    const tpl = parseTemplate(crlf(text))
    if ('error' in tpl) throw new Error(`${role}: ${tpl.error}`)
    expect(tpl).toEqual(load(role))
    const input = { name: `cloud-${role}-1`, issues: '84', prs: '127', note: 'one\r\ntwo' }
    expect(renderPrompt(tpl, input, crlf(rules))).toEqual(renderPrompt(load(role), { ...input, note: 'one\ntwo' }, rules))
  })

  it('keeps the templates and the orch scripts LF on every checkout (.gitattributes)', () => {
    const files = [`${ROLES}/builder.md`, '.claude/orch/rules.md', 'scripts/orch/prompt.mjs', 'scripts/orch/lib/status.mjs', 'tests/orch/night-2026-11-12.json']
    const out = execFileSync('git', ['check-attr', 'eol', '--', ...files], { encoding: 'utf8' })
    for (const f of files) expect(out, f).toContain(`${f}: eol: lf`)
  })
})
