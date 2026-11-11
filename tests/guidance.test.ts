import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  armGuidance,
  arrowKind,
  dueAnnouncement,
  nextTurn,
  synthesizeAnnouncements,
  type GuidanceCursor,
  type GuidanceStep,
} from '../src/core/index.ts'
import { parseDirections } from '../src/providers/mapbox/adapter.ts'
import { buildDirectionsUrl } from '../src/providers/mapbox/client.ts'
import { at } from './helpers/driveWorld.ts'

// Turn guidance: what the Mapbox adapter carries per route (banner and voice instructions,
// or instructions made up from the steps), and the pure functions that pick what to show
// and what to say. Hand-written bodies; no network.

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
}

function guidanceOf(body: unknown): readonly GuidanceStep[] {
  const result = parseDirections(body)
  if (!result.ok) throw new Error(`expected routes, got ${result.kind}`)
  return result.routes[0]!.guidance ?? []
}

/** A made-up route: set off, turn left 1 km on, turn right at 3 km, arrive at 3.5 km. */
const STEPS: readonly GuidanceStep[] = [
  { atDistanceM: 0, location: at(0, 0), type: 'depart', modifier: null, primaryText: 'First Road', secondaryText: null, announcements: [], synthesized: false },
  {
    atDistanceM: 1000,
    location: at(1000, 0),
    type: 'turn',
    modifier: 'left',
    primaryText: 'Second Road',
    secondaryText: 'North',
    announcements: [
      { atDistanceM: 0, text: 'Drive east on First Road. Then, in half a mile, turn left onto Second Road.' },
      { atDistanceM: 600, text: 'In a quarter mile, turn left onto Second Road.' },
      { atDistanceM: 920, text: 'Turn left onto Second Road.' },
    ],
    synthesized: false,
  },
  {
    atDistanceM: 3000,
    location: at(1000, 2000),
    type: 'turn',
    modifier: 'right',
    primaryText: 'Third Road',
    secondaryText: null,
    announcements: [
      { atDistanceM: 1000, text: 'Continue on Second Road for 1 mile.' },
      { atDistanceM: 2200, text: 'In half a mile, turn right onto Third Road.' },
      { atDistanceM: 2920, text: 'Turn right onto Third Road.' },
    ],
    synthesized: false,
  },
  {
    atDistanceM: 3500,
    location: at(1500, 2000),
    type: 'arrive',
    modifier: 'right',
    primaryText: 'Your destination',
    secondaryText: null,
    announcements: [{ atDistanceM: 3440, text: 'Your destination is on the right.' }],
    synthesized: false,
  },
]

/** Drives the route in steps and collects what is said, with the distance it was said at. */
function said(guidance: readonly GuidanceStep[], alongs: readonly number[], start: GuidanceCursor): [number, string][] {
  const lines: [number, string][] = []
  let cursor = start
  for (const alongM of alongs) {
    const due = dueAnnouncement(guidance, cursor, alongM)
    cursor = due.cursor
    if (due.say !== null) lines.push([alongM, due.say.text])
  }
  return lines
}

const every = (stepM: number, fromM: number, toM: number) => Array.from({ length: Math.floor((toM - fromM) / stepM) + 1 }, (_, i) => fromM + i * stepM)

