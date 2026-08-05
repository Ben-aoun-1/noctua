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

/** What the fake network answers with: a body, or a hop to somewhere else. */
interface Reply {
  status: number
  location?: string
}

interface RouteOpts {
  /** The tab moving, rather than something the page is pulling in. */
  navigation?: boolean
  method?: string
  /** Answers to `route.fetch`, by address. Anything unlisted answers a plain 200. */
  network?: Record<string, Reply>
  /** Makes `route.fetch` fail the way a refused connection does. */
  fetchThrows?: boolean
  /** Makes the settlement itself fail, the way a route whose page has already gone does. */
  settleThrows?: boolean
}

/**
 * A route the handler can settle, standing in for one request the page is making.
 *
 * It answers `route.fetch` as well as the settlements, because the handler now walks a redirect
 * chain itself rather than handing it to chromium — so what it *asked the network for* is as much
 * of its behaviour as how it finished, and `fetched` is what records that.
 */
function fakeRoute(url: string, opts: RouteOpts = {}) {
  const settled: string[] = []
  const fetched: string[] = []
  /** The headers each fetch went out with, `undefined` meaning "whatever the request already had". */
  const sentHeaders: (Record<string, string> | undefined)[] = []
  const network = opts.network ?? {}
  const finish = (what: string) => {
    settled.push(what)
    return opts.settleThrows === true
      ? Promise.reject(new Error("Route is already handled!"))
      : Promise.resolve()
  }
  const route = {
    request: () => ({
      url: () => url,
      method: () => opts.method ?? "GET",
      isNavigationRequest: () => opts.navigation === true,
      // A subresource's frame has a parent; the tab's own document is the frame that has none.
      frame: () => ({ parentFrame: () => (opts.navigation === true ? null : {}) }),
      allHeaders: () =>
        Promise.resolve({ accept: "*/*", cookie: "sess=SECRET", authorization: "Bearer t" }),
    }),
    fetch: vi.fn((sent: { url?: string; method?: string; headers?: Record<string, string> }) => {
      const asked = sent.url ?? url
      fetched.push(`${sent.method ?? "GET"} ${asked}`)
      sentHeaders.push(sent.headers)
      if (opts.fetchThrows === true) return Promise.reject(new Error("net::ERR_CONNECTION_REFUSED"))
      const reply = network[asked] ?? { status: 200 }
      return Promise.resolve({
        status: () => reply.status,
        headers: () => (reply.location === undefined ? {} : { location: reply.location }),
      })
    }),
    fulfill: vi.fn(() => finish("fulfill")),
    continue: vi.fn(() => finish("continue")),
    abort: vi.fn((reason?: string) => finish(`abort:${reason}`)),
  }
  return { route: route as unknown as Route, settled, fetched, sentHeaders }
}

/** Installs the guard and hands back the single handler it registered. */
async function guardWith(allowRequest?: (url: string) => boolean) {
  const { browser, routes } = fakeBrowser()
  launch.mockResolvedValue(browser)
  await createBrowserPage(allowRequest === undefined ? {} : { allowRequest })
  expect(routes).toHaveLength(1)
  return routes[0]!
}

