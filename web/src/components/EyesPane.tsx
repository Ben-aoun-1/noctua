import OwlMark from "./OwlMark.tsx"

/**
 * What Noctua is looking at.
 *
 * One image, the step it belongs to, and the address it was taken on — nothing else. The step
 * numeral is set in the display face at 20% ink and dropped over the top-right corner the way the
 * landing page ghosts its section numerals: it says which frame this is without ever competing
 * with the frame itself.
 *
 * The same pane doubles as the receipt viewer. A finding's receipt is the screenshot of the page
 * it was read from, so opening one is not a different view — it is this view, pinned to an earlier
 * step, with one bar saying so and offering the way back.
 */

export interface EyesPaneProps {
  /** The screenshot to show, or null before the first one exists. */
  url: string | null
  /** The step that screenshot belongs to, shown as the ghost numeral. */
  step: number | null
  /** Where the browser was at that step; blank when the log for it never named an address. */
  pageUrl: string
  /** Whether the run could still produce a first frame — the difference between waiting and empty. */
  waiting: boolean
  /** Set when the pane is pinned to a receipt rather than following the run. */
  receiptStep: number | null
  onLive: () => void
}

export default function EyesPane({
  url,
  step,
  pageUrl,
  waiting,
  receiptStep,
  onLive,
}: EyesPaneProps) {
  return (
    <section className="pane min-h-[260px]">
      <p className="microlabel">LIVE VIEW</p>

      {receiptStep !== null && (
        <button
          className="chip mt-3 w-full justify-center border-bronze/40 text-bronze hover:bg-sand"
          onClick={onLive}
          aria-label={`Stop showing the receipt for step ${receiptStep} and follow the run again`}
        >
          RECEIPT — STEP {stepNumeral(receiptStep)} ↩
        </button>
      )}

      <div className="relative mt-3 flex min-h-0 grow items-start justify-center overflow-hidden">
        {url === null ? (
          <div className="flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-3 rounded-[4px] bg-sand">
            <OwlMark size={44} className={waiting ? "animate-pulse text-ink/25" : "text-ink/20"} />
            <p className="microlabel">{waiting ? "OPENING A TAB" : "NO PAGE WAS CAPTURED"}</p>
          </div>
        ) : (
          <img
            className="hairline max-h-full w-full max-w-full rounded-[4px] border object-contain object-top"
            src={url}
            alt={step === null ? "The page Noctua is on" : `The page Noctua saw at step ${step}`}
            data-testid="live-shot"
          />
        )}
        {step !== null && (
          <span
            aria-hidden
            className="serif pointer-events-none absolute top-0 right-3 text-[80px] leading-none text-ink/20 select-none"
          >
            {stepNumeral(step)}
          </span>
        )}
      </div>

      {/* Always rendered: a blank tab has no address, and a line that appears and disappears
          would shift the image under the reader every time the agent navigates. */}
      <p className="mono mt-2 min-h-4 truncate text-[11px] text-ink/50" title={pageUrl}>
        {step === null ? "" : `STEP ${stepNumeral(step)}`}
        {pageUrl === "" ? "" : ` · ${pageUrl}`}
      </p>
    </section>
  )
}

/** Their two-digit numerals: 07, not 7 — a column of steps should not jitter as it passes ten. */
function stepNumeral(step: number): string {
  return String(step).padStart(2, "0")
}
