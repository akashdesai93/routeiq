import { useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import {
  CURRENT_LOCATION_ID,
  MAX_CUSTOM_PLACES,
  MAX_PLACE_NAME_LENGTH,
  MIN_SEARCH_CHARS,
  PLACE_SLOTS,
  savedPlaceAsPlace,
  savedPlaces,
  searchQuery,
  SLOT_NAME,
  type LngLat,
  type Place,
  type PlaceSuggestion,
  type SavedPlace,
} from './core/index.ts'
import type { LocationResult } from './device/geolocation.ts'
import { locateDevice } from './device/native/index.ts'
import { PIN_COLOR, PIN_NAME, PIN_ROLES, type PinRole } from './map/pins.ts'
import type { PlaceBookState } from './usePlaceBook.ts'
import { usePlaceSearch } from './usePlaceSearch.ts'

/** How a place was chosen: typed and picked from search, a saved place, a recent one, or the device's position. */
export type PlaceOrigin = 'search' | 'saved' | 'recent' | 'location'

interface PlanPanelProps {
  pins: Readonly<Record<PinRole, Place>>
  token: string
  places: PlaceBookState
  /** The point search results are biased to: the centre of the map. Asked when a request is made. */
  getProximity: () => LngLat
  onPlace: (role: PinRole, place: Place, from: PlaceOrigin) => void
  onSwap: () => void
  onReset: () => void
  /** Asks the device where it is. Swapped out in tests; called only from the button. */
  locate?: () => Promise<LocationResult>
}

/** One line of a field's list: a search suggestion, a saved place or a recent destination. */
interface FieldOption {
  key: string
  primary: string
  secondary: string
  pick: () => void
}

interface Shortcut {
  place: Place
  /** What is shown under the name: the address or landmark a saved place stands for. */
  detail: string
  from: PlaceOrigin
}

interface PlaceFieldProps {
  role: PinRole
  place: Place
  token: string
  getProximity: () => LngLat
  /** Offered before anything is typed: saved places, and for the destination the recent ones. */
  shortcuts: readonly Shortcut[]
  onChoose: (place: Place, from: PlaceOrigin) => void
  /** A control beside the field ("Use my location"). */
  children?: ReactNode
}

/**
 * One search field with its list, built as a combobox: a real input with a
 * label, a listbox under it, arrow keys, Enter and Escape, and rows big
 * enough for a thumb. Out of focus it shows the place the pin is on.
 */
function PlaceField({ role, place, token, getProximity, shortcuts, onChoose, children }: PlaceFieldProps) {
  const id = useId()
  const inputId = `${id}-input`
  const listId = `${id}-list`
  const statusId = `${id}-status`
  const search = usePlaceSearch(token, getProximity)
  const inputRef = useRef<HTMLInputElement>(null)
  // What is being typed; null when the field is not being edited and shows the pin's place.
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [problem, setProblem] = useState<string | null>(null)

  const close = () => {
    setOpen(false)
    setDraft(null)
    setActive(-1)
    search.reset()
  }
  const done = (chosen: Place, from: PlaceOrigin) => {
    onChoose(chosen, from)
    close()
    inputRef.current?.blur()
  }
  const pickSuggestion = async (suggestion: PlaceSuggestion) => {
    setProblem(null)
    const result = await search.choose(suggestion)
    if (result === null) return
    if (result.ok) done(result.place, 'search')
    else setProblem(result.message)
  }

  const typed = draft !== null && searchQuery(draft) !== null
  const { state } = search
  let options: FieldOption[] = []
  if (open && typed) {
    if (state.status === 'done')
      options = state.suggestions.map((s) => ({
        key: s.id,
        primary: s.name,
        secondary: s.detail,
        pick: () => void pickSuggestion(s),
      }))
  } else if (open) {
    const filter = (draft ?? '').trim().toLowerCase()
    options = shortcuts
      .filter((s) => filter === '' || s.place.label.toLowerCase().includes(filter))
      .map((s, i) => ({
        key: `${s.from}-${i}`,
        primary: s.place.label,
        secondary: s.from === 'recent' ? 'Recent' : s.detail,
        pick: () => done(s.place, s.from),
      }))
  }
  const activeOption = active >= 0 && active < options.length ? active : -1

  let status = ''
  let failed = false
  if (problem !== null) {
    status = problem
    failed = true
  } else if (search.retrieving) status = 'Getting that place…'
  else if (typed && state.status === 'error') {
    status = state.message
    failed = true
  } else if (typed && (state.status === 'waiting' || state.status === 'searching')) status = 'Searching…'
  else if (typed && state.status === 'done' && state.suggestions.length === 0)
    status = 'No places found. Try a fuller name or an address.'
  else if (draft !== null && draft.trim() !== '' && !typed && options.length === 0)
    status = `Type at least ${MIN_SEARCH_CHARS} characters to search.`

  return (
    <div className="field">
      <label htmlFor={inputId} className="dot" style={{ '--pin': PIN_COLOR[role] } as CSSProperties}>
        {PIN_NAME[role]}
      </label>
      <div className="field-row">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption >= 0 ? `${id}-option-${activeOption}` : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Search a place or address"
          value={draft ?? place.label}
          onFocus={(e) => {
            setOpen(true)
            e.currentTarget.select()
          }}
          onClick={() => setOpen(true)}
          onBlur={close}
          onChange={(e) => {
            setDraft(e.target.value)
            setOpen(true)
            setActive(-1)
            setProblem(null)
            search.setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              const n = options.length
              if (n === 0) setActive(-1)
              else if (e.key === 'ArrowDown') setActive((activeOption + 1) % n)
              else setActive(activeOption <= 0 ? n - 1 : activeOption - 1)
            } else if (e.key === 'Enter') {
              // Enter with nothing highlighted takes the first search result, never a shortcut.
              const option = options[activeOption] ?? (typed ? options[0] : undefined)
              if (option !== undefined) {
                e.preventDefault()
                option.pick()
              }
            } else if (e.key === 'Escape' && (open || draft !== null)) {
              e.preventDefault()
              close()
            }
          }}
        />
        {children}
      </div>
      {options.length > 0 && (
        <ul id={listId} className="options" role="listbox" aria-label={`${PIN_NAME[role]} suggestions`}>
          {options.map((option, i) => (
            <li
              key={option.key}
              id={`${id}-option-${i}`}
              role="option"
              aria-selected={i === activeOption}
              className={i === activeOption ? 'option active' : 'option'}
              // Keeps the focus in the input, so the click lands before the field closes.
              onMouseDown={(e) => e.preventDefault()}
              onClick={option.pick}
            >
              <span className="option-name">{option.primary}</span>
              {option.secondary !== '' && <span className="option-detail">{option.secondary}</span>}
            </li>
          ))}
        </ul>
      )}
      <p id={statusId} className={failed ? 'field-status failed' : 'field-status'} role={failed ? 'alert' : 'status'}>
        {status}
      </p>
    </div>
  )
}

