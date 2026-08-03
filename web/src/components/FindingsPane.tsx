import { exportUrl, type DoneOutcome, type ExportFormat } from "../api.ts"

/**
 * What Noctua has actually confirmed — and, once the run ends, the report it hands over.
 *
 * The columns are not ours to choose: the model names its own fields per run (a preset only
 * suggests a schema), so the header is the union of the keys the findings actually carry, in the
 * order they were first seen. Past five the pane would stop being readable, so the ones an
 * accountant checks first are kept and the tail is dropped from the *view* — never from the export,
 * which carries every field.
 *
 * Every row ends in a receipt: the step the fact was read on, which is the screenshot of the page
 * it was read from. Opening one expands the row into the frame itself and the address underneath
 * it. That chip is the whole argument of this project — a figure you can click back to the pixel it
 * came from is a figure you can sign off — and it is drawn entirely from events already in hand, so
 * a run replayed from disk has its receipts without a single extra request.
 */

/** Past this the table stops being scannable inside a third of the screen. */
const MAX_COLUMNS = 5

/**
 * The fields worth a column when there are more fields than columns, best first.
 *
 * These are also the fields exempt from the repeated-value rule below: one vendor's dossier has the
 * same `legal_name` on every row, and that is the first thing anyone reads, not noise.
 */
const PREFERRED_COLUMNS = [
  "legal_name",
  "company_number",
  "vat_number",
  "vat_valid",
  "registry_status",
  "title",
  "jurisdiction",
]

/**
 * The one field that loses its column first: it is a URL, it is the widest thing a finding carries,
 * and it is never lost by being dropped — the receipt under the row is exactly where it is shown.
 */
const SOURCE = "source"

/**
 * The receipt column is pinned to the right edge.
 *
 * Five columns of a model's own field names do not fit across a third of the screen, so the table
 * scrolls sideways inside the pane — and a receipt you have to go looking for is not a receipt. It
 * rides above the row on the pane's own cream, with one hairline separating it from what it covers.
 */
const STUCK = "hairline sticky right-0 border-l bg-cream pl-2"

/** How an ending reads at a glance: settled, partial, or lost. */
const OUTCOME_TONE: Record<DoneOutcome, string> = {
  success: "border-sage/40 text-sage",
  partial: "border-bronze/40 text-bronze",
  failed: "border-oxide/40 text-oxide",
  stopped: "border-oxide/40 text-oxide",
}

const EXPORTS: ExportFormat[] = ["md", "csv", "json"]

export interface Finding {
  data: Record<string, unknown>
  /** The step it was recorded on — the receipt. */
  step: number
}

export interface FindingsPaneProps {
  runId: string
  findings: Finding[]
  /** The run's ending, once there is one; the pane becomes the report at that point. */
  done: { outcome: DoneOutcome; summary: string } | null
  /**
   * Whether the run itself is over — which is not the same question as whether `done` is in view.
   *
   * The rest of this pane is a claim about the log at the moment being shown, and scrubbing back
   * into a finished run must take the summary and the outcome chip away with it: at event 9 the run
   * genuinely had not ended. An export is not a claim about that moment. It is a file of the whole
   * run, built by the server from the whole log, and the cursor has no bearing on it — so the links
   * are held by the run being over and stay put wherever the dial happens to be.
   */
  over: boolean
  /** The receipt currently open, or null. Shared with the live view, which pins to the same step. */
  openStep: number | null
  onToggleReceipt: (step: number) => void
  /** The screenshot taken at a step, or null when that step never produced one. */
  shotFor: (step: number) => string | null
}

