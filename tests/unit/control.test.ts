import { describe, it, expect } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunControl } from "../../src/runs/control.js"
import { RunStore } from "../../src/runs/store.js"

const freshDir = () => mkdtempSync(join(tmpdir(), "noctua-"))
/** Lets every already-scheduled promise callback run, so "did it block?" is a real assertion. */
const tick = () => new Promise((r) => setImmediate(r))

describe("RunControl", () => {
  it("starts in auto mode, unpaused and unstopped", () => {
    const c = new RunControl()
    expect(c.mode).toBe("auto")
    expect(c.isPaused()).toBe(false)
    expect(c.isStopped()).toBe(false)
  })

  it("resolves an approval request with the decision", async () => {
    const c = new RunControl()
    const approved = c.requestApproval()
    c.resolveApproval("approved")
    expect(await approved).toBe("approved")

    const denied = c.requestApproval()
    c.resolveApproval("denied")
    expect(await denied).toBe("denied")
  })

  it("leaves an approval pending until a decision arrives", async () => {
    const c = new RunControl()
    let settled = false
    const p = c.requestApproval().then((d) => {
      settled = true
      return d
    })
    await tick()
    expect(settled).toBe(false)
    c.resolveApproval("approved")
    expect(await p).toBe("approved")
  })

  it("waitWhilePaused resolves immediately when not paused", async () => {
    const c = new RunControl()
    let settled = false
    void c.waitWhilePaused().then(() => (settled = true))
    await tick()
    expect(settled).toBe(true)
  })

  it("waitWhilePaused blocks until resume, for every waiter", async () => {
    const c = new RunControl()
    const settled = [false, false]
    const waits = [
      c.waitWhilePaused().then(() => (settled[0] = true)),
      c.waitWhilePaused().then(() => (settled[1] = true)),
    ]
    c.pause()
    expect(c.isPaused()).toBe(true)
    // Both waiters registered *after* the pause are the ones that must block.
    const blocked = [false, false]
    const blockedWaits = [
      c.waitWhilePaused().then(() => (blocked[0] = true)),
      c.waitWhilePaused().then(() => (blocked[1] = true)),
    ]
    await Promise.all(waits)
    expect(settled).toEqual([true, true])
    await tick()
    expect(blocked).toEqual([false, false])
    c.resume()
    await Promise.all(blockedWaits)
    expect(blocked).toEqual([true, true])
    expect(c.isPaused()).toBe(false)
  })

  it("askHuman resolves with the answer text", async () => {
    const c = new RunControl()
    let settled = false
    const p = c.askHuman().then((t) => {
      settled = true
      return t
    })
    await tick()
    expect(settled).toBe(false)
    c.answerHuman("use the 2024 filing")
    expect(await p).toBe("use the 2024 filing")
  })

  it("drainSteer returns queued notes in order and empties the queue", () => {
    const c = new RunControl()
    expect(c.drainSteer()).toEqual([])
    c.addSteer("check the VAT number")
    c.addSteer("prefer official sources")
    expect(c.drainSteer()).toEqual(["check the VAT number", "prefer official sources"])
    expect(c.drainSteer()).toEqual([])
  })

  it("stop unblocks a pause wait, denies a pending approval and answers a pending question", async () => {
    const c = new RunControl()
    c.pause()
    const paused = c.waitWhilePaused()
    const approval = c.requestApproval()
    const answer = c.askHuman()
    c.stop()
    expect(c.isStopped()).toBe(true)
    await paused
    expect(await approval).toBe("denied")
    expect(await answer).toContain("stopped")
  })

  it("keeps answering promptly once stopped", async () => {
    const c = new RunControl()
    c.stop()
    expect(await c.requestApproval()).toBe("denied")
    expect(await c.askHuman()).toContain("stopped")
    c.pause()
    expect(c.isPaused()).toBe(false)
    let settled = false
    void c.waitWhilePaused().then(() => (settled = true))
    await tick()
    expect(settled).toBe(true)
  })

  it("ignores a decision or an answer when nothing is pending", () => {
    const c = new RunControl()
    expect(() => c.resolveApproval("approved")).not.toThrow()
    expect(() => c.answerHuman("nobody asked")).not.toThrow()
  })

  it("never leaves a superseded approval or question hanging", async () => {
    const c = new RunControl()
    const first = c.requestApproval()
    const second = c.requestApproval()
    expect(await first).toBe("denied")
    c.resolveApproval("approved")
    expect(await second).toBe("approved")

    const q1 = c.askHuman()
    const q2 = c.askHuman()
    expect(typeof (await q1)).toBe("string")
    c.answerHuman("here you go")
    expect(await q2).toBe("here you go")
  })
})

