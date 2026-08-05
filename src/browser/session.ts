import { chromium, type Browser, type Page } from "playwright"
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
  await context.route("**/*", async (route) => {
    if (allowRequest(route.request().url())) await route.continue()
    else await route.abort("blockedbyclient")
  })
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
