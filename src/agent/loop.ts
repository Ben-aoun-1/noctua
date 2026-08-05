import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "playwright"
import { createBrowserPage, type BrowserPage } from "../browser/session.js"
import { capture, snapshotText } from "../browser/snapshot.js"
import { config } from "../config.js"
import type { AgentEvent, RunStatus } from "../events/types.js"
import { STOPPED_ANSWER, SUPERSEDED_ANSWER, TIMED_OUT_ANSWER } from "../runs/control.js"
import { persistRun, type Run } from "../runs/store.js"
import { assertSafeUrl } from "../safety/urlGuard.js"
import { History } from "./history.js"
import type { LLM } from "./llm.js"
import { buildSystemPrompt } from "./prompts.js"
import { executeTool, isGuarded, toolDefs, type ToolOutcome } from "./tools.js"

/**
 * The observe → think → act loop: the only thing in Noctua that decides anything.
 *
 * Every turn it captures the page, hands the model that observation plus its own pruned history,
 * and runs the single tool that comes back — gating the ones a human must approve first, feeding
 * failures back as observations rather than ending the run, and stopping when the model calls
 * `finish`, when a budget runs out, when the human stops it, or when it visibly stops making
 * progress.
 *
 * Three properties hold on every path out of here, because the UI and the report are built from
 * the event log alone:
 *
 * - exactly one `done` event, always followed by a terminal `run_status`;
 * - `run.status` and `meta.json` agree with that event, so a restart lists the run as it ended;
 * - the loop is the *only* writer to the run's event log — nothing appends from a subscriber.
 *
 * It does not throw. A failure anywhere becomes `error` + `done(failed)`, because the caller is a
 * fire-and-forget HTTP route with nowhere to put an exception.
 */

/** Turns with no page change and no new finding before the model is told it looks stuck. */
const STUCK_TURNS = 4
/**
 * How many recent page changes the going-in-circles check looks back over.
 *
 * Three visits to a page in a cycle of `k` pages take `2k + 1` changes to happen, so nine is what
 * it costs to see a four-page circuit — and the live run that prompted all this went round three
 * pages, which a window of six can never catch.
 */
const URL_WINDOW = 9
/** Visits to one page inside that window before the model is told it is going in circles. */
const OSCILLATION_VISITS = 3
/** Consecutive turns with no tool call before the run is given up on. */
const MAX_NO_TOOL_TURNS = 3
/** The inert page: the tab starts here, and it is where a blocked page is swapped for. */
const BLANK = "about:blank"

const NO_TOOL_RESULT = "No tool was called. Continue with exactly one tool call, or call finish."
const DENIED_RESULT = "The user DENIED this action. Choose a different approach."
/** A denial nobody typed: the model is told the difference, because the fix is a different one. */
const UNATTENDED_RESULT =
  "Nobody was available to approve this action, so it was NOT run. Take an approach that needs " +
  "no approval, or call finish with what you have."
const SUPERSEDED_RESULT = "(the question was superseded — continue)"
/** What the transcript shows for a question nobody answered; it takes the whisper box down too. */
const TIMED_OUT_ANSWER_TEXT = "(no answer — timed out)"
const STUCK_NOTE =
  `You appear stuck (no page change or new findings for ${STUCK_TURNS} turns). ` +
  "Reconsider your approach or ask_human."
/** Going in circles is not being stuck: the page keeps changing, and nothing is gained by it. */
const oscillationNote = (visits: number): string =>
  `You have returned to this page ${visits} times without recording anything new — either ` +
  "record what you have or move on."
/** Quoted verbatim in the system prompt, so the model has been told what this line means. */
const BUDGET_NOTE = "BUDGET EXHAUSTED — you MUST call finish now with what you have."
const REDIRECT_NOTE =
  "The previous page redirected somewhere disallowed and was closed — you are back on a " +
  "blank tab. Do not go there again."
const REFUSAL_MESSAGE = "The model declined this task for safety reasons."
const approvalTimeoutMessage = (ms: number): string =>
  `No approval decision after ${waitLabel(ms)} — treating this action as denied.`
