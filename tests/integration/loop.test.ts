import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type Anthropic from "@anthropic-ai/sdk"
import { runAgent, type LoopOpts } from "../../src/agent/loop.js"
import { createBrowserPage } from "../../src/browser/session.js"
import {
  FakeLLM,
  type LLM,
  type ScriptedTurn,
  type TurnRequest,
  type TurnResult,
} from "../../src/agent/llm.js"
import { config } from "../../src/config.js"
import type { AgentEvent, RunStatus } from "../../src/events/types.js"
import { TIMED_OUT_ANSWER, type ApprovalDecision } from "../../src/runs/control.js"
import { RunStore, type Run } from "../../src/runs/store.js"
import { serveFixtures } from "../fixtures/serve.js"

/**
 * The loop end to end: a scripted model, a real chromium and the real fixture site, so every
 * assertion here is about what the loop does with the parts rather than about mocks of them.
 */

const GOAL = "Verify Glowbar Ltd and record its VAT status"
/** The stub `saveShot` returns this instead of writing a file; one test covers the real writer. */
const SHOT = "/shot.jpg"

let fx: Awaited<ReturnType<typeof serveFixtures>>
let dataDir: string
let store: RunStore

beforeAll(async () => {
  fx = await serveFixtures()
})
afterAll(async () => {
  await fx.close()
})
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "noctua-loop-"))
  store = new RunStore(dataDir)
})

/** Records every request the loop makes, so the observations can be asserted on. */
class SpyLLM implements LLM {
  readonly requests: TurnRequest[] = []

  constructor(private readonly inner: LLM) {}

  turn(req: TurnRequest, onThinkingDelta: (t: string) => void): Promise<TurnResult> {
    this.requests.push(req)
    return this.inner.turn(req, onThinkingDelta)
  }
}

