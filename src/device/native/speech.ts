import { createSpeaker, type Speaker, type SpeakerOptions, type SpeechSynthLike, type UtteranceLike } from '../speech.ts'
import type { RouteIQNativePlugin } from './plugin.ts'

/**
 * The plugin's voice (AVSpeechSynthesizer) behind the two methods of the
 * browser's speechSynthesis that the speaker uses. An utterance ends when
 * the plugin's `speak` settles: spoken, cut off or failed, the queue moves on.
 * A silent utterance (the browser's "unlock" trick) is not sent at all:
 * native speech needs no unlocking.
 */
export function nativeSynth(plugin: RouteIQNativePlugin): SpeechSynthLike {
  return {
    speak(utterance) {
      if (utterance.volume <= 0 || utterance.text.trim() === '') {
        utterance.onend?.()
        return
      }
      plugin.speak({ text: utterance.text }).then(
        () => utterance.onend?.(),
        () => utterance.onerror?.(),
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
export function createNativeSpeaker(plugin: RouteIQNativePlugin, options: Pick<SpeakerOptions, 'setTimer' | 'clearTimer'> = {}): Speaker {
  return createSpeaker({
    ...options,
    synth: nativeSynth(plugin),
    makeUtterance: (text): UtteranceLike => ({ text, lang: '', rate: 1, volume: 1, onend: null, onerror: null }),
  })
}