const questionTimeoutMessage = (ms: number): string =>
  `No answer after ${waitLabel(ms)} — the agent was told to carry on without one.`
/** How much of a step summary survives into the condensed history. */
const MAX_SUMMARY_LINE_CHARS = 90

type DoneOutcome = Extract<AgentEvent, { type: "done" }>["outcome"]

export interface LoopOpts {
  /** Stores one step's screenshot and returns the URL the UI loads it from. */
  saveShot?: (buf: Buffer, step: number) => string
  /**
   * URL safety gate, defaulting to `assertSafeUrl`. Production callers omit it; tests inject a
   * checker that allows their loopback fixture origin. It is used both for the capture-time
   * re-check below and by every tool that navigates, so a run has exactly one policy.
   */
  checkUrl?: (url: string) => Promise<void>
  /**
   * The subresource half of that policy: whether a request the *page* makes may go out, defaulting
   * to `allowPublicRequest`. Injected by tests for the same reason `checkUrl` is — their fixture
   * site is served from an address the real policy refuses.
   */
  allowRequest?: (url: string) => boolean
  /**
   * How long to wait for an approval decision or an answer before giving up on the human,
   * defaulting to `config.waitMinutes`. Tests pass milliseconds so the abandoned-gate paths run in
   * the time an assertion can afford.
   */
  waitMs?: number
}

