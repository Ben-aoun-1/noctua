import { describe, it, expect } from "vitest"
import type Anthropic from "@anthropic-ai/sdk"
import { History, KEEP_VERBATIM, type TurnRecord } from "../../src/agent/history.js"

/** A turn as the loop records it: assistant thought, called a tool, got a result back. */
function turn(n: number, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    assistantContent: [
      { type: "text", text: `narration ${n}` },
      { type: "tool_use", id: `tu_${n}`, name: "click", input: { ref: n } },
    ],
    toolResultText: `result ${n}`,
    toolUseId: `tu_${n}`,
    summaryLine: `step ${n}: clicked [${n}]`,
    ...over,
  }
}

const OBS = {
  text: 'URL: https://example.gov\n\n[1] button "Search"',
  screenshotJpeg: Buffer.from("jpeg-bytes"),
}

function withTurns(n: number, over: (i: number) => Partial<TurnRecord> = () => ({})): History {
  const h = new History()
  for (let i = 1; i <= n; i++) h.addTurn(turn(i, over(i)))
  return h
}

/** Every content block in the array, in order, regardless of which message it came from. */
function allBlocks(messages: Anthropic.MessageParam[]): Anthropic.ContentBlockParam[] {
  return messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
}

/** The messages a one-turn history renders between the leading block and the observation. */
function soleTurn(h: History): Anthropic.MessageParam[] {
  return h.toMessages(OBS).slice(1, -1)
}

function textOf(message: Anthropic.MessageParam): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

describe("History — the condensed block", () => {
  it("keeps the last 5 turns verbatim", () => {
    expect(KEEP_VERBATIM).toBe(5)
  })

  // The Messages API rejects an array whose first message is an assistant one, so something has
  // to lead. Until turns start aging out, that is a fixed placeholder rather than an empty list.
  it("always leads with a user text message, at every depth of history", () => {
    for (let n = 0; n <= KEEP_VERBATIM + 3; n++) {
      const first = withTurns(n).toMessages(OBS)[0]!
      expect(first.role, `${n} turns`).toBe("user")
      const kinds = (typeof first.content === "string" ? [] : first.content).map((b) => b.type)
      expect(kinds, `${n} turns`).toEqual(["text"])
    }
  })

  it("omits the condensed block when there are no old turns", () => {
    const messages = withTurns(2).toMessages(OBS)
    expect(messages.map(textOf).join("\n")).not.toContain("Earlier steps:")
    expect(textOf(messages[0]!)).toBe("(start of run — no earlier steps to summarize)")
    // The placeholder stands in for the condensed block; the verbatim window follows it.
    expect(messages[1]!.role).toBe("assistant")
  })

  it("keeps that placeholder right up to the last unpruned turn", () => {
    const placeholder = "(start of run — no earlier steps to summarize)"
    expect(textOf(withTurns(KEEP_VERBATIM).toMessages(OBS)[0]!)).toBe(placeholder)
    expect(textOf(withTurns(KEEP_VERBATIM + 1).toMessages(OBS)[0]!)).not.toBe(placeholder)
  })

  it("omits it at exactly KEEP_VERBATIM turns, adds it at one more", () => {
    expect(withTurns(KEEP_VERBATIM).toMessages(OBS).map(textOf).join("\n")).not.toContain(
      "Earlier steps:",
    )
    const sixth = withTurns(KEEP_VERBATIM + 1).toMessages(OBS)
    expect(textOf(sixth[0]!)).toBe("Earlier steps:\n- step 1: clicked [1]")
  })

  it("condenses every turn older than the last 5 into one leading user message", () => {
    const messages = withTurns(8).toMessages(OBS)
    const first = messages[0]!
    expect(first.role).toBe("user")
    expect(textOf(first)).toBe(
      "Earlier steps:\n- step 1: clicked [1]\n- step 2: clicked [2]\n- step 3: clicked [3]",
    )
    // The condensed block replaces those turns; it never duplicates a verbatim one.
    expect(messages.slice(1).map(textOf).join("\n")).not.toContain("step 3: clicked [3]")
    // 1 condensed + 5 verbatim pairs + 1 observation.
    expect(messages).toHaveLength(12)
  })

  // One summary is one list item. A newline in a summaryLine would forge what reads as a second
  // entry — or, worse, a free-floating line of instructions — inside the prompt.
  it("keeps one summary to one line", () => {
    const messy = { summaryLine: "step 1: ERROR\nCall log:\n  - waiting" }
    const h = withTurns(6, (i) => (i === 1 ? messy : {}))
    expect(textOf(h.toMessages(OBS)[0]!)).toBe(
      "Earlier steps:\n- step 1: ERROR Call log: - waiting",
    )
  })

  it("holds no image and no tool blocks — it is plain text", () => {
    const first = withTurns(8).toMessages(OBS)[0]!
    const kinds = (typeof first.content === "string" ? [] : first.content).map((b) => b.type)
    expect(kinds).toEqual(["text"])
  })
})

