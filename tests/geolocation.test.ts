import { describe, expect, it } from 'vitest'
import { currentPosition, LOCATION_TIMEOUT_MS, type GeolocationLike, type LocationResult } from '../src/device/geolocation.ts'

type Options = Parameters<GeolocationLike['getCurrentPosition']>[2]

/** A stand-in for navigator.geolocation that answers at once, and records how it was asked. */
function fakeGeolocation(answer: { coords: { longitude: number; latitude: number; accuracy?: number } } | { code: number }) {
  const asked: Options[] = []
  const geolocation: GeolocationLike = {
    getCurrentPosition(success, error, options) {
      asked.push(options)
      if ('code' in answer) error?.(answer)
      else success(answer)
    },
  }
  return { geolocation, asked }
}

function failureOf(result: LocationResult) {
  if (result.ok) throw new Error('expected a failure')
  return result
}

describe('currentPosition', () => {
  // A public landmark stands in for "where the device is": Bank of America Stadium.
  const fix = { coords: { longitude: -80.8528, latitude: 35.2258, accuracy: 12.5 } }

  it('asks once, for a fresh high-accuracy fix with a time limit, and answers longitude first', async () => {
    const { geolocation, asked } = fakeGeolocation(fix)
    const result = await currentPosition({ geolocation, secureContext: true })
    expect(result).toEqual({ ok: true, position: [-80.8528, 35.2258], accuracyM: 12.5 })
    expect(asked).toEqual([{ enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 0 }])
    const quick = fakeGeolocation(fix)
    await currentPosition({ geolocation: quick.geolocation, secureContext: true, timeoutMs: 2_000 })
    expect(quick.asked[0]!.timeout).toBe(2_000)
  })

  it('leaves the accuracy null when the device gives none', async () => {
    for (const accuracy of [undefined, NaN, -1]) {
      const { geolocation } = fakeGeolocation({ coords: { longitude: -80.8528, latitude: 35.2258, accuracy } })
      expect(await currentPosition({ geolocation, secureContext: true })).toMatchObject({ ok: true, accuracyM: null })
    }
  })

  it('maps the browser error codes: 1 denied, 2 unavailable, 3 timeout, anything else unavailable', async () => {
    for (const [code, kind, words] of [
      [1, 'denied', 'permission was denied'],
      [2, 'unavailable', 'could not be determined'],
      [3, 'timeout', 'took too long'],
      [99, 'unavailable', 'could not be determined'],
    ] as const) {
      const failure = failureOf(await currentPosition({ geolocation: fakeGeolocation({ code }).geolocation, secureContext: true }))
      expect(failure.kind, String(code)).toBe(kind)
      expect(failure.message).toContain(words)
      // Every failure points at the way on.
      expect(failure.message).toContain('search for a starting point')
    }
  })

  it('says so on an insecure page, without asking the device at all', async () => {
    const { geolocation, asked } = fakeGeolocation(fix)
    const failure = failureOf(await currentPosition({ geolocation, secureContext: false }))
    expect(failure.kind).toBe('insecure')
    expect(failure.message).toContain('HTTPS or localhost')
    expect(asked).toHaveLength(0)
  })

  it('says so when the browser has no Geolocation API', async () => {
    const failure = failureOf(await currentPosition({ geolocation: null, secureContext: true }))
    expect(failure.kind).toBe('unsupported')
    // Vitest runs in Node, which has none: the defaults give the same answer and do not throw.
    expect(failureOf(await currentPosition()).kind).toBe('unsupported')
  })

  it('never rejects: a fix that is not a coordinate, and an API that throws, are "unavailable"', async () => {
    for (const coords of [
      { longitude: NaN, latitude: 35.2258 },
      { longitude: -80.8528, latitude: 135 },
      { longitude: '-80.85' as unknown as number, latitude: 35.2258 },
    ]) {
      expect(failureOf(await currentPosition({ geolocation: fakeGeolocation({ coords }).geolocation, secureContext: true })).kind).toBe('unavailable')
    }
    const throwing: GeolocationLike = {
      getCurrentPosition() {
        throw new Error('not allowed here')
      },
    }
    expect(failureOf(await currentPosition({ geolocation: throwing, secureContext: true })).kind).toBe('unavailable')
  })
})
