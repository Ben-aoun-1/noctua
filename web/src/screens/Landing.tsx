import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  ApiError,
  auth,
  createRun,
  listRuns,
  type Preset,
  type RunStatus,
  type RunSummary,
} from "../api.ts"
import OwlMark from "../components/OwlMark.tsx"

/**
 * The first screen: what Noctua is, three ways to give it a chore, and everything it has flown so
 * far.
 *
 * The access gate is a *hint*, not a security boundary — the cookie the server sets is the only
 * thing that actually opens the API, and the localStorage flag exists solely so a returning
 * operator is not asked for the code again on every visit. That makes the two capable of
 * disagreeing (a month-old cookie expires while the flag stays), so any call that comes back 401
 * clears the flag and puts the gate back up. The flag is never trusted on its own: the first thing
 * an "authenticated" page does is ask the server for the run list, which is what proves it.
 */

const AUTH_FLAG = "noctua.authed"

/**
 * A goal still carrying `[...]` from its template is not ready to fly.
 *
 * Only the templated cards are held to it. Card 03 was never given brackets to replace, so there
 * brackets are just punctuation an operator meant to write ("check the [Q3] column") and holding
 * the launch button hostage to them would be a guard against nothing.
 */
const PLACEHOLDER = /\[[^\]]*\]/

/** The server rejects anything longer; better to stop the keystroke than to explain a 400. */
const MAX_GOAL_CHARS = 2000

interface PresetCard {
  numeral: string
  /** Rendered as a micro-label, which is why it is written in caps. */
  title: string
  blurb: string
  template: string
  preset: Preset
}

/**
 * The two showcase chores and the open door. A preset primes the report schema the agent writes
 * into — navigation stays fully agentic either way — and the templates are written to be edited:
 * everything in brackets is the operator's to replace.
 */
const CARDS: PresetCard[] = [
  {
    numeral: "01",
    title: "VENDOR DUE DILIGENCE",
    blurb: "VAT numbers checked, registries read, a sourced vendor-master table returned.",
    template:
      "Verify these vendors and build a vendor-master table: [vendor names + VAT/registration numbers]",
    preset: "vendor",
  },
  {
    numeral: "02",
    title: "COMPLIANCE BRIEF",
    blurb: "Registration steps, filing deadlines and rates — from official sources only.",
    template:
      "Client is opening [entity type] in [jurisdiction] — compile registration steps, filing deadlines, and rates from official sources.",
    preset: "compliance",
  },
  {
    numeral: "03",
    title: "ANYTHING ELSE",
    blurb: "Any chore that lives in a browser. Say it the way you would say it to a junior.",
    template: "",
    preset: null,
  },
]

/** How a run's state reads at a glance: settled, waiting on a human, lost, or still in the air. */
const STATUS_DOT: Record<RunStatus, string> = {
  finished: "bg-sage",
  awaiting_approval: "bg-bronze",
  awaiting_human: "bg-bronze",
  paused: "bg-bronze",
  failed: "bg-oxide",
  stopped: "bg-ink/30",
  running: "bg-ink animate-pulse",
  pending: "bg-ink animate-pulse",
}

/** Day-month-year on a 24-hour clock: the way a ledger dates things, unambiguous everywhere. */
const WHEN = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

