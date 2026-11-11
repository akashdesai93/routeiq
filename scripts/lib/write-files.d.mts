// Types for write-files.mjs, so the tests can import it. The script itself is plain JavaScript.

export function writeFilesAtomically(dir: string, files: readonly (readonly [name: string, text: string])[]): Promise<void>
