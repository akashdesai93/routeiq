// Picks the iPhone simulator for the simulator drive from what the runner has:
//
//   xcrun simctl list devices available -j | node sim/pick-device.mjs [name]
//
// Prints "<udid>\t<name>\t<runtime>". The newest iOS runtime, and on it the
// named device, else the first of a short list of plain iPhones, else any iPhone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PREFERRED = ['iPhone 17', 'iPhone 17 Pro', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 15'];

const versionOf = (runtime) => (/iOS-(\d+)-(\d+)/.exec(runtime) ?? []).slice(1).map(Number);

/** @param {{ devices: Record<string, { udid: string, name: string, isAvailable?: boolean }[]> }} list */
export function pickDevice(list, wanted = '') {
  const runtimes = Object.entries(list.devices ?? {})
    .map(([runtime, devices]) => ({ runtime, version: versionOf(runtime), phones: devices.filter((d) => d.isAvailable !== false && d.name.startsWith('iPhone')) }))
    .filter((r) => r.version.length === 2 && r.phones.length > 0)
    .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);
  for (const { runtime, phones } of runtimes) {
    const names = wanted === '' ? PREFERRED : [wanted];
    const found = names.map((name) => phones.find((d) => d.name === name)).find((d) => d !== undefined) ?? (wanted === '' ? phones[0] : undefined);
    if (found !== undefined) return { udid: found.udid, name: found.name, runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '') };
  }
  return null;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const picked = pickDevice(JSON.parse(readFileSync(0, 'utf8')), process.argv[2] ?? '');
  if (picked === null) {
    console.error('No available iPhone simulator was found.');
    process.exitCode = 1;
  } else {
    console.log(`${picked.udid}\t${picked.name}\t${picked.runtime}`);
  }
}