export async function runAgent(run: Run, llm: LLM, opts: LoopOpts = {}): Promise<void> {
  const { log, control } = run
  const emit = (e: AgentEvent): void => {
    log.append(e)
  }
  // meta.json is a convenience for the history list and the daily cap; a failed write must never
  // be the thing that ends a run that is otherwise going fine.
  const persist = (): void => {
    try {
      persistRun(run)
    } catch {
      // ignored on purpose
    }
  }
  const setStatus = (status: RunStatus): void => {
    run.status = status
    persist()
    emit({ type: "run_status", status })
  }
  // A run ends once. If the write of the status line that follows a `done` fails, the outer catch
  // takes over with the run already over — and a second `done` would leave the UI, and the report
  // that is built by replaying this log, with two endings.
  let ended = false
  const endRun = (outcome: DoneOutcome, summary: string, status: RunStatus): void => {
    if (ended) return
    ended = true
    emit({ type: "done", outcome, summary })
    setStatus(status)
  }
  const saveShot = opts.saveShot ?? defaultSaveShot(run)
  const checkUrl = opts.checkUrl ?? assertSafeUrl
  const waitMs = opts.waitMs ?? config.waitMinutes * 60_000

  setStatus("running")

  let bp: BrowserPage | null = null
  // The run's own array, so a stop or a crash still leaves the report whatever was confirmed.
  const findings = run.findings
  const history = new History()
  const system = buildSystemPrompt(run.preset)
  const startedAt = Date.now()
  let steps = 0
  let lastUrl = ""
  let lastFindingCount = 0
  let stuckTurns = 0
  /** The last {@link URL_WINDOW} page changes, each with the finding count at the time. */
  let visits: { url: string; findingsThen: number }[] = []
  let noToolTurns = 0
  let budgetWarned = false

  try {
    bp = await createBrowserPage({ allowRequest: opts.allowRequest })
    const page = bp.page

    /**
     * The `ask_human` tool's side of the conversation. The resolver is registered *before* the
     * event goes out, because `RunControl` drops an answer that arrives before anything is
     * waiting for it — and the answer can arrive synchronously, from a subscriber.
     *
     * Nobody is obliged to come back. An unanswered question is settled by the clock with an
     * answer that says so, because a run parked here holds a concurrency slot for ever otherwise.
     */
    const askHuman = async (question: string): Promise<string> => {
      const answered = control.askHuman()
      emit({ type: "ask_human", question })
      setStatus("awaiting_human")
      const { value: answer, timedOut } = await waitOrTimeout(answered, waitMs, () => {
        control.answerHuman(TIMED_OUT_ANSWER)
      })
      // A stop settles the question with this sentinel. Leave the status alone and let the top of
      // the loop end the run: the model will never read the tool result this turn produces.
      if (answer === STOPPED_ANSWER) return STOPPED_ANSWER
      setStatus("running")
      if (answer === SUPERSEDED_ANSWER) return SUPERSEDED_RESULT
      if (timedOut) {
        emit({ type: "error", message: questionTimeoutMessage(waitMs), recoverable: true })
        // The cockpit mounts its whisper box on `ask_human` and takes it down on `human_answer`,
        // so a question closed by the clock has to be closed here too — otherwise the UI goes on
        // soliciting an answer that nothing is waiting for, and posts it into the void. The text
        // says who closed it: the transcript is a record, not a ventriloquist act.
        emit({ type: "human_answer", text: TIMED_OUT_ANSWER_TEXT })
        return TIMED_OUT_ANSWER
      }
      emit({ type: "human_answer", text: answer })
      return answer
    }

    while (true) {
      if (control.isStopped()) {
        endRun("stopped", partialSummary(findings), "stopped")
        return
      }
      if (control.isPaused()) {
        setStatus("paused")
        await control.waitWhilePaused()
        // A stop is the other thing that releases a pause. Go back to the check above rather than
        // walk into a capture and a paid model turn for a run that is already over.
        if (control.isStopped()) continue
        setStatus("running")
      }

      steps++
      const wallMinutes = (Date.now() - startedAt) / 60_000
      const over =
        steps > config.maxSteps ||
        run.costUsd > config.maxRunCostUsd ||
        wallMinutes > config.maxWallMinutes
      // The model gets exactly one turn to finish after the warning; this is the turn after that.
      if (over && budgetWarned) {
        endRun("partial", `Budget exhausted. ${partialSummary(findings)}`, "finished")
        return
      }

      const blanked = await blankIfUnsafe(page, checkUrl, emit)
      const snap = await capture(page)
      emit({
        type: "screenshot",
        url: saveShot(snap.screenshotJpeg, steps),
        step: steps,
        // The frame and the address it was taken on travel together, because nothing else in the
        // log states one: a click that moves the page names no URL anywhere, so a UI reading the
        // address out of tool prose shows the last one a *navigate* mentioned for ever after.
        pageUrl: snap.url,
      })

      // "Same page, nothing new to show for it" is what being stuck looks like from out here.
      if (snap.url === lastUrl && findings.length === lastFindingCount) stuckTurns++
      else stuckTurns = 0

      // A→B→A→B→A is progress to the check above — the page keeps changing — and waste to
      // everyone else: a fact read and not written down is gone the moment the tab moves on, so
      // the agent goes back for it, and back again. Only page *changes* enter the window, which
      // leaves a run sitting on one page to the stuck check alone.
      if (snap.url !== lastUrl) {
        visits.push({ url: snap.url, findingsThen: findings.length })
        visits = visits.slice(-URL_WINDOW)
      }
      const seen = visits.filter((v) => v.url === snap.url)
      // Nothing banked since the first of those visits: the trips round the loop bought nothing.
      const circling =
        seen.length >= OSCILLATION_VISITS && seen[0]!.findingsThen === findings.length

      lastUrl = snap.url
      lastFindingCount = findings.length

      // Drained before the observation is built, so a note typed while the last turn was running
      // reaches the model on this one rather than the next.
      const steers = control.drainSteer()
      for (const text of steers) emit({ type: "steer", text })

      const notes: string[] = []
      if (blanked) notes.push(REDIRECT_NOTE)
      for (const text of steers) notes.push(`USER STEERING: ${text}`)
      if (stuckTurns >= STUCK_TURNS) notes.push(STUCK_NOTE)
      if (circling) notes.push(oscillationNote(seen.length))
      if (over) {
        notes.push(BUDGET_NOTE)
        budgetWarned = true
      }

      // The task leads every single turn: the model reads far more observation than system
      // prompt, and a long run drifts off task when the task itself scrolls out of view.
      const observation = [
        `TASK: ${run.goal}`,
        `Step ${steps} of ${config.maxSteps}.`,
        snapshotText(snap),
        `Findings so far: ${findings.length}`,
        ...notes,
      ].join("\n\n")

      const result = await llm.turn(
        {
          system,
          messages: history.toMessages({ text: observation, screenshotJpeg: snap.screenshotJpeg }),
          tools: toolDefs,
        },
        // An empty delta renders as nothing in the mind pane; it is only noise in the log.
        (text) => {
          if (text !== "") emit({ type: "thinking_delta", text })
        },
      )
      run.costUsd += result.costUsd
      persist()
      emit({
        type: "budget",
        steps,
        maxSteps: config.maxSteps,
        costUsd: round2(run.costUsd),
        maxCostUsd: config.maxRunCostUsd,
      })

      if (result.toolName === null) {
        // A refusal is not narration: the model has decided, and asking it again next turn would
        // only spend the budget arriving at the same answer.
        if (result.stopReason === "refusal") {
          emit({ type: "error", message: REFUSAL_MESSAGE, recoverable: false })
          const summary = `The model declined for safety reasons. ${partialSummary(findings)}`
          endRun("failed", summary, "failed")
          return
        }
        noToolTurns++
        // A turn that hit the token ceiling is worth remembering as that, not as the model
        // dithering — the fix is a shorter turn, and the condensed block is where it will read it.
        const cutOff = result.stopReason === "max_tokens" ? ", cut off at the token limit" : ""
        history.addTurn({
          assistantContent: result.assistantContent,
          toolUseId: null,
          toolResultText: NO_TOOL_RESULT,
          summaryLine: `step ${steps}: (narration only${cutOff})`,
        })
        if (noToolTurns >= MAX_NO_TOOL_TURNS) {
          endRun("partial", `Agent stalled. ${partialSummary(findings)}`, "failed")
          return
        }
        continue
      }
      noToolTurns = 0

      const guarded = isGuarded(result.toolName, result.toolInput)
      if (control.mode === "approve" || guarded) {
        // Same registration order as `askHuman`, for the same reason: the decision can land
        // synchronously, inside the append of the event that announces the proposal.
        const decided = control.requestApproval()
        emit({ type: "action_proposed", tool: result.toolName, args: result.toolInput, guarded })
        setStatus("awaiting_approval")
        // An abandoned proposal is denied by the clock: the safe reading of silence is "no", and a
        // run that waits here for ever is a demo link with one fewer slot until a restart.
        const { value: decision, timedOut } = await waitOrTimeout(decided, waitMs, () => {
          control.resolveApproval("denied")
        })
        setStatus("running")
        if (timedOut) {
          emit({ type: "error", message: approvalTimeoutMessage(waitMs), recoverable: true })
        }
        if (decision === "denied") {
          const denial = timedOut ? "timed out unapproved" : "denied by user"
          history.addTurn({
            assistantContent: result.assistantContent,
            toolUseId: result.toolUseId,
            toolResultText: timedOut ? UNATTENDED_RESULT : DENIED_RESULT,
            summaryLine: `step ${steps}: ${result.toolName} ${denial}`,
          })
          continue
        }
      }

      emit({ type: "action_started", tool: result.toolName, args: result.toolInput })
      let outcome: ToolOutcome
      try {
        outcome = await executeTool(result.toolName, result.toolInput, {
          page,
          findings,
          askHuman,
          checkUrl,
        })
      } catch (err) {
        // A failed step costs a turn, not the run: the model is told what went wrong and picks a
        // different approach, exactly as it would after reading an error on the page.
        const message = errorMessage(err)
        emit({ type: "action_result", tool: result.toolName, ok: false, summary: message })
        emit({ type: "error", message, recoverable: true })
        history.addTurn({
          assistantContent: result.assistantContent,
          toolUseId: result.toolUseId,
          toolResultText: `ERROR: ${message}. Try a different approach.`,
          summaryLine: `step ${steps}: ${result.toolName} failed`,
        })
        continue
      }

      // The step number is what pairs a finding with the screenshot it was read from — the
      // receipt an accountant needs to trust the row.
      if (result.toolName === "record_finding") {
        emit({
          type: "finding",
          data: result.toolInput.data as Record<string, unknown>,
          step: steps,
        })
      }
      emit({ type: "action_result", tool: result.toolName, ok: true, summary: outcome.summary })
      history.addTurn({
        assistantContent: result.assistantContent,
        toolUseId: result.toolUseId,
        toolResultText: outcome.summary,
        summaryLine: `step ${steps}: ${outcome.summary.slice(0, MAX_SUMMARY_LINE_CHARS)}`,
      })
      if (outcome.finish) {
        endRun(outcome.finish.outcome, outcome.finish.summary, "finished")
        return
      }
    }
  } catch (err) {
    const message = errorMessage(err)
    // Reporting a failure must not be able to fail: when the event log is what broke, there is
    // nowhere left to say so, and the caller is a fire-and-forget route with nowhere to put an
    // exception. Two guards rather than one, so a dead `error` write still lets `endRun` mark the
    // run terminal in memory and on disk.
    try {
      emit({ type: "error", message, recoverable: false })
    } catch {
      // ignored on purpose
    }
    try {
      endRun("failed", `Unrecoverable error: ${message}. ${partialSummary(findings)}`, "failed")
    } catch {
      // ignored on purpose
    }
  } finally {
    await bp?.close().catch(() => undefined)
  }
}

