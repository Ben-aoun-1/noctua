import { useEffect, useState } from "react"
import Cockpit from "./screens/Cockpit.tsx"
import Landing from "./screens/Landing.tsx"

/**
 * The whole router.
 *
 * Routing on the hash rather than on the path is a deliberate simplification: the server can serve
 * one `index.html` for every URL the app invents, a deep link into a run survives a hard refresh
 * without a history-fallback rule, and there is no router dependency to keep current.
 */

type Route = { name: "landing" } | { name: "run"; id: string }

/** `#/run/<id>` — anything else, including an empty hash, is the landing screen. */
const RUN_ROUTE = /^#\/run\/([^/?#]+)$/

function readRoute(): Route {
  const match = RUN_ROUTE.exec(window.location.hash)
  return match ? { name: "run", id: decodeId(match[1]) } : { name: "landing" }
}

/**
 * A hand-typed hash can carry a malformed escape (`%E0%A4%A`), and `decodeURIComponent` answers that
 * with a `URIError`. Thrown from the state initialiser it would take the whole app down to a blank
 * page, so a segment that will not decode is used exactly as it was written: the id is wrong either
 * way, and a run screen saying so beats no screen at all.
 */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    const onHashChange = (): void => setRoute(readRoute())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  // Keyed on the id: a jump from one run to another must build a fresh cockpit rather than hand
  // the new id to a component still holding the previous run's stream, findings and open receipt.
  return route.name === "run" ? <Cockpit key={route.id} id={route.id} /> : <Landing />
}
