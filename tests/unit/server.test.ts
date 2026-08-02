import { describe, it, expect } from "vitest"
import { buildServer } from "../../src/server.js"

describe("server", () => {
  it("responds to healthz", async () => {
    const app = await buildServer()
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, name: "noctua" })
  })
})
