import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config.js"

/**
 * The seam between the agent loop and Claude.
 *
 * The loop knows nothing about the Anthropic SDK: it hands over a system prompt, a message array
 * and the toolset, and gets back one tool call, the prose that came with it, the assistant content
 * to replay next turn, and what the turn cost. That narrow shape is what lets {@link FakeLLM} stand
 * in for the real model in tests — a scripted run needs no API key, no network and no tokens.
 *
 * Two details of the request are load-bearing rather than incidental:
 *
 * - `disable_parallel_tool_use` — {@link ../agent/history.History} pairs exactly one `tool_result`
 *   with the `tool_use` in the assistant message before it. Two tool calls in one turn would leave
 *   one of them unanswered, which the API rejects with a 400 that ends the run.
 * - the cached system block — the prompt is byte-identical on every turn of a run, so it is written
 *   to the cache once and read back for a tenth of the price on every turn after.
 */

/** Enough for a long chain of thought plus a tool call; a turn never writes prose at length. */
const MAX_TOKENS = 16000

/** USD per million tokens, `[input, output]`, from the published price list. */
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [3, 15],
  "claude-opus-5": [5, 25],
}

/**
 * What an unrecognised model is billed at. Unknown almost always means *newer*, and newer has so
 * far never been cheaper — guessing high stops a run early, guessing low spends past the cap.
 */
const FALLBACK_PRICE: [number, number] = [5, 25]

/** A cache read is a tenth of the base input rate; expressed as a divisor to keep the math exact. */
const CACHE_READ_DIVISOR = 10
/** Writing an entry to the cache costs a quarter more than sending those tokens uncached. */
const CACHE_WRITE_MULTIPLIER = 1.25

const PER_MTOK = 1_000_000

export interface TurnRequest {
  system: string
  messages: Anthropic.MessageParam[]
  tools: Anthropic.Tool[]
}

export interface TurnResult {
  /** The tool the model called, or null when the turn was narration only. */
  toolName: string | null
  /** That tool's arguments; `{}` when no tool was called. */
  toolInput: Record<string, unknown>
  /** The id the next turn's `tool_result` must quote; null when no tool was called. */
  toolUseId: string | null
  /** The visible prose of the turn, text blocks joined in order. */
  text: string
  /** The assistant message exactly as it came back — thinking blocks included, for replay. */
  assistantContent: Anthropic.ContentBlockParam[]
  costUsd: number
}

export interface LLM {
  turn(req: TurnRequest, onThinkingDelta: (t: string) => void): Promise<TurnResult>
}

export type LLMFactory = () => LLM

/** The four token classes a turn is billed for; the cache counts are optional and default to zero. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** The slice of `stream()` this adapter uses — small enough for a test to implement by hand. */
export interface TurnStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>
}

/** The slice of the Anthropic client this adapter uses; the real client satisfies it structurally. */
export interface StreamingClient {
  messages: { stream(params: Anthropic.MessageStreamParams): TurnStream }
}

/**
 * What one turn cost, in dollars.
 *
 * Cached tokens are most of a long run's input — by turn twenty the system prompt and the recent
 * transcript are read from the cache every time — so billing them at the base rate would report a
 * run as up to ten times more expensive than it was, and the budget guard would cut runs short for
 * money that was never spent.
 */
export function costUsd(model: string, usage: TokenUsage): number {
  const [inputPerMTok, outputPerMTok] = PRICES[model] ?? FALLBACK_PRICE
  const inputUsd =
    usage.inputTokens * inputPerMTok +
    ((usage.cacheReadTokens ?? 0) * inputPerMTok) / CACHE_READ_DIVISOR +
    (usage.cacheWriteTokens ?? 0) * inputPerMTok * CACHE_WRITE_MULTIPLIER
  return inputUsd / PER_MTOK + (usage.outputTokens * outputPerMTok) / PER_MTOK
}

/** Tool arguments arrive typed `unknown`; anything that is not a plain object is no arguments. */
function asToolInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

export class AnthropicLLM implements LLM {
  private readonly model: string
  private readonly client: StreamingClient

  /** `client` is for tests only; production passes nothing and gets the real SDK client. */
  constructor(model?: string, client?: StreamingClient) {
    this.model = model ?? config.model
    this.client = client ?? new Anthropic()
  }

  async turn(req: TurnRequest, onThinkingDelta: (t: string) => void): Promise<TurnResult> {
    let msg: Anthropic.Message
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: config.effort as Anthropic.OutputConfig["effort"] },
        tools: req.tools,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages: req.messages,
      })

      // Thinking and prose both belong in the mind pane: the watcher wants the reasoning as it
      // happens, and the sentence the model writes before acting is part of that reasoning.
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue
        if (event.delta.type === "thinking_delta") onThinkingDelta(event.delta.thinking)
        else if (event.delta.type === "text_delta") onThinkingDelta(event.delta.text)
      }

      msg = await stream.finalMessage()
    } catch (err) {
      // Retries are the loop's business; all this layer owes the log is which layer failed and the
      // original error underneath, where the SDK keeps the status code and request id.
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`llm: ${detail}`, { cause: err })
    }

    const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    const usage = msg.usage
    return {
      toolName: toolUse?.name ?? null,
      toolInput: asToolInput(toolUse?.input),
      toolUseId: toolUse?.id ?? null,
      // Newline-joined, not glued: separate blocks are separate sentences, and running the last
      // word of one into the first of the next is how a summary line turns into nonsense.
      text: msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      assistantContent: msg.content,
      costUsd: costUsd(this.model, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      }),
    }
  }
}

/** One scripted turn: whatever the test cares about, with the rest filled in. */
export type ScriptedTurn = Partial<TurnResult> & { thinking?: string }

/** What a scripted turn costs when the script does not say — a plausible small turn. */
const FAKE_TURN_COST_USD = 0.01

/**
 * A scripted stand-in for {@link AnthropicLLM}. Tests write the turns they want the model to take
 * and get a deterministic run out of the loop — no key, no network, no tokens.
 */
export class FakeLLM implements LLM {
  private next = 0

  constructor(private readonly script: ScriptedTurn[]) {}

  async turn(_req: TurnRequest, onThinkingDelta: (t: string) => void): Promise<TurnResult> {
    const i = this.next++
    const entry = this.script[i]
    // Repeating the last turn instead would spin the loop until a budget cut it off, and the test
    // would fail somewhere far from the cause. Say plainly that the script ran short.
    if (!entry) {
      const scripted = this.script.length
      throw new Error(`FakeLLM: script exhausted — turn ${i + 1} requested, ${scripted} scripted`)
    }

    onThinkingDelta(entry.thinking ?? "")

    const toolName = entry.toolName ?? null
    const toolInput = entry.toolInput ?? {}
    const toolUseId = entry.toolUseId ?? `tu_${i}`
    const text = entry.text ?? ""
    return {
      toolName,
      toolInput,
      toolUseId,
      text,
      // The id has to match the one reported above, or History cannot pair the tool_result with it.
      assistantContent: entry.assistantContent ?? [
        { type: "text", text },
        ...(toolName
          ? [{ type: "tool_use" as const, id: toolUseId, name: toolName, input: toolInput }]
          : []),
      ],
      costUsd: entry.costUsd ?? FAKE_TURN_COST_USD,
    }
  }
}
