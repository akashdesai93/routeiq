import { describe, expect, it } from 'vitest'
import { EMPTY_SPEECH_QUEUE, enqueueSpeech, speechFinished, type PositionFix, type SpokenLine } from '../src/core/index.ts'
import { geolocationSource, WATCH_TIMEOUT_MS, type CoordsLike, type GeolocationLike, type LocationErrorKind } from '../src/device/geolocation.ts'
import { createSpeaker, speechTimeoutMs, type UtteranceLike } from '../src/device/speech.ts'
import { pageVisibility, type VisibilityDocumentLike } from '../src/device/visibility.ts'
import { createWakeLock, type WakeLockLike, type WakeLockSentinelLike } from '../src/device/wakeLock.ts'

// The thin wrappers a live drive reaches the browser through, each against a stand-in:
// the position watch, the voice (and its queue rules), the screen wake lock, page visibility.

const turn = (text: string, distanceToManeuverM: number): SpokenLine => ({ text, priority: 'turn', distanceToManeuverM })
const urgent = (text: string): SpokenLine => ({ text, priority: 'urgent' })
const info = (text: string): SpokenLine => ({ text, priority: 'info' })

describe('speech queue rules', () => {
  it('says a line at once when nothing is being said', () => {
    const { queue, action } = enqueueSpeech(EMPTY_SPEECH_QUEUE, turn('Turn left.', 80))
    expect(action).toBe('speak')
    expect(queue.speaking!.text).toBe('Turn left.')
  })

  it('a switch announcement pre-empts a turn prompt that is still far away', () => {
    const far = enqueueSpeech(EMPTY_SPEECH_QUEUE, turn('In 2 miles, turn left.', 3200)).queue
    const { queue, action } = enqueueSpeech(far, urgent('Switching to a faster route.'))
    expect(action).toBe('interrupt')
    expect(queue.speaking!.text).toBe('Switching to a faster route.')
  })

  it('but not one for a turn that is right ahead, nor another urgent line: it waits its turn', () => {
    const near = enqueueSpeech(EMPTY_SPEECH_QUEUE, turn('Turn left.', 150)).queue
    const waited = enqueueSpeech(near, urgent('Switching to a faster route.'))
    expect(waited.action).toBe('wait')
    expect(waited.queue).toMatchObject({ speaking: { text: 'Turn left.' }, waiting: { text: 'Switching to a faster route.' } })
    const busy = enqueueSpeech(EMPTY_SPEECH_QUEUE, urgent('You are off the route.')).queue
    expect(enqueueSpeech(busy, urgent('New route.')).action).toBe('wait')
  })

  it('never holds more than two lines: the more important one waits, and of equals the newer', () => {
    let queue = enqueueSpeech(EMPTY_SPEECH_QUEUE, turn('Turn left.', 100)).queue
    queue = enqueueSpeech(queue, turn('In a mile, turn right.', 1600)).queue
    // A newer turn prompt replaces the one waiting.
    const newer = enqueueSpeech(queue, turn('In half a mile, turn right.', 800))
    expect(newer.action).toBe('wait')
    expect(newer.queue.waiting!.text).toBe('In half a mile, turn right.')
    // Something that can be lost does not push a turn prompt out.
    const lost = enqueueSpeech(newer.queue, info('RouteIQ started'))
    expect(lost.action).toBe('drop')
    expect(lost.queue).toBe(newer.queue)
    // An urgent line takes the waiting place from a turn prompt.
    const pushed = enqueueSpeech(newer.queue, urgent('Switching to a faster route.'))
    expect(pushed.queue.waiting!.text).toBe('Switching to a faster route.')
    expect(enqueueSpeech(queue, { text: '  ', priority: 'urgent' }).action).toBe('drop')
  })

  it('moves the waiting line up when the spoken one ends', () => {
    let queue = enqueueSpeech(EMPTY_SPEECH_QUEUE, urgent('One.')).queue
    queue = enqueueSpeech(queue, urgent('Two.')).queue
    const after = speechFinished(queue)
    expect(after.next!.text).toBe('Two.')
    expect(after.queue).toEqual({ speaking: { text: 'Two.', priority: 'urgent' }, waiting: null })
    expect(speechFinished(speechFinished(after.queue).queue)).toEqual({ queue: EMPTY_SPEECH_QUEUE, next: null })
  })
})

