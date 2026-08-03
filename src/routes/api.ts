import { createHash, timingSafeEqual } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { basename, join } from "node:path"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { LLMFactory } from "../agent/llm.js"
import { runAgent } from "../agent/loop.js"
import { config } from "../config.js"
import type { PersistedEvent } from "../events/types.js"
import type { RunControl } from "../runs/control.js"
import { RunStore, type Run } from "../runs/store.js"

/**
 * Everything the browser talks to: one access code, one way to start a run, one stream to watch it
 * on, and one way to intervene.
 *
 * Two shapes here are load-bearing rather than stylistic:
 *
 * - **The stream is never closed by the server.** A run's `done` event is followed by its terminal
 *   `run_status`, so a stream that ended on `done` would drop the very event the cockpit uses to
 *   settle its status chip. The client closes; we only clean up when the socket goes away.
 * - **Nothing in this file appends to a run's event log.** The agent loop is the sole appender
 *   (`RunEventLog` fans out from inside `append`, so writing back from a subscriber would recurse
 *   into it and interleave sequence numbers). A control call moves `RunControl`; the *loop* is what
 *   turns that into an event, if and when it acts on it.
 */

const COOKIE = "noctua_code"
/** Exempt from the cookie check — it is how the cookie is obtained. */
const AUTH_ROUTE = "/api/auth"

/** Comfortably inside every proxy's idle timeout, and invisible to the client (an SSE comment). */
const HEARTBEAT_MS = 15_000
/** A month of not retyping the code on a dashboard that is checked daily. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

const MAX_GOAL_CHARS = 2000
/** A steering note is a nudge, not a new brief — it is prefixed into one turn's observation. */
const MAX_STEER_CHARS = 500
const MAX_ANSWER_CHARS = 2000

/**
 * What a screenshot may be called, after `basename` has already removed every path separator.
 * Belt and braces: `basename("..")` is `".."`, which would otherwise resolve to the run directory
 * itself and be handed to a read stream.
 */
const SHOT_NAME = /^[\w.-]+\.jpg$/

const PRESETS: readonly string[] = ["vendor", "compliance"]

export interface ApiOpts {
  llmFactory: LLMFactory
}

interface RunParams {
  id: string
}

export async function apiRoutes(app: FastifyInstance, opts: ApiOpts): Promise<void> {
  const store = new RunStore(config.dataDir)

  // Registered inside this plugin, so it guards these routes and nothing else: `/healthz` and the
  // static SPA live in the parent context and stay open.
  app.addHook("preHandler", async (req, reply) => {
    if (req.routeOptions.url === AUTH_ROUTE) return
    if (codeMatches(req.cookies[COOKIE])) return
    return reply.code(401).send({ error: "unauthorized" })
  })

  app.post("/api/auth", async (req, reply) => {
    const code = readString(asObject(req.body).code)
    if (!codeMatches(code)) return reply.code(401).send({ error: "wrong access code" })
    // No `secure` flag: the operator may reach this over plain http (a tunnel, an IP, a staging
    // box), and a cookie the browser silently refuses to send locks them out of their own runs.
    // Confidentiality is the deployment's job — the code travels in this request body either way.
    reply.setCookie(COOKIE, config.accessCode, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
    })
    return { ok: true }
  })

  app.get("/api/runs", async () => store.list())

  app.post("/api/runs", async (req, reply) => {
    const body = asObject(req.body)
    const goal = readString(body.goal).trim()
    if (goal.length === 0 || goal.length > MAX_GOAL_CHARS) {
      return reply.code(400).send({ error: `goal must be 1..${MAX_GOAL_CHARS} characters` })
    }
    const preset = readPreset(body.preset)
    if (preset === undefined) {
      return reply.code(400).send({ error: `preset must be ${PRESETS.join(", ")} or null` })
    }
    // Both caps are about this machine, not this user: chromium instances are the scarce thing,
    // and the day's spend is money already gone.
    if (store.activeCount() >= config.maxConcurrentRuns) {
      return reply.code(429).send({ error: "too many runs in flight — wait for one to finish" })
    }
    if (store.todaysCostUsd() > config.dailyCostCapUsd) {
      return reply.code(429).send({ error: "today's budget is spent — try again tomorrow" })
    }

    // Built before the run exists. A factory that throws (no API key, say) would otherwise leave a
    // `pending` run in the history that nothing is ever going to drive.
    const llm = opts.llmFactory()
    const run = store.create(goal, preset)
    // Fire and forget: `runAgent` never throws, drives the run to a terminal state on its own, and
    // reports everything it does through the event log this response's caller is about to open.
    void runAgent(run, llm)
    return reply.code(201).send({ id: run.id })
  })

  /**
   * The live feed. Replay and live delivery are one subscription, so an event appended between the
   * file read and the handoff cannot fall down the gap between them.
   */
  app.get<{ Params: RunParams }>("/api/runs/:id/events", async (req, reply) => {
    const run = store.get(req.params.id)
    if (!run) return reply.code(404).send({ error: "unknown run" })

    // From here the socket is ours; Fastify must not try to send a body of its own.
    reply.hijack()
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which holds a run's events back until the
      // buffer fills — the whole point of this route is that it does not.
      "x-accel-buffering": "no",
    })
    reply.raw.flushHeaders()

    const heartbeat = setInterval(() => reply.raw.write(":hb\n\n"), HEARTBEAT_MS)
    // The listening socket already keeps the process alive; this only means a heartbeat can never
    // be the last thing holding it open.
    heartbeat.unref()
    const unsubscribe = run.log.subscribe(startSeq(req), (pe) => {
      reply.raw.write(frame(pe))
    })
    const stop = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    // A watcher closing a tab must not leave a subscriber writing into a dead socket for ever.
    reply.raw.on("close", stop)
    reply.raw.on("error", stop)
  })

  app.post<{ Params: RunParams }>("/api/runs/:id/control", async (req, reply) => {
    const run = store.get(req.params.id)
    if (!run) return reply.code(404).send({ error: "unknown run" })
    const problem = dispatchControl(run.control, asObject(req.body))
    if (problem !== null) return reply.code(400).send({ error: problem })
    return { ok: true }
  })

  app.get<{ Params: RunParams & { file: string } }>(
    "/api/runs/:id/shots/:file",
    async (req, reply) => {
      const run = store.get(req.params.id)
      if (!run) return reply.code(404).send({ error: "unknown run" })
      const file = basename(req.params.file)
      if (!SHOT_NAME.test(file)) return reply.code(404).send({ error: "no such screenshot" })
      const path = join(run.log.dir, "shots", file)
      if (!existsSync(path)) return reply.code(404).send({ error: "no such screenshot" })
      return reply.type("image/jpeg").send(createReadStream(path))
    },
  )
}

