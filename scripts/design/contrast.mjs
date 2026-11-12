// WCAG 2 contrast ratio of colour pairs, for checking design tokens.
//   node scripts/design/contrast.mjs '#9aa1ab' '#0b0d10' ['#fg' '#bg' ...]
// Prints each pair's ratio and whether it passes AA for body text (4.5:1),
// AA for large text and UI parts (3:1). No dependencies; nothing leaves the PC.

function channel(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = Number.parseInt(m[1], 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  if (args.length < 2 || args.length % 2 !== 0) {
    console.error('usage: node scripts/design/contrast.mjs <fg> <bg> [<fg> <bg> ...]')
    process.exit(2)
  }
  for (let i = 0; i < args.length; i += 2) {
    const r = contrast(args[i], args[i + 1])
    const verdict = r >= 4.5 ? 'AA text' : r >= 3 ? 'AA large text / UI only' : 'FAILS AA'
    console.log(`${args[i]} on ${args[i + 1]}: ${r.toFixed(2)}:1  ${verdict}`)
  }
}
