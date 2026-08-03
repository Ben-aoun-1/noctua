import { describe, it, expect } from "vitest"
import type Anthropic from "@anthropic-ai/sdk"
import { config } from "../../src/config.js"
import {
  AnthropicLLM,
  FakeLLM,
  costUsd,
  type StreamingClient,
  type TurnRequest,
} from "../../src/agent/llm.js"

const noop = () => {}

const REQ: TurnRequest = {
  system: "You are Noctua.",
  messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
  tools: [
    {
      name: "click",
      description: "Click an element.",
      input_schema: { type: "object", properties: { ref: { type: "number" } } },
    },
  ],
}

function usage(over: Partial<Anthropic.Usage> = {}): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...over,
  }
}

function message(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [],
    container: null,
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(),
    ...over,
  }
}

const thinkingDelta = (thinking: string): Anthropic.MessageStreamEvent => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "thinking_delta", thinking },
})

const textDelta = (text: string): Anthropic.MessageStreamEvent => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
})

/**
 * A stand-in for `client.messages.stream`. Records the params it was handed — that request shape
 * is the contract with the API and the one thing a unit test can pin down without a network.
 */
function mockClient(script: {
  events?: Anthropic.MessageStreamEvent[]
  final?: Anthropic.Message
  failIterating?: Error
  failFinal?: Error
} = {}) {
  const calls: Anthropic.MessageStreamParams[] = []
  const client: StreamingClient = {
    messages: {
      stream(params) {
        calls.push(params)
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of script.events ?? []) yield event
            if (script.failIterating) throw script.failIterating
          },
          async finalMessage() {
            if (script.failFinal) throw script.failFinal
            return script.final ?? message()
          },
        }
      },
    },
  }
  return { client, calls }
}

