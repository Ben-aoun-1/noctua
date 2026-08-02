import type Anthropic from "@anthropic-ai/sdk"
import type { Frame, Locator, Page, Request } from "playwright"
import { assertSafeUrl } from "../safety/urlGuard.js"

export type FinishOutcome = "success" | "partial" | "failed"

export interface ToolCtx {
  page: Page
  /** Every `record_finding` row, in the order the model recorded them. */
  findings: Record<string, unknown>[]
  askHuman: (question: string) => Promise<string>
  /**
   * URL safety gate, defaulting to `assertSafeUrl`. Production callers omit it. Tests inject a
   * checker that allows their loopback fixture origin — which the real guard blocks by design —
   * and delegate every other URL back to `assertSafeUrl`.
   */
  checkUrl?: (url: string) => Promise<void>
}

export interface ToolOutcome {
  /** One line for the event log and for the model's next observation. */
  summary: string
  /** Present only for `finish`; the loop stops when it sees this. */
  finish?: { outcome: FinishOutcome; summary: string }
}

/** A goto is a whole page load; a click is one already-rendered element. */
const NAVIGATE_TIMEOUT_MS = 20_000
const BACK_TIMEOUT_MS = 15_000
const ACTION_TIMEOUT_MS = 10_000
/**
 * How long a navigation that has *started* is given to land. Waiting is the point: returning
 * mid-navigation would have the caller screenshot a half-torn-down page, or lose its execution
 * context entirely part-way through a snapshot.
 */
const SETTLE_TIMEOUT_MS = 5_000
/**
 * How long after an action we watch for a navigation to *start*. Playwright cannot know in advance
 * whether a click or an Enter submits, and most clicks navigate nowhere — so only actions visibly
 * going somewhere within this window pay the settle above; the rest return at once. Browsers
 * dispatch the navigation request within a frame or two of the click, so this is generous.
 */
const NAV_GRACE_MS = 600
/** Reading an element's own text should be instant — it was located a moment ago. */
const LABEL_TIMEOUT_MS = 2_000
/** Roughly one viewport-ish nudge: enough to reveal new content, small enough not to skip past it. */
const SCROLL_PIXELS = 600
/** Long enough for a wheel event to be applied; spent in full only when the page cannot move. */
const SCROLL_SETTLE_MS = 1_000
const MIN_WAIT_SECONDS = 1
const MAX_WAIT_SECONDS = 10
/** Summaries are log lines, not transcripts — long labels and answers get cut. */
const MAX_LABEL_CHARS = 40
const MAX_ANSWER_CHARS = 120

const FINISH_OUTCOMES: readonly FinishOutcome[] = ["success", "partial", "failed"]

/**
 * The model-facing toolset. Descriptions are written for the model, not for us: they are the
 * only place it learns when a tool applies, so vagueness here shows up as wasted steps.
 */