function textBlocks(message: Anthropic.MessageParam): string {
  const content = message.content
  if (typeof content === "string") return content
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

/** The observation of one turn: the text of the last user message, which the screenshot rides on. */
function observation(req: TurnRequest): string {
  return textBlocks(req.messages[req.messages.length - 1]!)
}

/** The leading user message — the condensed "Earlier steps:" block once turns have aged out. */
function leading(req: TurnRequest): string {
  return textBlocks(req.messages[0]!)
}

/**
 * Everything the model was shown that turn, tool results included — serialized because a tool
 * result is a `tool_result` block, not a text one. Base64 image data cannot contain a space or a
 * bracket, so it never matches the phrases asserted against this.
 */
function transcript(req: TurnRequest): string {
  return JSON.stringify(req.messages.map((m) => m.content))
}

interface Driven {
  run: Run
  spy: SpyLLM
  events: AgentEvent[]
  of: <T extends AgentEvent["type"]>(type: T) => Extract<AgentEvent, { type: T }>[]
  statuses: RunStatus[]
}

async function drive(
  script: ScriptedTurn[],
  setup: (run: Run) => void = () => {},
  opts: LoopOpts = {},
): Promise<Driven> {
  const run = store.create(GOAL, "vendor")
  const spy = new SpyLLM(new FakeLLM(script))
  setup(run)
  await runAgent(run, spy, {
    saveShot: () => SHOT,
    checkUrl: fx.checkUrl,
    allowRequest: fx.allowRequest,
    ...opts,
  })
  const events = run.log.readAll().map((pe) => pe.event)
  const of = <T extends AgentEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
  return { run, spy, events, of, statuses: of("run_status").map((e) => e.status) }
}

/**
 * Answers each approval as it is proposed — synchronously, inside `log.append`. That timing is
 * the point: `RunControl` drops a decision that arrives before `requestApproval` registered its
 * resolver, so a loop that emitted the proposal first would wait here for ever.
 */
function decideOn(run: Run, ...decisions: ApprovalDecision[]): void {
  const queue = [...decisions]
  run.log.subscribe(1, (pe) => {
    if (pe.event.type === "action_proposed") run.control.resolveApproval(queue.shift() ?? "approved")
  })
}

/** Runs `fn` synchronously inside the append of every event of `type`. */
function on(run: Run, type: AgentEvent["type"], fn: (e: AgentEvent) => void): void {
  run.log.subscribe(1, (pe) => {
    if (pe.event.type === type) fn(pe.event)
  })
}

describe("the agent loop — happy path", () => {
  it("drives navigate → submit → record_finding → finish to a successful done", async () => {
    const finding = {
      kind: "vendor",
      legal_name: "Glowbar Ltd",
      source: `${fx.baseUrl}/company.html?q=Glowbar`,
    }
    const { run, spy, of, statuses } = await drive(
      [
        {
          thinking: "the registry first",
          toolName: "navigate",
          toolInput: { url: `${fx.baseUrl}/registry.html` },
        },
        // [2] is the search box in document order on registry.html; asserted below.
        {
          toolName: "type",
          toolInput: { ref: 2, text: "Glowbar", submit: true, why: "search the register" },
        },
        { toolName: "record_finding", toolInput: { data: finding } },
        { toolName: "finish", toolInput: { outcome: "success", summary: "Glowbar Ltd is active." } },
      ],
      (r) => decideOn(r, "approved"),
    )

    expect(of("done")).toEqual([
      { type: "done", outcome: "success", summary: "Glowbar Ltd is active." },
    ])
    expect(run.status).toBe("finished")
    expect(statuses[statuses.length - 1]).toBe("finished")
    expect(of("action_result").map((e) => [e.tool, e.ok])).toEqual([
      ["navigate", true],
      ["type", true],
      ["record_finding", true],
      ["finish", true],
    ])
    expect(of("error")).toEqual([])
    // Only turns that actually thought out loud: an empty delta is noise in the mind pane.
    expect(of("thinking_delta")).toEqual([{ type: "thinking_delta", text: "the registry first" }])
  })

  it("records the finding on the run and stamps the step that produced it", async () => {
    const finding = { kind: "vendor", legal_name: "Glowbar Ltd", source: "x" }
    const { run, of } = await drive([
      { toolName: "wait", toolInput: { seconds: 1, reason: "settling" } },
      { toolName: "record_finding", toolInput: { data: finding } },
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" } },
    ])
    // The step is what pairs a finding with its screenshot in the report — the receipts feature.
    expect(of("finding")).toEqual([{ type: "finding", data: finding, step: 2 }])
    expect(run.findings).toEqual([finding])
  })

  it("gates a submitting type behind approval even in auto mode", async () => {
    const args = { ref: 2, text: "Glowbar", submit: true, why: "search the register" }
    const { spy, of, statuses } = await drive(
      [
        { toolName: "navigate", toolInput: { url: `${fx.baseUrl}/registry.html` } },
        { toolName: "type", toolInput: args },
        { toolName: "finish", toolInput: { outcome: "success", summary: "Found it." } },
      ],
      (r) => decideOn(r, "approved"),
    )
    expect(of("action_proposed")).toEqual([
      { type: "action_proposed", tool: "type", args, guarded: true },
    ])
    expect(statuses).toContain("awaiting_approval")
    // The listing the ref came from, and the page the submit actually landed on.
    expect(observation(spy.requests[1]!)).toMatch(/\[2\] textbox "Company name"/)
    expect(observation(spy.requests[2]!)).toMatch(/URL: \S+company\.html\?q=Glowbar/)
  })

  it("opens every observation with the task, the step budget and the finding count", async () => {
    const { spy } = await drive([
      { toolName: "record_finding", toolInput: { data: { a: "1" } } },
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" } },
    ])
    expect(spy.requests).toHaveLength(2)
    spy.requests.forEach((req, i) => {
      const text = observation(req)
      // The goal has to lead every turn: the model reads far more observation than system prompt,
      // and a run that drifts off task drifts because the task scrolled out of view.
      expect(text.startsWith(`TASK: ${GOAL}\n`)).toBe(true)
      expect(text).toContain(`Step ${i + 1} of ${config.maxSteps}.`)
      expect(text).toContain("URL: about:blank")
      expect(text).toContain(`Findings so far: ${i}`)
    })
  })

  it("writes a screenshot per step and numbers it", async () => {
    const { of } = await drive([
      { toolName: "wait", toolInput: { seconds: 1, reason: "settling" } },
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" } },
    ])
    expect(of("screenshot")).toEqual([
      { type: "screenshot", url: SHOT, step: 1, pageUrl: "about:blank" },
      { type: "screenshot", url: SHOT, step: 2, pageUrl: "about:blank" },
    ])
  })

  /**
   * The frame carries the address it was taken on, because the cockpit shows the two together and
   * nothing else in the log states one. Read back out of `navigate`'s prose instead — which is what
   * the UI had to do — a click-through leaves the *previous* address under the live view for the
   * rest of the run, on the very demo this project is judged by.
   */
  it("stamps every screenshot with the address the tab was actually on", async () => {
    const url = `${fx.baseUrl}/registry.html`
    const { of } = await drive([
      { toolName: "navigate", toolInput: { url } },
      // A click, whose landing page no tool summary ever names.
      { toolName: "click", toolInput: { ref: 1, why: "open the first result" } },
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" } },
    ])
    const seen = of("screenshot").map((e) => e.pageUrl)
    expect(seen[0]).toBe("about:blank")
    expect(seen[1]).toBe(url)
    expect(seen[2]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\S+/)
    expect(seen[2]).not.toBe(url)
  })

  it("saves each step's shot under the run directory by default", async () => {
    const run = store.create(GOAL, null)
    const llm = new FakeLLM([
      { toolName: "finish", toolInput: { outcome: "success", summary: "nothing to do" } },
    ])
    await runAgent(run, llm)
    const shot = join(run.log.dir, "shots", "1.jpg")
    expect(existsSync(shot)).toBe(true)
    expect(statSync(shot).size).toBeGreaterThan(0)
    expect(run.log.readAll().map((pe) => pe.event)).toContainEqual({
      type: "screenshot",
      url: `/api/runs/${run.id}/shots/1.jpg`,
      step: 1,
      pageUrl: "about:blank",
    })
  })
})

describe("the agent loop — the human in the seat", () => {
  it("carries a denial back to the model and never starts the action", async () => {
    const url = `${fx.baseUrl}/registry.html`
    const { run, spy, of, statuses } = await drive(
      [
        { toolName: "navigate", toolInput: { url } },
        { toolName: "finish", toolInput: { outcome: "partial", summary: "The user said no." } },
      ],
      (r) => {
        r.control.mode = "approve"
        decideOn(r, "denied", "approved")
      },
    )
    expect(of("action_proposed").map((e) => e.tool)).toEqual(["navigate", "finish"])
    expect(of("action_started").map((e) => e.tool)).toEqual(["finish"])
    expect(statuses).toContain("awaiting_approval")
    expect(transcript(spy.requests[1]!)).toContain("The user DENIED this action.")
    // The denied navigation really did not happen.
    expect(observation(spy.requests[1]!)).toContain("URL: about:blank")
    expect(of("done")).toEqual([
      { type: "done", outcome: "partial", summary: "The user said no." },
    ])
    expect(run.status).toBe("finished")
  })

  it("asks the human, waits, and feeds the answer back as the tool result", async () => {
    const question = "Which Glowbar — London or Leeds?"
    const { spy, of, statuses } = await drive(
      [
        { toolName: "ask_human", toolInput: { question } },
        {
          toolName: "finish",
          toolInput: { outcome: "success", summary: "The London one is active." },
        },
      ],
      // Answered synchronously inside the event append: the same registration-order trap as
      // approvals — RunControl drops an answer that arrives before askHuman is waiting.
      (r) => on(r, "ask_human", () => r.control.answerHuman("the London one")),
    )
    expect(of("ask_human")).toEqual([{ type: "ask_human", question }])
    expect(of("human_answer")).toEqual([{ type: "human_answer", text: "the London one" }])
    expect(statuses).toContain("awaiting_human")
    expect(transcript(spy.requests[1]!)).toContain("human answered: the London one")
  })

  it("ends the run when a stop settles an unanswered question", async () => {
    const { run, spy, of } = await drive(
      [{ toolName: "ask_human", toolInput: { question: "Which Glowbar?" } }],
      (r) => on(r, "ask_human", () => r.control.stop()),
    )
    expect(of("human_answer")).toEqual([])
    expect(of("done")).toEqual([
      { type: "done", outcome: "stopped", summary: "0 finding(s) were preserved." },
    ])
    expect(run.status).toBe("stopped")
    // No further turn was asked for — the script would have thrown if one had been.
    expect(spy.requests).toHaveLength(1)
  })

  it("stops between turns, keeping the findings already recorded", async () => {
    const { run, spy, of } = await drive(
      [{ toolName: "record_finding", toolInput: { data: { a: "1" } } }],
      (r) => on(r, "action_result", () => r.control.stop()),
    )
    expect(of("done")).toEqual([
      { type: "done", outcome: "stopped", summary: "1 finding(s) were preserved." },
    ])
    expect(run.status).toBe("stopped")
    expect(spy.requests).toHaveLength(1)
  })

  it("reports a paused run and carries on when it is resumed", async () => {
    const { run, of, statuses } = await drive(
      [{ toolName: "finish", toolInput: { outcome: "success", summary: "done" } }],
      (r) => {
        r.control.pause()
        on(r, "run_status", (e) => {
          if (e.type === "run_status" && e.status === "paused") r.control.resume()
        })
      },
    )
    expect(statuses).toEqual(["running", "paused", "running", "finished"])
    expect(of("done")[0]!.outcome).toBe("success")
    expect(run.status).toBe("finished")
  })

  it("ends a paused run that is stopped rather than resumed, without spending a turn", async () => {
    const { run, spy, of, statuses } = await drive(
      [{ toolName: "finish", toolInput: { outcome: "success", summary: "never reached" } }],
      (r) => {
        r.control.pause()
        on(r, "run_status", (e) => {
          if (e.type === "run_status" && e.status === "paused") r.control.stop()
        })
      },
    )
    // stop() releases the pause waiters, so the loop wakes up here; it must go back to its stop
    // check rather than walk into a capture and a paid model turn.
    expect(spy.requests).toEqual([])
    expect(statuses).toEqual(["running", "paused", "stopped"])
    expect(of("done")).toEqual([
      { type: "done", outcome: "stopped", summary: "0 finding(s) were preserved." },
    ])
    expect(run.status).toBe("stopped")
  })

  it("passes steering notes into the very next observation, one steer event each", async () => {
    const { spy, of } = await drive(
      [
        { toolName: "record_finding", toolInput: { data: { a: "1" } } },
        { toolName: "finish", toolInput: { outcome: "success", summary: "done" } },
      ],
      (r) => {
        r.control.addSteer("check the VAT number too")
        on(r, "action_result", () => r.control.addSteer("then stop"))
      },
    )
    expect(of("steer")).toEqual([
      { type: "steer", text: "check the VAT number too" },
      { type: "steer", text: "then stop" },
    ])
    expect(observation(spy.requests[0]!)).toContain("USER STEERING: check the VAT number too")
    expect(observation(spy.requests[1]!)).toContain("USER STEERING: then stop")
    // Drained, not repeated: a steer is an instruction for the next move, not a standing note.
    expect(observation(spy.requests[1]!)).not.toContain("check the VAT number too")
  })
})

describe("the agent loop — when things go wrong", () => {
  it("feeds a failed action back as an observation and carries on", async () => {
    const { run, spy, of } = await drive([
      { toolName: "click", toolInput: { ref: 9999, why: "click nothing" } },
      { toolName: "finish", toolInput: { outcome: "partial", summary: "Could not get there." } },
    ])
    expect(of("action_result")[0]).toEqual({
      type: "action_result",
      tool: "click",
      ok: false,
      summary: expect.stringContaining("stale ref [9999]"),
    })
    expect(of("error")).toEqual([
      { type: "error", message: expect.stringContaining("stale ref [9999]"), recoverable: true },
    ])
    expect(transcript(spy.requests[1]!)).toContain("ERROR: stale ref [9999]")
    expect(of("done")[0]!.outcome).toBe("partial")
    expect(run.status).toBe("finished")
  })

  it("gives up after three turns with no tool call", async () => {
    const { run, spy, of } = await drive([
      { text: "Thinking about it." },
      { text: "Still thinking." },
      { text: "Hmm." },
    ])
    expect(of("done")).toEqual([
      { type: "done", outcome: "partial", summary: "Agent stalled. 0 finding(s) were preserved." },
    ])
    expect(run.status).toBe("failed")
    expect(of("action_started")).toEqual([])
    expect(spy.requests).toHaveLength(3)
    expect(transcript(spy.requests[1]!)).toContain("No tool was called.")
  })

  it("ends the run when the model refuses, instead of counting it as narration", async () => {
    const { run, spy, of } = await drive([
      { text: "I can't help with that.", stopReason: "refusal" },
    ])
    expect(of("error")).toEqual([
      { type: "error", message: expect.stringContaining("safety"), recoverable: false },
    ])
    expect(of("done")).toHaveLength(1)
    expect(of("done")[0]!.outcome).toBe("failed")
    expect(of("done")[0]!.summary).toMatch(/declined for safety reasons/)
    expect(run.status).toBe("failed")
    expect(spy.requests).toHaveLength(1)
  })

  it("notes a turn cut off at the token limit in the condensed history", async () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({
      toolName: "record_finding",
      toolInput: { data: { n: String(i) } },
    }))
    const { spy } = await drive([
      { text: "A thought that ran out of ro", stopReason: "max_tokens" },
      { text: "Still deciding." },
      ...findings,
      { toolName: "finish", toolInput: { outcome: "partial", summary: "done" } },
    ])
    // By turn 8 the first two turns have aged out of the verbatim window, so all that is left of
    // them is their summary line — which has to say *why* each turn called no tool.
    const earlier = leading(spy.requests[7]!)
    expect(earlier).toContain("Earlier steps:")
    expect(earlier).toMatch(/step 1: .*token limit/)
    expect(earlier).toMatch(/step 2: \(narration only\)/)
  })

  it("turns an unrecoverable failure into error + done rather than throwing", async () => {
    const run = store.create(GOAL, null)
    const boom: LLM = {
      turn: () => Promise.reject(new Error("llm: 529 overloaded")),
    }
    await expect(runAgent(run, boom, { saveShot: () => SHOT })).resolves.toBeUndefined()
    const events = run.log.readAll().map((pe) => pe.event)
    expect(events).toContainEqual({
      type: "error",
      message: "llm: 529 overloaded",
      recoverable: false,
    })
    const done = events.filter((e) => e.type === "done")
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ outcome: "failed" })
    expect(run.status).toBe("failed")
  })

  it("blanks the tab when a deferred redirect lands somewhere disallowed", async () => {
    const blockOffsite = async (url: string) => {
      if (url.includes("/offsite.html")) throw new Error("blocked: offsite.html")
      await fx.checkUrl(url)
    }
    const { spy, of } = await drive(
      [
        { toolName: "navigate", toolInput: { url: `${fx.baseUrl}/redirect.html` } },
        // The hop fires during this wait — after navigate's own landing check already passed.
        { toolName: "wait", toolInput: { seconds: 4, reason: "the page is still settling" } },
        { toolName: "finish", toolInput: { outcome: "partial", summary: "It redirected away." } },
      ],
      () => {},
      { checkUrl: blockOffsite },
    )
    expect(observation(spy.requests[1]!)).toContain("/redirect.html")
    expect(of("error")).toEqual([
      { type: "error", message: expect.stringContaining("blocked: offsite.html"), recoverable: true },
    ])
    const after = observation(spy.requests[2]!)
    expect(after).toContain("URL: about:blank")
    expect(after).toContain("redirected somewhere disallowed and was closed")
    expect(of("done")[0]!.outcome).toBe("partial")
  })

  /**
   * Both cases below kill the event log part-way through the shutdown, which is the one moment
   * the loop cannot report anything: the log is what reporting *is*.
   */
  it("emits one done even when the status line after it cannot be written", async () => {
    const run = store.create(GOAL, null)
    const real = run.log.append.bind(run.log)
    let sawDone = false
    // Fails only the run_status that follows the done event — so a second done, if the loop tried
    // one, would be written to disk and this test would see it.
    run.log.append = (e: AgentEvent) => {
      if (sawDone && e.type === "run_status") throw new Error("ENOSPC: no space left on device")
      if (e.type === "done") sawDone = true
      return real(e)
    }
    const llm = new FakeLLM([
      { toolName: "finish", toolInput: { outcome: "success", summary: "Glowbar Ltd is active." } },
    ])
    await expect(runAgent(run, llm, { saveShot: () => SHOT })).resolves.toBeUndefined()

    const done = run.log.readAll().filter((pe) => pe.event.type === "done")
    expect(done).toHaveLength(1)
    expect(done[0]!.event).toEqual({
      type: "done",
      outcome: "success",
      summary: "Glowbar Ltd is active.",
    })
    // The run really did finish; only the log write failed.
    expect(run.status).toBe("finished")
  })

  it("still resolves when the event log itself is unwritable", async () => {
    const run = store.create(GOAL, null)
    const real = run.log.append.bind(run.log)
    let sawDone = false
    run.log.append = (e: AgentEvent) => {
      if (sawDone) throw new Error("ENOSPC: no space left on device")
      if (e.type === "done") sawDone = true
      return real(e)
    }
    const llm = new FakeLLM([
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" } },
    ])
    // The caller is a fire-and-forget route with nowhere to put an exception, so the reporting of
    // a failure must not itself be able to throw.
    await expect(runAgent(run, llm, { saveShot: () => SHOT })).resolves.toBeUndefined()
    expect(run.log.readAll().filter((pe) => pe.event.type === "done")).toHaveLength(1)
  })

  it("tells the model it looks stuck, and stops saying so once it moves again", async () => {
    // Going back on a tab with no history is the cheapest way to spend a turn achieving nothing:
    // same URL, no new finding, no wait.
    const idle = { toolName: "go_back", toolInput: {} }
    const { spy, of } = await drive([
      idle,
      idle,
      idle,
      idle,
      idle,
      { toolName: "record_finding", toolInput: { data: { a: "1" } } },
      { toolName: "finish", toolInput: { outcome: "partial", summary: "Got nowhere." } },
    ])
    const stuck = (i: number) => observation(spy.requests[i]!).includes("You appear stuck")
    // Turn 1 has nothing to compare against; turns 2-4 are the first three unproductive ones.
    expect([stuck(0), stuck(1), stuck(2), stuck(3)]).toEqual([false, false, false, false])
    expect(stuck(4)).toBe(true)
    expect(observation(spy.requests[4]!)).toContain(
      "You appear stuck (no page change or new findings for 4 turns). Reconsider your approach or ask_human.",
    )
    // Still stuck on turn 6 — the finding it records there has not happened yet at capture time.
    expect(stuck(5)).toBe(true)
    // Turn 7 sees the new finding: progress, so the note is gone.
    expect(stuck(6)).toBe(false)
    // Sitting on one page is this note's business alone: the oscillation check is about a run
    // that keeps moving and gets nowhere, and must not double up on a run that never moved.
    expect(observation(spy.requests[4]!)).not.toContain("returned to this page")
    expect(of("done")[0]!.outcome).toBe("partial")
  })

  it("tells the model when it keeps coming back to a page it has already read", async () => {
    const a = `${fx.baseUrl}/registry.html`
    const b = `${fx.baseUrl}/vendor.html`
    const go = (url: string) => ({ toolName: "navigate", toolInput: { url } })
    const { spy, of } = await drive([
      go(a),
      go(b),
      go(a),
      go(b),
      go(a),
      { toolName: "record_finding", toolInput: { data: { a: "1" } } },
      { toolName: "finish", toolInput: { outcome: "partial", summary: "Round and round." } },
    ])
    const circling = (i: number) => observation(spy.requests[i]!).includes("returned to this page")
    // Turns 1-5 open on about:blank, A, B, A, B: the third visit to A is what turn 6 opens on.
    expect([circling(0), circling(1), circling(2), circling(3), circling(4)]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
    expect(observation(spy.requests[5]!)).toContain(
      "You have returned to this page 3 times without recording anything new — either record " +
        "what you have or move on.",
    )
    // The page kept changing, so the stuck check saw progress the whole way: this is the note it
    // cannot produce, not a second wording of it.
    expect(observation(spy.requests[5]!)).not.toContain("You appear stuck")
    // Turn 7 opens on the same page again, but a finding has landed since that first visit.
    expect(circling(6)).toBe(false)
    expect(of("done")[0]!.outcome).toBe("partial")
  })

  it("catches a three-page circuit, which is what the live run actually did", async () => {
    // The smoke run went registry record → vendor site → registry index → and round again. A
    // window of six page changes can only ever see two laps of a two-page cycle; this is the shape
    // the detector was built for, so it is the shape it has to catch.
    const a = `${fx.baseUrl}/registry.html`
    const b = `${fx.baseUrl}/vendor.html`
    const c = `${fx.baseUrl}/index.html`
    const go = (url: string) => ({ toolName: "navigate", toolInput: { url } })
    const { spy, of } = await drive([
      go(a),
      go(b),
      go(c),
      go(a),
      go(b),
      go(c),
      go(a),
      { toolName: "finish", toolInput: { outcome: "partial", summary: "Three laps, no rows." } },
    ])
    const circling = (i: number) => observation(spy.requests[i]!).includes("returned to this page")
    // Turns 1-7 open on about:blank, A, B, C, A, B, C: two laps, and the third A is turn 8.
    expect([0, 1, 2, 3, 4, 5, 6].map(circling)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect(observation(spy.requests[7]!)).toContain("You have returned to this page 3 times")
    expect(observation(spy.requests[7]!)).not.toContain("You appear stuck")
    expect(of("done")[0]!.outcome).toBe("partial")
  })
})