describe('Mapbox adapter: banner and voice instructions', () => {
  const guidance = guidanceOf(fixture('directions.guidance.json'))

  it('gives one entry per maneuver, each placed at the start of its step', () => {
    expect(guidance.map((g) => [g.type, g.modifier, g.atDistanceM])).toEqual([
      ['depart', null, 0],
      ['turn', 'right', 500],
      ['arrive', 'left', 2000],
    ])
    expect(guidance[1]!.location).toEqual([-80.847, 35.2238])
  })

  it('takes a maneuver its banner and voice from the step that leads to it', () => {
    const turn = guidance[1]!
    expect(turn.primaryText).toBe('West Morehead Street')
    expect(turn.secondaryText).toBe('US 29')
    expect(turn.synthesized).toBe(false)
    // distanceAlongGeometry is meters before the maneuver: 500 m before a maneuver at
    // 500 m is the start of the route, 80 m before it is 420 m along. In driving order,
    // plain text (never the SSML), unusable entries left out.
    expect(turn.announcements).toEqual([
      { atDistanceM: 0, text: 'Drive southwest on South Tryon Street. Then, in a quarter mile, turn right onto West Morehead Street.' },
      { atDistanceM: 420, text: 'Turn right onto West Morehead Street.' },
    ])
    // Setting off has nothing leading to it.
    expect(guidance[0]).toMatchObject({ primaryText: 'South Tryon Street', announcements: [], synthesized: false })
  })

  it('makes simple instructions from the step maneuver where Mapbox sent none, and says so', () => {
    const arrive = guidance[2]!
    expect(arrive.synthesized).toBe(true)
    expect(arrive.primaryText).toBe('West Morehead Street')
    expect(arrive.secondaryText).toBeNull()
    expect(arrive.announcements).toEqual([
      { atDistanceM: 1200, text: 'In 0.4 miles, you have arrived at your destination, on the left.' },
      { atDistanceM: 1910, text: 'You have arrived at your destination, on the left.' },
    ])
  })

  it('a response without any banner or voice fields still gives guidance for every maneuver', () => {
    const plain = guidanceOf(fixture('directions.ok.json'))
    expect(plain.map((g) => g.type)).toEqual(['depart', 'turn', 'fork', 'arrive'])
    expect(plain.slice(1).every((g) => g.synthesized && g.announcements.length > 0)).toBe(true)
    expect(plain[1]).toMatchObject({ modifier: 'left', atDistanceM: 800.5 })
    expect(plain[1]!.announcements.at(-1)!.atDistanceM).toBeCloseTo(710.5)
    // No steps at all: no guidance, and the route is still a route.
    const bare = parseDirections({ code: 'Ok', routes: [{ duration: 60, distance: 500, geometry: { coordinates: [[-80.84, 35.22], [-80.85, 35.22]] } }] })
    expect(bare.ok && bare.routes[0]!.guidance).toEqual([])
  })

  it('asks Mapbox for both, with imperial distances in the spoken text', () => {
    const query = new URL(buildDirectionsUrl([-80.8431, 35.2271], [-80.8295, 35.1527], 'pk.test-token')!).searchParams
    expect(query.get('steps')).toBe('true')
    expect(query.get('banner_instructions')).toBe('true')
    expect(query.get('voice_instructions')).toBe('true')
    expect(query.get('voice_units')).toBe('imperial')
  })
})

describe('what to show', () => {
  it('shows the first maneuver still ahead, with the distance to it', () => {
    expect(nextTurn(STEPS, 0)).toMatchObject({ arrow: 'left', distanceM: 1000, primaryText: 'Second Road', secondaryText: 'North' })
    expect(nextTurn(STEPS, 640)).toMatchObject({ arrow: 'left', distanceM: 360 })
    // In the middle of the turn it is still the one shown; a little past it, the next.
    expect(nextTurn(STEPS, 1010)).toMatchObject({ arrow: 'left', distanceM: 0 })
    expect(nextTurn(STEPS, 1020)).toMatchObject({ arrow: 'right', distanceM: 1980, primaryText: 'Third Road' })
    expect(nextTurn(STEPS, 3100)).toMatchObject({ arrow: 'arrive', distanceM: 400 })
    expect(nextTurn(STEPS, 3600)).toBeNull()
    expect(nextTurn(undefined, 0)).toBeNull()
    expect(nextTurn([STEPS[0]!], 0)).toBeNull()
  })

  it('names an arrow for every kind of maneuver', () => {
    expect(arrowKind('turn', 'sharp left')).toBe('sharp-left')
    expect(arrowKind('fork', 'slight right')).toBe('slight-right')
    expect(arrowKind('off ramp', 'right')).toBe('right')
    expect(arrowKind('continue', 'uturn')).toBe('uturn')
    expect(arrowKind('merge', 'slight left')).toBe('slight-left')
    expect(arrowKind('merge', null)).toBe('merge')
    expect(arrowKind('rotary', 'left')).toBe('roundabout')
    expect(arrowKind('arrive', 'left')).toBe('arrive')
    expect(arrowKind('new name', null)).toBe('straight')
    expect(arrowKind('something new', 'sideways')).toBe('straight')
  })
})

