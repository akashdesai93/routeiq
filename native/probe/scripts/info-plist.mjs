// The Info.plist entries the probe needs on top of Capacitor's template.
// Kept separate from generate-ios.mjs so it can be tested without a Mac.
import plist from 'plist';

export const REQUIRED_BACKGROUND_MODES = ['location', 'audio'];

const LOCATION_REASON =
  'RouteIQ Probe counts location fixes during a test drive to measure whether iOS keeps the app running. ' +
  'Your location is not stored and not sent anywhere.';

/** @param {string} xml Info.plist text. @returns {string} patched text. */
export function patchInfoPlist(xml) {
  const info = plist.parse(xml);

  const modes = new Set(info.UIBackgroundModes ?? []);
  for (const mode of REQUIRED_BACKGROUND_MODES) modes.add(mode);
  info.UIBackgroundModes = [...modes];

  info.NSLocationWhenInUseUsageDescription = LOCATION_REASON;
  info.NSLocationAlwaysAndWhenInUseUsageDescription =
    LOCATION_REASON + ' "Always" lets the test continue while the phone is locked.';

  // Makes the log visible in the Files app (On My iPhone > RouteIQ Probe) as a
  // second way to get it off the phone.
  info.UIFileSharingEnabled = true;
  info.LSSupportsOpeningDocumentsInPlace = true;

  // The only network call is plain HTTPS; this skips an export-compliance prompt.
  info.ITSAppUsesNonExemptEncryption = false;

  return plist.build(info);
}

/** Throws with a readable message if the generated project is not what the probe needs. */
export function checkInfoPlist(xml) {
  const info = plist.parse(xml);
  const problems = [];
  for (const mode of REQUIRED_BACKGROUND_MODES) {
    if (!(info.UIBackgroundModes ?? []).includes(mode)) problems.push(`UIBackgroundModes lacks "${mode}"`);
  }
  for (const key of ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription']) {
    if (!info[key]) problems.push(`${key} is missing`);
  }
  if (problems.length) throw new Error(`Info.plist check failed: ${problems.join('; ')}`);
}