/**
 * A public demo link is abandoned mid-run all the time — a tab closes on an approval prompt and
 * nothing is ever going to answer it. Every gate the loop waits on therefore has a clock on it,
 * because the alternative is a run that holds a concurrency slot until the process restarts.
 */
describe("the agent loop — when nobody is at the keyboard", () => {
  /** Long enough to be a real await, short enough to keep the suite fast. */
  const WAIT_MS = 50
  const maxWallMinutes = config.maxWallMinutes
  afterEach(() => {
    config.maxWallMinutes = maxWallMinutes
  })

  it("gives up on an abandoned approval, treats it as denied and lets the model carry on", async () => {
    const url = `${fx.baseUrl}/registry.html`
    const { run, spy, of, statuses } = await drive(
      [
        { toolName: "navigate", toolInput: { url } },
        { toolName: "finish", toolInput: { outcome: "partial", summary: "Nobody was there." } },
      ],
      (r) => {
        r.control.mode = "approve"
        // The first proposal is abandoned on purpose; only the second is ever decided.
        let seen = 0
        on(r, "action_proposed", () => {
          if (seen++ > 0) r.control.resolveApproval("approved")
        })
      },
      { waitMs: WAIT_MS },
    )
    expect(of("action_proposed").map((e) => e.tool)).toEqual(["navigate", "finish"])
    // The abandoned action really did not run.
    expect(of("action_started").map((e) => e.tool)).toEqual(["finish"])
    expect(observation(spy.requests[1]!)).toContain("URL: about:blank")
    expect(of("error")).toEqual([
      {
        type: "error",
        message: expect.stringContaining("treating this action as denied"),
        recoverable: true,
      },
    ])
    expect(transcript(spy.requests[1]!)).toContain("Nobody was available to approve this action")
    expect(statuses).toContain("awaiting_approval")
    expect(of("done")).toEqual([
      { type: "done", outcome: "partial", summary: "Nobody was there." },
    ])
    expect(run.status).toBe("finished")
  })

  it("gives up on an unanswered question and tells the model to carry on without one", async () => {
    const { run, spy, of, statuses } = await drive(
      [
        { toolName: "ask_human", toolInput: { question: "Which Glowbar?" } },
        {
          toolName: "finish",
          toolInput: { outcome: "partial", summary: "Went with the London one." },
        },
      ],
      () => {},
      { waitMs: WAIT_MS },
    )
    expect(of("ask_human")).toHaveLength(1)
    // The cockpit's whisper box is mounted by `ask_human` and taken down by `human_answer`. A
    // question closed by the clock has to close it too, or the UI keeps soliciting an answer that
    // nothing is waiting for — and the transcript has to say who did the closing.
    expect(of("human_answer")).toEqual([{ type: "human_answer", text: "(no answer — timed out)" }])
    expect(statuses).toContain("awaiting_human")
    expect(of("error")).toEqual([
      {
        type: "error",
        message: expect.stringContaining("No answer after"),
        recoverable: true,
      },
    ])
    // The sentinel *is* the tool result: the model reads why it is on its own.
    expect(transcript(spy.requests[1]!)).toContain(TIMED_OUT_ANSWER)
    expect(of("done")).toEqual([
      { type: "done", outcome: "partial", summary: "Went with the London one." },
    ])
    expect(run.status).toBe("finished")
  })

  it("cancels the clock when the decision and the answer do arrive", async () => {
    const { of } = await drive(
      [
        { toolName: "ask_human", toolInput: { question: "Which Glowbar?" } },
        { toolName: "navigate", toolInput: { url: `${fx.baseUrl}/registry.html` } },
        { toolName: "finish", toolInput: { outcome: "success", summary: "The London one." } },
      ],
      (r) => {
        r.control.mode = "approve"
        decideOn(r)
        on(r, "ask_human", () => r.control.answerHuman("the London one"))
      },
      { waitMs: WAIT_MS },
    )
    // Every turn after the first outlives the wait window, so a timer left running would have
    // denied a later action or spoken over a real answer.
    expect(of("human_answer")).toEqual([{ type: "human_answer", text: "the London one" }])
    expect(of("error")).toEqual([])
    expect(of("action_started").map((e) => e.tool)).toEqual(["ask_human", "navigate", "finish"])
  })

  it("ends a run whose wall-clock budget went on the wait, at the next turn", async () => {
    // `runAgent` starts its own clock a few microseconds after this line, so this stands in for it.
    const startedAt = Date.now()
    const { run, spy, of } = await drive(
      [
        { toolName: "ask_human", toolInput: { question: "Which Glowbar?" } },
        { toolName: "record_finding", toolInput: { data: { a: "1" } } },
      ],
      (r) =>
        on(r, "ask_human", () => {
          // A budget only the wait itself can exhaust: not spent at this instant, certainly spent
          // once the question times out.
          config.maxWallMinutes = (Date.now() - startedAt + WAIT_MS / 2) / 60_000
        }),
      { waitMs: WAIT_MS },
    )
    // Turn 1 was inside the budget; the time spent waiting is what put the run over it.
    expect(observation(spy.requests[0]!)).not.toContain("BUDGET EXHAUSTED")
    expect(observation(spy.requests[1]!)).toContain("BUDGET EXHAUSTED")
    expect(of("done")).toEqual([
      {
        type: "done",
        outcome: "partial",
        summary: "Budget exhausted. 1 finding(s) were preserved.",
      },
    ])
    expect(run.status).toBe("finished")
    // The run ended itself: no third turn was ever asked for, and no human ever came back.
    expect(spy.requests).toHaveLength(2)
  })
})

