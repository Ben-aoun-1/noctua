import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RunEventLog } from "../events/log.js"
import type { RunStatus } from "../events/types.js"
import { RunControl } from "./control.js"

/**
 * The named task presets. The HTTP layer validates against this same list, so a preset added here
 * is accepted at the door rather than rejected by a copy of the list that nobody remembered.
 */
export const RUN_PRESETS = ["vendor", "compliance"] as const

/** A run's preset, or `null` for a free-form goal. */
export type RunPreset = (typeof RUN_PRESETS)[number] | null

export interface Run {
  id: string
  goal: string
  preset: RunPreset
  createdAt: number
  log: RunEventLog
  control: RunControl
  status: RunStatus
  costUsd: number
  /** Filled by the agent loop via `record_finding`; the report and CSV export read it. */
  findings: Record<string, unknown>[]
}

/**
 * The listable projection of a run — everything the landing page needs, nothing live. It is also
 * exactly what `meta.json` holds, so a run this process never saw lists the same as a live one.
 */
export interface RunSummary {
  id: string
  goal: string
  preset: Run["preset"]
  createdAt: number
  status: RunStatus
  costUsd: number
}

/** Statuses that mean a loop is still driving the run (concurrency cap counts these). */
const ACTIVE_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "awaiting_approval",
  "awaiting_human",
  "paused",
]

const TERMINAL_STATUSES: readonly RunStatus[] = ["finished", "failed", "stopped"]

/** Every member of `RunStatus` — a meta.json carrying anything else is not ours. */
const ALL_STATUSES: readonly RunStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES]

/** Everything `Run["preset"]` may be on disk — the named presets plus free-form. */
const PRESETS: readonly RunPreset[] = [...RUN_PRESETS, null]

function summarize(run: Run): RunSummary {
  return {
    id: run.id,
    goal: run.goal,
    preset: run.preset,
    createdAt: run.createdAt,
    status: run.status,
    costUsd: run.costUsd,
  }
}

/**
 * Rewrites this run's `meta.json`.
 *
 * The agent loop calls it on every status change and after every budget update, because meta.json
 * is all a restarted process has: without it yesterday's finished runs list as `pending` for ever,
 * and the daily cost cap starts each restart with a fresh allowance it has already spent.
 */
export function persistRun(run: Run): void {
  writeFileSync(join(run.log.dir, "meta.json"), JSON.stringify(summarize(run)))
}

/**
 * In-memory registry of runs for this process, backed by one `meta.json` per run directory so
 * earlier flights still show up in the history after a restart.
 *
 * Invariant: exactly one `RunEventLog` per run — it is constructed here, once, and handed out on
 * the `Run` object. Building a second one over the same directory would fork the `seq` counter.
 */
export class RunStore {
  private readonly runs = new Map<string, Run>()

  constructor(private readonly dataDir: string) {}

  create(goal: string, preset: Run["preset"]): Run {
    const id = randomUUID()
    const run: Run = {
      id,
      goal,
      preset,
      createdAt: Date.now(),
      log: new RunEventLog(id, this.dataDir), // creates <dataDir>/runs/<id>/shots
      control: new RunControl(),
      status: "pending",
      costUsd: 0,
      findings: [],
    }
    this.runs.set(id, run)
    persistRun(run)
    return run
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /**
   * Live runs plus runs found on disk, newest first; a live run wins over its own meta.json.
   * Ties on `createdAt` (same millisecond) break by id, so the order is total and does not depend
   * on `readdir` order or on which pass inserted the entry.
   */
  list(): RunSummary[] {
    const byId = new Map<string, RunSummary>()
    for (const meta of this.readDiskMeta()) byId.set(meta.id, meta)
    for (const run of this.runs.values()) byId.set(run.id, summarize(run))
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  /** Only in-memory runs can be active: nothing in this process is driving a run found on disk. */
  activeCount(): number {
    let n = 0
    for (const run of this.runs.values()) if (ACTIVE_STATUSES.includes(run.status)) n++
    return n
  }

  /**
   * Spend since local midnight, across runs on disk as well as live ones — the cap is a daily
   * one, so a restart must not hand the day a fresh allowance it has already spent. `list()`
   * dedupes by id with the live run winning, so a run in both places is counted once.
   */
  todaysCostUsd(): number {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const since = midnight.getTime()
    let total = 0
    for (const summary of this.list()) if (summary.createdAt >= since) total += summary.costUsd
    return total
  }

  private readDiskMeta(): RunSummary[] {
    const runsDir = join(this.dataDir, "runs")
    if (!existsSync(runsDir)) return []
    const out: RunSummary[] = []
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(runsDir, entry.name, "meta.json")
      if (!existsSync(file)) continue // a run dir whose create never finished; not listable
      try {
        const summary = this.parseMeta(readFileSync(file, "utf8"))
        if (summary) out.push(summary)
      } catch {
        // Unreadable meta must not take down the whole history listing.
      }
    }
    return out
  }

  private parseMeta(raw: string): RunSummary | null {
    const { id, goal, preset, createdAt, status, costUsd } = JSON.parse(raw) as Partial<RunSummary>
    if (typeof id !== "string" || typeof goal !== "string" || typeof createdAt !== "number") {
      return null
    }
    if (!ALL_STATUSES.includes(status as RunStatus)) return null
    if (!PRESETS.includes(preset as Run["preset"])) return null
    return {
      id,
      goal,
      preset: preset as Run["preset"],
      createdAt,
      status: status as RunStatus,
      // A meta written before this process was billing (or by an older build) still lists; it
      // reports no spend rather than dropping the run from the history.
      costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : 0,
    }
  }
}
