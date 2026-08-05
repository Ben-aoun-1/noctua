import { afterEach, describe, expect, it, vi } from "vitest"
import type { Route } from "playwright"

/**
 * The browser page without a browser: how it is assembled, and what it does when chromium does not
 * come up. The guard it installs is proved against a real page in `tests/integration/loop.test.ts`
 * — this is about the wiring around it, which a launched browser would only make slower to check.
 */

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock("playwright", () => ({ chromium: { launch } }))

const { createBrowserPage } = await import("../../src/browser/session.js")

afterEach(() => {
  vi.clearAllMocks()
})

/** Just enough of playwright's object graph for `createBrowserPage` to walk it. */
function fakeBrowser() {
  const routes: ((route: Route) => unknown)[] = []
  const context = {
    route: vi.fn((_pattern: string, handler: (route: Route) => unknown) => {
      routes.push(handler)
      return Promise.resolve()
    }),
    addInitScript: vi.fn(() => Promise.resolve()),
    newPage: vi.fn(() => Promise.resolve({})),
  }
  const browser = {
    newContext: vi.fn(() => Promise.resolve(context)),
    close: vi.fn(() => Promise.resolve()),
  }
  return { browser, routes }
}

/** A route the handler can settle, standing in for one request the page is making. */
function fakeRoute(url: string) {
  const settled: string[] = []
  const route = {
    request: () => ({ url: () => url }),
    continue: vi.fn(() => {
      settled.push("continue")
      return Promise.resolve()
    }),
    abort: vi.fn((reason?: string) => {
      settled.push(`abort:${reason}`)
      return Promise.resolve()
    }),
  }
  return { route: route as unknown as Route, settled }
}

describe("createBrowserPage — the request guard", () => {
  it("aborts a request to a private address and lets everything else through", async () => {
    const { browser, routes } = fakeBrowser()
    launch.mockResolvedValue(browser)
    await createBrowserPage()
    expect(routes).toHaveLength(1)

    const blocked = fakeRoute("http://169.254.169.254/latest/meta-data/")
    await routes[0]!(blocked.route)
    expect(blocked.settled).toEqual(["abort:blockedbyclient"])

    const allowed = fakeRoute("https://example.com/logo.png")
    await routes[0]!(allowed.route)
    expect(allowed.settled).toEqual(["continue"])
  })

  /** The same seam as the loop's `checkUrl`: the fixture site is served from a blocked address. */
  it("takes the caller's own policy when one is given", async () => {
    const { browser, routes } = fakeBrowser()
    launch.mockResolvedValue(browser)
    await createBrowserPage({ allowRequest: (url) => url.startsWith("http://127.0.0.1:9/") })

    const allowed = fakeRoute("http://127.0.0.1:9/registry.html")
    await routes[0]!(allowed.route)
    expect(allowed.settled).toEqual(["continue"])

    const blocked = fakeRoute("https://example.com/logo.png")
    await routes[0]!(blocked.route)
    expect(blocked.settled).toEqual(["abort:blockedbyclient"])
  })
})

/**
 * A launch is a process fork and a websocket handshake, and it fails transiently on a loaded
 * machine — about two full test runs in fourteen here. Nothing about that failure has anything to
 * do with the run being started, so it costs one more attempt rather than a run (or a red suite).
 */
describe("createBrowserPage — when chromium does not come up", () => {
  it("asks a second time after a transient launch failure", async () => {
    const { browser } = fakeBrowser()
    launch.mockRejectedValueOnce(new Error("browserType.launch: Target page closed"))
    launch.mockResolvedValue(browser)
    await expect(createBrowserPage()).resolves.toMatchObject({ page: {} })
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it("gives up after that, reporting what chromium said", async () => {
    launch.mockRejectedValue(new Error("browserType.launch: Executable doesn't exist"))
    await expect(createBrowserPage()).rejects.toThrow(/Executable doesn't exist/)
    // Bounded: a launch that fails for a real reason must not retry the run into the ground.
    expect(launch).toHaveBeenCalledTimes(2)
  })
})
