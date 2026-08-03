/**
 * The three things every screen has to do to a value before it can be shown: say what went wrong in
 * the server's own words, shorten a tool call to something readable in a single line, and — for the
 * reasoning feed — write that call the way a person would say it out loud.
 */

/** Arguments are a glance, not a payload: past this a line stops being scannable. */
const MAX_ARG_CHARS = 64

/** A quoted fragment inside an action line; longer than this and the line wraps three times. */
const MAX_QUOTE_CHARS = 44

/**
 * Tool arguments that exist for the model's benefit rather than the watcher's. `why` and `reason`
 * are the model narrating its own choice — which the reasoning paragraph above it already did, at
 * length, in prose.
 */
const ASIDE_ARGS = ["why", "reason"]

/** The server's sentence where there is one; whatever the network said where there is not. */
export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message
  return "the server could not be reached"
}

/** One tool call's arguments, short enough to read at a glance and honest about being clipped. */
export function compactArgs(args: Record<string, unknown>): string {
  const shown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (!ASIDE_ARGS.includes(key)) shown[key] = value
  }
  const text = JSON.stringify(shown)
  if (text === "{}") return ""
  return text.length <= MAX_ARG_CHARS ? text : `${text.slice(0, MAX_ARG_CHARS - 1)}…`
}

/**
 * One tool call as a sentence: `click [12] "the search box"`.
 *
 * The tool names are the ones in `src/agent/tools.ts` and their argument shapes are fixed by that
 * file's schemas, so this can read them by name rather than dumping JSON. Anything it does not
 * recognise — a tool added later, a malformed call — falls back to the raw compact arguments, so an
 * unknown action is still shown rather than silently rendered as a bare verb.
 */
export function actionLine(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "navigate":
      return `navigate ${text(args.url)}`
    case "click":
      return `click ${slot(args.ref)}${quoted(args.why)}`
    case "type":
      return `type ${slot(args.ref)}${quoted(args.text)}${args.submit === true ? " ⏎" : ""}`
    case "select_option":
      return `select ${slot(args.ref)}${quoted(args.option)}`
    case "scroll":
      return `scroll ${text(args.direction)}`
    case "go_back":
      return "go back"
    case "wait":
      return `wait ${text(args.seconds)}s`
    case "record_finding":
      return `record finding${fields(args.data)}`
    case "ask_human":
      return "ask a human"
    case "finish":
      return `finish (${text(args.outcome)})`
    default: {
      const rest = compactArgs(args)
      return rest === "" ? tool : `${tool} ${rest}`
    }
  }
}

/** An element reference the way the page snapshot writes it: `[12]`, or nothing if it is not one. */
function slot(ref: unknown): string {
  return typeof ref === "number" ? `[${ref}]` : ""
}

/** A trailing `"…"` fragment, or nothing at all — never an empty pair of quotes. */
function quoted(value: unknown): string {
  const written = text(value)
  if (written === "") return ""
  const clipped =
    written.length <= MAX_QUOTE_CHARS ? written : `${written.slice(0, MAX_QUOTE_CHARS - 1)}…`
  return ` "${clipped}"`
}

/** The field names a finding is about to carry — the row, before it has a row to sit in. */
function fields(data: unknown): string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return ""
  const keys = Object.keys(data)
  return keys.length === 0 ? "" : ` (${keys.join(", ")})`
}

/** A scalar as one line of text; anything else, and anything absent, as nothing. */
function text(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}
