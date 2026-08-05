import { describe, it, expect } from "vitest"
import { RunEventLog } from "../../src/events/log.js"
import { appendFileSync, existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const freshDir = () => mkdtempSync(join(tmpdir(), "noctua-"))

describe("RunEventLog", () => {
  it("persists, replays and streams", () => {
    const dir = freshDir()
    const log = new RunEventLog("r1", dir)
    log.append({ type: "run_status", status: "running" })
    log.append({ type: "thinking_delta", text: "hm" })
    const seen: number[] = []
    const unsub = log.subscribe(2, (pe) => seen.push(pe.seq))
    expect(seen).toEqual([2])
    log.append({ type: "steer", text: "go" })
    expect(seen).toEqual([2, 3])
    unsub()
    log.append({ type: "steer", text: "x" })
    expect(seen).toEqual([2, 3])
    const reopened = new RunEventLog("r1", dir)
    expect(reopened.readAll()).toHaveLength(4)
  })

  it("exposes the run dir and creates the shots folder", () => {
    const dir = freshDir()
    const log = new RunEventLog("r2", dir)
    expect(log.dir).toBe(join(dir, "runs", "r2"))
    expect(existsSync(join(log.dir, "shots"))).toBe(true)
  })

  it("returns the persisted record and preserves the event payload", () => {
    const dir = freshDir()
    const log = new RunEventLog("r3", dir)
    const before = Date.now()
    const pe = log.append({ type: "finding", data: { vendor: "acme" }, step: 4 })
    expect(pe.seq).toBe(1)
    expect(pe.ts).toBeGreaterThanOrEqual(before)
    expect(pe.event).toEqual({ type: "finding", data: { vendor: "acme" }, step: 4 })
    expect(log.readAll()).toEqual([pe])
  })

  it("continues seq numbering after re-instantiation", () => {
    const dir = freshDir()
    new RunEventLog("r4", dir).append({ type: "run_status", status: "running" })
    const reopened = new RunEventLog("r4", dir)
    expect(reopened.append({ type: "run_status", status: "finished" }).seq).toBe(2)
    expect(reopened.readAll().map((pe) => pe.seq)).toEqual([1, 2])
  })

  it("replays every event when fromSeq is below the first seq", () => {
    const dir = freshDir()
    const log = new RunEventLog("r5", dir)
    log.append({ type: "run_status", status: "running" })
    const seen: number[] = []
    log.subscribe(0, (pe) => seen.push(pe.seq))
    expect(seen).toEqual([1])
  })

  /**
   * A process killed part-way through an append leaves half a line at the end of the file — and
   * `readAll` runs inside the constructor, so one torn byte used to make the whole run unreadable:
   * both `/events` and `/export` answered 500, for ever, for a run whose findings were all safely
   * on the lines above. Only lines that will not parse are dropped; an event this build does not
   * recognise is still an event.
   */
  it("reads a log whose last line was cut off mid-write", () => {
    const dir = freshDir()
    const log = new RunEventLog("r7", dir)
    log.append({ type: "run_status", status: "running" })
    log.append({ type: "finding", data: { vendor: "acme" }, step: 1 })
    appendFileSync(join(log.dir, "events.jsonl"), '{"seq":3,"ts":1700000000000,"ev')

    const reopened = new RunEventLog("r7", dir)
    expect(reopened.readAll().map((pe) => pe.seq)).toEqual([1, 2])
    expect(reopened.readAll()[1]!.event).toEqual({
      type: "finding",
      data: { vendor: "acme" },
      step: 1,
    })
  })

  it("keeps an event whose type this build has never heard of", () => {
    const dir = freshDir()
    const log = new RunEventLog("r8", dir)
    const line = { seq: 1, ts: 1_700_000_000_000, event: { type: "from_the_future", note: "hi" } }
    appendFileSync(join(log.dir, "events.jsonl"), JSON.stringify(line) + "\n")
    expect(new RunEventLog("r8", dir).readAll()).toEqual([line])
  })

  it("isolates a throwing subscriber from other subscribers and from append", () => {
    const dir = freshDir()
    const log = new RunEventLog("r6", dir)
    const seen: number[] = []
    log.subscribe(1, () => { throw new Error("boom") })
    log.subscribe(1, (pe) => seen.push(pe.seq))
    expect(() => log.append({ type: "steer", text: "go" })).not.toThrow()
    expect(seen).toEqual([1])
    expect(log.readAll()).toHaveLength(1)
  })
})