describe('what to say', () => {
  it('says each announcement once, where it becomes due', () => {
    const lines = said(STEPS, every(15, 0, 3500), armGuidance(STEPS, 0, true))
    expect(lines).toEqual([
      [0, 'Drive east on First Road. Then, in half a mile, turn left onto Second Road.'],
      [600, 'In a quarter mile, turn left onto Second Road.'],
      [930, 'Turn left onto Second Road.'],
      [1005, 'Continue on Second Road for 1 mile.'],
      [2205, 'In half a mile, turn right onto Third Road.'],
      [2925, 'Turn right onto Third Road.'],
      [3450, 'Your destination is on the right.'],
    ])
  })

  it('never repeats one, standing still or moving back', () => {
    let cursor = armGuidance(STEPS, 0, true)
    const first = dueAnnouncement(STEPS, cursor, 610)
    expect(first.say).toEqual({ text: 'In a quarter mile, turn left onto Second Road.', distanceToManeuverM: 390 })
    cursor = first.cursor
    for (const alongM of [610, 612, 605, 580, 610, 640]) {
      const again = dueAnnouncement(STEPS, cursor, alongM)
      expect(again.say).toBeNull()
      // Nothing new: the very same cursor comes back.
      expect(again.cursor).toBe(cursor)
    }
  })

  it('after a gap says only the newest line that still matters, not the backlog', () => {
    // From 500 m straight to 2950 m (a tunnel): five lines became due; one is still about a turn ahead.
    const cursor = dueAnnouncement(STEPS, armGuidance(STEPS, 0, true), 500).cursor
    const after = dueAnnouncement(STEPS, cursor, 2950)
    expect(after.say).toEqual({ text: 'Turn right onto Third Road.', distanceToManeuverM: 50 })
    expect(dueAnnouncement(STEPS, after.cursor, 2960).say).toBeNull()
    // Past the turn altogether: nothing stale is said.
    expect(dueAnnouncement(STEPS, cursor, 3100).say).toBeNull()
  })

  it('is re-armed for a new route: lines behind the car are dropped, the rest come when due', () => {
    // After a switch the car is 30 m into the new route: its opening line is not spoken
    // (the switch announcement has just said what comes next).
    const switched = said(STEPS, every(15, 30, 1000), armGuidance(STEPS, 30, false))
    expect(switched.map(([, text]) => text)).toEqual(['In a quarter mile, turn left onto Second Road.', 'Turn left onto Second Road.'])
    // Taken up in the middle (the previous route kept): only what is still ahead.
    const kept = said(STEPS, every(15, 2300, 3500), armGuidance(STEPS, 2300, false))
    expect(kept.map(([, text]) => text)).toEqual(['Turn right onto Third Road.', 'Your destination is on the right.'])
    // A fresh cursor on the same route speaks again: "once" is per cursor, so per route driven.
    expect(said(STEPS, [0], armGuidance(STEPS, 0, true))).toHaveLength(1)
    // No guidance: nothing to say, and nothing breaks.
    expect(dueAnnouncement(undefined, armGuidance(undefined, 0, true), 500).say).toBeNull()
  })
})

describe('made-up announcements', () => {
  it('gives one ahead and one at the turn on a long approach', () => {
    expect(synthesizeAnnouncements('Turn left onto Main Street.', 0, 5000)).toEqual([
      { atDistanceM: 4200, text: 'In 0.4 miles, turn left onto Main Street.' },
      { atDistanceM: 4910, text: 'Turn left onto Main Street.' },
    ])
  })

  it('on a short approach, only the instruction, and never before the approach begins', () => {
    expect(synthesizeAnnouncements('Turn right.', 950, 1000)).toEqual([{ atDistanceM: 950, text: 'Turn right.' }])
    expect(synthesizeAnnouncements('Turn right.', 600, 1000)).toEqual([
      { atDistanceM: 600, text: 'In 0.2 miles, turn right.' },
      { atDistanceM: 910, text: 'Turn right.' },
    ])
    expect(synthesizeAnnouncements('  ', 0, 1000)).toEqual([])
    // A road number at the start is not lower-cased.
    expect(synthesizeAnnouncements('I-77 South continues.', 0, 2000)[0]!.text).toBe('In 0.4 miles, I-77 South continues.')
  })
})
