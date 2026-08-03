import { chromium, type Page } from "playwright"

export interface BrowserPage {
  page: Page
  /** Closes the page, its context and the browser process. Safe to call once. */
  close: () => Promise<void>
}

/** Wide enough for desktop layouts, short enough that a screenshot stays cheap. */
const VIEWPORT = { width: 1280, height: 900 }

/**
 * Launches a headless chromium and hands back a single page.
 *
 * Deliberately no `page.route` interception: URL safety is enforced one layer up, by the
 * navigate tool, which runs `assertSafeUrl` on the URL the model asked for (Task 6). Blocking
 * every private-IP *request* here would also block loopback targets the operator legitimately
 * points the browser at (the test fixture server, a local staging site) and would duplicate —
 * and could silently diverge from — the single guard in `src/safety/urlGuard.ts`.
 */
export async function createBrowserPage(): Promise<BrowserPage> {
  const browser = await chromium.launch({
    headless: true,
    // --no-sandbox is required inside the unprivileged containers this runs in;
    // --disable-dev-shm-usage stops chromium crashing on the small /dev/shm they ship with.
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  })
  const context = await browser.newContext({ viewport: VIEWPORT })
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
