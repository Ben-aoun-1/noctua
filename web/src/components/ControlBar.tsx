import { useState, type FormEvent } from "react"
import { controlRun, type ControlBody, type RunMode, type RunStatus } from "../api.ts"
import { actionLine, messageOf } from "../format.ts"
import { isTerminal } from "../useRunStream.ts"
import StatusDot from "./StatusDot.tsx"

/**
 * The human half of the run.
 *
 * Everything here is a nudge to a loop that is already running: the server writes nothing into the
 * event log on our behalf, it moves `RunControl`, and the *loop* decides when to act on that and
 * says so in its own words. So nothing in this bar reports success — the answer to "did my stop
 * land?" is the status chip going grey, which is the run itself saying it, not us claiming it.
 *
 * Every call disables its own control while it is in flight and re-enables it whatever happens, so
 * a slow network can never leave a dead button behind; a refusal is printed in the server's own
 * sentence, in oxide, under the bar. Three separate in-flight flags rather than one, because STOP
 * is the control you reach for when something is going wrong: neither a mode switch, a pause, nor
 * a steering note posted a moment earlier may hold it shut.
 *
 * Once a run is terminal every control is disabled rather than hidden. A dead run's cockpit should
 * still look like a cockpit — that is the difference between "this is over" and "this is broken".
 * A disabled control must also *look* disabled, which is why the two buttons that carry a colour of
 * their own drop it while they are held: a utility class sits in a later cascade layer than
 * `.btn-outline:disabled`, so an oxide STOP left painted oxide would out-shout the disabled rule
 * and read as live.
 */

/** Mode is not readable back from the server, so the toggle is this client's own belief. */
const MODES: { mode: RunMode; label: string }[] = [
  { mode: "auto", label: "AUTOPILOT" },
  { mode: "approve", label: "APPROVE" },
]

/** Shared by every button in the footer: mono, small, widely tracked. */
const BUTTON = "mono px-3 py-2 text-[11px] tracking-[0.1em]"

/** STOP's colour, worn only while it can actually stop something. */
const DANGER = "border-oxide text-oxide hover:bg-oxide hover:text-cream"

/**
 * The chosen mode segment, live and held.
 *
 * Held it keeps a fill — which mode a finished run flew in is worth reading back — but a tenth of
 * ink rather than the full slab, so the segment sits inside the muted border and ink/40 text that
 * `.btn-outline:disabled` gives it instead of shouting over them in cream on black.
 */
const SELECTED = { live: "bg-ink text-cream", held: "bg-ink/10" } as const

/** The server's own caps. Better to stop the keystroke than to explain a 400 after the fact. */
const MAX_STEER_CHARS = 500
const MAX_ANSWER_CHARS = 2000

const INPUT =
  "mono hairline min-w-0 flex-1 rounded-[4px] border bg-transparent px-3 py-2 text-[12px] " +
  "outline-none placeholder:text-ink/30 focus:border-ink/40 disabled:text-ink/40"

export interface ControlBarProps {
  runId: string
  status: RunStatus
  /** The latest budget event, or null before the first turn has been billed. */
  budget: { steps: number; maxSteps: number; costUsd: number; maxCostUsd: number } | null
}

