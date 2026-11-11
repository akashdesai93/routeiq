import { useCallback, useMemo, useRef, useState } from 'react'
import {
  addCustomPlace,
  addRecent,
  EMPTY_PLACE_BOOK,
  removeSavedPlace,
  renameCustomPlace,
  setLastTrip,
  setSlot,
  toStoredTrip,
  type Place,
  type PlaceBook,
  type PlaceSlot,
  type Trip,
} from './core/index.ts'
import type { TextStore } from './storage/local.ts'
import { clearPlaceBook, loadPlaceBook, savePlaceBook } from './storage/placeBook.ts'

export interface PlaceBookActions {
  setSlot: (slot: PlaceSlot, place: Place | null) => void
  /** These two answer with the reason nothing changed, or null when it did. */
  addCustom: (name: string, place: Place) => string | null
  rename: (id: string, name: string) => string | null
  remove: (id: string) => void
  addRecent: (place: Place) => void
  /** Null for the built-in trip: nothing is kept, and the next visit opens with it again. */
  rememberTrip: (trip: Trip | null) => void
  /** Removes saved places, recents and the last trip from the device. */
  clear: () => void
}

export interface PlaceBookState extends PlaceBookActions {
  book: PlaceBook
  /** Set when the device would not store the book (storage full or blocked); null when all is well. */
  storageNote: string | null
}

const NOT_STORED =
  'This browser would not store your places (storage is full or blocked). They will last until this page is closed.'

/**
 * The place book (saved places, recents, last trip) as React state, read
 * from the device once and written back on every change. Orchestrates only:
 * the rules are in src/core/places.ts, the storage in src/storage. Nothing
 * here goes anywhere but the store it is given.
 */
export function usePlaceBook(store: TextStore): PlaceBookState {
  const [book, setBook] = useState<PlaceBook>(() => loadPlaceBook(store))
  const [stored, setStored] = useState(true)
  // The newest book, for changes made one after another before React has rendered.
  const latest = useRef(book)

  const apply = useCallback(
    (next: PlaceBook) => {
      if (next === latest.current) return
      latest.current = next
      setBook(next)
      setStored(savePlaceBook(store, next))
    },
    [store],
  )

  const actions = useMemo<PlaceBookActions>(
    () => ({
      setSlot: (slot, place) => apply(setSlot(latest.current, slot, place)),
      addCustom: (name, place) => {
        const change = addCustomPlace(latest.current, name, place)
        apply(change.book)
        return change.problem
      },
      rename: (id, name) => {
        const change = renameCustomPlace(latest.current, id, name)
        apply(change.book)
        return change.problem
      },
      remove: (id) => apply(removeSavedPlace(latest.current, id)),
      addRecent: (place) => apply(addRecent(latest.current, place)),
      rememberTrip: (trip) => apply(setLastTrip(latest.current, trip === null ? null : toStoredTrip(trip))),
      clear: () => {
        latest.current = EMPTY_PLACE_BOOK
        setBook(EMPTY_PLACE_BOOK)
        setStored(clearPlaceBook(store))
      },
    }),
    [apply, store],
  )

  return { book, storageNote: stored ? null : NOT_STORED, ...actions }
}
