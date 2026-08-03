import { useEffect, useRef, useState } from "react"

/**
 * The run, rewound.
 *
 * A finished run's cockpit is not a recording of a screen — it is the same three panes drawn from
 * the same log, and the log is a list of numbered events. So "time travel" needs no player, no
 * second view and no request: hand the panes the events up to seq *n* instead of all of them and
 * the whole cockpit is the run as it stood at that moment. This bar is only the dial that names n.
 *
 * It exists for finished runs alone. A live run's end moves under the cursor with every frame that
 * arrives, and a scrubber whose maximum keeps sliding away is a control that fights its user; the
 * cockpit already has the affordance for going back in time while a run is in flight, which is the
 * receipt chip. So the bar is mounted when there is nothing left to arrive, and not before.
 *
 * Playback is a chain of timeouts rather than one interval: each tick is scheduled from the cursor
 * it is about to advance, so a drag that lands mid-playback cannot leave a stale interval pulling
 * the cursor back to where the tape was. Six a second is the speed at which the reasoning column
 * reads like something being written rather than like a page being pasted in.
 */

/** Six events a second — fast enough to feel like playback, slow enough to read what goes by. */
const TICK_MS = 1000 / 6

/** Shared with the control bar below it: mono, small, widely tracked. */
const BUTTON = "mono px-3 py-2 text-[11px] tracking-[0.1em]"

export interface ReplayBarProps {
  /** The last seq in the log: the end of the run, and the top of the dial. */
  maxSeq: number
  /** The event the cockpit is currently drawn from. 0 is the moment before anything happened. */
  cursor: number
  /** The step the frame on screen belongs to, or null when nothing had been captured by then. */
  step: number | null
  /**
   * Pin the cockpit to a seq.
   *
   * Must be stable across renders — playback re-arms its timeout whenever this identity changes,
   * and a callback rebuilt on every render would leave the tape permanently one tick from moving.
   */
  onSeek: (seq: number) => void
  /** Let go of the dial and show the whole run again. */
  onEnd: () => void
}

export default function ReplayBar({ maxSeq, cursor, step, onSeek, onEnd }: ReplayBarProps) {
  const [playing, setPlaying] = useState(false)
  /**
   * Whether playback *arrived* at the end, as opposed to the cursor merely sitting there.
   *
   * Every finished run opens with the cursor at the end, and a cockpit that announced "REPLAY
   * COMPLETE" to someone who has not pressed anything would be describing something that never
   * happened. The label is earned by the tape running out, and is given up the moment the dial moves.
   */
  const [completed, setCompleted] = useState(false)
  const rangeRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // One timeout per tick, re-armed from the cursor it just moved. Cancelled by pausing, by the run
  // reaching its end, and by any seek — including one the human made mid-playback.
  useEffect(() => {
    if (!playing) return
    if (cursor >= maxSeq) {
      setPlaying(false)
      setCompleted(true)
      return
    }
    const timer = window.setTimeout(() => onSeek(cursor + 1), TICK_MS)
    return () => window.clearTimeout(timer)
  }, [playing, cursor, maxSeq, onSeek])

  /** Any deliberate move of the dial: playback stops, and the run is no longer "complete". */
  function seek(seq: number): void {
    setPlaying(false)
    setCompleted(false)
    onSeek(Math.max(0, Math.min(seq, maxSeq)))
  }

  function toggle(): void {
    if (playing) {
      setPlaying(false)
      return
    }
    setCompleted(false)
    // Play from the end means play again: the alternative is a button that does nothing at all
    // on a screen whose cursor starts at the end, which is every finished run's first paint.
    if (cursor >= maxSeq) onSeek(0)
    setPlaying(true)
  }

  /**
   * The two keys a tape deserves, scoped so they can only ever be taken from someone reaching for
   * the tape.
   *
   * Space is the page-down key. A bar that swallowed it everywhere would break scrolling on every
   * screen narrower than `lg` — where the cockpit is a tall single column — in exchange for a
   * shortcut nobody asked for. So the handler is live only while the bar has the focus or the
   * pointer: both are read from the DOM at the keystroke rather than mirrored into state, so there
   * is no hover flag to get stuck on a bar the mouse has left.
   *
   * On `window` rather than on the bar even so, because the hover half of that has to work with
   * focus somewhere else entirely. Three things inside the bar keep their own keys: any field being
   * typed into, the slider itself (whose native arrow handling already moves the cursor, and would
   * otherwise move it twice), and buttons and links, for which the browser turns Space into a click.
   *
   * Re-bound on every render on purpose: the handler closes over the cursor and over whether the
   * tape is running, both of which change constantly, and one `addEventListener` per render is not
   * a cost worth a dependency list that would go stale.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target
      const el = target instanceof HTMLElement ? target : null
      const bar = barRef.current
      if (bar === null) return
      // A dialog open over the cockpit owns its own keys: Space scrolls the About panel rather
      // than starting the tape running underneath it.
      if (el?.closest("[role='dialog']")) return
      const reached =
        (document.activeElement instanceof Node && bar.contains(document.activeElement)) ||
        bar.matches(":hover")
      if (!reached) return

      if (event.key === " ") {
        if (typing(el) || el?.tagName === "BUTTON" || el?.tagName === "A") return
        event.preventDefault()
        toggle()
        return
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (typing(el) || el === rangeRef.current) return
        event.preventDefault()
        seek(cursor + (event.key === "ArrowRight" ? 1 : -1))
      }
    }

    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div ref={barRef} className="hairline border-t bg-ivory/95 backdrop-blur" data-testid="replay-bar">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2 sm:px-8">
        <p className="microlabel shrink-0 max-sm:hidden">REPLAY</p>

        <button
          className={`btn-outline ${BUTTON} shrink-0`}
          onClick={toggle}
          aria-label={playing ? "Pause the replay" : "Play the replay"}
          data-testid="replay-play"
        >
          {playing ? "PAUSE" : "PLAY"}
        </button>

        <input
          ref={rangeRef}
          className="scrub accent-ink min-w-[140px] flex-1 basis-[240px]"
          type="range"
          min={0}
          max={maxSeq}
          step={1}
          value={cursor}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Replay position"
          aria-valuetext={`Event ${cursor} of ${maxSeq}`}
          data-testid="replay-range"
        />

        <span
          className="mono shrink-0 text-[12px] whitespace-nowrap text-ink/60"
          data-testid="replay-readout"
        >
          EVENT {cursor} / {maxSeq} · STEP {step === null ? "—" : String(step).padStart(2, "0")}
        </span>

        {/* Always rendered, and a live region for the same reason: a label that appears when the
            tape runs out must not shove the button beside it sideways at the exact moment someone
            is reaching for it — and an empty region that is already in the tree is the one a
            screen reader will actually announce when it fills. */}
        <span
          role="status"
          className="microlabel shrink-0 text-right sm:w-[128px]"
          data-testid="replay-state"
        >
          {completed ? "REPLAY COMPLETE" : ""}
        </span>

        <button
          className={`btn-outline ${BUTTON} shrink-0`}
          onClick={onEnd}
          disabled={cursor >= maxSeq}
          data-testid="replay-end"
        >
          JUMP TO END
        </button>
      </div>
    </div>
  )
}

/** Whether a keystroke belongs to something being written into. A slider is not typing. */
function typing(el: HTMLElement | null): boolean {
  if (el === null) return false
  if (el.isContentEditable) return true
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true
  return el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range"
}
