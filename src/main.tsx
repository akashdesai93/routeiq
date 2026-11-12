import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './fonts.css'
import './live.css'
import { shellDiagnostics } from './device/native/diagnostics.ts'
import { nativePlugin, startNativeShell } from './device/native/index.ts'
import { startLab } from './lab/lab.ts'
import { setDirectionsTransport } from './providers/mapbox/client.ts'
import { Root } from './ShellRoot.tsx'
import { forgetOldSignalData } from './signalData.ts'

// The removed City of Charlotte list (#13) left a database on devices that ran an older version.
void forgetOldSignalData()

// Inside the iPhone shell, route requests are made by iOS itself, so they go out with the phone locked.
// In a browser this is null and the requests stay on fetch.
setDirectionsTransport(startNativeShell())

// The phone lab (docs/phone-lab.md): off unless the shell app was started from the PC with its launch argument.
void startLab({ plugin: nativePlugin(), diagnostics: shellDiagnostics, target: window })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
