import { describe, expect, it } from 'vitest'
import {
  addCustomPlace,
  addRecent,
  cleanPlaceName,
  CURRENT_LOCATION_ID,
  DEFAULT_TRIP,
  EMPTY_PLACE_BOOK,
  isSamePlace,
  MAX_CUSTOM_PLACES,
  MAX_RECENTS,
  parsePlaceBook,
  removeSavedPlace,
  renameCustomPlace,
  restoreTrip,
  savedPlaceAsPlace,
  savedPlaces,
  serializePlaceBook,
  setLastTrip,
  setSlot,
  toStoredTrip,
  type LngLat,
  type Place,
  type PlaceBook,
} from '../src/core/index.ts'
import { localTextStore, memoryTextStore, type StorageLike } from '../src/storage/local.ts'
import { clearPlaceBook, loadPlaceBook, PLACE_BOOK_KEY, savePlaceBook } from '../src/storage/placeBook.ts'

// Public landmarks only: no test, fixture or stored book here holds a private address.
const place = (id: string, label: string, position: LngLat): Place => ({ id, label, position })
const STADIUM = place('mapbox:stadium', 'Bank of America Stadium', [-80.8528, 35.2258])
const AIRPORT = place('mapbox:airport', 'Charlotte Douglas International Airport', [-80.9431, 35.214])
const MALL = place('mapbox:mall', 'SouthPark Mall', [-80.8303, 35.1517])
const PARK = place('mapbox:park', 'Carowinds', [-80.9414, 35.1037])
const HERE = place(CURRENT_LOCATION_ID, 'My location', [-80.8431, 35.2271])

/** A point `meters` north of a place, under another id. */
function north(of: Place, meters: number, label = of.label): Place {
  return place(`${of.id}-north-${meters}`, label, [of.position[0], of.position[1] + meters / 111_320])
}

function added(book: PlaceBook, name: string, at: Place): PlaceBook {
  const change = addCustomPlace(book, name, at)
  expect(change.problem, name).toBeNull()
  return change.book
}

