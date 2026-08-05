import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves this at https://<user>.github.io/<repo>/, so the repo
// name has to be baked into the bundle's asset paths at build time.
// Set VITE_BASE=/ if you later move it to a custom domain at the root.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/org-chart/',
})
