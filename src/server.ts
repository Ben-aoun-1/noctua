import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import cookie from "@fastify/cookie"
import fastifyStatic from "@fastify/static"
import Fastify, { type FastifyInstance } from "fastify"
import { AnthropicLLM, type LLMFactory } from "./agent/llm.js"
import { apiRoutes } from "./routes/api.js"

/**
 * The whole HTTP surface: a health check, the API, and — once `web/` has been built — the single
 * page app that drives it, from one origin. Same origin is what lets the cookie be `httpOnly` and
 * `SameSite=Lax` and still reach every `fetch` and every `EventSource` the UI opens.
 */

/**
 * `web/dist` relative to this module, which sits one directory below the project root both as
 * `src/server.ts` under tsx and as `dist/server.js` after a build.
 */
function webDistDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist")
}

export interface ServerOpts {
  /** How each run gets its model. Tests pass a scripted fake; production gets the real client. */
  llmFactory?: LLMFactory
  /** Where the built SPA lives. Defaults to `web/dist`; a test points it at a fixture instead. */
  webDist?: string
}

export async function buildServer(opts: ServerOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)

  // Open on purpose: a deploy's health probe has no cookie, and this says nothing about any run.
  app.get("/healthz", async () => ({ ok: true, name: "noctua" }))

  await app.register(apiRoutes, { llmFactory: opts.llmFactory ?? (() => new AnthropicLLM()) })

  // The API is useful long before there is a UI (and the tests run without one), so an unbuilt
  // front end is a normal state rather than a failure.
  const webDist = opts.webDist ?? webDistDir()
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
    // The UI routes on the hash, so every deep link is really `/` — but a hard refresh of a URL
    // the SPA invented still has to land on the app. Only outside `/api/`: an unknown API path
    // answering with a page of HTML would leave a `fetch` parsing markup as JSON.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" })
      return reply.sendFile("index.html")
    })
  }

  return app
}
