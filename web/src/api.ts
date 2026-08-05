/**
 * Everything the UI knows about the server.
 *
 * Two shapes matter here. First, every call is `same-origin` with credentials: the session cookie
 * is `httpOnly`, so the UI never sees it and never has to carry it — it either rides along or the
 * server answers 401, and 401 is the only signal the landing page needs to put the gate back up.
 *
 * Second, a failed call throws with *the server's own words*. The API answers `{ error }` with a
 * sentence written for a human ("today's budget is spent — try again tomorrow"), and the UI's job
 * is to show it rather than to invent a parallel vocabulary of its own.
 */

export const RUN_PRESETS = ["vendor", "compliance"] as const

/** A named preset, or `null` for a free-form goal. Presets prime the report schema, nothing else. */
export type Preset = (typeof RUN_PRESETS)[number] | null

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_human"
  | "paused"
  | "finished"
  | "failed"
  | "stopped"

/** One row of the flight history — exactly what `GET /api/runs` returns, newest first. */
export interface RunSummary {
  id: string
  goal: string
  preset: Preset
  createdAt: number
  status: RunStatus
  costUsd: number
}

/**
 * Everything a run says about itself, mirroring `src/events/types.ts` field for field.
 *
 * Hand-written rather than shared: the UI is built by Vite out of `web/`, the server by tsc out of
 * `src/`, and reaching across that line for a type would drag the server's module graph into the
 * bundle. The cost is that a rename on one side has to be made on the other, which is why the two
 * are kept literally identical rather than "equivalent" — every field name here is the wire name.
 */
export type AgentEvent =
  | { type: "run_status"; status: RunStatus }
  | { type: "thinking_delta"; text: string }
  | { type: "action_proposed"; tool: string; args: Record<string, unknown>; guarded: boolean }
  | { type: "action_started"; tool: string; args: Record<string, unknown> }
  | { type: "action_result"; tool: string; ok: boolean; summary: string }
  // `url` is the image's own address; `pageUrl` is the address of the page in it, and is absent
  // from every log written before the loop started stamping it.
  | { type: "screenshot"; url: string; step: number; pageUrl?: string }
  | { type: "finding"; data: Record<string, unknown>; step: number }
  | { type: "ask_human"; question: string }
  | { type: "human_answer"; text: string }
  | { type: "steer"; text: string }
  | { type: "budget"; steps: number; maxSteps: number; costUsd: number; maxCostUsd: number }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "done"; outcome: DoneOutcome; summary: string }

export type DoneOutcome = "success" | "partial" | "failed" | "stopped"

/** One line of a run's log: `seq` is 1-based, gap-free, and doubles as the SSE event id. */
export interface PersistedEvent {
  seq: number
  ts: number
  event: AgentEvent
}

/** How much rope the agent is given: `auto` acts, `approve` asks before every single action. */
export type RunMode = "auto" | "approve"

/** The eight things a watching human can do to a run in flight. */
export interface ControlBody {
  action: "pause" | "resume" | "stop" | "mode" | "approve" | "deny" | "steer" | "answer"
  /** Required by `mode`, ignored otherwise. */
  mode?: RunMode
  /** Required by `steer` and `answer`, ignored otherwise. */
  text?: string
}

export type ExportFormat = "md" | "json" | "csv"

/** A non-2xx answer, carrying the server's message and the status the caller may want to branch on. */
export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** Exchanges the shared access code for the session cookie. Throws on a wrong code (401). */
export async function auth(code: string): Promise<void> {
  await send<{ ok: true }>("/api/auth", { code })
}

/** Starts a run and returns its id — the cockpit route is built from it. */
export async function createRun(goal: string, preset: Preset): Promise<{ id: string }> {
  return send<{ id: string }>("/api/runs", { goal, preset })
}

/** Every run this deployment remembers, live or finished, newest first. */
export async function listRuns(): Promise<RunSummary[]> {
  return request<RunSummary[]>("/api/runs")
}

/**
 * One run, or null when this deployment has never heard of it.
 *
 * There is no `GET /api/runs/:id`: the list is the only projection the server offers, and it
 * already carries every field the cockpit's header needs. A run found on disk lists the same as a
 * live one, so a link to yesterday's flight still resolves to its goal.
 */
export async function getRun(id: string): Promise<RunSummary | null> {
  const runs = await listRuns()
  return runs.find((run) => run.id === id) ?? null
}

/** Pause, resume, stop, switch modes, settle an approval, steer, or answer a question. */
export async function controlRun(id: string, body: ControlBody): Promise<void> {
  await send<{ ok: true }>(`/api/runs/${encodeURIComponent(id)}/control`, body)
}

/**
 * The SSE endpoint for a run, from `from` onwards.
 *
 * A URL rather than a fetch: `EventSource` opens the connection itself, and reconnects itself —
 * quoting the last id it saw in `Last-Event-ID`, which the server prefers over this `from`. So the
 * one seq in this string is only ever the *first* connection's starting point.
 */
export function eventsUrl(id: string, from = 1): string {
  return `/api/runs/${encodeURIComponent(id)}/events?from=${from}`
}

/** A run's report as something to keep. Used as an `href`, so it carries the cookie on its own. */
export function exportUrl(id: string, format: ExportFormat): string {
  return `/api/runs/${encodeURIComponent(id)}/export?format=${format}`
}

async function send<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init })
  if (!res.ok) throw new ApiError(await readError(res), res.status)
  return (await res.json()) as T
}

/**
 * The server's own sentence, or a plain fallback.
 *
 * A body that is not the JSON we expect is not itself worth reporting — it happens when something
 * in front of the app (a proxy, a captive portal) answered instead, and the status code is then the
 * only honest thing we have to show.
 */
async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (typeof body === "object" && body !== null && "error" in body) {
      const message = (body as { error: unknown }).error
      if (typeof message === "string" && message.length > 0) return message
    }
  } catch {
    // not JSON; fall through
  }
  return `request failed (${res.status})`
}
