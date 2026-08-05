import { chromium, type Browser, type Page, type Request, type Route } from "playwright"
import { allowPublicRequest } from "../safety/urlGuard.js"

export interface BrowserPage {
  page: Page
  /** Closes the page, its context and the browser process. Safe to call once. */
  close: () => Promise<void>
}

export interface BrowserPageOpts {
  /**
   * Whether one request the page makes may go out, defaulting to {@link allowPublicRequest}.
   *
   * The same seam, for the same reason, as the loop's `checkUrl`: the test fixture site is served
   * from 127.0.0.1, which the real policy refuses. Production omits this and gets that policy;
   * tests inject one that allows their own loopback origin and hands everything else back to it.
   * One implementation of the policy, and no test-only branch inside the guard.
   */
  allowRequest?: (url: string) => boolean
}

/** Wide enough for desktop layouts, short enough that a screenshot stays cheap. */
const VIEWPORT = { width: 1280, height: 900 }

/**
 * Hops one subresource may take before it is refused outright.
 *
 * Chromium allows twenty; ten is past anything a real site does and well short of a chain that
 * exists only to exhaust something. A loop between two addresses is refused rather than followed
 * until a timeout, which is what a chain nobody meant to build looks like from here.
 */
const MAX_REDIRECTS = 10

/**
 * Headers that must not survive a hop to another origin.
 *
 * Walking the chain by hand means re-sending the first request's headers, and those carry whatever
 * the browser attached for the address in the *markup*. Chromium would consult its cookie jar
 * again for wherever the hop actually leads; copying them across instead would hand the session
 * cookie of a site the agent is signed into to anyone who can find an open redirect on it —
 * `<img src="https://signed-in.example/r?to=attacker">` and the cookie arrives at the attacker.
 * Dropping them is what makes the jar fill them back in, for the origin being asked rather than
 * the one that pointed here.
 */
const CREDENTIAL_HEADERS = ["cookie", "authorization", "proxy-authorization"]

/**
 * How many times to ask chromium to start.
 *
 * A launch is a process fork plus a websocket handshake, and on a loaded machine it fails for
 * reasons that have nothing to do with the run being started — about two full test runs in
 * fourteen here. One more attempt costs a quarter of a second; not making it costs a run, or a red
 * suite in front of whoever is evaluating this. Bounded at two, because a launch that fails for a
 * real reason (no executable, no sandbox) fails identically however many times it is asked.
 */
const LAUNCH_ATTEMPTS = 2
/** Long enough for whatever was in the way — a dying sibling browser, a busy /tmp — to clear. */
const LAUNCH_RETRY_MS = 250

/**
 * Launches a headless chromium and hands back a single page.
 *
 * Where the *tab* goes is enforced one layer up, by the navigate tool and by the loop's re-check
 * of the address it actually landed on (`src/safety/urlGuard.ts`). That covers everything the
 * model chooses, and nothing a page chooses for it: a page that embeds
 * `<iframe src="http://169.254.169.254/latest/meta-data/">` never moves the tab at all — the
 * browser fetches the metadata on the page's behalf and renders it, and the screenshot carries it
 * into the model's context, the event log and the exported report.
 *
 * So requests are gated here as well, on the literal address alone: no DNS lookup per subresource,
 * which would put a resolver on the critical path of every image on every page to re-apply a
 * policy the tab's own address is already held to.
 */
export async function createBrowserPage(opts: BrowserPageOpts = {}): Promise<BrowserPage> {
  const allowRequest = opts.allowRequest ?? allowPublicRequest
  const browser = await launch()
  const context = await browser.newContext({ viewport: VIEWPORT })
  await context.route("**/*", (route) => guardRequest(route, allowRequest))
  // tsx/esbuild compiles with `keepNames`, which rewrites every named function into a
  // `__name(fn, "fn")` call and defines that helper at the top of the *module*. `page.evaluate`
  // ships only the function's own source to the browser, so the helper is left behind and the
  // page throws `ReferenceError: __name is not defined` — which takes out `capture` entirely
  // under `npm run dev`, though not under tsc's output or vitest's transform. This shim makes
  // those calls the no-ops they should be.
  //
  // It must be registered on the *context*, before the page exists: a page-level init script
  // does not reach the initial about:blank document that `newPage` has already created, and
  // that blank tab is exactly what every run captures on its first turn.
  await context.addInitScript("globalThis.__name = (fn) => fn")
  const page = await context.newPage()
  return {
    page,
    close: async () => {
      await browser.close()
    },
  }
}

/**
 * Applies the policy to one request — and to every address that request is redirected to.
 *
 * A gate on the address in the markup is not a gate on the address that gets fetched. Playwright
 * hands the handler the *first* URL of a redirect chain and nothing after it (documented on
 * `BrowserContext.route`), so `<img src="/bounce">` answering `302 Location:
 * http://169.254.169.254/latest/meta-data/` had the metadata fetched, rendered, photographed and
 * carried into the model's context, the event log and the exported report — with the check that
 * exists to stop exactly that never seeing the address at all.
 *
 * So the chain is not delegated to chromium: each response is taken with redirects switched off,
 * every `Location` is resolved and put back through the policy, and only a body that nothing
 * redirected to is handed over. The tab's own address is the one exception — see below.
 */
