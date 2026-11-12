// Line endings. A Windows checkout (core.autocrlf) gives the orch scripts CRLF files, and
// comments written in GitHub's web editor arrive with CRLF too; the parsers expect LF.

/** The text with every CRLF (and lone CR) turned into LF. */
export const lf = (text) => String(text ?? '').replace(/\r\n?/g, '\n')
