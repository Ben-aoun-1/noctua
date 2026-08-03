import type Anthropic from "@anthropic-ai/sdk"

/**
 * The rolling context the loop sends to Claude each turn.
 *
 * A run can go a hundred steps, but a hundred steps of verbatim transcript — each with its own
 * screenshot — would cost more than the run is worth and bury the current page under stale ones.
 * So the array is pruned two ways every turn:
 *
 * - the last {@link KEEP_VERBATIM} turns are replayed exactly as they happened, which is what lets
 *   the model see its own recent reasoning and the results it actually got, and
 * - everything older collapses into a single "Earlier steps:" list of one-line summaries.
 *
 * The screenshot of the *current* page is the only image in the array. Turns carry no images (a
 * `TurnRecord` holds text and tool blocks only), so the model never has to work out which of five
 * pictures is the page it is looking at now.
 */

/** How many turns are replayed verbatim; older ones survive only as their `summaryLine`. */
export const KEEP_VERBATIM = 5

/** Stands in for a result the caller left blank; the API rejects an empty text block. */
const NO_OUTPUT = "(the tool returned no output)"

/** One completed turn: what the model said, and what it got back. */
export interface TurnRecord {
  /** The assistant message content exactly as the API returned it — thinking blocks included. */
  assistantContent: Anthropic.ContentBlockParam[]
  /** The tool result, an error, or a denial — whatever the model reads next. */
  toolResultText: string
  /** The `tool_use` id this result answers; null when the turn called no tool. */
  toolUseId: string | null
  /** One line for the condensed block once this turn ages out of the verbatim window. */
  summaryLine: string
}

export class History {
  private readonly turns: TurnRecord[] = []

  addTurn(t: TurnRecord): void {
    this.turns.push(t)
  }

  /** The full message array for one API call, ending in the page the agent is looking at now. */
  toMessages(observation: { text: string; screenshotJpeg: Buffer }): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = []
    const cut = Math.max(0, this.turns.length - KEEP_VERBATIM)

    const older = this.turns.slice(0, cut)
    if (older.length > 0) {
      const lines = older.map((t) => `- ${t.summaryLine}`).join("\n")
      messages.push({ role: "user", content: [{ type: "text", text: `Earlier steps:\n${lines}` }] })
    }

    for (const turn of this.turns.slice(cut)) {
      // The API rejects a message with no content blocks. Consecutive same-role messages are
      // merged server-side, so dropping an empty assistant turn is safe where inventing one is not.
      if (turn.assistantContent.length > 0) {
        messages.push({ role: "assistant", content: turn.assistantContent })
      }
      messages.push({ role: "user", content: [this.resultBlock(turn)] })
    }

    messages.push({
      role: "user",
      content: [
        { type: "text", text: observation.text },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: observation.screenshotJpeg.toString("base64"),
          },
        },
      ],
    })
    return messages
  }

  /**
   * A `tool_result` only when the assistant message just pushed really contains that `tool_use`
   * id — the pairing the API enforces. An unpaired id is a 400 that would end the run, so a turn
   * that cannot be paired (no tool called, or a mismatch) hands the same text over as plain text.
   * Blank text is a 400 of the same kind, so it is described rather than sent empty.
   */
  private resultBlock(turn: TurnRecord): Anthropic.ContentBlockParam {
    const text = turn.toolResultText.trim() === "" ? NO_OUTPUT : turn.toolResultText
    const paired =
      turn.toolUseId !== null &&
      turn.assistantContent.some((b) => b.type === "tool_use" && b.id === turn.toolUseId)
    return paired
      ? { type: "tool_result", tool_use_id: turn.toolUseId!, content: text }
      : { type: "text", text }
  }
}
