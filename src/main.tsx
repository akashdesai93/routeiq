import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Root } from './ShellRoot.tsx'
import { forgetOldSignalData } from './signalData.ts'

// The removed City of Charlotte list (#13) left a database on devices that ran an older version.
void forgetOldSignalData()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
