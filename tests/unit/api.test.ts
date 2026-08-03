import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance, InjectOptions } from "fastify"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  FakeLLM,
  type LLM,
  type LLMFactory,
  type ScriptedTurn,
  type TurnRequest,
  type TurnResult,
} from "../../src/agent/llm.js"
import { config } from "../../src/config.js"
import type { PersistedEvent } from "../../src/events/types.js"
import type { RunSummary } from "../../src/runs/store.js"
import { buildServer } from "../../src/server.js"

/**
 * The HTTP surface end to end: real Fastify, real store, real agent loop behind a scripted model.
 *
 * Runs started through `POST /api/runs` drive the actual loop — which means a real chromium and a
 * real screenshot on disk — so the shot and SSE assertions are about what a browser would receive,
 * not about a mock of it. Two runs are started in the whole file, because that is two browsers.
 */

const COOKIE = "noctua_code"
const CODE = config.accessCode
const GOAL = "Confirm there is nothing to confirm"
const TERMINAL = ["finished", "failed", "stopped"]

/** One turn, one `finish`: the cheapest complete run there is. */
const FINISH_SCRIPT: ScriptedTurn[] = [
  {
    thinking: "A blank tab has nothing on it.",
    toolName: "finish",
    toolInput: { outcome: "success", summary: "Nothing to verify." },
  },
]

/** Config is a plain object read live by the routes; every test restores what it changed. */
const defaults = { ...config }
afterEach(() => {
  Object.assign(config, defaults)
})

/** A server on its own empty data dir. Set config first: the store reads it at construction. */
async function newApp(llmFactory?: LLMFactory): Promise<FastifyInstance> {
  config.dataDir = mkdtempSync(join(tmpdir(), "noctua-api-"))
  return buildServer(llmFactory ? { llmFactory } : {})
}

function authed(app: FastifyInstance, opts: InjectOptions) {
  return app.inject({ ...opts, cookies: { [COOKIE]: CODE } })
}

function createRun(app: FastifyInstance, payload: Record<string, unknown>) {
  return authed(app, { method: "POST", url: "/api/runs", payload })
}

function control(app: FastifyInstance, id: string, payload: Record<string, unknown>) {
  return authed(app, { method: "POST", url: `/api/runs/${id}/control`, payload })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls the list endpoint until the run reports a terminal status. */
async function waitForTerminal(app: FastifyInstance, id: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await authed(app, { method: "GET", url: "/api/runs" })
    const summary = (res.json() as RunSummary[]).find((r) => r.id === id)
    if (summary && TERMINAL.includes(summary.status)) return summary
    await sleep(50)
  }
  throw new Error(`run ${id} never reached a terminal status`)
}

/** A model that blocks mid-turn until the test lets go — a run that stays active on demand. */
class GateLLM implements LLM {
  private readonly inner = new FakeLLM(FINISH_SCRIPT)
  private release!: () => void
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  private signalStarted!: () => void
  /** Resolves once the loop has a browser up and is asking for its first turn. */
  readonly started = new Promise<void>((resolve) => {
    this.signalStarted = resolve
  })

  async turn(req: TurnRequest, onThinkingDelta: (t: string) => void): Promise<TurnResult> {
    this.signalStarted()
    await this.gate
    return this.inner.turn(req, onThinkingDelta)
  }

  /** Lets the turn return `finish`, so the run ends and its browser closes. */
  finish(): void {
    this.release()
  }
}

interface Frame {
  id: string | null
  event: string | null
  data: PersistedEvent | null
}

/** Minimal SSE reader: frames in, plus the one question a test cannot ask twice — is it still open? */
class SseClient {
  private readonly decoder = new TextDecoder()
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  private buf = ""
  readonly frames: Frame[] = []
  readonly comments: string[] = []

  constructor(
    readonly res: Response,
    private readonly ac: AbortController,
  ) {
    this.reader = res.body!.getReader()
  }

