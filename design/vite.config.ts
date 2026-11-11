import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5273 on purpose: 5173 is taken by another project on this machine.
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  resolve: { dedupe: ['react', 'react-dom'] },
})