/** A stand-in for speechSynthesis: remembers what was spoken, and ends an utterance when told to. */
function fakeSynth() {
  const spoken: UtteranceLike[] = []
  let cancels = 0
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const speaker = createSpeaker({
    synth: {
      speak: (u) => spoken.push(u),
      cancel: () => {
        cancels++
      },
    },
    makeUtterance: (text) => ({ text, lang: '', rate: 0, volume: 1, onend: null, onerror: null }),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (id) => {
      ;(id as { cleared: boolean }).cleared = true
    },
  })
  return { speaker, spoken, texts: () => spoken.map((u) => u.text), cancels: () => cancels, timers }
}

describe('createSpeaker', () => {
  it('speaks a line in US English at normal speed, and the waiting line when it ends', () => {
    const { speaker, spoken, texts } = fakeSynth()
    speaker.say(turn('Turn left.', 100))
    speaker.say(turn('In a mile, turn right.', 1600))
    expect(texts()).toEqual(['Turn left.'])
    expect(spoken[0]).toMatchObject({ lang: 'en-US', rate: 1, volume: 1 })
    spoken[0]!.onend!()
    expect(texts()).toEqual(['Turn left.', 'In a mile, turn right.'])
    spoken[1]!.onend!()
    expect(texts()).toHaveLength(2)
  })

  it('cuts a far-away turn prompt off for a switch, and ignores the end of the line it cut', () => {
    const { speaker, spoken, texts, cancels } = fakeSynth()
    speaker.say(turn('In 2 miles, turn left.', 3200))
    speaker.say(urgent('Switching to a faster route.'))
    expect(cancels()).toBe(1)
    expect(texts()).toEqual(['In 2 miles, turn left.', 'Switching to a faster route.'])
    speaker.say(turn('In a mile, turn right.', 1600))
    // The cancelled utterance reports its end late: that must not start the next line early.
    spoken[0]!.onerror!()
    expect(texts()).toHaveLength(2)
    spoken[1]!.onend!()
    expect(texts().at(-1)).toBe('In a mile, turn right.')
  })

  it('muted it says nothing; the Start tap still primes the voice, silently', () => {
    const { speaker, spoken, texts, cancels } = fakeSynth()
    speaker.prime('RouteIQ started')
    expect(texts()).toEqual(['RouteIQ started'])
    speaker.setMuted(true)
    expect(cancels()).toBe(1)
    speaker.say(urgent('Switching to a faster route.'))
    expect(texts()).toHaveLength(1)
    speaker.prime('RouteIQ started')
    expect(spoken[1]).toMatchObject({ text: ' ', volume: 0 })
    speaker.setMuted(false)
    speaker.say(urgent('You have arrived.'))
    expect(texts().at(-1)).toBe('You have arrived.')
  })

  it('does not wait for ever on a browser that never reports the end of a line', () => {
    const { speaker, texts, timers } = fakeSynth()
    speaker.say(urgent('One.'))
    speaker.say(urgent('Two.'))
    expect(timers[0]!.ms).toBe(speechTimeoutMs('One.'))
    timers[0]!.fn()
    expect(texts()).toEqual(['One.', 'Two.'])
    // Stop forgets what was waiting.
    speaker.say(urgent('Three.'))
    speaker.stop()
    timers.filter((t) => !t.cleared).forEach((t) => t.fn())
    expect(texts()).toEqual(['One.', 'Two.'])
  })

  it('is a speaker that does nothing where the browser cannot speak (Node has no speech)', () => {
    const none = createSpeaker({ synth: null })
    expect(none.supported).toBe(false)
    none.prime('RouteIQ started')
    none.say(urgent('Nothing happens.'))
    none.setMuted(true)
    none.stop()
    expect(createSpeaker().supported).toBe(false)
    // A speech engine that throws does not take the drive down.
    const throwing = createSpeaker({
      synth: {
        speak() {
          throw new Error('not allowed')
        },
        cancel() {
          throw new Error('not allowed')
        },
      },
      makeUtterance: (text) => ({ text, lang: '', rate: 0, volume: 1, onend: null, onerror: null }),
      setTimer: () => 0,
      clearTimer: () => {},
    })
    expect(() => {
      throwing.say(urgent('One.'))
      throwing.stop()
    }).not.toThrow()
  })
})