export const toolDefs: Anthropic.Tool[] = [
  {
    name: "navigate",
    description:
      "Load a URL in the browser tab. Use it to start a task or to jump straight to a page you already know the address of. Private, local and non-http(s) addresses are refused.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to open, including the scheme." },
      },
    },
  },
  {
    name: "click",
    description:
      "Click one numbered element from the current page listing. Refs come from the latest page listing only — after the page changes, use the new numbers.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "why"],
      properties: {
        ref: { type: "integer", description: "The [n] number of the element to click." },
        why: { type: "string", description: "One short clause on why this element." },
      },
    },
  },
  {
    name: "type",
    description:
      "Type text into one numbered input from the current page listing, replacing whatever is already in it. Set submit to press Enter afterwards, which usually submits the form.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "text", "why"],
      properties: {
        ref: { type: "integer", description: "The [n] number of the input to type into." },
        text: { type: "string", description: "The exact text to put in the field." },
        submit: {
          type: "boolean",
          description: "Press Enter after typing to submit the form. Defaults to false.",
        },
        why: { type: "string", description: "One short clause on why this input and this text." },
      },
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page by about one screen. Use it when the listing mentions content you cannot see in the screenshot, or to reach a page's footer.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["direction"],
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Which way to scroll: down for later content, up for earlier content.",
        },
      },
    },
  },
  {
    name: "go_back",
    description:
      "Return to the previous page in this tab's history. Use it after following a link that turned out to be a dead end.",
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "wait",
    description:
      "Pause before looking at the page again. Use it only when the page is visibly still loading or updating; it does not make a stuck page work.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["seconds", "reason"],
      properties: {
        seconds: {
          type: "integer",
          minimum: MIN_WAIT_SECONDS,
          maximum: MAX_WAIT_SECONDS,
          description: "How long to wait, from 1 to 10 seconds. Longer values are clamped to 10.",
        },
        reason: { type: "string", description: "One short clause on what you are waiting for." },
      },
    },
  },
  {
    name: "record_finding",
    description:
      "Save one fact or one result row you have confirmed on the page. Call it once per row or fact, as soon as you read it, rather than saving everything at the end.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["data"],
      properties: {
        data: {
          type: "object",
          description:
            "The finding as a flat JSON object of your own field names, e.g. {\"company\": \"Glowbar Ltd\", \"status\": \"active\"}.",
        },
      },
    },
  },
  {
    name: "ask_human",
    description:
      "Ask the person watching this run a question and wait for their reply. Use it when you genuinely cannot proceed — an ambiguous choice, a missing credential — not to confirm ordinary steps.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: {
          type: "string",
          description: "One specific question, with the options if there are any.",
        },
      },
    },
  },
  {
    name: "finish",
    description:
      "End the run. Call it once the task is done, or once you are certain you cannot make further progress.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "summary"],
      properties: {
        outcome: {
          type: "string",
          enum: ["success", "partial", "failed"],
          description:
            "success if the whole task is done, partial if some of it is, failed if none of it is.",
        },
        summary: {
          type: "string",
          description: "A few sentences on what you found, and on anything you could not do.",
        },
      },
    },
  },
]

/**
 * Whether an action needs human approval before it runs, in approve mode. Only a submitting
 * `type` qualifies here: it is the one tool that can post data to a site. The loop layers its own
 * checks on top (Task 7) — this is the tool-level floor, not the whole policy.
 */
export function isGuarded(tool: string, args: Record<string, unknown>): boolean {
  return tool === "type" && args.submit === true
}

type Executor = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolOutcome>