export default function Landing() {
  const [authed, setAuthed] = useState(readAuthFlag)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runsError, setRunsError] = useState<string | null>(null)

  /** The cookie is gone or was never good: forget the hint and ask for the code again. */
  const lockOut = useCallback((): void => {
    writeAuthFlag(false)
    setAuthed(false)
    setRuns([])
    setRunsLoaded(false)
    setRunsError(null)
  }, [])

  // Also the proof that the flag was telling the truth — a 401 here is what re-shows the gate.
  useEffect(() => {
    if (!authed) return
    let cancelled = false
    listRuns().then(
      (list) => {
        if (cancelled) return
        setRuns(list)
        setRunsLoaded(true)
      },
      (err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          lockOut()
          return
        }
        setRunsError(messageOf(err))
        setRunsLoaded(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [authed, lockOut])

  return (
    <main className="mx-auto w-full max-w-[1080px] px-6 py-14 sm:px-10 sm:py-20">
      <header>
        <OwlMark size={40} />
        <p className="microlabel mt-6">MINERVA · TAKE-HOME BUILD BY MOHAMED BEN AOUN</p>
        <h1 className="serif mt-4 text-[34px] leading-[1.06] sm:text-[44px] lg:text-[56px]">
          Give Noctua a chore.
          <br />
          Watch it fly.
        </h1>
        <p className="mt-5 max-w-[54ch] text-[15px] leading-[1.6] text-ink/60">
          An accounting-grade browser agent. It reads, clicks, verifies, and reports — while you
          watch every thought.
        </p>
      </header>

      <hr className="hairline my-10 border-t sm:my-14" />

      {authed ? (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            {CARDS.map((card) => (
              <PresetPanel key={card.numeral} card={card} onExpired={lockOut} />
            ))}
          </section>

          <section className="mt-16 sm:mt-20">
            <p className="microlabel">PREVIOUS FLIGHTS</p>
            {runsError !== null && <p className="mt-3 text-[13px] text-oxide">{runsError}</p>}
            {/* A failed read knows nothing about the log, so it claims nothing: the error stands
                alone, with no "No flights yet." under it contradicting the sentence above. */}
            <div className="mt-4">
              {runs.length > 0
                ? runs.map((run) => <FlightRow key={run.id} run={run} />)
                : runsError === null && (
                    <p className="hairline border-t py-4 text-[13px] text-ink/45">
                      {runsLoaded ? "No flights yet." : "Reading the log…"}
                    </p>
                  )}
            </div>
          </section>
        </>
      ) : (
        <Gate onEntered={() => setAuthed(true)} />
      )}

      <footer className="hairline mt-20 border-t pt-6 sm:mt-24">
        <p className="microlabel">NOCTUA — THE OWL OF MINERVA · BUILT WITH CLAUDE</p>
      </footer>
    </main>
  )
}

/** Until the code is right, this is the whole page below the masthead. */
function Gate({ onEntered }: { onEntered: () => void }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const given = code.trim()
    if (busy || given === "") return
    setBusy(true)
    setError(null)
    try {
      await auth(given)
      writeAuthFlag(true)
      // Unmounts this component; nothing below may touch its state afterwards.
      onEntered()
      return
    } catch (err) {
      setError(messageOf(err))
    }
    setBusy(false)
  }

  return (
    <section className="mx-auto flex max-w-[440px] flex-col items-center py-8 text-center sm:py-14">
      <p className="microlabel">ACCESS CODE</p>
      <form onSubmit={submit} className="mt-4 flex w-full flex-col gap-3 sm:flex-row">
        <input
          className="mono hairline min-w-0 flex-1 rounded-[4px] border bg-transparent px-3 py-3 text-[13px] tracking-[0.08em] outline-none placeholder:text-ink/30 focus:border-ink/40"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          type="password"
          autoComplete="current-password"
          autoFocus
          spellCheck={false}
          aria-label="Access code"
          placeholder="the code that came with the link"
        />
        <button className="btn-ink shrink-0" type="submit" disabled={busy || code.trim() === ""}>
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
      {error !== null && <p className="mt-3 text-[13px] text-oxide">{error}</p>}
      <p className="microlabel mt-6">ONE CODE, SHARED WITH THE SUBMISSION LINK</p>
    </section>
  )
}

/** One chore, ready to edit and fly. */
function PresetPanel({ card, onExpired }: { card: PresetCard; onExpired: () => void }) {
  const [goal, setGoal] = useState(card.template)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const text = goal.trim()
  const unfilled = card.template !== "" && PLACEHOLDER.test(text)
  const ready = text.length > 0 && !unfilled

  async function launch(): Promise<void> {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await createRun(text, card.preset)
      window.location.hash = `#/run/${id}`
      return
    } catch (err) {
      // A run refused because the cookie died is not a card-level problem — the page is stale.
      if (err instanceof ApiError && err.status === 401) {
        onExpired()
        return
      }
      setError(messageOf(err))
    }
    setBusy(false)
  }

  return (
    <article className="relative flex flex-col overflow-hidden rounded-[4px] bg-sand p-6">
      {/* Their "01 TALK / 02 DILIGENCE" numerals, ghosted back into the panel. */}
      <span
        aria-hidden
        className="serif pointer-events-none absolute top-1 right-4 text-[76px] leading-none text-ink/10 select-none md:text-[104px]"
      >
        {card.numeral}
      </span>

      {/* Kept clear of the numeral's column so the two never read as one muddled block. */}
      <p className="microlabel relative pr-16">{card.title}</p>
      <p className="relative mt-3 pr-16 text-[13px] leading-[1.6] text-ink/60">{card.blurb}</p>

      <textarea
        className="mono hairline relative mt-5 min-h-[136px] grow resize-none rounded-[4px] border bg-transparent p-3 text-[13px] leading-[1.55] outline-none placeholder:text-ink/30 focus:border-ink/30"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        maxLength={MAX_GOAL_CHARS}
        spellCheck={false}
        aria-label={`Goal for ${card.title.toLowerCase()}`}
        placeholder="Describe the chore in plain English."
      />

      <button className="btn-ink relative mt-4 w-full" onClick={launch} disabled={!ready || busy}>
        {busy ? "Launching…" : "Run with Noctua →"}
      </button>

      {/* Always rendered, so a hint on one card cannot lift its button out of line with the rest. */}
      <p className="microlabel relative mt-2 min-h-4">
        {unfilled ? "REPLACE THE [BRACKETS] TO LAUNCH" : ""}
      </p>
      {error !== null && <p className="relative text-[13px] leading-[1.5] text-oxide">{error}</p>}
    </article>
  )
}

/**
 * One line of history, and the way into a run's cockpit.
 *
 * The row wraps on a narrow screen rather than dropping a column: the goal takes the first line and
 * the date and the cost fall to the second, so nothing an operator came to read is hidden at 375px.
 */
function FlightRow({ run }: { run: RunSummary }) {
  return (
    <button
      className="hairline flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-t py-3 text-left last:border-b hover:bg-cream"
      onClick={() => (window.location.hash = `#/run/${run.id}`)}
      title={run.goal}
    >
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[run.status]}`} />
      <span className="sr-only">{run.status.replace("_", " ")}</span>
      <span className="mono max-w-[80ch] min-w-0 grow basis-[calc(100%_-_1.5rem)] truncate text-[13px] sm:basis-0">
        {run.goal}
      </span>
      <span className="mono ml-6 text-[12px] text-ink/45 sm:ml-0">{WHEN.format(run.createdAt)}</span>
      <span className="mono ml-auto w-[68px] shrink-0 text-right text-[13px] text-ink/70">
        ${run.costUsd.toFixed(2)}
      </span>
    </button>
  )
}

function readAuthFlag(): boolean {
  try {
    return window.localStorage.getItem(AUTH_FLAG) === "1"
  } catch {
    // Storage can be denied outright (private mode, blocked cookies); a code prompt is the cost.
    return false
  }
}

function writeAuthFlag(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(AUTH_FLAG, "1")
    else window.localStorage.removeItem(AUTH_FLAG)
  } catch {
    // ignored on purpose — the flag is a convenience, never the authority
  }
}

/** The server's sentence where there is one; whatever the network said where there is not. */
function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message
  return "the server could not be reached"
}
