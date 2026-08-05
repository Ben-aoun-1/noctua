import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, PersistedEvent } from "./types.js"

export type EventSubscriber = (pe: PersistedEvent) => void

/**
 * Append-only event log for one run, persisted as JSONL and fanned out to live subscribers.
 *
 * The file is the source of truth: `append` writes synchronously *before* notifying, so an
 * event a subscriber saw is always already on disk. That makes replay (reconnecting SSE
 * clients, finished-run playback, report building) just a re-read of the same file.
 */
export class RunEventLog {
  private readonly runDir: string
  private readonly file: string
  private readonly subs = new Set<EventSubscriber>()
  private seq: number

  constructor(runId: string, dataDir: string) {
    this.runDir = join(dataDir, "runs", runId)
    this.file = join(this.runDir, "events.jsonl")
    mkdirSync(join(this.runDir, "shots"), { recursive: true })
    // Re-instantiating over an existing run (restart, report build) continues its numbering.
    const existing = this.readAll()
    this.seq = existing.length === 0 ? 0 : existing[existing.length - 1].seq
  }

  /** Directory holding `events.jsonl` and `shots/` for this run. */
  get dir(): string {
    return this.runDir
  }

  append(e: AgentEvent): PersistedEvent {
    const pe: PersistedEvent = { seq: ++this.seq, ts: Date.now(), event: e }
    appendFileSync(this.file, JSON.stringify(pe) + "\n")
    // Snapshot: a callback may unsubscribe (or subscribe) while we are fanning out.
    for (const cb of [...this.subs]) this.emit(cb, pe)
    return pe
  }

  /** Replays persisted events with `seq >= fromSeq`, then streams live ones. Returns unsubscribe. */
  subscribe(fromSeq: number, cb: EventSubscriber): () => void {
    for (const pe of this.readAll()) if (pe.seq >= fromSeq) this.emit(cb, pe)
    this.subs.add(cb)
    return () => {
      this.subs.delete(cb)
    }
  }

  /**
   * Every event on the file, skipping any line that will not parse.
   *
   * There is exactly one way to write a line here — `JSON.stringify` then a newline — so a line
   * that will not parse is a line that was not finished: the process was killed part-way through
   * the append. Reading is also the constructor's first act, so before this guard a single torn
   * byte at the end of a run made the whole of it unreadable — `/events` and `/export` both 500,
   * permanently, over a run whose findings were all safely on the lines above.
   *
   * Parse failure is the only thing dropped. An event of a type this build does not recognise is
   * still an event that happened, and is passed on to whoever is replaying the run.
   */
  readAll(): PersistedEvent[] {
    if (!existsSync(this.file)) return []
    const events: PersistedEvent[] = []
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line) as PersistedEvent)
      } catch {
        // a torn tail; the events before it are the run
      }
    }
    return events
  }

  /** One bad consumer (dead SSE socket, UI bug) must not stall the run or the other consumers. */
  private emit(cb: EventSubscriber, pe: PersistedEvent): void {
    try {
      cb(pe)
    } catch {
      // ignored on purpose
    }
  }
}
