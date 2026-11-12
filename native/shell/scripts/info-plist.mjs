// The Info.plist entries the shell needs on top of Capacitor's template.
// Kept separate from generate-ios.mjs so it can be tested without a Mac.
import { build, parse } from 'plist';

/** location: GPS continues while locked. audio: spoken guidance plays while locked. */
export const REQUIRED_BACKGROUND_MODES = ['location', 'audio'];

const LOCATION_REASON =
  'RouteIQ uses your location to follow your drive, speak the turns and find a faster route. ' +
  'It is not stored, and is sent only to Mapbox to ask for routes.';

/** @param {string} xml Info.plist text. @returns {string} patched text. */
export function patchInfoPlist(xml) {
  const info = parse(xml);

  const modes = new Set(info.UIBackgroundModes ?? []);
  for (const mode of REQUIRED_BACKGROUND_MODES) modes.add(mode);
  info.UIBackgroundModes = [...modes];

  info.NSLocationWhenInUseUsageDescription = LOCATION_REASON;
  info.NSLocationAlwaysAndWhenInUseUsageDescription =
    LOCATION_REASON + ' "Always" also lets a drive continue however the app was opened; "While Using" is enough for a drive you start yourself.';

  // The only network calls are plain HTTPS; this skips an export-compliance prompt.
  info.ITSAppUsesNonExemptEncryption = false;

  return build(info);
}

/** Throws with a readable message if the generated project is not what the shell needs. */
export function checkInfoPlist(xml) {
  const info = parse(xml);
  const problems = [];
  for (const mode of REQUIRED_BACKGROUND_MODES) {
    if (!(info.UIBackgroundModes ?? []).includes(mode)) problems.push(`UIBackgroundModes lacks "${mode}"`);
  }
  for (const key of ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription']) {
    if (!info[key]) problems.push(`${key} is missing`);
  }
  if (problems.length) throw new Error(`Info.plist check failed: ${problems.join('; ')}`);
}