describe('saved places', () => {
  it('sets and empties Home and Work, under their fixed names', () => {
    let book = setSlot(EMPTY_PLACE_BOOK, 'home', STADIUM)
    book = setSlot(book, 'work', AIRPORT)
    expect(book.home).toEqual({ id: 'home', name: 'Home', label: 'Bank of America Stadium', position: STADIUM.position })
    expect(savedPlaces(book).map((p) => p.name)).toEqual(['Home', 'Work'])
    // As a pin, a saved place goes by its name.
    expect(savedPlaceAsPlace(book.work!)).toEqual({ id: 'work', label: 'Work', position: AIRPORT.position })
    book = setSlot(book, 'home', null)
    expect(book.home).toBeNull()
    expect(savedPlaces(book).map((p) => p.id)).toEqual(['work'])
    expect(EMPTY_PLACE_BOOK).toEqual({ home: null, work: null, custom: [], recents: [], lastTrip: null })
  })

  it('adds named places with tidy names and ids that are never reused', () => {
    let book = added(EMPTY_PLACE_BOOK, '  The   mall ', MALL)
    book = added(book, 'Rides', PARK)
    expect(book.custom).toEqual([
      { id: 'custom-1', name: 'The mall', label: 'SouthPark Mall', position: MALL.position },
      { id: 'custom-2', name: 'Rides', label: 'Carowinds', position: PARK.position },
    ])
    book = removeSavedPlace(book, 'custom-1')
    book = added(book, 'Flights', AIRPORT)
    expect(book.custom.map((p) => p.id)).toEqual(['custom-2', 'custom-3'])
    expect(savedPlaces(setSlot(book, 'work', STADIUM)).map((p) => p.name)).toEqual(['Work', 'Rides', 'Flights'])
  })

  it('updates a place saved again under the same name instead of listing it twice', () => {
    let book = added(EMPTY_PLACE_BOOK, 'Game day', STADIUM)
    book = added(book, 'game DAY', MALL)
    expect(book.custom).toEqual([{ id: 'custom-1', name: 'game DAY', label: 'SouthPark Mall', position: MALL.position }])
  })

  it('refuses an empty name, Home and Work as names, and a seventh place, saying why', () => {
    expect(addCustomPlace(EMPTY_PLACE_BOOK, '   ', MALL)).toEqual({ book: EMPTY_PLACE_BOOK, problem: 'Give the place a name first.' })
    expect(addCustomPlace(EMPTY_PLACE_BOOK, ' home ', MALL).problem).toContain('built-in place')
    expect(addCustomPlace(EMPTY_PLACE_BOOK, 'WORK', MALL).problem).toContain('built-in place')
    let book = EMPTY_PLACE_BOOK
    for (let i = 1; i <= MAX_CUSTOM_PLACES; i++) book = added(book, `Gate ${i}`, AIRPORT)
    const full = addCustomPlace(book, 'One more', AIRPORT)
    expect(full.book).toBe(book)
    expect(full.problem).toBe('You can keep 6 named places. Remove one first.')
    // A name already in the full list is still an update.
    expect(addCustomPlace(book, 'gate 3', PARK).problem).toBeNull()
  })

  it('cuts a long name to 40 characters', () => {
    expect(cleanPlaceName('x'.repeat(60))).toHaveLength(40)
    expect(cleanPlaceName(` ${'a'.repeat(39)}  b`)).toBe('a'.repeat(39))
    expect(added(EMPTY_PLACE_BOOK, 'y'.repeat(60), MALL).custom[0]!.name).toHaveLength(40)
  })

  it('renames a named place, and refuses a name that is empty, built in or taken', () => {
    let book = added(EMPTY_PLACE_BOOK, 'Mall', MALL)
    book = added(book, 'Rides', PARK)
    const renamed = renameCustomPlace(book, 'custom-1', ' Shopping ')
    expect(renamed.problem).toBeNull()
    expect(renamed.book.custom.map((p) => p.name)).toEqual(['Shopping', 'Rides'])
    expect(renamed.book.custom[0]!.position).toEqual(MALL.position)
    expect(renameCustomPlace(book, 'custom-1', '').problem).toBe('Give the place a name first.')
    expect(renameCustomPlace(book, 'custom-1', 'Work').problem).toContain('built-in place')
    expect(renameCustomPlace(book, 'custom-1', 'rides').problem).toBe('Another place is already called "rides".')
    expect(renameCustomPlace(book, 'custom-9', 'Else').problem).toBe('That place is no longer saved.')
    // Changing only the case of its own name is fine.
    expect(renameCustomPlace(book, 'custom-1', 'MALL').book.custom[0]!.name).toBe('MALL')
    for (const refused of [renameCustomPlace(book, 'custom-1', ''), renameCustomPlace(book, 'custom-9', 'Else')]) {
      expect(refused.book).toBe(book)
    }
  })

  it('removes by id and leaves the book alone for an id it does not know', () => {
    let book = setSlot(added(EMPTY_PLACE_BOOK, 'Mall', MALL), 'home', STADIUM)
    expect(removeSavedPlace(book, 'nope')).toBe(book)
    expect(removeSavedPlace(book, 'work')).toBe(book)
    book = removeSavedPlace(book, 'home')
    expect(book.home).toBeNull()
    expect(removeSavedPlace(book, 'custom-1').custom).toEqual([])
  })
})

describe('recent destinations', () => {
  it('tells the same place by closeness, or by the same name close by', () => {
    expect(isSamePlace(STADIUM, north(STADIUM, 40, 'Stadium, north gate'))).toBe(true)
    expect(isSamePlace(STADIUM, north(STADIUM, 60, 'Stadium, north gate'))).toBe(false)
    // The same name: one place up to 300 m, two places beyond.
    expect(isSamePlace(MALL, north(MALL, 250, ' southpark mall '))).toBe(true)
    expect(isSamePlace(MALL, north(MALL, 350))).toBe(false)
    expect(isSamePlace(STADIUM, AIRPORT)).toBe(false)
  })

  it('lists newest first, without repeats, moving a place searched again to the top', () => {
    let book = EMPTY_PLACE_BOOK
    for (const p of [STADIUM, AIRPORT, MALL]) book = addRecent(book, p)
    expect(book.recents.map((p) => p.label)).toEqual(['SouthPark Mall', 'Charlotte Douglas International Airport', 'Bank of America Stadium'])
    // The stadium again, from a result 30 m away under another id: one entry, the newer one, on top.
    const again = north(STADIUM, 30)
    book = addRecent(book, again)
    expect(book.recents).toHaveLength(3)
    expect(book.recents[0]).toBe(again)
    expect(book.recents.map((p) => p.label)).toEqual(['Bank of America Stadium', 'SouthPark Mall', 'Charlotte Douglas International Airport'])
  })

  it('keeps the last 8', () => {
    let book = EMPTY_PLACE_BOOK
    for (let i = 0; i < 12; i++) book = addRecent(book, place(`gate-${i}`, `Gate ${i}`, [-80.94 + i * 0.01, 35.21]))
    expect(MAX_RECENTS).toBe(8)
    expect(book.recents.map((p) => p.label)).toEqual(['Gate 11', 'Gate 10', 'Gate 9', 'Gate 8', 'Gate 7', 'Gate 6', 'Gate 5', 'Gate 4'])
  })

  it('never lists the device position or a place that is nowhere', () => {
    expect(addRecent(EMPTY_PLACE_BOOK, HERE)).toBe(EMPTY_PLACE_BOOK)
    expect(addRecent(EMPTY_PLACE_BOOK, place('bad', 'Nowhere', [0, 95]))).toBe(EMPTY_PLACE_BOOK)
  })
})