export default function ControlBar({ runId, status, budget }: ControlBarProps) {
  const [mode, setMode] = useState<RunMode>("auto")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [steering, setSteering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const over = isTerminal(status)
  const held = over || busy
  const stopHeld = over || stopping

  /** One control call, holding only its own flag down, and releasing it whatever happened. */
  async function send(body: ControlBody, hold: (on: boolean) => void): Promise<void> {
    hold(true)
    try {
      await controlRun(runId, body)
      setError(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      hold(false)
    }
  }

  /** Optimistic, then honest: the segment moves at once and moves back if the server refused. */
  async function pickMode(next: RunMode): Promise<void> {
    if (next === mode) return
    const previous = mode
    setMode(next)
    setBusy(true)
    try {
      await controlRun(runId, { action: "mode", mode: next })
      setError(null)
    } catch (err) {
      setMode(previous)
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function steer(event: FormEvent): Promise<void> {
    event.preventDefault()
    const text = note.trim()
    if (over || steering || text === "") return
    // Cleared before the round trip: the note is already queued as far as the operator is
    // concerned, and a field that empties late is a field they type into twice.
    setNote("")
    setSteering(true)
    try {
      await controlRun(runId, { action: "steer", text })
      setError(null)
    } catch (err) {
      // Given back rather than lost: a note the server refused is still a note worth sending.
      setNote(text)
      setError(messageOf(err))
    } finally {
      setSteering(false)
    }
  }

  return (
    <div className="hairline border-t bg-ivory/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="chip" data-testid="status-chip">
            <StatusDot status={status} />
            <span aria-hidden>{status.replace("_", " ")}</span>
          </span>
          <span className="mono text-[12px] whitespace-nowrap text-ink/60" data-testid="budget">
            {gauges(budget)}
          </span>
        </div>

        <div className="mx-auto flex items-center gap-2">
          <div className="flex" role="group" aria-label="Autonomy mode">
            {MODES.map((segment, i) => (
              <button
                key={segment.mode}
                className={`btn-outline ${BUTTON} ${i === 0 ? "rounded-r-none" : "-ml-px rounded-l-none"} ${
                  mode === segment.mode ? SELECTED[held ? "held" : "live"] : ""
                }`}
                aria-pressed={mode === segment.mode}
                disabled={held}
                onClick={() => void pickMode(segment.mode)}
                data-testid={`mode-${segment.mode}`}
              >
                {segment.label}
              </button>
            ))}
          </div>

          <button
            className={`btn-outline ${BUTTON}`}
            disabled={held}
            onClick={() => void send({ action: status === "paused" ? "resume" : "pause" }, setBusy)}
          >
            {status === "paused" ? "RESUME" : "PAUSE"}
          </button>

          <button
            className={`btn-outline ${BUTTON} ${stopHeld ? "" : DANGER}`}
            disabled={stopHeld}
            onClick={() => void send({ action: "stop" }, setStopping)}
            data-testid="stop"
          >
            STOP
          </button>
        </div>

        <form
          onSubmit={(event) => void steer(event)}
          className="ml-auto flex min-w-[240px] flex-1 items-center gap-2"
        >
          <input
            className={INPUT}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Whisper to Noctua…"
            aria-label="Steer this run"
            spellCheck={false}
            maxLength={MAX_STEER_CHARS}
            disabled={over}
            data-testid="steer-input"
          />
          <button
            className={`btn-ink ${BUTTON}`}
            type="submit"
            disabled={over || steering || note.trim() === ""}
          >
            SEND
          </button>
        </form>
      </div>

      {error !== null && (
        <p className="mono px-5 pb-2 text-[11px] text-oxide sm:px-8" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The band that stops the run until a human says yes.
 *
 * Shown for a guarded action in autopilot as well as for every action in approve mode — the loop
 * decides which, and both arrive here as the same `action_proposed` event.
 *
 * The proposal is written the way the reasoning feed writes an action rather than as the raw
 * arguments: this is the one moment a human is asked to take responsibility for a step, and
 * `finish {"outcome":"success","summary":"Glowbar Ltd (0987…` is not a sentence anyone can consent
 * to. A denial says so and waits, because a denied action produces no event of its own — the loop
 * simply takes another turn, and until it does, two dead buttons look like a hung page.
 */
export function ApprovalStrip({
  runId,
  tool,
  args,
}: {
  runId: string
  tool: string
  args: Record<string, unknown>
}) {
  const [settled, setSettled] = useState<"open" | "sending" | "approved" | "denied">("open")
  const [error, setError] = useState<string | null>(null)

  async function decide(action: "approve" | "deny"): Promise<void> {
    setSettled("sending")
    try {
      await controlRun(runId, { action })
      setError(null)
      // Left settled: this strip is about to be unmounted by the run moving on, and re-opening it
      // first would offer a second decision on a question that is already answered.
      setSettled(action === "deny" ? "denied" : "approved")
    } catch (err) {
      setError(messageOf(err))
      setSettled("open")
    }
  }

  return (
    <div
      className="hairline flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-sand px-5 py-3 sm:px-8"
      data-testid="approval-strip"
    >
      <p className="mono min-w-[240px] grow text-[12px] leading-[1.5] break-words text-bronze">
        NOCTUA WANTS TO: {actionLine(tool, args)}
      </p>
      {settled === "denied" ? (
        <p className="mono text-[11px] text-ink/50" data-testid="denied-note">
          DENIED — WAITING FOR NOCTUA TO CHOOSE ANOTHER WAY
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <button
            className={`btn-ink ${BUTTON}`}
            disabled={settled !== "open"}
            onClick={() => void decide("approve")}
          >
            APPROVE
          </button>
          <button
            className={`btn-outline ${BUTTON}`}
            disabled={settled !== "open"}
            onClick={() => void decide("deny")}
          >
            DENY
          </button>
        </div>
      )}
      {error !== null && (
        <p className="mono w-full text-[11px] text-oxide" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The band that stops the run until a human answers a question only they can answer.
 *
 * It does not take focus when it appears. A question can arrive at any moment, including the
 * moment someone is halfway through a steering note, and a field that grabs the caret mid-sentence
 * loses the rest of it.
 */
export function AskStrip({ runId, question }: { runId: string; question: string }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function answer(event: FormEvent): Promise<void> {
    event.preventDefault()
    const given = text.trim()
    if (busy || given === "") return
    setBusy(true)
    try {
      await controlRun(runId, { action: "answer", text: given })
      setError(null)
      // Left disabled on purpose: the answer has landed and the strip is about to be unmounted by
      // the run moving on. A second answer to a settled question would be dropped anyway.
      return
    } catch (err) {
      setError(messageOf(err))
    }
    setBusy(false)
  }

  return (
    <div
      className="hairline border-t bg-sage/10 px-5 py-3 sm:px-8"
      data-testid="ask-strip"
    >
      <p className="mono text-[12px] leading-[1.5] break-words text-sage">NOCTUA ASKS: {question}</p>
      <form onSubmit={(event) => void answer(event)} className="mt-2 flex items-center gap-2">
        <input
          className={INPUT}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Your answer…"
          aria-label="Answer Noctua"
          spellCheck={false}
          maxLength={MAX_ANSWER_CHARS}
          disabled={busy}
          data-testid="answer-input"
        />
        <button className={`btn-ink ${BUTTON}`} type="submit" disabled={busy || text.trim() === ""}>
          ANSWER
        </button>
      </form>
      {error !== null && (
        <p className="mono mt-2 text-[11px] text-oxide" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** `STEP 12/40 · $0.34 / $1.50`, or the same shape with nothing in it yet. */
function gauges(budget: ControlBarProps["budget"]): string {
  if (budget === null) return "STEP —/— · $— / $—"
  return (
    `STEP ${budget.steps}/${budget.maxSteps} · ` +
    `$${budget.costUsd.toFixed(2)} / $${budget.maxCostUsd.toFixed(2)}`
  )
}
