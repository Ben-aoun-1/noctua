import { useEffect, useMemo, useRef, useState, type UIEvent } from "react"
import type { PersistedEvent } from "../api.ts"
import { actionLine } from "../format.ts"

/**
 * What Noctua is thinking, as it thinks it.
 *
 * The pane is a *reading* surface, not a console: the model's own reasoning is set in the display
 * face, italic, at reading size — a voice, distinct from everything mechanical around it, which is
 * set in mono at 12px so the prose is never competing with the log. The italic is the real cut, not
 * a browser's synthesized slant (`400-italic` is imported alongside the roman in `theme.css`).
 *
 * Streaming deltas are coalesced rather than rendered one to a line. The model emits a thought in
 * however many chunks the network happened to cut it into, and every turn is bracketed by events
 * that are not thoughts (a screenshot before, a budget after), so "consecutive deltas" is exactly
 * one turn's thinking — split into paragraphs on the blank lines the model itself wrote.
 */

/** How close to the bottom still counts as "following along". */
const PIN_SLACK_PX = 40

/** The voices in the feed, and the colour each speaks in. */
type Voice = "action" | "ok" | "fail" | "error" | "you" | "asks" | "answered"

const VOICE_TONE: Record<Voice, string> = {
  action: "text-ink/80",
  ok: "text-sage",
  fail: "text-oxide",
  error: "text-oxide",
  you: "text-bronze",
  asks: "text-sage",
  answered: "text-sage",
}

/** A line that opens a new exchange gets air above it; a consequence sits tight under its cause. */
const VOICE_LEAD: Record<Voice, string> = {
  action: "mt-3",
  ok: "mt-1",
  fail: "mt-1",
  error: "mt-1",
  you: "mt-3",
  asks: "mt-3",
  answered: "mt-1",
}

type Entry =
  | { kind: "thought"; key: number; paragraphs: string[] }
  | { kind: "line"; key: number; voice: Voice; text: string }

export default function MindPane({ events }: { events: PersistedEvent[] }) {
  const feed = useMemo(() => buildFeed(events), [events])
  const boxRef = useRef<HTMLDivElement>(null)
  /** Following the stream, as opposed to reading something further up. */
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    const box = boxRef.current
    if (box && pinned) box.scrollTop = box.scrollHeight
  }, [feed, pinned])

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const box = event.currentTarget
    setPinned(box.scrollHeight - box.scrollTop - box.clientHeight <= PIN_SLACK_PX)
  }

  return (
    <section className="pane min-h-[220px]">
      <p className="microlabel">REASONING</p>
      <div className="relative mt-3 min-h-0 grow">
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto pr-1"
          data-testid="reasoning-feed"
        >
          {feed.length === 0 ? (
            <p className="text-[14px] text-ink/40">Waiting for the first thought…</p>
          ) : (
            feed.map((entry) => <Line key={entry.key} entry={entry} />)
          )}
        </div>
        {!pinned && (
          <button
            className="chip absolute bottom-2 left-1/2 -translate-x-1/2 bg-ivory hover:bg-sand"
            onClick={() => setPinned(true)}
          >
            ↓ latest
          </button>
        )}
      </div>
    </section>
  )
}

function Line({ entry }: { entry: Entry }) {
  if (entry.kind === "thought") {
    return (
      <div className="mt-3 first:mt-0">
        {entry.paragraphs.map((paragraph, i) => (
          <p
            key={i}
            className="serif mt-2 text-[16px] leading-[1.5] text-ink/70 italic first:mt-0"
          >
            {paragraph}
          </p>
        ))}
      </div>
    )
  }
  return (
    <p
      className={`mono text-[12px] leading-[1.5] break-words first:mt-0 ${VOICE_LEAD[entry.voice]} ${
        VOICE_TONE[entry.voice]
      }`}
    >
      {entry.text}
    </p>
  )
}

/**
 * The event log as a column of prose and log lines, in the order it happened.
 *
 * Only the events a watcher can act on the meaning of are rendered. A proposal, a screenshot, a
 * budget line and a status change are all shown somewhere else in the cockpit — repeating them
 * here would bury the one thing this pane is for.
 */
function buildFeed(events: PersistedEvent[]): Entry[] {
  const feed: Entry[] = []
  /** The thought being written into, or null when the last event was not a delta. */
  let thinking: { key: number; text: string } | null = null

  const say = (key: number, voice: Voice, text: string): void => {
    feed.push({ kind: "line", key, voice, text })
  }

  for (const { seq, event } of events) {
    if (event.type === "thinking_delta") {
      if (thinking) thinking.text += event.text
      else thinking = { key: seq, text: event.text }
      continue
    }
    if (thinking) {
      feed.push({ kind: "thought", key: thinking.key, paragraphs: paragraphsOf(thinking.text) })
      thinking = null
    }

    switch (event.type) {
      case "action_started":
        say(seq, "action", `→ ${actionLine(event.tool, event.args)}`)
        break
      case "action_result":
        say(seq, event.ok ? "ok" : "fail", `${event.ok ? "✓" : "✕"} ${event.summary}`)
        break
      case "error":
        say(seq, "error", `! ${event.message}`)
        break
      case "steer":
        say(seq, "you", `YOU: ${event.text}`)
        break
      case "ask_human":
        say(seq, "asks", `NOCTUA ASKS: ${event.question}`)
        break
      case "human_answer":
        say(seq, "answered", `ANSWERED: ${event.text}`)
        break
      default:
        break
    }
  }

  // A thought still being streamed belongs on screen as it arrives, not once it is finished.
  if (thinking) {
    feed.push({ kind: "thought", key: thinking.key, paragraphs: paragraphsOf(thinking.text) })
  }
  return feed.filter((entry) => entry.kind !== "thought" || entry.paragraphs.length > 0)
}

/** The model's own paragraphing, kept: a blank line it wrote is a break it meant. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
}
