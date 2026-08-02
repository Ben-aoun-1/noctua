import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RunEventLog } from "../events/log.js"
import type { RunStatus } from "../events/types.js"
import { RunControl } from "./control.js"

export interface Run {
  id: string
  goal: string
  preset: "vendor" | "compliance" | null
  createdAt: number
  log: RunEventLog
  control: RunControl
  status: RunStatus
  costUsd: number
  /** Filled by the agent loop via `record_finding`; the report and CSV export read it. */
  findings: Record<string, unknown>[]
}

/** The listable projection of a run — everything the landing page needs, nothing live. */
export interface RunSummary {
  id: string
  goal: string
  preset: Run["preset"]
  createdAt: number
  status: RunStatus
}

/** Statuses that mean a loop is still driving the run (concurrency cap counts these). */
const ACTIVE_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "awaiting_approval",
  "awaiting_human",
  "paused",
]

const PRESETS: readonly Run["preset"][] = ["vendor", "compliance", null]

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
    writeFileSync(join(run.log.dir, "meta.json"), JSON.stringify(this.summarize(run)))
    return run
  }

  get(id: string): Run | undefined {
    return this.runs.get(id)
  }

  /** Live runs plus runs found on disk, newest first; a live run wins over its own meta.json. */
  list(): RunSummary[] {
    const byId = new Map<string, RunSummary>()
    for (const meta of this.readDiskMeta()) byId.set(meta.id, meta)
    for (const run of this.runs.values()) byId.set(run.id, this.summarize(run))
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Only in-memory runs can be active: nothing in this process is driving a run found on disk. */
  activeCount(): number {
    let n = 0
    for (const run of this.runs.values()) if (ACTIVE_STATUSES.includes(run.status)) n++
    return n
  }

  /** Spend since local midnight, in-memory only — `meta.json` does not carry cost. */
  todaysCostUsd(): number {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const since = midnight.getTime()
    let total = 0
    for (const run of this.runs.values()) if (run.createdAt >= since) total += run.costUsd
    return total
  }

  private summarize(run: Run): RunSummary {
    return {
      id: run.id,
      goal: run.goal,
      preset: run.preset,
      createdAt: run.createdAt,
      status: run.status,
    }
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
    const m = JSON.parse(raw) as Partial<RunSummary>
    const ok =
      typeof m.id === "string" &&
      typeof m.goal === "string" &&
      typeof m.createdAt === "number" &&
      typeof m.status === "string" &&
      PRESETS.includes(m.preset as Run["preset"])
    return ok ? (m as RunSummary) : null
  }
}
