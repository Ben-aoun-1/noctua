import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError, getRun, type DoneOutcome, type PersistedEvent } from "../api.ts"
import AboutPanel from "../components/AboutPanel.tsx"
import ControlBar, { ApprovalStrip, AskStrip } from "../components/ControlBar.tsx"
import EyesPane from "../components/EyesPane.tsx"
import FindingsPane, { type Finding } from "../components/FindingsPane.tsx"
import MindPane from "../components/MindPane.tsx"
import OwlMark from "../components/OwlMark.tsx"
import ReplayBar from "../components/ReplayBar.tsx"
import StatusDot from "../components/StatusDot.tsx"
import { isTerminal, useRunStream } from "../useRunStream.ts"

/**
 * The run, while it is happening: what Noctua is thinking, what it is looking at, and what it has
 * confirmed — with the controls to interrupt any of it along the bottom.
 *
 * Everything on this screen is derived from one array of events. There is no second source of
 * truth and no polling: the stream replays from `seq` 1 on open, so a run watched from the first
 * second and a run opened three days later are rendered by exactly the same code from exactly the
 * same input. That is also what makes the receipts free — the screenshot a finding points at is an
 * event this client already holds, so opening one costs no request at all.
 *
 * The one thing the events do not carry is the run's goal, which is read once from the run list.
 *
 * That single-source-of-truth is also what makes time travel free. A finished run is scrubbed by
 * handing the panes `events` up to a seq instead of all of them: the reasoning column truncates,
 * the live view falls back to the frame of that moment, the table loses the rows that had not been
 * confirmed yet — not because three components implement rewinding, but because none of them can
 * tell the difference between the past and a shorter log.
 */

export interface Digest {
  /** Every screenshot by the step it was taken on — the receipt index. */
  shots: Map<number, string>
  /** The last frame to arrive, which is what the live view follows. */
  latestShot: { step: number; url: string } | null
  /** Where the page was at each step: the frame's own address, or the last one the log named. */
  addressAt: Map<number, string>
  findings: Finding[]
  budget: { steps: number; maxSteps: number; costUsd: number; maxCostUsd: number } | null
  done: { outcome: DoneOutcome; summary: string } | null
  /** An action waiting on a yes, or null. */
  approval: { tool: string; args: Record<string, unknown> } | null
  /** A question waiting on an answer, or null. */
  question: string | null
}

/**
 * The address a step was on, for a log written before the frame carried its own.
 *
 * A `screenshot` event now states the page's URL (`pageUrl`) alongside the image's, and that is
 * what this prefers. Older runs have to replay too, and all they ever said out loud is the
 * summaries `navigate` and `go_back` write — produced by this repository (`src/agent/tools.ts`).
 * That reading lags: a click that moves the page states no address at all, so the last one a
 * navigate mentioned stands for the rest of the run, which is why the line under the live view is
 * labelled as the last address seen rather than as "the current URL".
 */
const ADDRESS_SAID = /(?:navigated to|went back to|still at) (\S+)/