  async readUntil(pred: (frames: Frame[]) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!pred(this.frames)) {
      const state = await this.next(Math.max(1, deadline - Date.now()))
      if (state !== "data") throw new Error(`sse ${state} after ${this.frames.length} frames`)
    }
  }

  /** True when nothing arrived for `ms` — how "the server did not close the stream" is asserted. */
  async idleFor(ms: number): Promise<boolean> {
    return (await this.next(ms)) === "idle"
  }

  close(): void {
    this.ac.abort()
    this.pending?.catch(() => undefined)
  }

  private async next(ms: number): Promise<"data" | "idle" | "end"> {
    // The read is kept across a timeout rather than restarted, so no chunk is ever dropped.
    this.pending ??= this.reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<"idle">((resolve) => {
      timer = setTimeout(() => resolve("idle"), ms)
    })
    try {
      const result = await Promise.race([this.pending, idle])
      if (result === "idle") return "idle"
      this.pending = null
      if (result.done) return "end"
      this.push(this.decoder.decode(result.value, { stream: true }))
      return "data"
    } finally {
      clearTimeout(timer)
    }
  }

  private push(text: string): void {
    this.buf += text
    const parts = this.buf.split("\n\n")
    this.buf = parts.pop() ?? ""
    for (const part of parts) {
      if (part.startsWith(":")) {
        this.comments.push(part)
        continue
      }
      const frame: Frame = { id: null, event: null, data: null }
      for (const line of part.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4)
        else if (line.startsWith("event: ")) frame.event = line.slice(7)
        else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6)) as PersistedEvent
      }
      this.frames.push(frame)
    }
  }
}