describe('createWakeLock', () => {
  function fakeWakeLock(fail = false) {
    const sentinels: (WakeLockSentinelLike & { released: boolean; fire: () => void })[] = []
    const wakeLock: WakeLockLike = {
      request: () => {
        if (fail) return Promise.reject(new Error('NotAllowedError'))
        let listener = () => {}
        const sentinel = {
          released: false,
          release: () => {
            sentinel.released = true
            return Promise.resolve()
          },
          addEventListener: (_type: 'release', l: () => void) => {
            listener = l
          },
          fire: () => listener(),
        }
        sentinels.push(sentinel)
        return Promise.resolve(sentinel)
      },
    }
    return { wakeLock, sentinels }
  }

  it('acquires on request, once, and releases', async () => {
    const { wakeLock, sentinels } = fakeWakeLock()
    const lock = createWakeLock({ wakeLock })
    expect(await lock.acquire()).toBe('held')
    expect(await lock.acquire()).toBe('held')
    expect(sentinels).toHaveLength(1)
    await lock.release()
    expect(sentinels[0]!.released).toBe(true)
  })

  it('reports when the system takes the lock away, and can take it again', async () => {
    const { wakeLock, sentinels } = fakeWakeLock()
    let released = 0
    const lock = createWakeLock({ wakeLock, onReleased: () => released++ })
    await lock.acquire()
    // The page was hidden: the browser drops the lock.
    sentinels[0]!.fire()
    expect(released).toBe(1)
    expect(await lock.acquire()).toBe('held')
    expect(sentinels).toHaveLength(2)
    // Our own release is not reported as the system's.
    await lock.release()
    sentinels[1]!.fire()
    expect(released).toBe(1)
  })

  it('is "unavailable", never an exception, when unsupported or refused', async () => {
    expect(await createWakeLock({ wakeLock: null }).acquire()).toBe('unavailable')
    expect(await createWakeLock({ wakeLock: fakeWakeLock(true).wakeLock }).acquire()).toBe('unavailable')
    // Node has no navigator.wakeLock: the defaults give the same answer.
    expect(await createWakeLock().acquire()).toBe('unavailable')
    await expect(createWakeLock({ wakeLock: null }).release()).resolves.toBeUndefined()
  })
})

describe('pageVisibility', () => {
  it('reports hidden and visible, and stops when unsubscribed', () => {
    let listener: (() => void) | null = null
    const doc: VisibilityDocumentLike & { visibilityState: string } = {
      visibilityState: 'visible',
      addEventListener: (_type, l) => {
        listener = l
      },
      removeEventListener: () => {
        listener = null
      },
    }
    const seen: boolean[] = []
    const visibility = pageVisibility(doc)
    const stop = visibility.subscribe((hidden) => seen.push(hidden))
    expect(visibility.isHidden()).toBe(false)
    doc.visibilityState = 'hidden'
    listener!()
    doc.visibilityState = 'visible'
    listener!()
    expect(seen).toEqual([true, false])
    stop()
    expect(listener).toBeNull()
    // Without a page (Node, a native shell) it is always in front.
    expect(pageVisibility(null).isHidden()).toBe(false)
    expect(pageVisibility().isHidden()).toBe(false)
    pageVisibility(null).subscribe(() => {})()
  })
})

