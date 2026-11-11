import { distanceM, isValidLngLat } from './geo.ts'
import type { LngLat, Place } from './types.ts'

/**
 * Saved places, recent destinations and the last trip: the "place book" kept
 * on the device. Everything here is plain data in, plain data out. Where the
 * book is kept (the browser's local storage today, a file or the keychain in
 * a native app) is not this module's business: see src/storage/placeBook.ts.
 */

/** Bumped when the stored shape changes; a book of another version is discarded, not migrated. */
export const PLACE_BOOK_VERSION = 1
/** Named places besides Home and Work. */
export const MAX_CUSTOM_PLACES = 6
export const MAX_RECENTS = 8
export const MAX_PLACE_NAME_LENGTH = 40
/** Longest label kept for a stored place; a longer one is cut, never rejected. */
export const MAX_PLACE_LABEL_LENGTH = 160
/** Two places this close together are the same place, whatever they are called. */
export const SAME_PLACE_M = 50
/** Two places with the same name are the same place up to this distance (two entrances of one mall). */
export const SAME_NAME_PLACE_M = 300

/** The id of a pin set from the device's position. Such a place is never written to the book by itself. */
export const CURRENT_LOCATION_ID = 'current-location'

export type PlaceSlot = 'home' | 'work'
export const PLACE_SLOTS: readonly PlaceSlot[] = ['home', 'work']
export const SLOT_NAME: Readonly<Record<PlaceSlot, string>> = { home: 'Home', work: 'Work' }

/** A place the user named. `label` says what was saved (an address, a landmark, a dropped pin). */
export interface SavedPlace {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly position: LngLat
}

export interface Trip {
  readonly origin: Place
  readonly destination: Place
}

/** The last trip as stored. A null origin means "not kept": the origin was the device's position. */
export interface StoredTrip {
  readonly origin: Place | null
  readonly destination: Place
}

export interface PlaceBook {
  readonly home: SavedPlace | null
  readonly work: SavedPlace | null
  /** In the order they were added. */
  readonly custom: readonly SavedPlace[]
  /** Newest first. */
  readonly recents: readonly Place[]
  readonly lastTrip: StoredTrip | null
}

export const EMPTY_PLACE_BOOK: PlaceBook = { home: null, work: null, custom: [], recents: [], lastTrip: null }

/** Trimmed, inner whitespace collapsed, cut to the longest name allowed. May come back empty. */
export function cleanPlaceName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PLACE_NAME_LENGTH).trim()
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * True when two places are one place for the lists: within SAME_PLACE_M of
 * each other, or carrying the same label (ignoring case) within
 * SAME_NAME_PLACE_M. The same name far apart is two places (two branches of
 * one chain).
 */
export function isSamePlace(a: Place, b: Place): boolean {
  const apartM = distanceM(a.position, b.position)
  if (apartM <= SAME_PLACE_M) return true
  return sameText(a.label, b.label) && apartM <= SAME_NAME_PLACE_M
}

/** Home, Work, then the named places: the order they are listed in. */
export function savedPlaces(book: PlaceBook): SavedPlace[] {
  return [book.home, book.work, ...book.custom].filter((p): p is SavedPlace => p !== null)
}

/** A saved place as a pin: it is shown under the name the user gave it. */
export function savedPlaceAsPlace(saved: SavedPlace): Place {
  return { id: saved.id, label: saved.name, position: saved.position }
}

/** Sets Home or Work to a place, or empties the slot with null. */
export function setSlot(book: PlaceBook, slot: PlaceSlot, place: Place | null): PlaceBook {
  const saved: SavedPlace | null =
    place === null ? null : { id: slot, name: SLOT_NAME[slot], label: place.label, position: place.position }
  return { ...book, [slot]: saved }
}

export interface PlaceBookChange {
  readonly book: PlaceBook
  /** Why nothing changed, in words for the user; null when the change was made. */
  readonly problem: string | null
}

