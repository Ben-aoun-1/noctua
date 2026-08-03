import type { RunStatus } from "../api.ts"

/**
 * How a run's state reads at a glance: settled, waiting on a human, lost, or still in the air.
 *
 * One definition, used by the flight list and by the cockpit's status chip — a run that is bronze
 * in the history must not be sage in the cockpit.
 */
const TONE: Record<RunStatus, string> = {
  finished: "bg-sage",
  awaiting_approval: "bg-bronze",
  awaiting_human: "bg-bronze",
  paused: "bg-bronze",
  failed: "bg-oxide",
  stopped: "bg-ink/30",
  running: "bg-ink animate-pulse",
  pending: "bg-ink animate-pulse",
}

/**
 * The dot, plus the same fact in words for a screen reader. The label is out of flow (`sr-only` is
 * absolutely positioned), so this renders as one dot wherever it is dropped, flex gaps included.
 */
export default function StatusDot({ status }: { status: RunStatus }) {
  return (
    <>
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${TONE[status]}`} />
      <span className="sr-only">{status.replace("_", " ")}</span>
    </>
  )
}
