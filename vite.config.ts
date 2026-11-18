import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vercel serves the app at the root of its domain, so assets load from '/'.
// VITE_BASE is only there in case it ever has to live under a sub-path again
// (GitHub Pages, which hosted it until 2026-11, served it at /org-chart/).
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
})
