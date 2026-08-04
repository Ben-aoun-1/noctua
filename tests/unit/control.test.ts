import { describe, it, expect } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RunControl,
  STOPPED_ANSWER,
  SUPERSEDED_ANSWER,
  TIMED_OUT_ANSWER,
} from "../../src/runs/control.js"
import { RunStore, persistRun } from "../../src/runs/store.js"

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
    expect(await answer).toBe(STOPPED_ANSWER)
  })

  it("keeps answering promptly once stopped", async () => {
    const c = new RunControl()
    c.stop()
    expect(await c.requestApproval()).toBe("denied")
    expect(await c.askHuman()).toBe(STOPPED_ANSWER)
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
    // Distinguishable from a real reply, so the loop can tell the two apart.
    expect(await q1).toBe(SUPERSEDED_ANSWER)
    expect(SUPERSEDED_ANSWER).not.toBe(STOPPED_ANSWER)
    c.answerHuman("here you go")
    expect(await q2).toBe("here you go")
  })

  it("keeps its three sentinel answers distinct, and says what to do in the one the model reads", async () => {
    // The loop dispatches on identity: two sentinels that collided would end a run as stopped when
    // it was only superseded, or hand the model "(run stopped)" as an answer to act on.
    const sentinels = [STOPPED_ANSWER, SUPERSEDED_ANSWER, TIMED_OUT_ANSWER]
    expect(new Set(sentinels).size).toBe(sentinels.length)
    // The timed-out one is not translated on the way out — it is handed to the model as the
    // answer, so it has to tell it what to do next rather than name a state.
    expect(TIMED_OUT_ANSWER).toMatch(/nobody answered/)
    expect(TIMED_OUT_ANSWER).toMatch(/finish/)
    const c = new RunControl()
    const asked = c.askHuman()
    c.answerHuman(TIMED_OUT_ANSWER)
    expect(await asked).toBe(TIMED_OUT_ANSWER)
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
      costUsd: 0,
    })
  })

  // Without this a restart shows every past run as `pending` for ever, and the daily cost cap
  // forgets everything a crashed or restarted process already spent.
  it("persistRun rewrites meta.json with the live status and cost", () => {
    const dir = freshDir()
    const store = new RunStore(dir)
    const run = store.create("audit", null)
    run.status = "finished"
    run.costUsd = 0.42
    persistRun(run)
    expect(JSON.parse(readFileSync(join(dir, "runs", run.id, "meta.json"), "utf8"))).toEqual({
      id: run.id,
      goal: "audit",
      preset: null,
      createdAt: run.createdAt,
      status: "finished",
      costUsd: 0.42,
    })
  })

  it("lists in-memory runs newest first", () => {
    const store = new RunStore(freshDir())
    const a = store.create("first", "vendor")
    const b = store.create("second", null)
    // Pinned rather than relying on the clock: two creates can land in the same millisecond.
    a.createdAt = 1_000
    b.createdAt = 2_000
    b.status = "finished"
    b.costUsd = 0.5
    expect(store.list()).toEqual([
      { id: b.id, goal: "second", preset: null, createdAt: 2_000, status: "finished", costUsd: 0.5 },
      { id: a.id, goal: "first", preset: "vendor", createdAt: 1_000, status: "pending", costUsd: 0 },
    ])
  })

  it("breaks createdAt ties by id so the order is total", () => {
    const store = new RunStore(freshDir())
    // Eight tied runs: without a tiebreak the result would follow readdir/insertion order, which
    // matching id order by chance is a 1-in-8! event.
    const runs = Array.from({ length: 8 }, (_, i) => store.create(`run ${i}`, null))
    for (const run of runs) run.createdAt = 5_000
    const ids = runs.map((r) => r.id).sort((x, y) => x.localeCompare(y))
    expect(store.list().map((r) => r.id)).toEqual(ids)
  })

  it("lists finished runs discovered on disk, with in-memory state winning", () => {
    const dir = freshDir()
    const first = new RunStore(dir)
    const old = first.create("yesterday's flight", "vendor")
    old.status = "finished"
    old.costUsd = 1.25
    persistRun(old)

    const second = new RunStore(dir)
    const fresh = second.create("today's flight", null)
    expect(second.get(old.id)).toBeUndefined()
    const listed = second.list()
    expect(listed.map((r) => r.id).sort()).toEqual([old.id, fresh.id].sort())
    // From disk: how the run really ended, not the `pending` it was created as.
    expect(listed.find((r) => r.id === old.id)).toEqual({
      id: old.id,
      goal: "yesterday's flight",
      preset: "vendor",
      createdAt: old.createdAt,
      status: "finished",
      costUsd: 1.25,
    })
    // In memory: the live run wins over the same run's meta.json.
    old.status = "stopped"
    expect(first.list().find((r) => r.id === old.id)!.status).toBe("stopped")
  })

  it("reads a meta.json written before cost was recorded as costing nothing", () => {
    const dir = freshDir()
    mkdirSync(join(dir, "runs", "older"), { recursive: true })
    writeFileSync(
      join(dir, "runs", "older", "meta.json"),
      JSON.stringify({ id: "older", goal: "g", preset: null, createdAt: 1, status: "finished" }),
    )
    expect(new RunStore(dir).list()).toEqual([
      { id: "older", goal: "g", preset: null, createdAt: 1, status: "finished", costUsd: 0 },
    ])
  })

  it("skips run directories whose meta.json is missing, corrupt or not a run", () => {
    const dir = freshDir()
    const write = (name: string, body: string) => {
      mkdirSync(join(dir, "runs", name), { recursive: true })
      writeFileSync(join(dir, "runs", name, "meta.json"), body)
    }
    mkdirSync(join(dir, "runs", "orphan"), { recursive: true }) // no meta.json at all
    write("corrupt", "{not json")
    write("bad-status", JSON.stringify({ id: "x", goal: "g", preset: null, createdAt: 1, status: "wat" }))
    write("bad-preset", JSON.stringify({ id: "y", goal: "g", preset: "nope", createdAt: 1, status: "finished" }))
    write("no-goal", JSON.stringify({ id: "z", preset: null, createdAt: 1, status: "finished" }))
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

  // The cap is a daily one, so a restart that forgot what earlier processes spent would hand the
  // day a fresh $20 — and a run counted twice (live and on disk) would close the day early.
  it("counts today's on-disk runs once, live state winning over meta", () => {
    const dir = freshDir()
    const first = new RunStore(dir)
    const today = first.create("today", null)
    today.costUsd = 0.75
    persistRun(today)
    const yesterday = first.create("yesterday", null)
    yesterday.costUsd = 99
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    yesterday.createdAt = midnight.getTime() - 1
    persistRun(yesterday)

    expect(new RunStore(dir).todaysCostUsd()).toBeCloseTo(0.75, 10)

    // The same run, still live in this process, must not be added to its own meta.json.
    today.costUsd = 1.1
    expect(first.todaysCostUsd()).toBeCloseTo(1.1, 10)
  })
})
