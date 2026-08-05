import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
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

/**
 * How a run found on disk really stands, whatever its `meta.json` says.
 *
 * A status is written by the loop that owns the run, and a loop that never wrote a terminal one is
 * a loop whose process is gone: `running` on disk means "killed mid-turn", not "in flight". Read
 * literally, every such run is live for ever — the cockpit raises an approval strip whose buttons
 * 404 on a `RunControl` that no longer exists, and hides the replay bar and the export links, which
 * are all that is left of the run worth having.
 *
 * Only runs nobody is driving reach this. A live run is served from memory: `list()` overwrites the
 * disk entry with it, and every other reader asks the store for the live run first.
 */
function asAbandoned(status: RunStatus): RunStatus {
  return TERMINAL_STATUSES.includes(status) ? status : "failed"
}

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
 *
 * Written beside and renamed onto, because it is rewritten that often: a process killed part-way
 * through a plain overwrite leaves a truncated file, and a run whose meta.json will not parse is
 * gone from the history and 404s on export — everything it earned, lost to a write that was only
 * ever bookkeeping. A rename is the one file operation a crash cannot catch half-done.
 */
export function persistRun(run: Run): void {
  const file = join(run.log.dir, "meta.json")
  const pending = `${file}.tmp`
  writeFileSync(pending, JSON.stringify(summarize(run)))
  renameSync(pending, file)
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

  /**
   * One run's `meta.json`, or null when there is none to read — which is how a caller asks "did
   * this process's predecessor know about this run?" without holding it in memory. A status that
   * predecessor never finished is reported as {@link asAbandoned} reads it, so this and `list()`
   * describe the same run the same way.
   *
   * `id` is joined into a path, so it must already have been checked to be a run id: the HTTP
   * layer does that at the door, and the only other caller is the directory walk below.
   */
  readMeta(id: string): RunSummary | null {
    const file = join(this.dataDir, "runs", id, "meta.json")
    if (!existsSync(file)) return null // a run dir whose create never finished; not listable
    try {
      return this.parseMeta(readFileSync(file, "utf8"))
    } catch {
      // Unreadable meta must not take down the whole history listing.
      return null
    }
  }

  private readDiskMeta(): RunSummary[] {
    const runsDir = join(this.dataDir, "runs")
    if (!existsSync(runsDir)) return []
    const out: RunSummary[] = []
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const summary = this.readMeta(entry.name)
      if (summary) out.push(summary)
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
      // A projection, not a repair: the file still says what the dead process last knew, and
      // reading a run's history must not rewrite it.
      status: asAbandoned(status as RunStatus),
      // A meta written before this process was billing (or by an older build) still lists; it
      // reports no spend rather than dropping the run from the history.
      costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : 0,
    }
  }
}
