import { describe, expect, it } from "vitest"
import type { AgentEvent, PersistedEvent } from "../src/api.ts"
import { digest } from "../src/screens/Cockpit.tsx"

/**
 * The cockpit's one derivation: an array of events in, everything three panes render out.
 *
 * It is the whole of the screen's logic — the panes themselves take what this returns and lay it
 * out — and it is what makes replay free, since a run scrubbed back to event nine is just this
 * function over a shorter array. So the cases below are mostly about the two questions it answers
 * that the run's *status* cannot: whether something is waiting on this human right now, and where
 * the page was when a frame was taken.
 */

/** Numbers a hand-written event list the way the log would have. */
function log(...events: AgentEvent[]): PersistedEvent[] {
  return events.map((event, i) => ({ seq: i + 1, ts: 1_700_000_000_000 + i, event }))
}

const shot = (step: number, pageUrl?: string): AgentEvent => ({
  type: "screenshot",
  url: `/shots/${step}.jpg`,
  step,
  ...(pageUrl === undefined ? {} : { pageUrl }),
})

describe("digest — what the run currently is", () => {
  it("indexes every frame by step and follows the last one", () => {
    const view = digest(log(shot(1), shot(2), shot(3)))
    expect(view.shots.get(2)).toBe("/shots/2.jpg")
    expect(view.latestShot).toEqual({ step: 3, url: "/shots/3.jpg" })
  })

  it("has no frame at all before the first screenshot", () => {
    const view = digest(log({ type: "run_status", status: "running" }))
    expect(view.latestShot).toBeNull()
    expect(view.shots.size).toBe(0)
  })

  it("collects the findings with the step each was read on", () => {
    const view = digest(
      log(
        shot(1),
        { type: "finding", data: { legal_name: "Glowbar Ltd" }, step: 1 },
        shot(2),
        { type: "finding", data: { legal_name: "Monzo Bank Limited" }, step: 2 },
      ),
    )
    // The step is the receipt: it is what pairs the row with the frame it was read from.
    expect(view.findings).toEqual([
      { data: { legal_name: "Glowbar Ltd" }, step: 1 },
      { data: { legal_name: "Monzo Bank Limited" }, step: 2 },
    ])
  })

  it("reports the latest budget and the run's own ending", () => {
    const view = digest(
      log(
        { type: "budget", steps: 1, maxSteps: 40, costUsd: 0.02, maxCostUsd: 1.5 },
        { type: "budget", steps: 2, maxSteps: 40, costUsd: 0.08, maxCostUsd: 1.5 },
        { type: "done", outcome: "partial", summary: "Two of three vendors." },
        { type: "run_status", status: "finished" },
      ),
    )
    expect(view.budget).toMatchObject({ steps: 2, costUsd: 0.08 })
    expect(view.done).toEqual({ outcome: "partial", summary: "Two of three vendors." })
  })
})

/**
 * A proposal is settled in more than one way, and only one of them is an event about the proposal.
 * A *denied* action produces no `action_started` and no `action_result` at all — the loop simply
 * takes another turn, whose first act is a screenshot. So the strip has to come down on any of
 * those, or the cockpit goes on soliciting a decision that nothing is waiting for.
 */
describe("digest — what is waiting on the human", () => {
  const proposed: AgentEvent = {
    type: "action_proposed",
    tool: "type",
    args: { ref: 2, text: "Glowbar", submit: true },
    guarded: true,
  }

  it("raises the approval strip on a proposal", () => {
    expect(digest(log(shot(1), proposed)).approval).toEqual({
      tool: "type",
      args: { ref: 2, text: "Glowbar", submit: true },
    })
  })

  it("clears it on the next frame, which is how a denial ends", () => {
    expect(digest(log(shot(1), proposed, shot(2))).approval).toBeNull()
  })

  it.each([
    ["the action starting", { type: "action_started", tool: "type", args: {} } as AgentEvent],
    [
      "the action's result",
      { type: "action_result", tool: "type", ok: true, summary: "typed" } as AgentEvent,
    ],
    ["the run ending", { type: "done", outcome: "stopped", summary: "" } as AgentEvent],
    ["a terminal status", { type: "run_status", status: "failed" } as AgentEvent],
  ])("clears it on %s", (_label, event) => {
    expect(digest(log(shot(1), proposed, event)).approval).toBeNull()
  })

  it("keeps the question up until it is answered", () => {
    const asked = log(shot(1), { type: "ask_human", question: "Which Glowbar?" })
    expect(digest(asked).question).toBe("Which Glowbar?")
    // Including the answer the clock writes when nobody came back: the box has to come down.
    expect(digest([...asked, ...log({ type: "human_answer", text: "(no answer — timed out)" })]).question).toBeNull()
  })

  it("takes an unanswered question down when the run ends without one", () => {
    const events = log(
      { type: "ask_human", question: "Which Glowbar?" },
      { type: "done", outcome: "stopped", summary: "" },
    )
    expect(digest(events).question).toBeNull()
  })

  // A frame is a new turn, not an answer: the question outlives it, and the whisper box with it.
  it("does not take a question down on the next frame", () => {
    expect(digest(log({ type: "ask_human", question: "Which one?" }, shot(2))).question).toBe(
      "Which one?",
    )
  })
})

/**
 * The address under the live view. The frame states its own now; a log written before it did says
 * one out loud only in the summaries `navigate` and `go_back` write — which is why a click-through
 * used to leave the previous address standing for the rest of the run.
 */
describe("digest — where the page was", () => {
  it("takes the address off the frame itself", () => {
    const view = digest(
      log(
        shot(1, "about:blank"),
        shot(2, "https://example.com/register"),
        shot(3, "https://example.com/company/09446231"),
      ),
    )
    expect(view.addressAt.get(2)).toBe("https://example.com/register")
    // The click-through: nothing in the log names this address except the frame.
    expect(view.addressAt.get(3)).toBe("https://example.com/company/09446231")
  })

  it("falls back to what a navigate said, for a log written before frames carried one", () => {
    const view = digest(
      log(
        shot(1),
        { type: "action_started", tool: "navigate", args: { url: "https://example.com/a" } },
        { type: "action_result", tool: "navigate", ok: true, summary: "navigated to https://example.com/b" },
        shot(2),
      ),
    )
    expect(view.addressAt.get(1)).toBe("")
    // The landing address, not the requested one: a redirect is the difference between them.
    expect(view.addressAt.get(2)).toBe("https://example.com/b")
  })

  it("prefers the frame's own address over the prose of the same turn", () => {
    const view = digest(
      log(
        { type: "action_result", tool: "navigate", ok: true, summary: "navigated to https://example.com/b" },
        shot(1, "https://example.com/actually-here"),
      ),
    )
    expect(view.addressAt.get(1)).toBe("https://example.com/actually-here")
  })
})