describe('geolocationSource (watchPosition)', () => {
  type Success = (position: { coords: CoordsLike }) => void
  function fakeWatch() {
    const watch: { success: Success | null; error: ((e: { code: number }) => void) | null; options: unknown; cleared: number[] } = {
      success: null,
      error: null,
      options: null,
      cleared: [],
    }
    const geolocation: GeolocationLike = {
      getCurrentPosition() {},
      watchPosition(success, error, options) {
        watch.success = success
        watch.error = error ?? null
        watch.options = options
        return 7
      },
      clearWatch: (id) => {
        watch.cleared.push(id)
      },
    }
    return { geolocation, watch }
  }
  function listen(options: Parameters<typeof geolocationSource>[0]) {
    const fixes: PositionFix[] = []
    const errors: LocationErrorKind[] = []
    const stop = geolocationSource(options).start(
      (fix) => fixes.push(fix),
      (kind) => errors.push(kind),
    )
    return { fixes, errors, stop }
  }

  it('watches with high accuracy and no cached fixes, and stamps each fix with its own clock', () => {
    const { geolocation, watch } = fakeWatch()
    let now = 5_000
    const { fixes, stop } = listen({ geolocation, secureContext: true, now: () => now })
    expect(watch.options).toEqual({ enableHighAccuracy: true, timeout: WATCH_TIMEOUT_MS, maximumAge: 0 })
    // A public landmark stands in for "where the device is": Bank of America Stadium.
    watch.success!({ coords: { longitude: -80.8528, latitude: 35.2258, accuracy: 6, speed: 13.4, heading: 182 } })
    now = 6_000
    // Standing still, phones report no heading (null or NaN) and sometimes no speed.
    watch.success!({ coords: { longitude: -80.8529, latitude: 35.2257, accuracy: 9, speed: null, heading: NaN } })
    expect(fixes).toEqual([
      { lng: -80.8528, lat: 35.2258, accuracyM: 6, speedMps: 13.4, headingDeg: 182, timeMs: 5_000 },
      { lng: -80.8529, lat: 35.2257, accuracyM: 9, speedMps: null, headingDeg: null, timeMs: 6_000 },
    ])
    stop()
    expect(watch.cleared).toEqual([7])
    // Nothing arrives after stopping, even if the browser is slow to stop.
    watch.success!({ coords: { longitude: -80.85, latitude: 35.22 } })
    expect(fixes).toHaveLength(2)
  })

  it('maps the error codes and keeps watching: 1 denied, 2 unavailable, 3 timeout', () => {
    const { geolocation, watch } = fakeWatch()
    const { errors, fixes } = listen({ geolocation, secureContext: true })
    for (const code of [1, 2, 3, 99]) watch.error!({ code })
    expect(errors).toEqual(['denied', 'unavailable', 'timeout', 'unavailable'])
    watch.success!({ coords: { longitude: 500, latitude: 35 } })
    expect(errors.at(-1)).toBe('unavailable')
    expect(fixes).toEqual([])
    watch.success!({ coords: { longitude: -80.8528, latitude: 35.2258 } })
    expect(fixes[0]!.accuracyM).toBeNaN()
  })

  it('says insecure or unsupported at once, without asking the device', () => {
    const { geolocation, watch } = fakeWatch()
    expect(listen({ geolocation, secureContext: false }).errors).toEqual(['insecure'])
    expect(watch.success).toBeNull()
    expect(listen({ geolocation: null, secureContext: true }).errors).toEqual(['unsupported'])
    // A geolocation that can only answer once cannot be watched.
    expect(listen({ geolocation: { getCurrentPosition() {} }, secureContext: true }).errors).toEqual(['unsupported'])
    // Node has none.
    expect(listen({}).errors).toEqual(['unsupported'])
    const throwing: GeolocationLike = {
      getCurrentPosition() {},
      watchPosition() {
        throw new Error('not allowed here')
      },
    }
    const failed = listen({ geolocation: throwing, secureContext: true })
    expect(failed.errors).toEqual(['unavailable'])
    expect(() => failed.stop()).not.toThrow()
  })
})