/**
 * Runs one tool call. Throws on a bad argument, a stale ref, a blocked URL or a Playwright
 * timeout — the loop catches those and feeds them back to the model as an observation, so a
 * failed step costs a turn rather than the run.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolOutcome> {
  // Own-property lookup only, so a name like "constructor" cannot reach Object.prototype.
  const run = Object.prototype.hasOwnProperty.call(executors, name) ? executors[name] : undefined
  if (run === undefined) throw new Error(`unknown tool: ${name}`)
  return run(args, ctx)
}

async function navigate(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const url = String(args.url ?? "")
  await checker(ctx)(url)
  await ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS })
  await assertLandedSafely(ctx)
  return { summary: `navigated to ${ctx.page.url()} (${JSON.stringify(await ctx.page.title())})` }
}

async function click(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const ref = readRef(args)
  const element = await locate(ctx.page, ref)
  // Read the label first: the click may navigate, which leaves the locator pointing at nothing.
  const label = await labelOf(element)
  await actAndSettle(ctx, () => element.click({ timeout: ACTION_TIMEOUT_MS }))
  return { summary: `clicked [${ref}]${label}` }
}

async function typeInto(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const ref = readRef(args)
  const text = String(args.text ?? "")
  const element = await locate(ctx.page, ref)
  const label = await labelOf(element)
  // `fill` replaces the existing value, so a retry never appends to a half-typed field.
  await element.fill(text, { timeout: ACTION_TIMEOUT_MS })
  const typed = `typed ${JSON.stringify(text)} into [${ref}]${label}`
  if (args.submit !== true) return { summary: typed }
  await actAndSettle(ctx, () => element.press("Enter", { timeout: ACTION_TIMEOUT_MS }))
  return { summary: `${typed} and submitted` }
}

async function scroll(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const direction = args.direction
  if (direction !== "up" && direction !== "down") {
    throw new Error(`scroll direction must be "up" or "down", got ${JSON.stringify(direction)}`)
  }
  const before = await offsetY(ctx.page)
  await ctx.page.mouse.wheel(0, direction === "down" ? SCROLL_PIXELS : -SCROLL_PIXELS)
  // A wheel event is dispatched, not applied — the page moves a frame or two later. Without this
  // the caller screenshots the page it was already looking at. The wait times out harmlessly when
  // there is nowhere left to scroll, which is exactly the case the summary below reports.
  await ctx.page
    .waitForFunction((y) => window.scrollY !== y, before, { timeout: SCROLL_SETTLE_MS })
    .catch(() => undefined)
  if ((await offsetY(ctx.page)) !== before) return { summary: `scrolled ${direction}` }
  // Saying "scrolled" when nothing moved invites the model to keep scrolling a page that has ended.
  return { summary: `already at the ${direction === "down" ? "bottom" : "top"} of the page` }
}

function offsetY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY)
}

async function goBack(_args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const before = ctx.page.url()
  await ctx.page.goBack({ waitUntil: "domcontentloaded", timeout: BACK_TIMEOUT_MS })
  await assertLandedSafely(ctx)
  const after = ctx.page.url()
  // Playwright's return value cannot answer "did we move?" — it is null both when there was no
  // history and when the step back produced no HTTP response, as going back to a blank tab does.
  if (after === before) return { summary: `no earlier page in history — still at ${after}` }
  return { summary: `went back to ${after}` }
}

async function wait(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const requested = Number(args.seconds)
  const seconds = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), MIN_WAIT_SECONDS), MAX_WAIT_SECONDS)
    : MIN_WAIT_SECONDS
  const reason = String(args.reason ?? "").trim()
  await ctx.page.waitForTimeout(seconds * 1000)
  return { summary: `waiting ${seconds}s${reason === "" ? "" : `: ${reason}`}` }
}

async function recordFinding(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const data = args.data
  // Arrays and scalars would render as garbage in the results table, so refuse them here where
  // the model still has a turn to fix the call.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`record_finding needs a JSON object in "data", got ${JSON.stringify(data)}`)
  }
  ctx.findings.push(data as Record<string, unknown>)
  return { summary: `recorded finding #${ctx.findings.length}` }
}

async function askHuman(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const answer = await ctx.askHuman(String(args.question ?? ""))
  return { summary: `human answered: ${oneLine(answer, MAX_ANSWER_CHARS)}` }
}

async function finish(args: Record<string, unknown>): Promise<ToolOutcome> {
  const outcome = args.outcome
  if (!FINISH_OUTCOMES.includes(outcome as FinishOutcome)) {
    throw new Error(
      `finish outcome must be one of ${FINISH_OUTCOMES.join(", ")}, got ${JSON.stringify(outcome)}`,
    )
  }
  const summary = String(args.summary ?? "")
  return { summary: "finished", finish: { outcome: outcome as FinishOutcome, summary } }
}

const executors: Record<string, Executor> = {
  navigate,
  click,
  type: typeInto,
  scroll,
  go_back: goBack,
  wait,
  record_finding: recordFinding,
  ask_human: askHuman,
  finish,
}

function checker(ctx: ToolCtx): (url: string) => Promise<void> {
  return ctx.checkUrl ?? assertSafeUrl
}

/**
 * Re-checks the URL the browser actually ended up on. A redirect — or a DNS rebind between the
 * guard's lookup and the browser's — can land on an address the model was never allowed to ask
 * for, so the check that matters is the one after the navigation, not before it.
 */
