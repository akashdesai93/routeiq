// Runs in the shell's WebView before the web app's own script. Puts the Swift
// plugin where the web app looks for it (src/device/native/plugin.ts in the
// repository root). In a browser this file is never loaded, and the web app
// uses the browser's GPS and voice.
//
// No "is the plugin there?" check on purpose: if the plugin were missing, a
// silent fall-back to the web page's GPS would look fine at home and stop
// working with the phone locked. Without the check, Start drive fails at once
// with an error instead. (The build checks that the plugin is in the app.)
import { Capacitor, registerPlugin } from '@capacitor/core';

if (Capacitor.isNativePlatform()) {
  window.RouteIQNative = registerPlugin('RouteIQNative');
}
