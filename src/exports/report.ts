import type { PersistedEvent } from "../events/types.js"

/**
 * The deliverable: a run's event log turned into something a person can read, file, or import.
 *
 * Everything here is derived from the log and nothing else. The loop is the only writer of that
 * log and it always writes an ending, so a report is a pure function of the file on disk — which
 * is what lets a run be exported long after the process that drove it has gone, and lets the
 * builder be tested against a hand-written event array rather than a browser.
 *
 * Two shapes are load-bearing:
 *
 * - **Every finding carries the step it came from.** That number is the receipt: it names the
 *   screenshot the fact was read off, which is the difference between a table an accountant can
 *   check and a table they have to believe.
 * - **The columns are the union of what the findings actually carry**, in the order first seen.
 *   The model chooses its own field names per run (the presets only suggest a schema), so there is
 *   no fixed header to write down — and a row that lacks a key gets an empty cell rather than
 *   shifting every column after it.
 */

export interface ReportStep {
  step: number
  /** The `action_result` of that step, or `""` for a step that was photographed and no more. */
  summary: string
  shotUrl: string | null
}

export interface Report {
  goal: string
  outcome: string
  summary: string
  /** One row per `record_finding`: the model's own fields, plus the step it was recorded on. */
  findings: Record<string, unknown>[]
  steps: ReportStep[]
  costUsd: number
}

/**
 * What a log with no `done` event is reported as. The loop guarantees exactly one ending on every
 * path out of it, so a log without one was cut off mid-write — the run is over either way, and a
 * report that quietly claimed success would be the one thing worse than saying so.
 */
const NO_ENDING = "the run ended without a report"

/** The receipt column. Named once: the builder writes it, and both serializers move it last. */
const STEP = "step"

/** RFC 4180 says CRLF, and it is what Excel expects on every platform. */
const CRLF = "\r\n"

export function buildReport(goal: string, events: PersistedEvent[]): Report {
  let outcome = "failed"
  let summary = NO_ENDING
  let costUsd = 0
  const findings: Record<string, unknown>[] = []
  const steps = new Map<number, ReportStep>()
  /**
   * An `action_result` says nothing about which step it belongs to, so it is attributed to the
   * turn whose screenshot most recently went past — which is the order the loop emits them in. It
   * starts at 0, so a result that somehow arrives before any screenshot is still reported (as
   * step 0) rather than dropped.
   */
  let current = 0

  const stepFor = (n: number): ReportStep => {
    const known = steps.get(n)
    if (known) return known
    const made: ReportStep = { step: n, summary: "", shotUrl: null }
    steps.set(n, made)
    return made
  }

  for (const { event } of events) {
    switch (event.type) {
      case "done":
        outcome = event.outcome
        summary = event.summary
        break
      case "finding":
        // The step is written last on purpose: a model that put its own `step` field in the data
        // does not get to overwrite the number that says where the fact came from.
        findings.push({ ...event.data, [STEP]: event.step })
        break
      case "budget":
        // Each budget event carries the running total, so the last one is the run's whole bill.
        costUsd = event.costUsd
        break
      case "screenshot":
        current = event.step
        stepFor(event.step).shotUrl = event.url
        break
      case "action_result": {
        const step = stepFor(current)
        // One result per turn is what the loop emits; joining rather than replacing means a log
        // that ever carries two keeps both.
        step.summary = step.summary === "" ? event.summary : `${step.summary}; ${event.summary}`
        break
      }
      default:
        break
    }
  }

  return {
    goal,
    outcome,
    summary,
    findings,
    steps: [...steps.values()].sort((a, b) => a.step - b.step),
    costUsd,
  }
}

/** The report as a document: readable as plain text, and a proper table wherever GFM is rendered. */
export function toMarkdown(report: Report): string {
  const lines = [
    "# Noctua — run report",
    "",
    `**Goal:** ${oneLine(report.goal)}`,
    "",
    `**Outcome:** ${oneLine(report.outcome)} · **Cost:** $${report.costUsd.toFixed(2)}`,
    "",
    report.summary,
    "",
    "## Findings",
    "",
  ]

  if (report.findings.length === 0) {
    lines.push("_No findings were recorded._")
  } else {
    const cols = columns(report.findings)
    lines.push(tableRow(cols.map(escapeCell)))
    lines.push(tableRow(cols.map(() => "---")))
    for (const finding of report.findings) {
      lines.push(tableRow(cols.map((col) => escapeCell(text(finding[col])))))
    }
  }

  lines.push("", "## Step log", "")
  if (report.steps.length === 0) {
    lines.push("_No steps were recorded._")
  } else {
    report.steps.forEach((step, i) => lines.push(stepLine(i + 1, step)))
  }

  return lines.join("\n") + "\n"
}

/**
 * The findings as a spreadsheet — the artifact that gets imported into a ledger rather than read.
 *
 * RFC 4180 throughout: a field holding a comma, a quote or a line break is quoted, quotes inside
 * it are doubled, and records end with CRLF. Values are left exactly as recorded, so what opens in
 * Excel is what the agent read off the page.
 */
export function toCsv(findings: Record<string, unknown>[]): string {
  // A header with no rows under it is a file that looks like data and is not; an empty export
  // says plainly that the run confirmed nothing.
  if (findings.length === 0) return ""
  const cols = columns(findings)
  const rows = [cols, ...findings.map((finding) => cols.map((col) => text(finding[col])))]
  return rows.map((row) => row.map(csvField).join(",")).join(CRLF)
}

/** Every key any finding carries, in the order first seen, with the step column last. */
function columns(findings: Record<string, unknown>[]): string[] {
  const keys = new Set<string>()
  for (const finding of findings) for (const key of Object.keys(finding)) keys.add(key)
  // Deleted and re-added rather than skipped: wherever a finding happened to carry it, the receipt
  // belongs at the end of the row.
  keys.delete(STEP)
  return [...keys, STEP]
}

/** One value as text. A missing field is an empty cell — never the word "undefined". */
function text(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  // Numbers and booleans render as themselves; a nested object renders as the JSON it was.
  return JSON.stringify(value) ?? ""
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`
}

/** A cell may hold neither a pipe nor a line break: either ends the row where it stands. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>")
}

function stepLine(n: number, step: ReportStep): string {
  const summary = step.summary === "" ? "" : ` — ${oneLine(step.summary)}`
  const shot = step.shotUrl === null ? "" : ` ([screenshot](${step.shotUrl}))`
  return `${n}. **Step ${step.step}**${summary}${shot}`
}

/** Collapses whitespace, for the places where a stray newline would end the line early. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
