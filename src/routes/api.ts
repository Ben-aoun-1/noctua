import { createHash, timingSafeEqual } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { basename, join } from "node:path"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { LLMFactory } from "../agent/llm.js"
import { runAgent } from "../agent/loop.js"
import { config } from "../config.js"
import { RunEventLog } from "../events/log.js"
import type { PersistedEvent, RunStatus } from "../events/types.js"
import { buildReport, toCsv, toMarkdown, type Report } from "../exports/report.js"
import type { RunControl } from "../runs/control.js"
import {
  persistRun,
  RunStore,
  RUN_PRESETS,
  type RunPreset,
  type RunSummary,
} from "../runs/store.js"

/**
 * Everything the browser talks to: one access code, one way to start a run, one stream to watch it
 * on, and one way to intervene.
 *
 * Three shapes here are load-bearing rather than stylistic:
 *
 * - **The stream is never closed by the server.** A run's `done` event is followed by its terminal
 *   `run_status`, so a stream that ended on `done` would drop the very event the cockpit uses to
 *   settle its status chip. The client closes; we only clean up when the socket goes away.
 * - **Nothing in this file appends to a run's event log.** The agent loop is the sole appender
 *   (`RunEventLog` fans out from inside `append`, so writing back from a subscriber would recurse
 *   into it and interleave sequence numbers). A control call moves `RunControl`; the *loop* is what
 *   turns that into an event, if and when it acts on it.
 * - **A run this process never drove can still be read back.** Replay and export open the run's
 *   own files directly, so yesterday's work survives a restart. That second `RunEventLog` is only
 *   ever built for a run that is *not* in memory — a live run has exactly one log, and a second
 *   one over the same directory would fork its `seq` counter.
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

/**
 * What a run id may look like before it is joined into a filesystem path. `randomUUID` is the only
 * thing that ever names a run directory, so anything carrying a separator, a dot or a `%` is not
 * one of ours and is answered without going near the disk. It also makes the id safe to quote in a
 * `content-disposition` filename.
 */
const RUN_ID = /^[0-9a-f-]{36}$/i

/**
 * Excel reads a UTF-8 CSV as the local codepage unless the file opens with a byte order mark —
 * which turns every accented vendor name in a European ledger into mojibake. The bytes are
 * otherwise plain RFC 4180.
 */
const UTF8_BOM = "\uFEFF"

/** The three shapes a report is served in: how it is rendered, typed, and named on disk. */
const FORMATS = {
  md: {
    ext: "md",
    type: "text/markdown; charset=utf-8",
    render: (report: Report): string => toMarkdown(report),
  },
  json: {
    ext: "json",
    type: "application/json; charset=utf-8",
    render: (report: Report): string => JSON.stringify(report),
  },
  csv: {
    ext: "csv",
    type: "text/csv; charset=utf-8",
    render: (report: Report): string => UTF8_BOM + toCsv(report.findings),
  },
} as const

type ExportFormat = keyof typeof FORMATS

export interface ApiOpts {
  llmFactory: LLMFactory
}

interface RunParams {
  id: string
}

/** A run's goal, where it stands, and its whole log — wherever the three were found. */
interface ExportSource {
  goal: string
  status: RunStatus
  events: PersistedEvent[]
}