describe("RunStore", () => {
  it("creates a run with an id, a log, a control and empty findings", () => {
    const store = new RunStore(freshDir())
    const before = Date.now()
    const run = store.create("verify Glowbar Ltd", "vendor")
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(run.goal).toBe("verify Glowbar Ltd")
    expect(run.preset).toBe("vendor")
    expect(run.createdAt).toBeGreaterThanOrEqual(before)
    expect(run.status).toBe("pending")
    expect(run.costUsd).toBe(0)
    expect(run.findings).toEqual([])
    expect(run.control).toBeInstanceOf(RunControl)
    expect(existsSync(join(run.log.dir, "shots"))).toBe(true)
  })

  it("get returns the same run object (one event log per run) and undefined for unknown ids", () => {
    const store = new RunStore(freshDir())
    const run = store.create("goal", null)
    expect(store.get(run.id)).toBe(run)
    expect(store.get(run.id)!.log).toBe(run.log)
    run.log.append({ type: "run_status", status: "running" })
    expect(store.get(run.id)!.log.readAll().map((pe) => pe.seq)).toEqual([1])
    expect(store.get("nope")).toBeUndefined()
  })

  it("gives each run its own id and directory", () => {
    const store = new RunStore(freshDir())
    const a = store.create("a", null)
    const b = store.create("b", "compliance")
    expect(a.id).not.toBe(b.id)
    expect(a.log.dir).not.toBe(b.log.dir)
  })

  it("writes meta.json at create", () => {
    const dir = freshDir()
    const store = new RunStore(dir)
    const run = store.create("audit", "compliance")
    const meta = JSON.parse(readFileSync(join(dir, "runs", run.id, "meta.json"), "utf8"))
    expect(meta).toEqual({
      id: run.id,
      goal: "audit",
      preset: "compliance",
      createdAt: run.createdAt,
      status: "pending",
    })
  })

  it("lists in-memory runs newest first", () => {
    const store = new RunStore(freshDir())
    const a = store.create("first", "vendor")
    const b = store.create("second", null)
    b.status = "finished"
    expect(store.list()).toEqual([
      { id: b.id, goal: "second", preset: null, createdAt: b.createdAt, status: "finished" },
      { id: a.id, goal: "first", preset: "vendor", createdAt: a.createdAt, status: "pending" },
    ])
  })

  it("lists finished runs discovered on disk, with in-memory state winning", () => {
    const dir = freshDir()
    const first = new RunStore(dir)
    const old = first.create("yesterday's flight", "vendor")
    old.status = "finished"

    const second = new RunStore(dir)
    const fresh = second.create("today's flight", null)
    expect(second.get(old.id)).toBeUndefined()
    const listed = second.list()
    expect(listed.map((r) => r.id).sort()).toEqual([old.id, fresh.id].sort())
    // From disk: the meta written at create time.
    expect(listed.find((r) => r.id === old.id)).toEqual({
      id: old.id,
      goal: "yesterday's flight",
      preset: "vendor",
      createdAt: old.createdAt,
      status: "pending",
    })
    // In memory: the live status wins over the same run's meta.json.
    expect(first.list().find((r) => r.id === old.id)!.status).toBe("finished")
  })

  it("skips run directories without a readable meta.json", () => {
    const dir = freshDir()
    mkdirSync(join(dir, "runs", "orphan"), { recursive: true })
    mkdirSync(join(dir, "runs", "corrupt"), { recursive: true })
    writeFileSync(join(dir, "runs", "corrupt", "meta.json"), "{not json")
    const store = new RunStore(dir)
    const run = store.create("only one", null)
    expect(store.list().map((r) => r.id)).toEqual([run.id])
  })

  it("lists nothing for a data dir with no runs yet", () => {
    expect(new RunStore(join(freshDir(), "missing")).list()).toEqual([])
  })

  it("counts pending, running, awaiting_* and paused runs as active", () => {
    const store = new RunStore(freshDir())
    expect(store.activeCount()).toBe(0)
    const statuses = [
      "pending",
      "running",
      "awaiting_approval",
      "awaiting_human",
      "paused",
      "finished",
      "failed",
      "stopped",
    ] as const
    for (const status of statuses) store.create(status, null).status = status
    expect(store.activeCount()).toBe(5)
  })

  it("sums today's cost and ignores runs created before local midnight", () => {
    const store = new RunStore(freshDir())
    const a = store.create("a", null)
    const b = store.create("b", null)
    const old = store.create("old", null)
    a.costUsd = 0.25
    b.costUsd = 1.5
    old.costUsd = 99
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    old.createdAt = midnight.getTime() - 1
    expect(store.todaysCostUsd()).toBeCloseTo(1.75, 10)
  })
})