export default function FindingsPane({
  runId,
  findings,
  done,
  over,
  openStep,
  onToggleReceipt,
  shotFor,
}: FindingsPaneProps) {
  const columns = columnsOf(findings)

  return (
    <section className="pane min-h-[220px]">
      <header className="flex items-center justify-between gap-3">
        <p className="microlabel">{done ? "REPORT" : "FINDINGS"}</p>
        <div className="flex items-center gap-2">
          {done && (
            <span className={`chip ${OUTCOME_TONE[done.outcome]}`} data-testid="outcome-chip">
              {done.outcome}
            </span>
          )}
          <span className="chip" data-testid="findings-count">
            <span aria-hidden>{findings.length}</span>
            <span className="sr-only">{findings.length} findings recorded</span>
          </span>
        </div>
      </header>

      <div className="mt-3 min-h-0 grow overflow-y-auto">
        {done && (
          <p className="serif mb-4 text-[16px] leading-[1.45] text-ink/85" data-testid="report-summary">
            {done.summary}
          </p>
        )}

        {findings.length === 0 ? (
          <p className="text-[13px] text-ink/40">Nothing confirmed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mono w-full border-collapse text-[12px]">
              <thead>
                <tr className="hairline border-b">
                  {columns.map((column) => (
                    <th key={column} className="microlabel py-2 pr-3 text-left font-normal">
                      {column.replace(/_/g, " ")}
                    </th>
                  ))}
                  <th className={`microlabel py-2 text-right font-normal ${STUCK}`}>RECEIPT</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding, row) => (
                  <Row
                    key={row}
                    columns={columns}
                    finding={finding}
                    open={openStep === finding.step}
                    onToggle={() => onToggleReceipt(finding.step)}
                    shot={shotFor(finding.step)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {over && (
        <div className="hairline mt-3 flex flex-wrap gap-2 border-t pt-3">
          {EXPORTS.map((format) => (
            <a
              key={format}
              className="mono btn-outline px-3 py-2 text-[11px] tracking-[0.1em]"
              href={exportUrl(runId, format)}
              download
              data-testid={`export-${format}`}
            >
              {format.toUpperCase()}
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

/** One confirmed fact, and — when its receipt is open — the frame it was read off. */
function Row({
  columns,
  finding,
  open,
  onToggle,
  shot,
}: {
  columns: string[]
  finding: Finding
  open: boolean
  onToggle: () => void
  shot: string | null
}) {
  const source = typeof finding.data[SOURCE] === "string" ? (finding.data[SOURCE] as string) : ""

  return (
    <>
      <tr className={`hairline border-b align-top ${open ? "" : "last:border-b-0"}`}>
        {columns.map((column) => (
          <td key={column} className="py-2 pr-3">
            <span className="block max-w-[24ch] truncate" title={cellText(finding.data[column])}>
              {cellText(finding.data[column])}
            </span>
          </td>
        ))}
        <td className={`py-2 text-right ${STUCK}`}>
          <button
            className={`chip hover:bg-sand ${open ? "border-bronze/60 text-bronze" : ""}`}
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`Receipt for this row — the page it was read from, at step ${finding.step}`}
            data-testid="receipt-chip"
          >
            {String(finding.step).padStart(2, "0")}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="hairline border-b last:border-b-0">
          <td colSpan={columns.length + 1} className="pb-3">
            <div className="rounded-[4px] bg-sand p-3" data-testid="receipt-detail">
              <p className="microlabel">READ FROM</p>
              {source === "" ? (
                <p className="mt-1 text-[12px] text-ink/45">
                  This finding did not record a source URL.
                </p>
              ) : (
                <a
                  className="mono mt-1 block text-[11px] break-all text-ink/70 underline underline-offset-2 hover:text-ink"
                  href={source}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="receipt-source"
                >
                  {source}
                </a>
              )}
              {shot === null ? (
                <p className="mt-2 text-[12px] text-ink/45">No frame was captured at this step.</p>
              ) : (
                <img
                  className="hairline mt-2 w-full max-w-full rounded-[4px] border"
                  src={shot}
                  alt={`The page as it looked at step ${finding.step}`}
                  data-testid="receipt-shot"
                />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The columns to show: every key the findings carry, first-seen order, capped.
 *
 * Two things are dropped before the cap is even reached. A field that reads the same on every row
 * (`kind: vendor`, over and over) describes the *run*, not the row — it is a column of one repeated
 * answer, and the pane has five columns to spend. And `source` is the widest thing a finding
 * carries and is never lost by being dropped, because the receipt under the row is exactly where it
 * is shown; so it is the last non-preferred field to get a column.
 *
 * The row is still *drawn* in first-seen order, so the table reads the way the model wrote it
 * rather than the way this list happens to be ordered.
 */
function columnsOf(findings: Finding[]): string[] {
  const seen: string[] = []
  for (const finding of findings) {
    for (const key of Object.keys(finding.data)) if (!seen.includes(key)) seen.push(key)
  }

  const varied = seen.filter(
    (key) => PREFERRED_COLUMNS.includes(key) || !repeats(findings, key),
  )
  // A run whose findings are genuinely all one value would otherwise table nothing at all.
  const usable = varied.length > 0 ? varied : seen
  if (usable.length <= MAX_COLUMNS) return usable

  const kept = new Set(PREFERRED_COLUMNS.filter((key) => usable.includes(key)).slice(0, MAX_COLUMNS))
  for (const key of [...usable.filter((key) => key !== SOURCE), SOURCE]) {
    if (kept.size >= MAX_COLUMNS) break
    if (usable.includes(key)) kept.add(key)
  }
  return usable.filter((key) => kept.has(key))
}

/**
 * Whether a field says the same thing on every row.
 *
 * Compared as the cell renders it, so a row that simply does not carry the field reads as blank and
 * counts as different — "every row says Active" and "one row says Active and the rest say nothing"
 * are not the same claim. A single finding is never repetition: there is nothing to repeat.
 */
function repeats(findings: Finding[], key: string): boolean {
  if (findings.length < 2) return false
  const first = cellText(findings[0].data[key])
  return findings.every((finding) => cellText(finding.data[key]) === first)
}

/** One cell. A field a row does not carry is empty — never the word "undefined". */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? ""
}
