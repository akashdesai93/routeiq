import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boundsOf, distanceM, isValidLngLat, SOUTHPARK, TEST_PLACES, UPTOWN_CHARLOTTE } from '../src/core/index.ts'
import { checkToken, tokenErrorHelp } from '../src/config.ts'

describe('core geo helpers', () => {
  it('test points are valid and in the Charlotte area', () => {
    for (const p of TEST_PLACES) {
      expect(isValidLngLat(p.position)).toBe(true)
      expect(p.position[0]).toBeGreaterThan(-81.1)
      expect(p.position[0]).toBeLessThan(-80.6)
      // Indian Land is just over the state line in South Carolina.
      expect(p.position[1]).toBeGreaterThan(34.9)
      expect(p.position[1]).toBeLessThan(35.4)
    }
  })

  it('boundsOf wraps every point', () => {
    const [w, s, e, n] = boundsOf(TEST_PLACES.map((p) => p.position))
    for (const { position: [lng, lat] } of TEST_PLACES) {
      expect(lng).toBeGreaterThanOrEqual(w)
      expect(lng).toBeLessThanOrEqual(e)
      expect(lat).toBeGreaterThanOrEqual(s)
      expect(lat).toBeLessThanOrEqual(n)
    }
    expect(() => boundsOf([])).toThrow()
    expect(() => boundsOf([[200, 0]])).toThrow()
  })

  it('distanceM is about 8 km Uptown to SouthPark', () => {
    const d = distanceM(UPTOWN_CHARLOTTE.position, SOUTHPARK.position)
    expect(d).toBeGreaterThan(7_500)
    expect(d).toBeLessThan(9_000)
  })
})

describe('token check', () => {
  it('accepts only public tokens', () => {
    expect(checkToken(undefined).kind).toBe('missing')
    expect(checkToken('pk.your_public_token_here').kind).toBe('missing')
    expect(checkToken('sk.abc').kind).toBe('secret')
    expect(checkToken('abc').kind).toBe('malformed')
    expect(checkToken(' pk.abc ').kind).toBe('ok')
  })

  it('explains a token Mapbox rejects at runtime', () => {
    expect(tokenErrorHelp(401)).toContain('rejected the token')
    expect(tokenErrorHelp(403)).toContain('http://localhost:5173')
    expect(tokenErrorHelp(403, 'https://akashdesai93.github.io')).toContain('add https://akashdesai93.github.io to its allowed URLs')
    expect(tokenErrorHelp(404)).toBeNull()
    expect(tokenErrorHelp(undefined)).toBeNull()
  })
})

describe('src/core stays framework-free', () => {
  it('imports nothing from React, Mapbox, the DOM or the network', () => {
    const dir = join(import.meta.dirname, '../src/core')
    const banned = /(from|import)\s*['"](react|react-dom|mapbox-gl)|\b(window|document|fetch|localStorage)\b/
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      // Strip comments first so docs that mention "no fetch" don't trip the check.
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(code, f).not.toMatch(banned)
    }
  })
})