describe("the agent loop — budgets and bookkeeping", () => {
  const maxSteps = config.maxSteps
  afterEach(() => {
    config.maxSteps = maxSteps
  })

  it("warns once past the step budget, then finishes the run itself", async () => {
    config.maxSteps = 2
    const record = { toolName: "record_finding", toolInput: { data: { a: "1" } } }
    const { run, spy, of } = await drive([record, record, record])
    expect(observation(spy.requests[0]!)).not.toContain("BUDGET EXHAUSTED")
    expect(observation(spy.requests[2]!)).toContain(
      "BUDGET EXHAUSTED — you MUST call finish now with what you have.",
    )
    expect(of("done")).toEqual([
      {
        type: "done",
        outcome: "partial",
        summary: "Budget exhausted. 3 finding(s) were preserved.",
      },
    ])
    expect(run.status).toBe("finished")
    expect(of("budget")[of("budget").length - 1]).toEqual({
      type: "budget",
      steps: 3,
      maxSteps: 2,
      costUsd: 0.03,
      maxCostUsd: config.maxRunCostUsd,
    })
  })

  it("meters each turn onto the run and reports it", async () => {
    const { run, of } = await drive([
      { toolName: "record_finding", toolInput: { data: { a: "1" } }, costUsd: 0.2 },
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" }, costUsd: 0.1 },
    ])
    expect(run.costUsd).toBeCloseTo(0.3, 10)
    expect(of("budget").map((e) => e.costUsd)).toEqual([0.2, 0.3])
    expect(of("budget")[0]).toMatchObject({ steps: 1, maxSteps: config.maxSteps })
  })

  it("persists status and cost to meta.json, so a restart lists the run as it ended", async () => {
    const { run } = await drive([
      { toolName: "finish", toolInput: { outcome: "success", summary: "done" }, costUsd: 0.25 },
    ])
    const meta = JSON.parse(readFileSync(join(run.log.dir, "meta.json"), "utf8"))
    expect(meta).toEqual({
      id: run.id,
      goal: GOAL,
      preset: "vendor",
      createdAt: run.createdAt,
      status: "finished",
      costUsd: 0.25,
    })
    // A process that never saw this run still reports it correctly, cost included.
    expect(new RunStore(dataDir).list()).toEqual([
      {
        id: run.id,
        goal: GOAL,
        preset: "vendor",
        createdAt: run.createdAt,
        status: "finished",
        costUsd: 0.25,
      },
    ])
    expect(new RunStore(dataDir).todaysCostUsd()).toBeCloseTo(0.25, 10)
  })
})

/**
 * The tab is not the only thing that fetches. A page can ask the browser for an address the model
 * never chose and the navigation guard never sees — the tab does not move — and whatever comes
 * back is rendered into the frame that becomes the model's observation, the event log and the
 * exported report.
 */
describe("the browser page — what a page pulls in", () => {
  it("aborts an embedded private address while the page itself still renders", async () => {
    const bp = await createBrowserPage({ allowRequest: fx.allowRequest })
    try {
      const blocked = bp.page.waitForEvent("requestfailed", (req) =>
        req.url().startsWith("http://169.254.169.254/"),
      )
      await bp.page.goto(`${fx.baseUrl}/embedded.html`)
      expect((await blocked).failure()?.errorText).toContain("BLOCKED")
      // Not a blanket refusal: the page the frame was embedded in came through the same
      // interception, so a guard that broke every load would fail here rather than pass quietly.
      expect(await bp.page.textContent("h1")).toBe("Vendor notes")
    } finally {
      await bp.close()
    }
  })
})