describe("api auth", () => {
  it("leaves healthz open", async () => {
    const app = await newApp()
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
  })

  it("refuses an /api call with no cookie", async () => {
    const app = await newApp()
    const res = await app.inject({ method: "GET", url: "/api/runs" })
    expect(res.statusCode).toBe(401)
  })

  it("refuses a cookie that is not the access code", async () => {
    const app = await newApp()
    const res = await app.inject({
      method: "GET",
      url: "/api/runs",
      cookies: { [COOKIE]: "not-the-code" },
    })
    expect(res.statusCode).toBe(401)
  })

  it("refuses the wrong code and sets no cookie", async () => {
    const app = await newApp()
    const res = await app.inject({ method: "POST", url: "/api/auth", payload: { code: "nope" } })
    expect(res.statusCode).toBe(401)
    expect(res.cookies).toHaveLength(0)
  })

  it("refuses a missing code", async () => {
    const app = await newApp()
    const res = await app.inject({ method: "POST", url: "/api/auth", payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it("sets an httpOnly cookie for the right code, which then opens /api", async () => {
    const app = await newApp()
    const res = await app.inject({ method: "POST", url: "/api/auth", payload: { code: CODE } })
    expect(res.statusCode).toBe(200)
    const cookie = res.cookies[0] as Record<string, unknown>
    expect(cookie.name).toBe(COOKIE)
    expect(cookie.value).toBe(CODE)
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.path).toBe("/")
    expect(String(cookie.sameSite).toLowerCase()).toBe("lax")

    const listed = await app.inject({
      method: "GET",
      url: "/api/runs",
      cookies: { [COOKIE]: String(cookie.value) },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toEqual([])
  })
})

describe("api run creation", () => {
  const never: LLMFactory = () => {
    throw new Error("the model should not have been reached")
  }

  it("rejects a missing, empty or oversized goal", async () => {
    const app = await newApp(never)
    expect((await createRun(app, {})).statusCode).toBe(400)
    expect((await createRun(app, { goal: "   " })).statusCode).toBe(400)
    expect((await createRun(app, { goal: "x".repeat(2001) })).statusCode).toBe(400)
  })

  it("rejects an unknown preset", async () => {
    const app = await newApp(never)
    const res = await createRun(app, { goal: GOAL, preset: "astrology" })
    expect(res.statusCode).toBe(400)
  })

  it("refuses a run when the concurrency cap is reached", async () => {
    config.maxConcurrentRuns = 1
    const gate = new GateLLM()
    const app = await newApp(() => gate)

    const first = await createRun(app, { goal: GOAL, preset: null })
    expect(first.statusCode).toBe(201)
    // Wait for the loop to actually be mid-turn: until then "active" would rest on timing.
    await gate.started

    const second = await createRun(app, { goal: GOAL, preset: null })
    expect(second.statusCode).toBe(429)

    gate.finish()
    await waitForTerminal(app, first.json().id as string)
    // With the run over, the cap frees up again.
    expect((await createRun(app, { goal: GOAL, preset: null })).statusCode).toBe(201)
    await waitForTerminal(app, (await authed(app, { method: "GET", url: "/api/runs" })).json()[0].id)
  })

  it("refuses a run when the day's budget is spent", async () => {
    const app = await newApp(never)
    // A finished run on disk, as a restart would find it: the cap counts yesterday's process too.
    const id = randomUUID()
    mkdirSync(join(config.dataDir, "runs", id), { recursive: true })
    writeFileSync(
      join(config.dataDir, "runs", id, "meta.json"),
      JSON.stringify({
        id,
        goal: "an expensive afternoon",
        preset: null,
        createdAt: Date.now(),
        status: "finished",
        costUsd: 9.99,
      }),
    )
    config.dailyCostCapUsd = 1

    const res = await createRun(app, { goal: GOAL, preset: null })
    expect(res.statusCode).toBe(429)
  })
})

describe("api with a finished run", () => {
  let app: FastifyInstance
  let base: string
  let id: string

  beforeAll(async () => {
    app = await newApp(() => new FakeLLM(FINISH_SCRIPT))
    await app.listen({ port: 0, host: "127.0.0.1" })
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const res = await createRun(app, { goal: GOAL, preset: "vendor" })
    expect(res.statusCode).toBe(201)
    id = res.json().id as string
    const summary = await waitForTerminal(app, id)
    expect(summary.status).toBe("finished")
  }, 40_000)

  afterAll(async () => {
    await app.close()
  })

  function sse(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const ac = new AbortController()
    return fetch(`${base}${path}`, {
      headers: { cookie: `${COOKIE}=${CODE}`, ...headers },
      signal: ac.signal,
    }).then((res) => new SseClient(res, ac))
  }

  it("lists the run with its goal, preset and cost", async () => {
    const res = await authed(app, { method: "GET", url: "/api/runs" })
    expect(res.statusCode).toBe(200)
    const summary = (res.json() as RunSummary[]).find((r) => r.id === id)!
    expect(summary.goal).toBe(GOAL)
    expect(summary.preset).toBe("vendor")
    expect(summary.status).toBe("finished")
    expect(summary.costUsd).toBeGreaterThan(0)
  })

  it("serves the step screenshot the loop wrote", async () => {
    const res = await authed(app, { method: "GET", url: `/api/runs/${id}/shots/1.jpg` })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("image/jpeg")
    // JPEG start-of-image marker: the bytes really are the screenshot.
    expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it("404s a missing shot, an unknown run and a traversal attempt", async () => {
    expect((await authed(app, { method: "GET", url: `/api/runs/${id}/shots/99.jpg` })).statusCode).toBe(404)
    expect(
      (await authed(app, { method: "GET", url: `/api/runs/${randomUUID()}/shots/1.jpg` })).statusCode,
    ).toBe(404)
    for (const attempt of ["..%2F..%2Fmeta.json", "..%2Fmeta.json", "%2Fetc%2Fpasswd", "..", "meta.json"]) {
      const res = await authed(app, { method: "GET", url: `/api/runs/${id}/shots/${attempt}` })
      expect(res.statusCode, attempt).toBe(404)
    }
  })

  it("needs the cookie for shots too", async () => {
    const res = await app.inject({ method: "GET", url: `/api/runs/${id}/shots/1.jpg` })
    expect(res.statusCode).toBe(401)
  })

  it("404s control of an unknown run and 400s a bad payload", async () => {
    expect((await control(app, randomUUID(), { action: "pause" })).statusCode).toBe(404)
    expect((await control(app, id, { action: "levitate" })).statusCode).toBe(400)
    expect((await control(app, id, {})).statusCode).toBe(400)
    expect((await control(app, id, { action: "mode", mode: "sideways" })).statusCode).toBe(400)
    expect((await control(app, id, { action: "steer", text: "" })).statusCode).toBe(400)
    expect((await control(app, id, { action: "steer", text: "x".repeat(501) })).statusCode).toBe(400)
    expect((await control(app, id, { action: "answer", text: "x".repeat(2001) })).statusCode).toBe(400)
  })

  it("accepts every control action", async () => {
    for (const payload of [
      { action: "pause" },
      { action: "resume" },
      { action: "mode", mode: "approve" },
      { action: "mode", mode: "auto" },
      { action: "approve" },
      { action: "deny" },
      { action: "steer", text: "check the VAT number too" },
      { action: "answer", text: "yes, proceed" },
      { action: "stop" },
    ]) {
      const res = await control(app, id, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    }
  })

  it("replays the whole log over SSE and keeps the stream open past done", async () => {
    const client = await sse(`/api/runs/${id}/events?from=1`)
    expect(client.res.status).toBe(200)
    expect(client.res.headers.get("content-type")).toContain("text/event-stream")
    expect(client.res.headers.get("cache-control")).toContain("no-cache")
    expect(client.res.headers.get("x-accel-buffering")).toBe("no")

    await client.readUntil((f) => f.some((x) => x.data?.event.type === "done"))
    // The terminal status is appended *after* done; a stream closed on done would lose it.
    await client.readUntil((f) => {
      const last = f[f.length - 1]?.data?.event
      return last?.type === "run_status" && last.status === "finished"
    })

    const first = client.frames[0]!
    expect(first.id).toBe("1")
    expect(first.event).toBe("agent")
    expect(first.data!.seq).toBe(1)
    expect(first.data!.event).toEqual({ type: "run_status", status: "running" })

    const doneAt = client.frames.findIndex((f) => f.data?.event.type === "done")
    expect(client.frames[doneAt + 1]!.data!.event).toEqual({
      type: "run_status",
      status: "finished",
    })
    // Ids are the seq numbers, in order and gap-free.
    expect(client.frames.map((f) => f.id)).toEqual(
      client.frames.map((_, i) => String(i + 1)),
    )

    expect(await client.idleFor(300)).toBe(true)
    client.close()
  })

  it("replays from ?from=N", async () => {
    const client = await sse(`/api/runs/${id}/events?from=3`)
    await client.readUntil((f) => f.length > 0)
    expect(client.frames[0]!.id).toBe("3")
    expect(client.frames[0]!.data!.seq).toBe(3)
    client.close()
  })

  it("resumes after Last-Event-ID, which beats ?from", async () => {
    const client = await sse(`/api/runs/${id}/events?from=1`, { "last-event-id": "2" })
    await client.readUntil((f) => f.length > 0)
    expect(client.frames[0]!.id).toBe("3")
    client.close()
  })

  it("404s the event stream of an unknown run", async () => {
    const res = await fetch(`${base}/api/runs/${randomUUID()}/events`, {
      headers: { cookie: `${COOKIE}=${CODE}` },
    })
    expect(res.status).toBe(404)
    await res.body?.cancel()
  })

  it("needs the cookie for the event stream", async () => {
    const res = await fetch(`${base}/api/runs/${id}/events`)
    expect(res.status).toBe(401)
    await res.body?.cancel()
  })
})

describe("static single page app", () => {
  const INDEX = "<!doctype html><title>noctua</title><div id=root></div>"

  async function appWithWeb(): Promise<FastifyInstance> {
    const webDist = mkdtempSync(join(tmpdir(), "noctua-web-"))
    writeFileSync(join(webDist, "index.html"), INDEX)
    writeFileSync(join(webDist, "app.js"), "// built bundle")
    config.dataDir = mkdtempSync(join(tmpdir(), "noctua-api-"))
    return buildServer({ webDist, llmFactory: () => new FakeLLM([]) })
  }

  it("serves the built app and its assets", async () => {
    const app = await appWithWeb()
    const index = await app.inject({ method: "GET", url: "/" })
    expect(index.statusCode).toBe(200)
    expect(index.body).toBe(INDEX)
    expect((await app.inject({ method: "GET", url: "/app.js" })).statusCode).toBe(200)
  })

  it("falls back to the app for a deep link, but never for /api", async () => {
    const app = await appWithWeb()
    const deep = await app.inject({ method: "GET", url: "/run/abc123" })
    expect(deep.statusCode).toBe(200)
    expect(deep.body).toBe(INDEX)

    const missing = await app.inject({ method: "GET", url: "/api/nope" })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers["content-type"]).toContain("application/json")
  })

  it("leaves the real routes alone", async () => {
    const app = await appWithWeb()
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200)
    expect((await app.inject({ method: "GET", url: "/api/runs" })).statusCode).toBe(401)
    expect((await authed(app, { method: "GET", url: "/api/runs" })).statusCode).toBe(200)
  })

  it("serves the API alone when the app has not been built", async () => {
    const app = await newApp(() => new FakeLLM([]))
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404)
    expect((await authed(app, { method: "GET", url: "/api/runs" })).statusCode).toBe(200)
  })
})