describe('last trip', () => {
  it('keeps a trip, but never the device position', () => {
    expect(toStoredTrip({ origin: STADIUM, destination: MALL })).toEqual({ origin: STADIUM, destination: MALL })
    expect(toStoredTrip({ origin: HERE, destination: MALL })).toEqual({ origin: null, destination: MALL })
    // Swapped, so the trip ends at the device position: nothing to keep.
    expect(toStoredTrip({ origin: MALL, destination: HERE })).toBeNull()
  })

  it('restores the stored trip, filling an origin that was not kept from the fallback', () => {
    expect(restoreTrip(null, DEFAULT_TRIP)).toBe(DEFAULT_TRIP)
    expect(restoreTrip({ origin: STADIUM, destination: MALL }, DEFAULT_TRIP)).toEqual({ origin: STADIUM, destination: MALL })
    expect(restoreTrip({ origin: null, destination: MALL }, DEFAULT_TRIP)).toEqual({ origin: DEFAULT_TRIP.origin, destination: MALL })
  })

  it('returns the same book when the trip did not change, so nothing is written', () => {
    const book = setLastTrip(EMPTY_PLACE_BOOK, { origin: STADIUM, destination: MALL })
    expect(book.lastTrip).toEqual({ origin: STADIUM, destination: MALL })
    expect(setLastTrip(book, { origin: { ...STADIUM }, destination: { ...MALL } })).toBe(book)
    expect(setLastTrip(EMPTY_PLACE_BOOK, null)).toBe(EMPTY_PLACE_BOOK)
    expect(setLastTrip(book, { origin: null, destination: MALL })).not.toBe(book)
    expect(setLastTrip(book, { origin: STADIUM, destination: PARK }).lastTrip!.destination).toBe(PARK)
    expect(setLastTrip(book, null).lastTrip).toBeNull()
  })
})