/**
 * Constant-time comparison of the presented code against the configured one.
 *
 * Both sides are hashed first, which makes the buffers the same length whatever was presented —
 * `timingSafeEqual` throws on a length mismatch, and the length of the real code is itself
 * something worth not leaking.
 */
function codeMatches(given: string | undefined): boolean {
  if (typeof given !== "string") return false
  return timingSafeEqual(sha256(given), sha256(config.accessCode))
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

/** One SSE message. `seq` doubles as the event id, which is what makes `Last-Event-ID` work. */
function frame(pe: PersistedEvent): string {
  return `id: ${pe.seq}\nevent: agent\ndata: ${JSON.stringify(pe)}\n\n`
}

/**
 * Where a stream should pick up.
 *
 * `Last-Event-ID` wins over `?from`, and is incremented: it names the last event the client has
 * *seen*, whereas `from` names the first it wants. EventSource sets the header by itself on a
 * reconnect, so a dropped connection resumes without losing or repeating an event even though the
 * URL it reconnects to is the original one.
 */
function startSeq(req: FastifyRequest): number {
  const header = req.headers["last-event-id"]
  const last = Number(Array.isArray(header) ? header[0] : header)
  if (header !== undefined && Number.isInteger(last) && last >= 0) return last + 1
  const from = Number((req.query as { from?: string }).from)
  return Number.isInteger(from) && from >= 1 ? from : 1
}

/** Applies one control action, or returns why it could not be applied. */
function dispatchControl(control: RunControl, body: Record<string, unknown>): string | null {
  switch (body.action) {
    case "pause":
      control.pause()
      return null
    case "resume":
      control.resume()
      return null
    case "stop":
      control.stop()
      return null
    case "approve":
      control.resolveApproval("approved")
      return null
    case "deny":
      control.resolveApproval("denied")
      return null
    case "mode": {
      const mode = body.mode
      if (mode !== "auto" && mode !== "approve") return 'mode must be "auto" or "approve"'
      control.mode = mode
      return null
    }
    case "steer": {
      const text = readBoundedText(body.text, MAX_STEER_CHARS)
      if (text === null) return `steer needs text of 1..${MAX_STEER_CHARS} characters`
      control.addSteer(text)
      return null
    }
    case "answer": {
      const text = readBoundedText(body.text, MAX_ANSWER_CHARS)
      if (text === null) return `answer needs text of 1..${MAX_ANSWER_CHARS} characters`
      control.answerHuman(text)
      return null
    }
    default:
      return `unknown action ${JSON.stringify(body.action)}`
  }
}

/** A JSON body that is not an object (`null`, a bare string, an array) carries no fields we want. */
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {}
  return body as Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Trimmed text within bounds, or null when there is none — the caller turns that into a 400. */
function readBoundedText(value: unknown, maxChars: number): string | null {
  const text = readString(value).trim()
  return text.length === 0 || text.length > maxChars ? null : text
}

/** The preset, or `undefined` for "not a preset" — `null` is itself a valid answer (free-form). */
function readPreset(value: unknown): Run["preset"] | undefined {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "string" && PRESETS.includes(value)) return value as Run["preset"]
  return undefined
}