export async function apiRoutes(app: FastifyInstance, opts: ApiOpts): Promise<void> {
  // Read once and shared with everything below that opens a run's files, so the store and the logs
  // it hands out can never end up pointed at two different directories.
  const dataDir = config.dataDir
  const store = new RunStore(dataDir)

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
    // `secure` in production, where the deployment terminates TLS, and not on a laptop reached
    // over plain http — there a cookie the browser silently refuses to send would lock the
    // operator out of their own runs with no visible reason why.
    reply.setCookie(COOKIE, config.accessCode, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_S,
      secure: process.env.NODE_ENV === "production",
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
      return reply.code(400).send({ error: `preset must be ${RUN_PRESETS.join(", ")} or null` })
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
    // Fire and forget: `runAgent` drives the run to a terminal state on its own and reports what it
    // does through the event log this response's caller is about to open.
    //
    // It handles its own failures — but only from inside its try block, and its first status write
    // happens before that. An unwritable data directory would therefore reject a promise nobody is
    // awaiting, which in Node means the whole server dies with it. This catch is that floor: the
    // run is already lost, and marking it terminal in memory at least stops it holding a
    // concurrency slot for ever. Nothing is appended here — the log is what failed.
    void runAgent(run, llm).catch((err: unknown) => {
      run.status = "failed"
      // meta.json is a different file from the log that just died, and may well still be
      // writable — worth the attempt, so a restart lists this run as failed rather than as
      // pending for ever. Guarded, because it is just as likely to be the thing that broke.
      try {
        persistRun(run)
      } catch {
        // ignored on purpose
      }
      console.error(`run ${run.id} died before the loop could report it:`, err)
    })
    return reply.code(201).send({ id: run.id })
  })

  /**
   * The live feed. Replay and live delivery are one subscription, so an event appended between the
   * file read and the handoff cannot fall down the gap between them.
   *
   * A run this process is not driving is served from its file alone: the log is complete, nothing
   * will ever append to it again, and replaying it is exactly what the cockpit does with a run it
   * has just opened. That is the whole of "watch yesterday's flight back".
   */
  app.get<{ Params: RunParams }>("/api/runs/:id/events", async (req, reply) => {
    const run = store.get(req.params.id)
    const log = run ? run.log : diskLog(store, dataDir, req.params.id)
    if (!log) return reply.code(404).send({ error: "unknown run" })

    // From here the socket is ours; Fastify must not try to send a body of its own.
    reply.hijack()
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which holds a run's events back until the
      // buffer fills — the whole point of this route is that it does not.
      "x-accel-buffering": "no",
      // Hijacked, so the app-wide onSend hook never sees this reply; set it here as well.
      "x-content-type-options": "nosniff",
    })
    reply.raw.flushHeaders()

    const heartbeat = setInterval(() => reply.raw.write(":hb\n\n"), HEARTBEAT_MS)
    // The listening socket already keeps the process alive; this only means a heartbeat can never
    // be the last thing holding it open.
    heartbeat.unref()
    const unsubscribe = log.subscribe(startSeq(req), (pe) => {
      reply.raw.write(frame(pe))
    })
    const stop = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    // A watcher closing a tab must not leave a subscriber writing into a dead socket for ever.
    reply.raw.on("close", stop)
    reply.raw.on("error", stop)
    // A client that hung up while the replay was being written has already fired `close`, and
    // would never fire it again: the handlers above would be registered onto a dead socket and
    // the heartbeat and the subscription would outlive the connection.
    if (reply.raw.destroyed) stop()
  })

  app.post<{ Params: RunParams }>("/api/runs/:id/control", async (req, reply) => {
    const run = store.get(req.params.id)
    if (!run) return reply.code(404).send({ error: "unknown run" })
    const problem = dispatchControl(run.control, asObject(req.body))
    if (problem !== null) return reply.code(400).send({ error: problem })
    return { ok: true }
  })

  /**
   * The run, as something to keep: a Markdown report to read, JSON to feed a script, or the CSV
   * that goes into a ledger. Served for finished runs found on disk as well as live ones — the
   * export is the point of the whole exercise, and it must outlive the process that earned it.
   */
  app.get<{ Params: RunParams; Querystring: { format?: string } }>(
    "/api/runs/:id/export",
    async (req, reply) => {
      const format = readFormat(req.query.format)
      // Checked before the run is looked for, so a typo in the query string never sends us to the
      // filesystem for an answer it cannot use.
      if (!format) {
        return reply.code(400).send({ error: `format must be ${Object.keys(FORMATS).join(", ")}` })
      }
      const source = loadForExport(store, dataDir, req.params.id)
      if (!source) return reply.code(404).send({ error: "unknown run" })

      const report = buildReport(source.goal, source.events, source.status)
      // Enough of the id to tell one download from another in a folder of them, and short enough
      // to stay readable. The id is known to be a run id by now, so nothing can escape the quotes.
      const filename = `noctua-${req.params.id.slice(0, 8)}.${format.ext}`
      return reply
        .type(format.type)
        .header("content-disposition", `attachment; filename="${filename}"`)
        .send(format.render(report))
    },
  )

  /** Served for a run found on disk as well as a live one: an exported report links straight here. */
  app.get<{ Params: RunParams & { file: string } }>(
    "/api/runs/:id/shots/:file",
    async (req, reply) => {
      const dir = shotsDir(store, dataDir, req.params.id)
      if (!dir) return reply.code(404).send({ error: "unknown run" })
      const file = basename(req.params.file)
      if (!SHOT_NAME.test(file)) return reply.code(404).send({ error: "no such screenshot" })
      const path = join(dir, file)
      if (!existsSync(path)) return reply.code(404).send({ error: "no such screenshot" })
      return reply.type("image/jpeg").send(createReadStream(path))
    },
  )
}

/** The named export format, defaulting to Markdown; null for one we do not write. */
function readFormat(value: unknown): (typeof FORMATS)[ExportFormat] | null {
  const name = typeof value === "string" && value !== "" ? value : "md"
  // `hasOwn` rather than a bare lookup: `?format=constructor` would otherwise find something.
  return Object.hasOwn(FORMATS, name) ? FORMATS[name as ExportFormat] : null
}

/**
 * A run's goal and its whole event log, whether or not this process is the one that drove it.
 *
 * A live run is read from the log it is already writing. Anything else comes off disk — the goal
 * from `meta.json` (the events never carry it) and the events from the file, through a log opened
 * for this read alone. Nothing here appends, and a live run never reaches that second `RunEventLog`.
 */
function loadForExport(store: RunStore, dataDir: string, id: string): ExportSource | null {
  const live = store.get(id)
  if (live) return { goal: live.goal, status: live.status, events: live.log.readAll() }
  const meta = diskMeta(store, id)
  if (!meta) return null
  return {
    goal: meta.goal,
    status: meta.status,
    events: new RunEventLog(id, dataDir).readAll(),
  }
}

/**
 * Where a run's screenshots are, whether or not this process is driving it.
 *
 * A finished run's shots are what its exported report links to, so they have to outlive the
 * process as the report does. This is a path, not a log: nothing is opened or created here.
 */
function shotsDir(store: RunStore, dataDir: string, id: string): string | null {
  const live = store.get(id)
  if (live) return join(live.log.dir, "shots")
  return diskMeta(store, id) ? join(dataDir, "runs", id, "shots") : null
}

/** The log file of a finished run this process never drove, reopened to be replayed and no more. */
function diskLog(store: RunStore, dataDir: string, id: string): RunEventLog | null {
  return diskMeta(store, id) ? new RunEventLog(id, dataDir) : null
}

/**
 * What disk remembers of a run, or null — including for an id that is not a run id at all, which
 * is checked *before* anything joins it into a path.
 */
function diskMeta(store: RunStore, id: string): RunSummary | null {
  if (!RUN_ID.test(id)) return null
  return store.readMeta(id)
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
function readPreset(value: unknown): RunPreset | undefined {
  if (value === undefined || value === null || value === "") return null
  const named = RUN_PRESETS.find((preset) => preset === value)
  return named ?? undefined
}
