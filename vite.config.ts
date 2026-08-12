import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Chrome extensions reject cross-world <link rel="modulepreload"> tags with
    // "cross-world extension resource mismatch" errors on chrome://extensions.
    // Disabling both the injection and the polyfill keeps the popup HTML clean.
    modulePreload: false,
  },
})
