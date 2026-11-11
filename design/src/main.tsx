import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './base.css'
import { DEMOS } from './demos'
import { Gallery } from './gallery'

// ?capture=<name> mounts one stage alone, the route the filming scripts use.
// Anything else shows the gallery.
const name = new URLSearchParams(location.search).get('capture')
const Demo = name ? DEMOS[name] : null
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {name ? <div id="example">{Demo ? <Demo /> : <p role="alert">Unknown demo: {name}</p>}</div> : <Gallery />}
  </StrictMode>,
)