async function guardRequest(route: Route, allowRequest: (url: string) => boolean): Promise<void> {
  try {
    const request = route.request()
    const start = request.url()
    if (!allowRequest(start)) return await settle(() => route.abort("blockedbyclient"))
    // A document fulfilled here would be a document served at the address it was *asked* for
    // rather than the one it came from, and everything downstream reads that address: relative
    // links and images resolve against it, and the loop re-checks it — with DNS, which is the
    // stronger of the two policies — before anything is allowed to read the page. Following the
    // tab's own chain by hand would quietly cost all of that, so it is left to chromium, whose
    // landing the loop then judges. Every other request is fetched here, where its hops are seen.
    if (isTabNavigation(request)) return await settle(() => route.continue())
    // A scheme the browser answers without the network — `data:`, `blob:` — has no chain to walk
    // and nothing to re-check, so it goes on as it did before rather than through a fetch that
    // would only find new ways to fail.
    if (!isWeb(start)) return await settle(() => route.continue())

    const origin = new URL(start).origin
    let url = start
    let method = request.method()
    let body: string | undefined
    let headers: Record<string, string> | undefined
    for (let hop = 0; ; hop++) {
      const response = await route.fetch({ url, method, postData: body, headers, maxRedirects: 0 })
      const location = response.headers()["location"]
      const redirected = response.status() >= 300 && response.status() < 400
      if (!redirected || location === undefined) {
        return await settle(() => route.fulfill({ response }))
      }
      if (hop >= MAX_REDIRECTS) return await settle(() => route.abort("failed"))
      // Relative as often as not — `Location: /latest/meta-data/` is a hop like any other.
      const next = new URL(location, url).toString()
      if (!allowRequest(next) || !isWeb(next)) {
        return await settle(() => route.abort("blockedbyclient"))
      }
      // Browsers re-issue these as a bodyless GET. A chain followed by hand has to do the same, or
      // a form post that redirects is submitted a second time, to the page it redirected to.
      if (response.status() === 303 || (response.status() < 303 && method === "POST")) {
        method = "GET"
        body = ""
      }
      // Credentials belong to the address that was asked for, not to wherever it points.
      headers = new URL(next).origin === origin ? undefined : await unauthenticated(request)
      url = next
    }
  } catch {
    // Whatever the reason — the address refused the connection, a `Location` that is not a URL, a
    // policy that threw — the request does not go out. This is the same failure the page would
    // have seen from a network that dropped it, which is a page that renders without it.
    await settle(() => route.abort("failed"))
  }
}

/** Only http(s) has a redirect chain, and only http(s) reaches an address at all. */
function isWeb(url: string): boolean {
  const protocol = new URL(url).protocol
  return protocol === "http:" || protocol === "https:"
}

/**
 * This request's headers with the caller's credentials taken out, so Playwright fills in whatever
 * the cookie jar holds for the origin actually being asked. See {@link CREDENTIAL_HEADERS}.
 */
async function unauthenticated(request: Request): Promise<Record<string, string>> {
  const headers = { ...(await request.allHeaders()) }
  for (const name of CREDENTIAL_HEADERS) delete headers[name]
  return headers
}

/**
 * Whether this request is the tab moving, rather than something the page is pulling in.
 *
 * A frame is not always available — a service worker's request belongs to no frame, and Playwright
 * throws rather than saying so. That is not the tab's address either, so it takes the gated path:
 * the answer this cannot establish is the one that costs least to be wrong about.
 */
function isTabNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false
  try {
    return request.frame().parentFrame() === null
  } catch {
    return false
  }
}

/**
 * Settles a route without letting the settlement itself throw.
 *
 * Playwright invokes this handler itself, so a rejection here escapes into its own machinery
 * rather than into the loop's try — which is how `runAgent` never throwing would be routed around.
 * And a route whose page has already gone rejects on every one of these calls, which is a race
 * with a closing run rather than anything to report.
 */
async function settle(act: () => Promise<void>): Promise<void> {
  await act().catch(() => undefined)
}

/** Chromium, with one more attempt for the launch that fails over nothing. */
async function launch(): Promise<Browser> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chromium.launch({
        headless: true,
        // --no-sandbox is required inside the unprivileged containers this runs in;
        // --disable-dev-shm-usage stops chromium crashing on the small /dev/shm they ship with.
        args: ["--disable-dev-shm-usage", "--no-sandbox"],
      })
    } catch (err) {
      if (attempt >= LAUNCH_ATTEMPTS) throw err
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_MS))
    }
  }
}