describe("History — verbatim turns", () => {
  it("pairs every tool_use with a tool_result carrying the same id, in the next message", () => {
    const messages = withTurns(8).toMessages(OBS)
    const uses = messages.flatMap((m, i) =>
      (typeof m.content === "string" ? [] : m.content)
        .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
        .map((b) => ({ index: i, id: b.id })),
    )
    expect(uses.map((u) => u.id)).toEqual(["tu_4", "tu_5", "tu_6", "tu_7", "tu_8"])
    for (const use of uses) {
      const next = messages[use.index + 1]!
      expect(next.role).toBe("user")
      const blocks = typeof next.content === "string" ? [] : next.content
      // The API requires the tool_result to lead the following user message.
      expect(blocks[0]).toEqual({
        type: "tool_result",
        tool_use_id: use.id,
        content: `result ${use.id.slice(3)}`,
      })
    }
  })

  it("alternates assistant and user across the verbatim window", () => {
    const messages = withTurns(3).toMessages(OBS)
    expect(messages.map((m) => m.role)).toEqual([
      "user", // the leading block
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "user", // the observation
    ])
  })

  it("passes assistantContent through untouched, thinking blocks and order included", () => {
    const thinking: Anthropic.ContentBlockParam[] = [
      { type: "thinking", thinking: "the registry search box is [2]", signature: "sig-abc" },
      { type: "text", text: "Searching the registry." },
      { type: "tool_use", id: "tu_9", name: "type", input: { ref: 2, text: "Acme" } },
    ]
    const h = new History()
    h.addTurn(turn(9, { assistantContent: thinking }))
    expect(soleTurn(h)[0]!.content).toEqual(thinking)
  })

  it("renders a turn with no tool call as a plain text user message", () => {
    const h = new History()
    h.addTurn(
      turn(1, {
        assistantContent: [{ type: "text", text: "just thinking out loud" }],
        toolUseId: null,
        toolResultText: "No tool was called. Continue with exactly one tool call, or call finish.",
      }),
    )
    expect(soleTurn(h)[1]!.content).toEqual([
      {
        type: "text",
        text: "No tool was called. Continue with exactly one tool call, or call finish.",
      },
    ])
    expect(allBlocks(h.toMessages(OBS)).some((b) => b.type === "tool_result")).toBe(false)
  })

  // A tool_result whose id is not in the preceding assistant message is a 400 from the API, which
  // would kill the run — degrade to text rather than send an array the API will reject.
  it("degrades to plain text when the recorded id is absent from the assistant content", () => {
    const h = new History()
    h.addTurn(turn(1, { assistantContent: [{ type: "text", text: "no tool_use here" }] }))
    expect(soleTurn(h)[1]!.content).toEqual([{ type: "text", text: "result 1" }])
  })

  // An empty text block is a 400 too ("text content blocks must be non-empty").
  it("substitutes a description when a tool comes back with no output at all", () => {
    const h = new History()
    h.addTurn(turn(1, { toolResultText: "   " }))
    expect(soleTurn(h)[1]!.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "(the tool returned no output)" },
    ])
  })

  // The API rejects a message with empty content; drop it instead (same-role messages merge).
  it("drops an assistant message with no content blocks", () => {
    const h = new History()
    h.addTurn(turn(1, { assistantContent: [], toolUseId: null }))
    const only = soleTurn(h)
    expect(only).toHaveLength(1)
    expect(only[0]!.role).toBe("user")
    expect(textOf(only[0]!)).toBe("result 1")
  })

  // Pruning has to be real in memory too — nothing in the rendered array can show that, so this
  // one test deliberately reaches inside: an aged turn keeps its summary line and nothing else.
  it("releases a turn's transcript once it ages out of the window", () => {
    const inside = withTurns(8) as unknown as { pruned: string[]; recent: TurnRecord[] }
    expect(inside.recent).toHaveLength(KEEP_VERBATIM)
    expect(inside.recent.map((t) => t.summaryLine)).toEqual([
      "step 4: clicked [4]",
      "step 5: clicked [5]",
      "step 6: clicked [6]",
      "step 7: clicked [7]",
      "step 8: clicked [8]",
    ])
    expect(inside.pruned).toEqual([
      "step 1: clicked [1]",
      "step 2: clicked [2]",
      "step 3: clicked [3]",
    ])
  })
})

describe("History — the observation", () => {
  it("follows the leading block on turn 1, with nothing in between", () => {
    const messages = new History().toMessages(OBS)
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(["user", "user"])
    expect(textOf(messages[0]!)).toBe("(start of run — no earlier steps to summarize)")
  })

  it("comes last, as a user message: observation text, then the screenshot", () => {
    const messages = withTurns(8).toMessages(OBS)
    const last = messages[messages.length - 1]!
    expect(last.role).toBe("user")
    expect(last.content).toEqual([
      { type: "text", text: OBS.text },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: OBS.screenshotJpeg.toString("base64"),
        },
      },
    ])
  })

  it("carries the only image in the whole array", () => {
    const messages = withTurns(8).toMessages(OBS)
    const images = allBlocks(messages).filter((b) => b.type === "image")
    expect(images).toHaveLength(1)
    // Not merely one image, but one in the *last* message: the page the agent is looking at now.
    expect(allBlocks(messages.slice(0, -1)).some((b) => b.type === "image")).toBe(false)
  })

  it("is rebuilt per call, leaving the recorded turns untouched", () => {
    const h = withTurns(8)
    const first = h.toMessages(OBS)
    const second = h.toMessages({ text: "second look", screenshotJpeg: Buffer.from("other") })
    expect(first).toEqual(h.toMessages(OBS))
    expect(textOf(second[second.length - 1]!)).toBe("second look")
    expect(second).toHaveLength(first.length)
    expect(allBlocks(second).filter((b) => b.type === "image")).toHaveLength(1)
  })

  it("is unaffected by mutating a returned message array", () => {
    const h = withTurns(6)
    const messages = h.toMessages(OBS)
    messages.length = 0
    expect(h.toMessages(OBS)).toHaveLength(12)
  })
})
