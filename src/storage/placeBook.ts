import { EMPTY_PLACE_BOOK, parsePlaceBook, serializePlaceBook, type PlaceBook } from '../core/index.ts'
import type { TextStore } from './local.ts'

/**
 * The one key the place book lives under. The version is in the key and in
 * the stored value: a new shape gets a new key, and whatever sits under this
 * one with another version inside is discarded.
 */
export const PLACE_BOOK_KEY = 'routeiq.places.v1'

/**
 * Reads the place book from the device. Never throws. Text that is not JSON,
 * or not a book of this version, is removed from the store and read as an
 * empty book; a damaged entry inside a good book is dropped by itself (see
 * parsePlaceBook).
 */
export function loadPlaceBook(store: TextStore): PlaceBook {
  const text = store.read(PLACE_BOOK_KEY)
  if (text === null) return EMPTY_PLACE_BOOK
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = null
  }
  const book = parsePlaceBook(raw)
  if (book === null) {
    store.remove(PLACE_BOOK_KEY)
    return EMPTY_PLACE_BOOK
  }
  return book
}

/** Writes the book. False when the device would not take it (full or blocked): it then lives in memory only. */
export function savePlaceBook(store: TextStore, book: PlaceBook): boolean {
  return store.write(PLACE_BOOK_KEY, JSON.stringify(serializePlaceBook(book)))
}

/** Removes everything the place book ever wrote. False when the device would not do it. */
export function clearPlaceBook(store: TextStore): boolean {
  return store.remove(PLACE_BOOK_KEY)
}
