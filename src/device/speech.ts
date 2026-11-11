import {
  EMPTY_SPEECH_QUEUE,
  enqueueSpeech,
  speechFinished,
  type SpeechQueue,
  type SpokenLine,
} from '../core/index.ts'

/** What an utterance looks like to this wrapper: the part of SpeechSynthesisUtterance that is used. */
export interface UtteranceLike {
  text: string
  lang: string
  rate: number
  volume: number
  onend: (() => void) | null
  onerror: (() => void) | null
}

/** The part of the browser's speechSynthesis that is used, so a test can hand in a stand-in. */
export interface SpeechSynthLike {
  speak(utterance: UtteranceLike): void
  cancel(): void
}

/** The voice of a live drive. A native shell brings its own (AVSpeechSynthesizer) behind the same four methods. */
export interface Speaker {
  /** False when this browser cannot speak; every method is then a no-op. */
  readonly supported: boolean
  /** Says a line, or queues or drops it by the rules of core/speechQueue.ts. Says nothing while muted. */
  say(line: SpokenLine): void
  /**
   * Called from inside the Start tap. Phone browsers (iOS Safari above all)
   * only let a page speak once it has spoken from a user gesture, so this
   * speaks `text` at once; muted, it speaks a silent utterance instead, so
   * that unmuting later still works.
   */
  prime(text: string): void
  setMuted(muted: boolean): void
  /** Stops talking and forgets what was waiting. */
  stop(): void
}

export interface SpeakerOptions {
  /** The speech engine; null for "this browser has none". Defaults to the browser's. */
  synth?: SpeechSynthLike | null
  /** Makes an utterance. Defaults to the browser's SpeechSynthesisUtterance. */
  makeUtterance?: (text: string) => UtteranceLike
  /** Timers, for the watchdog below. Default to the browser's. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
  lang?: string
}

function defaultSynth(): SpeechSynthLike | null {
  try {
    const synth = (globalThis as { speechSynthesis?: SpeechSynthLike }).speechSynthesis
    return synth !== undefined && typeof globalThis.SpeechSynthesisUtterance === 'function' ? synth : null
  } catch {
    return null
  }
}

/**
 * How long a line may take before it is taken to be over, in milliseconds.
 * Some browsers never fire `onend` (a page in the background, a voice that
 * failed to load); without this the queue would wait for ever.
 */
export function speechTimeoutMs(text: string): number {
  return 4000 + text.length * 120
}

/**
 * A voice on top of the Web Speech API (speechSynthesis). The queue rules
 * are core/speechQueue.ts: one line speaking and at most one waiting, an
 * urgent line cutting off a turn prompt that is still far away. Never
 * throws: a browser without speech gives a speaker that does nothing.
 */
export function createSpeaker(options: SpeakerOptions = {}): Speaker {
  const {
    synth = defaultSynth(),
    makeUtterance = (text: string) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    lang = 'en-US',
  } = options
  let queue: SpeechQueue = EMPTY_SPEECH_QUEUE
  let muted = false
  // Names the utterance whose end is being waited for; an older one ending (after a cancel) is ignored.
  let turn = 0
  let watchdog: unknown = null

  const utter = (text: string, volume: number, onDone: () => void) => {
    if (synth === null) return
    try {
      const utterance = makeUtterance(text)
      utterance.lang = lang
      utterance.rate = 1
      utterance.volume = volume
      utterance.onend = onDone
      utterance.onerror = onDone
      synth.speak(utterance)
    } catch {
      onDone()
    }
  }

  const speakNow = (line: SpokenLine) => {
    const mine = ++turn
    const done = () => {
      if (mine !== turn) return
      turn++
      if (watchdog !== null) clearTimer(watchdog)
      watchdog = null
      const after = speechFinished(queue)
      queue = after.queue
      if (after.next !== null) speakNow(after.next)
    }
    if (watchdog !== null) clearTimer(watchdog)
    watchdog = setTimer(done, speechTimeoutMs(line.text))
    utter(line.text, 1, done)
  }

  const silence = () => {
    turn++
    if (watchdog !== null) clearTimer(watchdog)
    watchdog = null
    queue = EMPTY_SPEECH_QUEUE
    try {
      synth?.cancel()
    } catch {
      // A speech engine that cannot be stopped is not worth failing a drive over.
    }
  }

  return {
    supported: synth !== null,
    say(line) {
      if (synth === null || muted) return
      const added = enqueueSpeech(queue, line)
      if (added.action === 'interrupt') {
        // Stop the line being spoken (its end is no longer waited for), keep the one waiting.
        turn++
        try {
          synth.cancel()
        } catch {
          // As above.
        }
      }
      queue = added.queue
      if (added.action === 'speak' || added.action === 'interrupt') speakNow(line)
    },
    prime(text) {
      if (synth === null) return
      if (muted) utter(' ', 0, () => {})
      else this.say({ text, priority: 'info' })
    },
    setMuted(next) {
      muted = next
      if (muted) silence()
    },
    stop: silence,
  }
}
