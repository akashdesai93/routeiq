// Shared by the scripts that write data files under public/seed.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Writes files so that a reader never sees half of one: each goes to a
 * temporary name next to its target first, and only when every one of them
 * is on disk are they renamed into place, in the order given. If anything
 * fails before the renames, the temporary files are removed and the files
 * already there are untouched.
 * @param {string} dir
 * @param {readonly (readonly [name: string, text: string])[]} files
 */
export async function writeFilesAtomically(dir, files) {
  await mkdir(dir, { recursive: true })
  const staged = []
  try {
    for (const [name, text] of files) {
      const temporary = join(dir, `.${name}.tmp`)
      staged.push([temporary, join(dir, name)])
      await writeFile(temporary, text, 'utf8')
    }
  } catch (error) {
    await Promise.allSettled(staged.map(([temporary]) => rm(temporary, { force: true })))
    throw error
  }
  for (const [temporary, target] of staged) await rename(temporary, target)
}
