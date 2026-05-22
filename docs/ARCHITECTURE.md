# AI Leak Guard — Architecture

## Core principle
Everything runs locally in the user's browser. No backend, no database, no telemetry, no user text ever leaves the device. One optional outbound call: daily fetch of a static rules JSON file from a CDN.

## Tech stack
- **Language:** TypeScript
- **Bundler:** Vite (with `vite-plugin-web-extension` or similar)
- **Test runner:** Vitest
- **Linter:** ESLint with TypeScript plugin
- **Formatter:** Prettier
- **Manifest:** Chrome Manifest V3
- **UI:** Vanilla TypeScript + HTML for popup, Shadow DOM for in-page toast (no React in V1 — bundle size matters for extensions)

## Project structure
```
