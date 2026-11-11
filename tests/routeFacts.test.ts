import { describe, expect, it } from 'vitest'
import {
  delayVsTypicalSec,
  formatDataMonth,
  formatDelay,
  formatDistance,
  formatDuration,
  formatLatLng,
  type RouteCandidate,
} from '../src/core/index.ts'
import { routeFeatures } from '../src/map/routeFeatures.ts'

function route(id: string, durationSec: number, typicalDurationSec: number | null = null): RouteCandidate {
  return {
    id,
    geometry: [
      [-80.84, 35.22],
      [-80.83, 35.15],
    ],
    durationSec,
    typicalDurationSec,
    distanceM: 9000,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: null,
    maneuvers: [],
  }
}

describe('delayVsTypicalSec', () => {
  it('is positive when slower than typical and negative when faster', () => {
    expect(delayVsTypicalSec(route('a', 900, 780))).toBe(120)
    expect(delayVsTypicalSec(route('a', 840, 860))).toBe(-20)
    expect(delayVsTypicalSec(route('a', 600, 600))).toBe(0)
  })

  it('is null, not a guess, when there is no typical duration', () => {
    expect(delayVsTypicalSec(route('a', 900, null))).toBeNull()
    expect(delayVsTypicalSec(route('a', 900, NaN))).toBeNull()
    expect(delayVsTypicalSec(route('a', NaN, 780))).toBeNull()
  })
})

describe('formatDuration', () => {
  it('rounds to minutes and switches to hours at 60', () => {
    expect(formatDuration(840)).toBe('14 min')
    expect(formatDuration(869)).toBe('14 min')
    expect(formatDuration(870)).toBe('15 min')
    expect(formatDuration(3570)).toBe('1 h')
    expect(formatDuration(3600)).toBe('1 h')
    expect(formatDuration(3900)).toBe('1 h 5 min')
  })

  it('never shows less than a minute and refuses nonsense', () => {
    expect(formatDuration(0)).toBe('1 min')
    expect(formatDuration(10)).toBe('1 min')
    expect(formatDuration(-5)).toBe('n/a')
    expect(formatDuration(NaN)).toBe('n/a')
    expect(formatDuration(Infinity)).toBe('n/a')
  })
})

describe('formatDistance', () => {
  it('uses miles, one decimal under ten', () => {
    expect(formatDistance(1609.344)).toBe('1.0 mi')
    expect(formatDistance(9300)).toBe('5.8 mi')
    expect(formatDistance(16_050)).toBe('10 mi')
    expect(formatDistance(40_233.6)).toBe('25 mi')
  })

  it('uses feet under a tenth of a mile', () => {
    expect(formatDistance(0)).toBe('0 ft')
    expect(formatDistance(100)).toBe('330 ft')
    expect(formatDistance(161)).toBe('0.1 mi')
  })

  it('refuses nonsense', () => {
    expect(formatDistance(-1)).toBe('n/a')
    expect(formatDistance(NaN)).toBe('n/a')
  })
})

describe('formatDelay', () => {
  it('says slower, faster, or about typical', () => {
    expect(formatDelay(180)).toBe('3 min slower than typical')
    expect(formatDelay(-120)).toBe('2 min faster than typical')
    expect(formatDelay(20)).toBe('About the typical time')
    expect(formatDelay(-29)).toBe('About the typical time')
    expect(formatDelay(0)).toBe('About the typical time')
  })

  it('says so when there is no typical time', () => {
    expect(formatDelay(null)).toBe('No typical time available')
    expect(formatDelay(NaN)).toBe('No typical time available')
  })
})

describe('formatLatLng', () => {
  it('puts latitude first for reading', () => {
    expect(formatLatLng([-80.84312, 35.22714])).toBe('35.2271, -80.8431')
  })
})

describe('formatDataMonth', () => {
  it('names the month a dataset dates from, in UTC, or nothing', () => {
    expect(formatDataMonth(Date.UTC(2026, 10, 10, 21, 21, 39))).toBe('Nov 2026')
    // The last second of a month and the first of the next, wherever the reader is.
    expect(formatDataMonth(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('Dec 2026')
    expect(formatDataMonth(Date.UTC(2027, 0, 1))).toBe('Jan 2027')
    expect(formatDataMonth(null)).toBeNull()
    expect(formatDataMonth(NaN)).toBeNull()
    expect(formatDataMonth(8.7e15)).toBeNull()
  })
})

describe('routeFeatures', () => {
  it('makes one line per route and flags the selected one', () => {
    const fc = routeFeatures([route('a', 900), route('b', 840)], 'b')
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features.map((f) => f.properties)).toEqual([
      { id: 'a', selected: false },
      { id: 'b', selected: true },
    ])
    expect(fc.features[0]!.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-80.84, 35.22],
        [-80.83, 35.15],
      ],
    })
  })

  it('is empty with no routes and selects nothing for an unknown id', () => {
    expect(routeFeatures([], null).features).toEqual([])
    expect(routeFeatures([route('a', 900)], 'gone').features[0]!.properties.selected).toBe(false)
  })
})
