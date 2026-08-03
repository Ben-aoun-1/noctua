import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The built app is served by Fastify out of `web/dist`, from the same origin as the API — which is
 * what lets the session cookie be `httpOnly` and `SameSite=Lax` and still reach every request the
 * UI makes. In development Vite serves the app instead, so `/api` is proxied to the backend to keep
 * that same-origin story true there too: no CORS, no cookie exemption, one code path.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080" },
    },
  },
})
