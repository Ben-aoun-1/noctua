import { useEffect, useState } from "react"
import { eventsUrl, type PersistedEvent, type RunStatus } from "./api.ts"

/**
 * A run's live log, as React state.
 *
 * Four things about the protocol are load-bearing here:
 *
 * - **The frames are named.** The server writes `event: agent`, so `onmessage` — which only ever
 *   sees the default `message` type — receives nothing at all. It is `addEventListener("agent")`
 *   or an empty cockpit.
 * - **The server never closes the stream.** A run's `done` is followed by its terminal
 *   `run_status`, so a server that hung up on `done` would drop the event the status chip settles
 *   on. Closing is the client's half of that bargain, and it happens here on that status — after
 *   which `EventSource` is permanently closed and will never reconnect to a finished run.
 * - **Reconnects replay.** `EventSource` reconnects on its own and quotes `Last-Event-ID`, so the
 *   server resumes where this client got to — but a browser that reconnected without the header
 *   would replay the run from the top. Sequence numbers are gap-free and rising, so anything not
 *   above the highest seq already rendered is dropped rather than drawn twice.
 * - **`onerror` means two different things.** A retry in progress leaves `readyState` at
 *   `CONNECTING` and is not worth alarming anyone about; a stream the browser has given up on
 *   (a 404 for a run this deployment never had, a 401 for an expired cookie) leaves it at `CLOSED`,
 *   and that is the only case the cockpit shows as an error.
 */

const TERMINAL: readonly RunStatus[] = ["finished", "failed", "stopped"]

/** What a stream that will never open says, in the absence of a body we are allowed to read. */
const DEAD_STREAM = "this run's feed could not be opened — it may not exist on this deployment"

/** Whether a run has stopped moving — nothing more will ever be appended to its log. */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status)
}

export interface RunStream {
  /** Every event this client has seen, in `seq` order. */
  events: PersistedEvent[]
  /** The latest `run_status`; `pending` until the run announces itself. */
  status: RunStatus
  /** Whether the feed is open right now — false while `EventSource` is between attempts. */
  live: boolean
  /** Set only when the feed is not coming back: a run that cannot be opened at all. */
  error: string | null
}

function empty(): RunStream {
  return { events: [], status: "pending", live: false, error: null }
}

export function useRunStream(id: string): RunStream {
  const [state, setState] = useState<RunStream>(empty)

  useEffect(() => {
    // A new id is a different run: drop the previous one's events rather than append to them.
    setState(empty())

    // Closure state, not refs: it belongs to this connection and dies with it, and nothing renders
    // from it — so a change here must never be able to cost a render.
    let lastSeq = 0

    const source = new EventSource(eventsUrl(id, 1))

    source.onopen = () => {
      setState((prev) => (prev.live && prev.error === null ? prev : { ...prev, live: true, error: null }))
    }

    source.onerror = () => {
      // `CLOSED` is terminal: EventSource only reaches it when it has decided not to retry.
      const dead = source.readyState === EventSource.CLOSED
      setState((prev) => ({ ...prev, live: false, error: dead ? DEAD_STREAM : prev.error }))
    }

    source.addEventListener("agent", (message) => {
      const pe = parseEvent((message as MessageEvent<string>).data)
      if (pe === null || pe.seq <= lastSeq) return
      lastSeq = pe.seq

      // The terminal status is the last line a run will ever write. Closing here — rather than
      // waiting to be hung up on — is what stops a finished run holding a socket open for ever,
      // and `close()` is permanent, so nothing reconnects behind it.
      const closing = pe.event.type === "run_status" && isTerminal(pe.event.status)
      if (closing) source.close()

      // One update per event, so a burst of frames costs one render rather than three.
      setState((prev) => ({
        events: [...prev.events, pe],
        status: pe.event.type === "run_status" ? pe.event.status : prev.status,
        live: closing ? false : prev.live,
        // A run that reached us at all did not fail to open, whatever an earlier attempt said.
        error: null,
      }))
    })

    return () => source.close()
  }, [id])

  return state
}

/**
 * One frame, or null for anything that is not one.
 *
 * A frame that will not parse is dropped in silence: the stream carries on, the missing seq leaves
 * a gap nothing depends on, and a run is not worth failing over a line the UI cannot read.
 */
function parseEvent(data: string): PersistedEvent | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== "object" || parsed === null) return null
    const pe = parsed as Partial<PersistedEvent>
    if (typeof pe.seq !== "number" || typeof pe.event !== "object" || pe.event === null) return null
    if (typeof (pe.event as { type?: unknown }).type !== "string") return null
    return pe as PersistedEvent
  } catch {
    return null
  }
}