function nameProblem(name: string): string | null {
  if (name === '') return 'Give the place a name first.'
  if (PLACE_SLOTS.some((slot) => sameText(SLOT_NAME[slot], name)))
    return `"${name}" is already a built-in place. Use the ${name} button, or pick another name.`
  return null
}

function nextCustomId(custom: readonly SavedPlace[]): string {
  let highest = 0
  for (const { id } of custom) {
    const n = /^custom-(\d+)$/.exec(id)
    if (n !== null) highest = Math.max(highest, Number(n[1]))
  }
  return `custom-${highest + 1}`
}

/**
 * Adds a named place. A name already in use (ignoring case) is updated in
 * place instead of added twice. Refused, with the reason, when the name is
 * empty or is Home or Work, or when the list is full.
 */
export function addCustomPlace(book: PlaceBook, rawName: string, place: Place): PlaceBookChange {
  const name = cleanPlaceName(rawName)
  const problem = nameProblem(name)
  if (problem !== null) return { book, problem }
  const existing = book.custom.find((p) => sameText(p.name, name))
  if (existing !== undefined) {
    const updated: SavedPlace = { id: existing.id, name, label: place.label, position: place.position }
    return { book: { ...book, custom: book.custom.map((p) => (p === existing ? updated : p)) }, problem: null }
  }
  if (book.custom.length >= MAX_CUSTOM_PLACES)
    return { book, problem: `You can keep ${MAX_CUSTOM_PLACES} named places. Remove one first.` }
  const added: SavedPlace = { id: nextCustomId(book.custom), name, label: place.label, position: place.position }
  return { book: { ...book, custom: [...book.custom, added] }, problem: null }
}

/** Renames a named place. Refused when the name is empty, is Home or Work, or belongs to another place. */
export function renameCustomPlace(book: PlaceBook, id: string, rawName: string): PlaceBookChange {
  const name = cleanPlaceName(rawName)
  const problem = nameProblem(name)
  if (problem !== null) return { book, problem }
  if (!book.custom.some((p) => p.id === id)) return { book, problem: 'That place is no longer saved.' }
  if (book.custom.some((p) => p.id !== id && sameText(p.name, name)))
    return { book, problem: `Another place is already called "${name}".` }
  return { book: { ...book, custom: book.custom.map((p) => (p.id === id ? { ...p, name } : p)) }, problem: null }
}

/** Removes a saved place by id: 'home', 'work' or a named place's id. An unknown id changes nothing. */
export function removeSavedPlace(book: PlaceBook, id: string): PlaceBook {
  if (id === 'home' || id === 'work') return book[id] === null ? book : { ...book, [id]: null }
  if (!book.custom.some((p) => p.id === id)) return book
  return { ...book, custom: book.custom.filter((p) => p.id !== id) }
}

/**
 * Puts a destination at the head of the recent list. An entry for the same
 * place (isSamePlace) is replaced, not repeated, and the list is cut to
 * MAX_RECENTS. The device's own position is never listed.
 */
export function addRecent(book: PlaceBook, place: Place): PlaceBook {
  if (place.id === CURRENT_LOCATION_ID || !isValidLngLat(place.position)) return book
  const rest = book.recents.filter((p) => !isSamePlace(p, place))
  return { ...book, recents: [place, ...rest].slice(0, MAX_RECENTS) }
}

/**
 * What to keep of a trip so it can be restored. The device's position is not
 * kept: an origin set from it is stored as null, and a trip that ends at it
 * is not stored at all.
 */
export function toStoredTrip(trip: Trip): StoredTrip | null {
  if (trip.destination.id === CURRENT_LOCATION_ID) return null
  return { origin: trip.origin.id === CURRENT_LOCATION_ID ? null : trip.origin, destination: trip.destination }
}

