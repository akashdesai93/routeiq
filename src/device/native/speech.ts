import { createSpeaker, type Speaker, type SpeakerOptions, type SpeechSynthLike, type UtteranceLike } from '../speech.ts'
import type { DriveDiagnostics } from './diagnostics.ts'
import type { RouteIQNativePlugin } from './plugin.ts'

/** Counts lines started and ended for the drive diagnostics. The text of a line is never passed on. */
export type SpeechLog = Pick<DriveDiagnostics, 'speechStarted' | 'speechEnded'>

/**
 * The plugin's voice (AVSpeechSynthesizer) behind the two methods of the
 * browser's speechSynthesis that the speaker uses. An utterance ends when
 * the plugin's `speak` settles: spoken, cut off or failed, the queue moves on.
 * A silent utterance (the browser's "unlock" trick) is not sent at all:
 * native speech needs no unlocking.
 */
export function nativeSynth(plugin: RouteIQNativePlugin, log?: SpeechLog): SpeechSynthLike {
  return {
    speak(utterance) {
      if (utterance.volume <= 0 || utterance.text.trim() === '') {
        utterance.onend?.()
        return
      }
      log?.speechStarted()
      plugin.speak({ text: utterance.text }).then(
        (result) => {
          log?.speechEnded(result?.finished !== false)
          utterance.onend?.()
        },
        () => {
          log?.speechEnded(false)
          utterance.onerror?.()
        },
      )
    },
    cancel() {
      plugin.cancelSpeech().catch(() => {})
    },
  }
}

/**
 * The live drive's voice in the shell: the same queue rules and watchdog as
 * in a browser (createSpeaker), speaking through the plugin, which lowers
 * music while it talks and keeps talking with the phone locked.
 */
export function createNativeSpeaker(
  plugin: RouteIQNativePlugin,
  options: Pick<SpeakerOptions, 'setTimer' | 'clearTimer'> & { log?: SpeechLog } = {},
): Speaker {
  const { log, ...timers } = options
  return createSpeaker({
    ...timers,
    synth: nativeSynth(plugin, log),
    makeUtterance: (text): UtteranceLike => ({ text, lang: '', rate: 1, volume: 1, onend: null, onerror: null }),
  })
}