/**
 * Awaits a gate the human may simply never come back to.
 *
 * `settle` is the control's own resolver rather than a second promise, so the timeout resolves the
 * very promise being awaited and leaves nothing registered behind: a decision typed a minute later
 * finds no waiter instead of resolving something a second time. The timer is cleared on the way
 * out either way, so an answered gate leaves no timer to fire over a later one.
 */
async function waitOrTimeout<T>(
  pending: Promise<T>,
  ms: number,
  settle: () => void,
): Promise<{ value: T; timedOut: boolean }> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    settle()
  }, ms)
  try {
    return { value: await pending, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** The wait limit as a human reads it: minutes in production, milliseconds under a test. */
function waitLabel(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`
}

/**
 * Re-checks the address the tab is actually on, before anything reads it.
 *
 * The tools check right after they act, which a redirect scheduled for later slips past: the tool
 * returns on a permitted page and the timer fires afterwards. This is the check that sees where
 * the tab ended up. On a violation the page is blanked *before* the screenshot is taken, so no
 * part of the blocked page reaches the model, the event log or the run directory — and if the tab
 * cannot be blanked, the run fails rather than photographing it anyway.
 */
async function blankIfUnsafe(
  page: Page,
  checkUrl: (url: string) => Promise<void>,
  emit: (e: AgentEvent) => void,
): Promise<boolean> {
  const url = page.url()
  // A blank tab is inert, and is where this function's own recovery leaves the page.
  if (url === BLANK) return false
  try {
    await checkUrl(url)
    return false
  } catch (err) {
    const reason = errorMessage(err)
    await page.goto(BLANK).catch(() => undefined)
    if (page.url() !== BLANK) {
      throw new Error(`${reason}; the tab could not be cleared`, { cause: err })
    }
    const message = `${reason}; the tab was returned to ${BLANK}`
    emit({ type: "error", message, recoverable: true })
    return true
  }
}

/** Where a step's screenshot goes when the caller has no opinion: the run's own `shots/` dir. */
function defaultSaveShot(run: Run): (buf: Buffer, step: number) => string {
  return (buf, step) => {
    writeFileSync(join(run.log.dir, "shots", `${step}.jpg`), buf)
    return `/api/runs/${run.id}/shots/${step}.jpg`
  }
}

/** What is left to say when a run ends early: the work already banked is the whole point. */
function partialSummary(findings: Record<string, unknown>[]): string {
  return `${findings.length} finding(s) were preserved.`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Dollars, to the cent — the budget event is read by a human, not by the meter. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}