describe('parsePlaceBook', () => {
  const full = (): PlaceBook => {
    let book = setSlot(EMPTY_PLACE_BOOK, 'home', STADIUM)
    book = added(book, 'Rides', PARK)
    book = addRecent(addRecent(book, AIRPORT), MALL)
    return setLastTrip(book, { origin: null, destination: MALL })
  }

  it('reads back exactly what was stored', () => {
    const book = full()
    const stored: unknown = JSON.parse(JSON.stringify(serializePlaceBook(book)))
    expect(stored).toMatchObject({ version: 1 })
    expect(parsePlaceBook(stored)).toEqual(book)
    expect(parsePlaceBook(JSON.parse(JSON.stringify(serializePlaceBook(EMPTY_PLACE_BOOK))))).toEqual(EMPTY_PLACE_BOOK)
  })

  it('discards anything that is not a book of this version', () => {
    for (const raw of [null, undefined, 'text', 7, [], {}, { version: 2, home: null }, { version: '1' }, { home: STADIUM }]) {
      expect(parsePlaceBook(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('drops damaged entries one by one and keeps the good ones', () => {
    const book = parsePlaceBook({
      version: 1,
      home: { id: 'home', name: 'Home', label: 'Bank of America Stadium', position: [-80.8528, 35.2258] },
      // Latitude and longitude the wrong way round: not a place on Earth.
      work: { id: 'work', name: 'Work', label: 'Airport', position: [35.214, -180.9431] },
      custom: [
        { id: 'custom-1', name: 'Rides', label: 'Carowinds', position: [-80.9414, 35.1037] },
        { id: 'custom-2', name: '', label: 'No name', position: [-80.9414, 35.1037] },
        { id: 'custom-3', name: 'Home', label: 'A reserved name', position: [-80.9414, 35.1037] },
        { id: 'custom-4', name: 'Text position', label: 'Mall', position: '-80.83,35.15' },
        { id: 'custom-1', name: 'Same id', label: 'Mall', position: [-80.8303, 35.1517] },
        { id: 'custom-5', name: 'rides', label: 'Same name', position: [-80.8303, 35.1517] },
        { id: 7, name: 'Number id', label: 'Mall', position: [-80.8303, 35.1517] },
        null,
      ],
      recents: [MALL, { id: 'x', label: '', position: [-80.8303, 35.1517] }, 'junk', { id: 'y', label: 'Three numbers', position: [1, 2, 3] }, AIRPORT],
      lastTrip: { origin: { id: 'gone' }, destination: PARK },
    })!
    expect(book.home?.label).toBe('Bank of America Stadium')
    expect(book.work).toBeNull()
    expect(book.custom).toEqual([{ id: 'custom-1', name: 'Rides', label: 'Carowinds', position: [-80.9414, 35.1037] }])
    expect(book.recents).toEqual([MALL, AIRPORT])
    // A damaged origin reads as "not kept"; a damaged destination loses the trip.
    expect(book.lastTrip).toEqual({ origin: null, destination: PARK })
    expect(parsePlaceBook({ version: 1, lastTrip: { origin: STADIUM, destination: null } })!.lastTrip).toBeNull()
    expect(parsePlaceBook({ version: 1, custom: 'none', recents: {}, lastTrip: 'yesterday' })).toEqual(EMPTY_PLACE_BOOK)
  })

  it('applies the caps and the no-repeat rule again, trusting nothing', () => {
    const gates = Array.from({ length: 20 }, (_, i) => ({ id: `g${i}`, name: `Gate ${i}`, label: `Gate ${i}`, position: [-80.94 + i * 0.01, 35.21] }))
    const book = parsePlaceBook({ version: 1, custom: gates, recents: [...gates.slice(0, 3), gates[0], ...gates.slice(3)] })!
    expect(book.custom).toHaveLength(MAX_CUSTOM_PLACES)
    expect(book.recents).toHaveLength(MAX_RECENTS)
    expect(book.recents.map((p) => p.label).slice(0, 4)).toEqual(['Gate 0', 'Gate 1', 'Gate 2', 'Gate 3'])
  })

  it('never reads the device position back, and takes Home and Work names from the slot', () => {
    const book = parsePlaceBook({
      version: 1,
      home: { id: 'elsewhere', name: 'Not home', label: 'SouthPark Mall', position: MALL.position },
      recents: [HERE],
      lastTrip: { origin: HERE, destination: MALL },
    })!
    expect(book.home).toEqual({ id: 'home', name: 'Home', label: 'SouthPark Mall', position: MALL.position })
    expect(book.recents).toEqual([])
    expect(book.lastTrip).toEqual({ origin: null, destination: MALL })
    expect(parsePlaceBook({ version: 1, home: { ...MALL, label: 'm'.repeat(500) } })!.home!.label).toHaveLength(160)
  })
})

/** A stand-in for localStorage that can be made to refuse. */
function fakeStorage(options: { failRead?: boolean; failWrite?: boolean } = {}) {
  const items = new Map<string, string>()
  const storage: StorageLike = {
    getItem(key) {
      if (options.failRead) throw new DOMException('blocked', 'SecurityError')
      return items.get(key) ?? null
    },
    setItem(key, value) {
      if (options.failWrite) throw new DOMException('full', 'QuotaExceededError')
      items.set(key, value)
    },
    removeItem(key) {
      if (options.failWrite) throw new DOMException('blocked', 'SecurityError')
      items.delete(key)
    },
  }
  return { storage, items, options }
}

describe('text stores', () => {
  it('memory: reads back what was written, and forgets what was removed', () => {
    const store = memoryTextStore({ seeded: 'yes' })
    expect(store.read('seeded')).toBe('yes')
    expect(store.read('missing')).toBeNull()
    expect(store.write('k', 'v')).toBe(true)
    expect(store.read('k')).toBe('v')
    expect(store.remove('k')).toBe(true)
    expect(store.read('k')).toBeNull()
    expect(store.remove('k')).toBe(true)
  })

  it('local: goes through the storage it is given', () => {
    const { storage, items } = fakeStorage()
    const store = localTextStore(storage)
    expect(store.write('k', 'v')).toBe(true)
    expect(items.get('k')).toBe('v')
    expect(store.read('k')).toBe('v')
    expect(store.remove('k')).toBe(true)
    expect(items.size).toBe(0)
  })

  it('local: a storage that throws reads as empty and reports the failed write, without throwing', () => {
    const blocked = localTextStore(fakeStorage({ failRead: true, failWrite: true }).storage)
    expect(blocked.read('k')).toBeNull()
    expect(blocked.write('k', 'v')).toBe(false)
    expect(blocked.remove('k')).toBe(false)
  })

  it('local: a full storage keeps what it had', () => {
    const fake = fakeStorage()
    const store = localTextStore(fake.storage)
    store.write('k', 'old')
    fake.options.failWrite = true
    expect(store.write('k', 'new')).toBe(false)
    expect(store.read('k')).toBe('old')
  })

  it('local: with no storage at all (Node, storage switched off) it is a memory store', () => {
    const store = localTextStore(null)
    expect(store.write('k', 'v')).toBe(true)
    expect(store.read('k')).toBe('v')
    // Vitest runs in Node: the default is the same fallback, and must not throw.
    expect(localTextStore().read('k')).toBeNull()
  })
})

describe('place book on the device', () => {
  it('uses one versioned key', () => {
    expect(PLACE_BOOK_KEY).toBe('routeiq.places.v1')
  })

  it('saves, loads and clears', () => {
    const store = memoryTextStore()
    expect(loadPlaceBook(store)).toBe(EMPTY_PLACE_BOOK)
    const book = addRecent(setSlot(EMPTY_PLACE_BOOK, 'work', AIRPORT), MALL)
    expect(savePlaceBook(store, book)).toBe(true)
    expect(JSON.parse(store.read(PLACE_BOOK_KEY)!)).toMatchObject({ version: 1, work: { name: 'Work' } })
    expect(loadPlaceBook(store)).toEqual(book)
    expect(clearPlaceBook(store)).toBe(true)
    expect(store.read(PLACE_BOOK_KEY)).toBeNull()
    expect(loadPlaceBook(store)).toBe(EMPTY_PLACE_BOOK)
  })

  it('discards corrupt data: not JSON, the wrong version, the wrong shape', () => {
    for (const text of ['{"version":1,"home":', 'null', '[]', '"text"', '{"version":0}', '{"home":{}}']) {
      const store = memoryTextStore({ [PLACE_BOOK_KEY]: text })
      expect(loadPlaceBook(store), text).toBe(EMPTY_PLACE_BOOK)
      // What could not be read is removed, not left to be tripped over again.
      expect(store.read(PLACE_BOOK_KEY), text).toBeNull()
    }
  })

  it('keeps a good book whose entries are partly damaged', () => {
    const text = JSON.stringify({ version: 1, home: { id: 'home', label: 'Carowinds', position: [-80.9414, 35.1037] }, recents: [{ bad: true }, MALL] })
    const store = memoryTextStore({ [PLACE_BOOK_KEY]: text })
    const book = loadPlaceBook(store)
    expect(book.home?.label).toBe('Carowinds')
    expect(book.recents).toEqual([MALL])
    expect(store.read(PLACE_BOOK_KEY)).toBe(text)
  })

  it('tolerates storage that is blocked or full', () => {
    const blocked = localTextStore(fakeStorage({ failRead: true, failWrite: true }).storage)
    expect(loadPlaceBook(blocked)).toBe(EMPTY_PLACE_BOOK)
    expect(savePlaceBook(blocked, setSlot(EMPTY_PLACE_BOOK, 'home', STADIUM))).toBe(false)
    expect(clearPlaceBook(blocked)).toBe(false)
  })
})
