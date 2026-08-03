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
