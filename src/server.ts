import Fastify from "fastify"

export async function buildServer(opts: { llmFactory?: unknown } = {}) {
  const app = Fastify({ logger: false })
  app.get("/healthz", async () => ({ ok: true, name: "noctua" }))
  return app
}