function shortcutOf(saved: SavedPlace): Shortcut {
  return { place: savedPlaceAsPlace(saved), detail: saved.label, from: 'saved' }
}

/**
 * The trip input: where from, where to, the saved places one tap away, and
 * the recent destinations. Presentation and field state only: places are
 * found by the Mapbox search provider, the place book's rules are in
 * src/core/places.ts, and the trip itself belongs to App.
 */
export function PlanPanel({ pins, token, places, getProximity, onPlace, onSwap, onReset, locate = locateDevice }: PlanPanelProps) {
  const { book } = places
  const [locating, setLocating] = useState(false)
  const [locationProblem, setLocationProblem] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [saveRole, setSaveRole] = useState<PinRole>('destination')
  const [newName, setNewName] = useState('')
  const [saveProblem, setSaveProblem] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const saved = savedPlaces(book)
  const savedShortcuts = saved.map(shortcutOf)
  const recentShortcuts: Shortcut[] = book.recents.map((place) => ({ place, detail: '', from: 'recent' }))

  const locateMe = async () => {
    setLocating(true)
    setLocationProblem(null)
    const result = await locate()
    setLocating(false)
    if (!result.ok) {
      setLocationProblem(result.message)
      return
    }
    onPlace('origin', { id: CURRENT_LOCATION_ID, label: 'My location', position: result.position }, 'location')
  }

  const toSave = pins[saveRole]
  const addNamed = (e: FormEvent) => {
    e.preventDefault()
    const problem = places.addCustom(newName, toSave)
    setSaveProblem(problem)
    if (problem === null) setNewName('')
  }
  const rename = (e: FormEvent) => {
    e.preventDefault()
    if (renaming === null) return
    const problem = places.rename(renaming.id, renaming.name)
    setSaveProblem(problem)
    if (problem === null) setRenaming(null)
  }

  return (
    <section className="plan" aria-label="Plan a trip">
      <PlaceField
        role="origin"
        place={pins.origin}
        token={token}
        getProximity={getProximity}
        shortcuts={savedShortcuts}
        onChoose={(place, from) => {
          setLocationProblem(null)
          onPlace('origin', place, from)
        }}
      >
        <button type="button" className="locate" onClick={() => void locateMe()} disabled={locating}>
          {locating ? 'Locating…' : 'Use my location'}
        </button>
      </PlaceField>
      {locationProblem !== null && (
        <p className="field-status failed" role="alert">
          {locationProblem}
        </p>
      )}
      <PlaceField
        role="destination"
        place={pins.destination}
        token={token}
        getProximity={getProximity}
        shortcuts={[...savedShortcuts, ...recentShortcuts]}
        onChoose={(place, from) => onPlace('destination', place, from)}
      />

      <div className="plan-row" role="group" aria-label="Go to a saved place">
        {PLACE_SLOTS.map((slot) => {
          const place = book[slot]
          return place === null ? (
            <button key={slot} type="button" className="chip unset" onClick={() => setMoreOpen(true)}>
              Set {SLOT_NAME[slot]}…
            </button>
          ) : (
            <button
              key={slot}
              type="button"
              className="chip"
              title={place.label}
              onClick={() => onPlace('destination', savedPlaceAsPlace(place), 'saved')}
            >
              {place.name}
            </button>
          )
        })}
        {book.custom.map((place) => (
          <button
            key={place.id}
            type="button"
            className="chip"
            title={place.label}
            onClick={() => onPlace('destination', savedPlaceAsPlace(place), 'saved')}
          >
            {place.name}
          </button>
        ))}
      </div>
      <div className="plan-row">
        <button type="button" onClick={onSwap}>
          Swap
        </button>
        <button type="button" onClick={onReset}>
          Reset to test points
        </button>
      </div>

      <details className="plan-more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
        <summary>Recent and saved places</summary>

        <h3>Recent</h3>
        {book.recents.length === 0 ? (
          <p className="hint">No recent destinations yet. Places you search for are listed here.</p>
        ) : (
          <ul className="place-list" aria-label="Recent destinations">
            {book.recents.map((place, i) => (
              <li key={`${place.id}-${i}`}>
                <button type="button" className="place-go" onClick={() => onPlace('destination', place, 'recent')}>
                  {place.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3>Save a place</h3>
        <div className="plan-row">
          {PIN_ROLES.map((role) => (
            <button key={role} type="button" aria-pressed={saveRole === role} onClick={() => setSaveRole(role)}>
              {PIN_NAME[role]}
            </button>
          ))}
        </div>
        <p className="hint">
          Saving the {PIN_NAME[saveRole].toLowerCase()}: {toSave.label}
        </p>
        <div className="plan-row">
          {PLACE_SLOTS.map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => {
                places.setSlot(slot, toSave)
                setSaveProblem(null)
              }}
            >
              Save as {SLOT_NAME[slot]}
            </button>
          ))}
        </div>
        <form className="plan-row" onSubmit={addNamed}>
          <label className="name-field">
            <span>Or under a name</span>
            <input
              type="text"
              value={newName}
              maxLength={MAX_PLACE_NAME_LENGTH}
              placeholder="Gym"
              autoComplete="off"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <button type="submit" disabled={newName.trim() === ''}>
            Save
          </button>
        </form>
        {saveProblem !== null && (
          <p className="field-status failed" role="alert">
            {saveProblem}
          </p>
        )}

        {saved.length > 0 && (
          <>
            <h3>Saved</h3>
            <ul className="place-list" aria-label="Saved places">
              {saved.map((place) => (
                <li key={place.id}>
                  {renaming !== null && renaming.id === place.id ? (
                    <form className="plan-row" onSubmit={rename}>
                      <label className="name-field">
                        <span>New name for {place.name}</span>
                        <input
                          type="text"
                          value={renaming.name}
                          maxLength={MAX_PLACE_NAME_LENGTH}
                          autoComplete="off"
                          onChange={(e) => setRenaming({ id: place.id, name: e.target.value })}
                        />
                      </label>
                      <button type="submit">Save</button>
                      <button type="button" onClick={() => setRenaming(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="saved-row">
                      <span className="saved-text">
                        <strong>{place.name}</strong>
                        <span className="option-detail">{place.label}</span>
                      </span>
                      {place.id !== 'home' && place.id !== 'work' && (
                        <button type="button" onClick={() => setRenaming({ id: place.id, name: place.name })}>
                          Rename
                        </button>
                      )}
                      <button type="button" aria-label={`Remove ${place.name}`} onClick={() => places.remove(place.id)}>
                        Remove
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {places.storageNote !== null && (
          <p className="field-status failed" role="alert">
            {places.storageNote}
          </p>
        )}
        <p className="hint">
          Home, Work, up to {MAX_CUSTOM_PLACES} named places, your recent destinations and your last trip are kept
          in this browser only. What you type in a search field is sent to Mapbox to find places.
        </p>
        {confirmClear ? (
          <div className="plan-row" role="group" aria-label="Confirm clearing">
            <span>Remove them all from this device?</span>
            <button
              type="button"
              onClick={() => {
                places.clear()
                setConfirmClear(false)
                setRenaming(null)
                setSaveProblem(null)
              }}
            >
              Yes, clear
            </button>
            <button type="button" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmClear(true)}>
            Clear saved places and history
          </button>
        )}
      </details>
    </section>
  )
}