export default function Cockpit({ id }: { id: string }) {
  const { events, status, live, opened, error } = useRunStream(id)
  const [goal, setGoal] = useState<string | null>(null)
  const [goalMissing, setGoalMissing] = useState(false)
  /** The receipt currently open, shared by the findings table and the live view. */
  const [receiptStep, setReceiptStep] = useState<number | null>(null)
  /**
   * Where the replay dial is being held, or null for "wherever the log currently ends".
   *
   * Null rather than a number for the resting state, so a run that finishes while it is being
   * watched does not strand the cockpit on the second-to-last event: nothing has to notice the
   * arrival of a new event and push the cursor along behind it.
   */
  const [pinned, setPinned] = useState<number | null>(null)
  const [about, setAbout] = useState(false)
  const aboutButton = useRef<HTMLButtonElement>(null)

  const maxSeq = events.length === 0 ? 0 : events[events.length - 1].seq
  const cursor = pinned ?? maxSeq
  // Identity matters: an unpinned cockpit hands the panes the very same array it was given, so
  // watching a live run costs no copy per event.
  const shown = useMemo(
    () => (pinned === null ? events : events.filter((entry) => entry.seq <= pinned)),
    [events, pinned],
  )
  const view = useMemo(() => digest(shown), [shown])

  // Stable, because playback re-arms its timeout whenever this changes identity.
  const seek = useCallback(
    (seq: number) => setPinned(Math.max(0, Math.min(seq, maxSeq))),
    [maxSeq],
  )

  // A receipt whose row has been scrubbed out of existence closes itself, rather than pinning the
  // live view to a frame with no visible finding left to explain why.
  useEffect(() => {
    if (receiptStep !== null && !view.findings.some((finding) => finding.step === receiptStep)) {
      setReceiptStep(null)
    }
  }, [view, receiptStep])

  // Read once: a run's goal never changes, and the list is the only projection that carries it.
  useEffect(() => {
    let cancelled = false
    getRun(id).then(
      (run) => {
        if (cancelled) return
        if (run) setGoal(run.goal)
        else setGoalMissing(true)
      },
      (err: unknown) => {
        if (cancelled) return
        // An expired cookie is not this screen's problem to explain: the landing page owns the
        // gate, and it will put it back up the moment it asks for the run list itself.
        if (err instanceof ApiError && err.status === 401) window.location.hash = "#/"
        else setGoalMissing(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [id])

  const over = isTerminal(status)
  const pinnedShot = receiptStep === null ? null : (view.shots.get(receiptStep) ?? null)
  const shownStep = receiptStep ?? view.latestShot?.step ?? null
  const shownUrl = receiptStep === null ? (view.latestShot?.url ?? null) : pinnedShot

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <header className="hairline shrink-0 border-b px-5 py-3 sm:px-8">
        <div className="mx-auto flex w-full max-w-[1600px] items-center gap-4">
          <a href="#/" aria-label="Back to the landing page" className="shrink-0 hover:opacity-70">
            <OwlMark size={26} />
          </a>
          <h1
            className="serif min-w-0 flex-1 truncate text-[17px] leading-tight sm:text-[20px]"
            title={goal ?? undefined}
          >
            {goal ?? (goalMissing ? "This run is not on this deployment." : "…")}
          </h1>
          <span className="chip shrink-0">
            <StatusDot status={status} />
            <span aria-hidden>{status.replace("_", " ")}</span>
          </span>
          <button
            ref={aboutButton}
            className="chip shrink-0 hover:bg-sand"
            aria-label="About Noctua"
            aria-haspopup="dialog"
            aria-expanded={about}
            onClick={() => setAbout(true)}
            data-testid="about-open"
          >
            <span aria-hidden>?</span>
          </button>
          <a className="microlabel shrink-0 hover:text-ink max-sm:hidden" href="#/">
            ← ALL FLIGHTS
          </a>
        </div>
        {/* "Reconnecting" is only true of a feed that was connected: before the first `onopen`
            this would fire on every run's first paint, announcing a fault that is just a socket
            being opened. */}
        {(error !== null || (opened && !live && !over)) && (
          <p className={`microlabel mx-auto mt-1 w-full max-w-[1600px] ${error ? "text-oxide" : ""}`}>
            {error ?? "RECONNECTING…"}
          </p>
        )}
      </header>

      <main className="mx-auto grid w-full max-w-[1600px] grow gap-4 px-5 py-4 sm:px-8 lg:min-h-0 lg:grid-cols-[minmax(280px,1fr)_minmax(400px,1.4fr)_minmax(300px,1fr)] lg:overflow-hidden">
        <MindPane events={shown} />
        <EyesPane
          url={shownUrl}
          step={shownStep}
          pageUrl={shownStep === null ? "" : (view.addressAt.get(shownStep) ?? "")}
          waiting={!over && receiptStep === null}
          receiptStep={receiptStep}
          onLive={() => setReceiptStep(null)}
        />
        <FindingsPane
          runId={id}
          findings={view.findings}
          done={view.done}
          over={over}
          openStep={receiptStep}
          onToggleReceipt={(step) => setReceiptStep((open) => (open === step ? null : step))}
          shotFor={(step) => view.shots.get(step) ?? null}
        />
      </main>

      <footer className="sticky bottom-0 z-10 shrink-0">
        {/* Guarded by `over` as well as by the digest, which clears both on the run's own last
            event: scrubbed back to the middle of a finished run, the log genuinely does say that
            something was waiting on a human — and offering to answer a question that was settled
            days ago would be the one place this cockpit lied about which way time runs. */}
        {!over && view.approval && (
          <ApprovalStrip runId={id} tool={view.approval.tool} args={view.approval.args} />
        )}
        {!over && view.question !== null && <AskStrip runId={id} question={view.question} />}
        {over && maxSeq > 0 && (
          <ReplayBar
            maxSeq={maxSeq}
            cursor={cursor}
            step={view.latestShot?.step ?? null}
            onSeek={seek}
            onEnd={() => setPinned(null)}
          />
        )}
        <ControlBar runId={id} status={status} budget={view.budget} />
      </footer>

      {about && (
        <AboutPanel
          onClose={() => {
            setAbout(false)
            aboutButton.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/**
 * Everything the three panes need, in one pass over the log.
 *
 * The two "is something waiting on me?" questions are answered from the events rather than from the
 * status, because a proposal can be settled in more than one way. An approval that is *denied*
 * produces no `action_started` and no `action_result` at all — the loop simply takes another turn,
 * whose first act is a screenshot. So a proposal is outstanding until an action, a frame, or the
 * end of the run happens after it, and any of those three is enough to take the strip down.
 */
export function digest(events: PersistedEvent[]): Digest {
  const shots = new Map<number, string>()
  const addressAt = new Map<number, string>()
  const findings: Finding[] = []
  let latestShot: Digest["latestShot"] = null
  let budget: Digest["budget"] = null
  let done: Digest["done"] = null
  let approval: Digest["approval"] = null
  let question: string | null = null
  let address = ""

  for (const { event } of events) {
    switch (event.type) {
      case "screenshot":
        // The frame's own account of where it was taken wins over anything inferred from prose,
        // and stands as the last known address for the steps after it.
        if (event.pageUrl !== undefined && event.pageUrl !== "") address = event.pageUrl
        shots.set(event.step, event.url)
        addressAt.set(event.step, address)
        latestShot = { step: event.step, url: event.url }
        // A new turn has begun: nothing proposed before it is still waiting on this human.
        approval = null
        break
      case "finding":
        findings.push({ data: event.data, step: event.step })
        break
      case "budget":
        budget = event
        break
      case "done":
        done = { outcome: event.outcome, summary: event.summary }
        approval = null
        question = null
        break
      case "action_proposed":
        approval = { tool: event.tool, args: event.args }
        break
      case "action_started":
        approval = null
        if (event.tool === "navigate" && typeof event.args.url === "string") address = event.args.url
        break
      case "action_result": {
        approval = null
        const said = event.ok ? ADDRESS_SAID.exec(event.summary) : null
        if (said) address = said[1]
        break
      }
      case "ask_human":
        question = event.question
        break
      case "human_answer":
        question = null
        break
      case "run_status":
        // A run that ended without saying goodbye still takes its strips down with it.
        if (isTerminal(event.status)) {
          approval = null
          question = null
        }
        break
      default:
        break
    }
  }

  return { shots, latestShot, addressAt, findings, budget, done, approval, question }
}