async function assertLandedSafely(ctx: ToolCtx): Promise<void> {
  // A blank tab is inert and is where this function's own recovery leaves the page, so checking it
  // would flag the safe state as unsafe. Going back past the first navigation lands here too.
  if (ctx.page.url() === "about:blank") return
  try {
    await checker(ctx)(ctx.page.url())
  } catch (err) {
    // Step off the blocked page before failing, so no later screenshot or snapshot renders its
    // content. Going back is preferred — it leaves the model somewhere it can carry on from — but
    // if it did not move us (no history, or it timed out), blanking the tab is the fallback that
    // must not be skipped: leaving the page loaded would hand the model exactly what was blocked.
    const blocked = ctx.page.url()
    await ctx.page
      .goBack({ waitUntil: "domcontentloaded", timeout: BACK_TIMEOUT_MS })
      .catch(() => undefined)
    if (ctx.page.url() === blocked) await ctx.page.goto("about:blank").catch(() => undefined)
    // Say where the tab ended up. The model reads this as its observation and then sees the next
    // screenshot; without it the two disagree and it re-plans from a page it is no longer on.
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${reason}; the tab was returned to ${ctx.page.url()}`, { cause: err })
  }
}

/**
 * Performs an action that may or may not navigate, waits out any navigation it triggers, and
 * re-checks the destination when one happened — a link can point at a private address just as a
 * redirect can.
 *
 * Two waits, because "will this navigate?" is only answerable after the fact: a short grace window
 * for a navigation to *start*, then the full settle for it to land. A click that goes nowhere —
 * the common case — costs the grace window and nothing more.
 */
async function actAndSettle(ctx: ToolCtx, action: () => Promise<void>): Promise<void> {
  const before = ctx.page.url()
  // Both waits are armed before the action: a fast navigation can start and even commit before the
  // action's own promise resolves.
  //
  // Landing is detected by the URL changing, which misses a navigation to the *same* URL — a form
  // posting back to itself, say. That costs the full settle and then reports no navigation; it is
  // only a latency and re-check gap, never a wrong URL, since the address was already checked when
  // the page was first opened.
  const landed = ctx.page
    .waitForURL((url) => url.href !== before, {
      waitUntil: "domcontentloaded",
      timeout: SETTLE_TIMEOUT_MS,
    })
    .then(
      () => true,
      () => false,
    )
  const start = watchForNavigationStart(ctx.page)
  try {
    await action()
    if (!(await start.startedWithin(NAV_GRACE_MS))) return
    await landed
  } finally {
    start.stop()
  }
  if (ctx.page.url() !== before) await assertLandedSafely(ctx)
}

interface NavigationStartWatch {
  /** True if a main-frame navigation began within `ms` of being asked. */
  startedWithin: (ms: number) => Promise<boolean>
  stop: () => void
}

/**
 * Watches for the first sign that the main frame is going somewhere. Two signals, because neither
 * covers the other: a document navigation shows up as a navigation request well before it commits,
 * while a History API navigation issues no request at all and only surfaces as `framenavigated`.
 */
function watchForNavigationStart(page: Page): NavigationStartWatch {
  let signal!: () => void
  const started = new Promise<void>((resolve) => {
    signal = resolve
  })
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) signal()
  }
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) signal()
  }
  page.on("request", onRequest)
  page.on("framenavigated", onNavigated)

  return {
    startedWithin: async (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          started.then(() => true),
          // Cleared in the finally, so a click that navigates never leaves this timer pending.
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), ms)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    stop: () => {
      page.off("request", onRequest)
      page.off("framenavigated", onNavigated)
    },
  }
}

/**
 * Refs are interpolated into a CSS selector, so a non-integer would be an injection point as well
 * as a mistake — reject anything else before it reaches the page.
 */
function readRef(args: Record<string, unknown>): number {
  const ref = args.ref
  if (typeof ref !== "number" || !Number.isInteger(ref)) {
    throw new Error(`ref must be a whole number, got ${JSON.stringify(ref)}`)
  }
  return ref
}

async function locate(page: Page, ref: number): Promise<Locator> {
  const element = page.locator(`[data-noctua-ref="${ref}"]`)
  // Without this the action would burn its full timeout before failing, and the model would be
  // told "timeout" when the real answer is "that number is from an older page".
  if ((await element.count()) === 0) {
    throw new Error(`stale ref [${ref}] — element not found; take a new look at the page`)
  }
  return element
}

/** The element's own text, quoted for the summary; empty for inputs, which have none. */
async function labelOf(element: Locator): Promise<string> {
  const text = await element.innerText({ timeout: LABEL_TIMEOUT_MS }).catch(() => "")
  const label = oneLine(text, MAX_LABEL_CHARS)
  return label === "" ? "" : ` ${JSON.stringify(label)}`
}

/** Collapses whitespace and clips, so one summary is always one line. */
function oneLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`
}