describe("costUsd", () => {
  it("prices sonnet input and output at the published per-MTok rates", () => {
    expect(costUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBe(4.5)
  })

  it("prices opus at its own rates", () => {
    expect(costUsd("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30)
  })

  // Cached input is the bulk of a long run's tokens — billing it at the base rate would report a
  // run as ten times more expensive than it was, and the budget guard would cut runs short.
  it("bills cache reads at a tenth of the base input rate", () => {
    expect(costUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(0.3)
  })

  it("bills cache writes at 1.25x the base input rate", () => {
    expect(costUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(3.75)
  })

  it("adds the four token classes together", () => {
    const total = costUsd("claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    expect(total).toBeCloseTo(3 + 1.5 + 0.3 + 3.75, 10)
  })

  it("treats omitted cache counts as zero", () => {
    const bare = costUsd("claude-sonnet-5", { inputTokens: 5_000, outputTokens: 900 })
    const explicit = costUsd("claude-sonnet-5", {
      inputTokens: 5_000,
      outputTokens: 900,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(bare).toBe(explicit)
    expect(costUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  // An unknown model is most likely a newer, pricier one: overestimating stops a run early,
  // underestimating spends real money past the cap.
  it("falls back to the opus rates for an unknown model", () => {
    const unknown = costUsd("claude-something-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(unknown).toBe(30)
    expect(unknown).toBe(costUsd("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }))
  })

  // A model id off the environment reaching Object.prototype would otherwise destructure a
  // function and throw inside the meter — which runs on every turn of every run.
  it("falls back for a model name that is an Object.prototype key", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(costUsd(name, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30)
    }
  })
})

describe("FakeLLM", () => {
  it("returns the scripted turns in order", async () => {
    const llm = new FakeLLM([
      { toolName: "navigate", toolInput: { url: "https://example.gov" } },
      { toolName: "click", toolInput: { ref: 2 } },
      { toolName: "finish", toolInput: { outcome: "success" } },
    ])
    const names = [
      (await llm.turn(REQ, noop)).toolName,
      (await llm.turn(REQ, noop)).toolName,
      (await llm.turn(REQ, noop)).toolName,
    ]
    expect(names).toEqual(["navigate", "click", "finish"])
  })

  it("emits the scripted thinking, and an empty delta when a turn scripts none", async () => {
    const seen: string[] = []
    const llm = new FakeLLM([{ thinking: "the search box is [2]" }, {}])
    await llm.turn(REQ, (t) => seen.push(t))
    await llm.turn(REQ, (t) => seen.push(t))
    expect(seen).toEqual(["the search box is [2]", ""])
  })

  it("fills the defaults of an all-blank turn", async () => {
    const result = await new FakeLLM([{}]).turn(REQ, noop)
    expect(result).toEqual({
      toolName: null,
      toolInput: {},
      toolUseId: "tu_0",
      text: "",
      assistantContent: [{ type: "text", text: "" }],
      stopReason: "end_turn",
      costUsd: 0.01,
    })
  })

  // The loop reads stopReason to tell a refusal or a cut-off turn from ordinary narration, so a
  // scripted turn has to carry the reason the API would really have sent with it.
  it("defaults stopReason to tool_use when a tool was called, end_turn otherwise", async () => {
    const llm = new FakeLLM([{ toolName: "click", toolInput: { ref: 2 } }, { text: "Just talking." }])
    expect((await llm.turn(REQ, noop)).stopReason).toBe("tool_use")
    expect((await llm.turn(REQ, noop)).stopReason).toBe("end_turn")
  })

  it("passes a scripted stopReason through", async () => {
    const llm = new FakeLLM([{ text: "I can't help with that.", stopReason: "refusal" }])
    expect((await llm.turn(REQ, noop)).stopReason).toBe("refusal")
  })

  // The loop replays assistantContent and pairs the tool_result by id, so a scripted tool call has
  // to produce a matching tool_use block — otherwise History degrades the result to plain text.
  it("builds assistantContent with a tool_use block whose id matches toolUseId", async () => {
    const llm = new FakeLLM([{}, { toolName: "click", toolInput: { ref: 2 }, text: "Clicking." }])
    await llm.turn(REQ, noop)
    const result = await llm.turn(REQ, noop)
    expect(result.toolUseId).toBe("tu_1")
    expect(result.assistantContent).toEqual([
      { type: "text", text: "Clicking." },
      { type: "tool_use", id: "tu_1", name: "click", input: { ref: 2 } },
    ])
  })

  it("passes scripted overrides through untouched", async () => {
    const assistantContent: Anthropic.ContentBlockParam[] = [
      { type: "thinking", thinking: "quiet part", signature: "sig-1" },
      { type: "text", text: "spoken part" },
    ]
    const result = await new FakeLLM([
      { toolUseId: "tu_custom", costUsd: 0.42, text: "spoken part", assistantContent },
    ]).turn(REQ, noop)
    expect(result.toolUseId).toBe("tu_custom")
    expect(result.costUsd).toBe(0.42)
    expect(result.assistantContent).toEqual(assistantContent)
  })

  // Silently repeating the last turn would spin the loop forever; a named error points at the test.
  it("throws once the script runs out", async () => {
    const llm = new FakeLLM([{}])
    await llm.turn(REQ, noop)
    await expect(llm.turn(REQ, noop)).rejects.toThrow(/FakeLLM/)
  })
})

describe("AnthropicLLM — the request", () => {
  it("sends exactly the params the API contract calls for", async () => {
    const { client, calls } = mockClient()
    await new AnthropicLLM("claude-opus-5", client).turn(REQ, noop)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      model: "claude-opus-5",
      max_tokens: 16000,
      // One cached system block: the prompt is identical every turn, so it should be read, not resent.
      system: [{ type: "text", text: "You are Noctua.", cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: config.effort },
      tools: REQ.tools,
      // History records one tool_use per assistant turn; parallel calls would break that pairing.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: REQ.messages,
    })
  })

  it("defaults the model to the configured one", async () => {
    const { client, calls } = mockClient()
    await new AnthropicLLM(undefined, client).turn(REQ, noop)
    expect(calls[0]!.model).toBe(config.model)
  })
})

describe("AnthropicLLM — the stream", () => {
  it("forwards thinking and text deltas, in order, to the mind pane", async () => {
    const seen: string[] = []
    const { client } = mockClient({
      events: [thinkingDelta("weighing "), thinkingDelta("options"), textDelta("Searching now.")],
    })
    await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, (t) => seen.push(t))
    expect(seen).toEqual(["weighing ", "options", "Searching now."])
  })

  it("ignores stream events that carry no prose", async () => {
    const seen: string[] = []
    const { client } = mockClient({
      events: [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ref":' } },
        { type: "content_block_stop", index: 0 },
      ],
    })
    await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, (t) => seen.push(t))
    expect(seen).toEqual([])
  })
})

describe("AnthropicLLM — the result", () => {
  const toolUse: Anthropic.ContentBlock = {
    type: "tool_use",
    id: "toolu_1",
    caller: { type: "direct" },
    name: "type",
    input: { ref: 2, text: "Acme" },
  }

  it("reads the tool call, the prose and the verbatim content off the final message", async () => {
    const content: Anthropic.ContentBlock[] = [
      { type: "thinking", thinking: "the box is [2]", signature: "sig-abc" },
      { type: "text", text: "Typing the name.", citations: null },
      toolUse,
    ]
    const { client } = mockClient({ final: message({ content }) })
    const result = await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)
    expect(result.toolName).toBe("type")
    expect(result.toolUseId).toBe("toolu_1")
    expect(result.toolInput).toEqual({ ref: 2, text: "Acme" })
    expect(result.text).toBe("Typing the name.")
    // Thinking blocks must be replayed byte-for-byte on the next turn, so nothing is rebuilt here.
    expect(result.assistantContent).toEqual(content)
  })

  it("takes the first tool_use block when the model somehow returns two", async () => {
    const second: Anthropic.ContentBlock = {
      type: "tool_use",
      id: "toolu_2",
      caller: { type: "direct" },
      name: "click",
      input: { ref: 9 },
    }
    const { client } = mockClient({ final: message({ content: [toolUse, second] }) })
    const result = await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)
    expect(result.toolUseId).toBe("toolu_1")
    expect(result.toolName).toBe("type")
  })

  it("reports no tool call rather than throwing when the turn was narration only", async () => {
    const content: Anthropic.ContentBlock[] = [{ type: "text", text: "Just thinking.", citations: null }]
    const { client } = mockClient({ final: message({ content }) })
    const result = await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)
    expect(result.toolName).toBeNull()
    expect(result.toolUseId).toBeNull()
    expect(result.toolInput).toEqual({})
    expect(result.text).toBe("Just thinking.")
  })

  // The SDK types a tool_use input as `unknown`; anything that is not a plain object would reach
  // executeTool as a non-object and blow up on the first property read.
  it("reports no arguments when the tool input is not a plain object", async () => {
    for (const input of [null, [1, 2], "text", 7]) {
      const block = { ...toolUse, input } as Anthropic.ContentBlock
      const { client } = mockClient({ final: message({ content: [block] }) })
      const result = await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)
      expect(result.toolName).toBe("type")
      expect(result.toolInput).toEqual({})
    }
  })

  // What the loop branches on: a refusal ends the run, a cut-off turn is narration worth noting.
  it("reports the stop reason the API sent", async () => {
    for (const stop of ["tool_use", "end_turn", "refusal", "max_tokens"] as const) {
      const { client } = mockClient({ final: message({ stop_reason: stop }) })
      expect((await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)).stopReason).toBe(stop)
    }
  })

  it("reports a null stop reason rather than inventing one", async () => {
    const { client } = mockClient({ final: message({ stop_reason: null }) })
    expect((await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)).stopReason).toBeNull()
  })

  it("joins several text blocks without gluing sentences together", async () => {
    const content: Anthropic.ContentBlock[] = [
      { type: "text", text: "First.", citations: null },
      { type: "text", text: "Second.", citations: null },
    ]
    const { client } = mockClient({ final: message({ content }) })
    expect((await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)).text).toBe("First.\nSecond.")
  })

  it("prices the turn from usage, cache classes at their own rates", async () => {
    const { client } = mockClient({
      final: message({
        usage: usage({
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 1_000_000,
        }),
      }),
    })
    const result = await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)
    expect(result.costUsd).toBeCloseTo(3 + 1.5 + 0.3 + 3.75, 10)
  })

  it("tolerates the null cache counters the API sends on an uncached turn", async () => {
    const { client } = mockClient({
      final: message({ usage: usage({ input_tokens: 1_000_000, output_tokens: 100_000 }) }),
    })
    expect((await new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)).costUsd).toBe(4.5)
  })

  it("prices by the model that was asked for, not the one echoed back", async () => {
    const { client } = mockClient({
      final: message({ model: "claude-sonnet-5", usage: usage({ input_tokens: 1_000_000 }) }),
    })
    expect((await new AnthropicLLM("claude-opus-5", client).turn(REQ, noop)).costUsd).toBe(5)
  })
})

describe("AnthropicLLM — failure", () => {
  // The loop retries and logs whatever comes out of here; the prefix says which layer failed, and
  // the cause keeps the SDK's own error (status, request id) reachable.
  it("rethrows a mid-stream failure under an llm: prefix, keeping the cause", async () => {
    const boom = new Error("529 overloaded")
    const { client } = mockClient({ failIterating: boom })
    const err = await new AnthropicLLM("claude-sonnet-5", client)
      .turn(REQ, noop)
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(err?.message).toBe("llm: 529 overloaded")
    expect(err?.cause).toBe(boom)
  })

  it("wraps a failure raised when the final message is assembled", async () => {
    const { client } = mockClient({ failFinal: new Error("stream ended early") })
    await expect(new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)).rejects.toThrow(
      "llm: stream ended early",
    )
  })

  it("still prefixes a thrown non-Error", async () => {
    const { client } = mockClient({ failIterating: "socket hang up" as unknown as Error })
    await expect(new AnthropicLLM("claude-sonnet-5", client).turn(REQ, noop)).rejects.toThrow(
      "llm: socket hang up",
    )
  })
})
