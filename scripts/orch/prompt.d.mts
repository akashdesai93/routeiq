// Types for prompt.mjs, so the tests can import it. The script itself is plain JavaScript.

export interface RoleTemplate {
  role: string
  surface: 'cloud' | 'local'
  started: string
  params: { name: string; required: boolean }[]
  body: string
}

export function parseTemplate(text: string): RoleTemplate | { error: string }
export function numberList(value: string | number | undefined): number[]
export function defaultName(tpl: RoleTemplate, issues: number[]): string
export function renderPrompt(
  tpl: RoleTemplate,
  input: { name?: string; issues?: string; prs?: string; note?: string },
  rulesText: string,
): { name: string; text: string } | { error: string }
export function dispatchComment(tpl: RoleTemplate, input: { name?: string; issues?: string; by?: string }): string
