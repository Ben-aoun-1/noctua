import { useEffect, useState } from "react"
import OwlMark from "./components/OwlMark.tsx"
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
  return match ? { name: "run", id: decodeURIComponent(match[1]) } : { name: "landing" }
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    const onHashChange = (): void => setRoute(readRoute())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  return route.name === "run" ? <CockpitStub id={route.id} /> : <Landing />
}

/** Task 14 replaces this with the live cockpit; the route exists now so the landing page can use it. */
function CockpitStub({ id }: { id: string }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1080px] flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <OwlMark size={48} />
      <p className="microlabel">COCKPIT</p>
      <p className="mono max-w-full text-[13px] break-words">
        Run {id} — cockpit lands in the next task
      </p>
      <a className="btn-outline mt-2" href="#/">
        Back to landing
      </a>
    </main>
  )
}
