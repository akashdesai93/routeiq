import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './fonts.css'
import './live.css'
import { shellDiagnostics } from './device/native/diagnostics.ts'
import { nativePlugin, startNativeShell } from './device/native/index.ts'
import { startLab, type RouteIQLab } from './lab/lab.ts'
import { LAYOUT_FIXES, layoutProbe } from './lab/probe.ts'
import { setDirectionsTransport } from './providers/mapbox/client.ts'
import { Root } from './ShellRoot.tsx'
import { forgetOldSignalData } from './signalData.ts'

declare global {
  interface Window {
    /** The phone lab's hook: there only in lab mode (src/lab/lab.ts). */
    __routeiqLab?: RouteIQLab
  }
}

// The removed City of Charlotte list (#13) left a database on devices that ran an older version.
void forgetOldSignalData()

// Inside the iPhone shell, route requests are made by iOS itself, so they go out with the phone locked.
// In a browser this is null and the requests stay on fetch.
setDirectionsTransport(startNativeShell())

// The phone lab (docs/phone-lab.md): off unless the shell app was started from the PC with its launch argument.
void startLab({
  plugin: nativePlugin(),
  diagnostics: shellDiagnostics,
  target: window,
  probe: {
    layout: () => layoutProbe(document, window),
    fixes: Object.fromEntries(Object.entries(LAYOUT_FIXES).map(([name, fix]) => [name, () => fix(document, window)])),
  },
})
// Page errors and a lost map (WebGL) context, as words only, for the lab's report.
window.addEventListener('error', (event) => window.__routeiqLab?.note(`page error: ${event.error instanceof Error ? event.error.name : 'error'}`))
document.addEventListener('webglcontextlost', () => window.__routeiqLab?.note('the map lost its WebGL context'), true)
document.addEventListener('webglcontextrestored', () => window.__routeiqLab?.note('the map got its WebGL context back'), true)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