/** The trip to open with: the stored one, its missing origin taken from `fallback`, or `fallback` itself. */
export function restoreTrip(stored: StoredTrip | null, fallback: Trip): Trip {
  if (stored === null) return fallback
  return { origin: stored.origin ?? fallback.origin, destination: stored.destination }
}

function samePlaceValue(a: Place | null, b: Place | null): boolean {
  if (a === null || b === null) return a === b
  return a.id === b.id && a.label === b.label && a.position[0] === b.position[0] && a.position[1] === b.position[1]
}

/** Records the last trip. Returns the same book when nothing changed, so callers can skip a write. */
export function setLastTrip(book: PlaceBook, trip: StoredTrip | null): PlaceBook {
  const before = book.lastTrip
  if (before === null || trip === null) return before === trip ? book : { ...book, lastTrip: trip }
  if (samePlaceValue(before.origin, trip.origin) && samePlaceValue(before.destination, trip.destination)) return book
  return { ...book, lastTrip: trip }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toPosition(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const lng: unknown = v[0]
  const lat: unknown = v[1]
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  const p: LngLat = [lng, lat]
  return isValidLngLat(p) ? p : null
}

function toPlace(v: unknown): Place | null {
  if (!isRecord(v)) return null
  const position = toPosition(v.position)
  if (position === null || typeof v.id !== 'string' || typeof v.label !== 'string') return null
  const id = v.id.trim()
  const label = v.label.trim().slice(0, MAX_PLACE_LABEL_LENGTH)
  if (id === '' || id.length > 200 || label === '' || id === CURRENT_LOCATION_ID) return null
  return { id, label, position }
}

function toSavedPlace(v: unknown, fixed: { id: string; name: string } | null): SavedPlace | null {
  const place = toPlace(v)
  if (place === null || !isRecord(v)) return null
  if (fixed !== null) return { ...fixed, label: place.label, position: place.position }
  const name = typeof v.name === 'string' ? cleanPlaceName(v.name) : ''
  if (nameProblem(name) !== null) return null
  return { id: place.id, name, label: place.label, position: place.position }
}

/**
 * Reads a stored book back, trusting nothing. Anything that is not a book of
 * this version gives null (the caller discards what is stored); inside a
 * book of the right version each entry is checked by itself, so one damaged
 * entry is dropped without taking the rest with it. The caps and the
 * no-duplicates rules are applied again.
 */
export function parsePlaceBook(raw: unknown): PlaceBook | null {
  if (!isRecord(raw) || raw.version !== PLACE_BOOK_VERSION) return null
  const custom: SavedPlace[] = []
  for (const entry of Array.isArray(raw.custom) ? (raw.custom as unknown[]) : []) {
    const saved = toSavedPlace(entry, null)
    if (saved === null || custom.length >= MAX_CUSTOM_PLACES) continue
    if (custom.some((p) => p.id === saved.id || sameText(p.name, saved.name))) continue
    custom.push(saved)
  }
  let book: PlaceBook = {
    home: toSavedPlace(raw.home, { id: 'home', name: SLOT_NAME.home }),
    work: toSavedPlace(raw.work, { id: 'work', name: SLOT_NAME.work }),
    custom,
    recents: [],
    lastTrip: null,
  }
  const recents = (Array.isArray(raw.recents) ? (raw.recents as unknown[]) : [])
    .map(toPlace)
    .filter((p): p is Place => p !== null)
  // Oldest first, so the stored order (newest first) comes out again.
  for (const place of recents.reverse()) book = addRecent(book, place)
  if (isRecord(raw.lastTrip)) {
    const destination = toPlace(raw.lastTrip.destination)
    if (destination !== null) book = { ...book, lastTrip: { origin: toPlace(raw.lastTrip.origin), destination } }
  }
  return book
}

/** The book as it is stored: itself, plus the version that parsePlaceBook asks for. */
export function serializePlaceBook(book: PlaceBook): { readonly version: number } & PlaceBook {
  return { version: PLACE_BOOK_VERSION, ...book }
}