describe("createBrowserPage — the request guard", () => {
  it("aborts a request to a private address and lets everything else through", async () => {
    const guard = await guardWith()

    const blocked = fakeRoute("http://169.254.169.254/latest/meta-data/")
    await guard(blocked.route)
    expect(blocked.settled).toEqual(["abort:blockedbyclient"])
    // Refused before it left, not after it came back.
    expect(blocked.fetched).toEqual([])

    const allowed = fakeRoute("https://example.com/logo.png")
    await guard(allowed.route)
    expect(allowed.settled).toEqual(["fulfill"])
  })

  /** The same seam as the loop's `checkUrl`: the fixture site is served from a blocked address. */
  it("takes the caller's own policy when one is given", async () => {
    const guard = await guardWith((url) => url.startsWith("http://127.0.0.1:9/"))

    const allowed = fakeRoute("http://127.0.0.1:9/registry.html")
    await guard(allowed.route)
    expect(allowed.settled).toEqual(["fulfill"])

    const blocked = fakeRoute("https://example.com/logo.png")
    await guard(blocked.route)
    expect(blocked.settled).toEqual(["abort:blockedbyclient"])
  })

  /**
   * The address in the markup is not the address that gets fetched. Playwright hands this handler
   * the *first* URL of a redirect chain and nothing after it, so a permitted URL answering
   * `302 Location: http://169.254.169.254/…` had the metadata fetched, rendered and photographed
   * with the check that exists to stop exactly that never seeing the address at all.
   */
  it("refuses a hop to a private address, having never asked for it", async () => {
    const guard = await guardWith()
    const bounce = fakeRoute("https://example.com/bounce", {
      network: {
        "https://example.com/bounce": {
          status: 302,
          location: "http://169.254.169.254/latest/meta-data/",
        },
      },
    })

    await guard(bounce.route)
    expect(bounce.settled).toEqual(["abort:blockedbyclient"])
    expect(bounce.fetched).toEqual(["GET https://example.com/bounce"])
  })

  it("follows a hop the policy allows and hands back what it found", async () => {
    const guard = await guardWith()
    const bounce = fakeRoute("https://example.com/bounce", {
      network: {
        "https://example.com/bounce": { status: 302, location: "https://example.com/logo.png" },
      },
    })

    await guard(bounce.route)
    expect(bounce.settled).toEqual(["fulfill"])
    expect(bounce.fetched).toEqual([
      "GET https://example.com/bounce",
      "GET https://example.com/logo.png",
    ])
  })

  it("resolves a relative Location against the address it came from", async () => {
    const guard = await guardWith()
    const bounce = fakeRoute("https://example.com/a/bounce", {
      network: { "https://example.com/a/bounce": { status: 302, location: "../logo.png" } },
    })

    await guard(bounce.route)
    expect(bounce.fetched.at(-1)).toBe("GET https://example.com/logo.png")
    expect(bounce.settled).toEqual(["fulfill"])
  })

  /** Browsers re-issue a 303 as a bodyless GET; a chain followed by hand has to do the same, or a
   * form post that redirects is submitted a second time to wherever it redirected to. */
  it("re-issues a redirected POST as a GET", async () => {
    const guard = await guardWith()
    const posted = fakeRoute("https://example.com/submit", {
      method: "POST",
      network: { "https://example.com/submit": { status: 303, location: "/thanks" } },
    })

    await guard(posted.route)
    expect(posted.fetched).toEqual([
      "POST https://example.com/submit",
      "GET https://example.com/thanks",
    ])
  })

  it("refuses a chain that never arrives rather than following it for ever", async () => {
    const guard = await guardWith()
    let hop = 0
    const looping = fakeRoute("https://example.com/0", {
      // Every address answers with the next one, so nothing but the cap ends this.
      network: new Proxy({} as Record<string, Reply>, {
        get: () => ({ status: 302, location: `https://example.com/${++hop}` }),
        has: () => true,
      }),
    })

    await guard(looping.route)
    expect(looping.settled).toEqual(["abort:failed"])
    // Ten hops allowed, and the eleventh answer is where it gives up.
    expect(looping.fetched).toHaveLength(11)
  })

  /**
   * The tab's own document is the one thing left to chromium: fulfilling it here would serve it at
   * the address it was *asked* for rather than the one it came from, and the loop re-checks that
   * landing address with DNS — the stronger of the two policies — before anything reads the page.
   */
  it("leaves the tab's own navigation to chromium, which the loop then judges", async () => {
    const guard = await guardWith()
    const tab = fakeRoute("https://example.com/", { navigation: true })

    await guard(tab.route)
    expect(tab.settled).toEqual(["continue"])
    expect(tab.fetched).toEqual([])
  })

  it("still refuses a private address the tab is being navigated to", async () => {
    const guard = await guardWith()
    const tab = fakeRoute("http://169.254.169.254/", { navigation: true })

    await guard(tab.route)
    expect(tab.settled).toEqual(["abort:blockedbyclient"])
  })

  /**
   * The cost of walking the chain by hand, and the reason this is not just "follow it": the hop
   * re-sends the *first* request's headers, and those carry the credentials the browser attached
   * for the address in the markup. Chromium consults its jar again for wherever the hop leads; a
   * verbatim copy would turn any open redirect on a site the agent is signed into into an
   * exfiltration primitive. Confirmed against a real browser before it was written down: a page on
   * one loopback host bouncing an image to another had `sess=SECRET` arrive at the second.
   */
  it("does not carry credentials across a hop to another origin", async () => {
    const guard = await guardWith()
    const bounce = fakeRoute("https://example.com/bounce", {
      network: { "https://example.com/bounce": { status: 302, location: "https://elsewhere.test/x" } },
    })

    await guard(bounce.route)
    expect(bounce.settled).toEqual(["fulfill"])
    // The first request goes as the browser built it; the hop goes without the secrets, which is
    // what makes playwright refill them from the jar for the origin actually being asked.
    expect(bounce.sentHeaders[0]).toBeUndefined()
    expect(bounce.sentHeaders[1]).toEqual({ accept: "*/*" })
  })

  it("leaves a same-origin hop's headers exactly as the browser built them", async () => {
    const guard = await guardWith()
    const bounce = fakeRoute("https://example.com/bounce", {
      network: { "https://example.com/bounce": { status: 302, location: "/logo.png" } },
    })

    await guard(bounce.route)
    expect(bounce.sentHeaders).toEqual([undefined, undefined])
  })

  it("refuses a hop out of http entirely", async () => {
    const guard = await guardWith()
    const bounce = fakeRoute("https://example.com/bounce", {
      network: { "https://example.com/bounce": { status: 302, location: "file:///etc/passwd" } },
    })

    await guard(bounce.route)
    expect(bounce.settled).toEqual(["abort:blockedbyclient"])
  })

  it("fails the request rather than the run when the fetch itself does not come back", async () => {
    const guard = await guardWith()
    const dead = fakeRoute("https://example.com/logo.png", { fetchThrows: true })

    await guard(dead.route)
    expect(dead.settled).toEqual(["abort:failed"])
  })

  /**
   * Playwright invokes this handler itself, so a rejection escapes into its own machinery rather
   * than into the loop's try — which is how `runAgent` never throwing would be routed around. A
   * route whose page has already gone rejects on every settlement, and that is a closing run
   * rather than anything to report.
   */
  it("never lets a settlement failure escape into playwright", async () => {
    const guard = await guardWith()
    const going = fakeRoute("https://example.com/logo.png", { settleThrows: true })

    await expect(guard(going.route)).resolves.toBeUndefined()
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
