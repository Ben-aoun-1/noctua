import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { allowPublicRequest, assertSafeUrl } from "../../src/safety/urlGuard.js"

/** The fixture site lives next to this file so tests stay hermetic and offline. */
const SITE_ROOT = resolve(fileURLToPath(new URL("./site", import.meta.url)))

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
}

export interface FixtureServer {
  /** e.g. `http://127.0.0.1:41235` — no trailing slash, so `baseUrl + "/registry.html"` works. */
  baseUrl: string
  /**
   * The navigation policy to hand the loop and the tools as `checkUrl`.
   *
   * This site is served from 127.0.0.1, which `assertSafeUrl` refuses by design — so tests allow
   * exactly this origin and hand every other address straight to the real guard, which therefore
   * remains the thing under test everywhere it matters.
   */
  checkUrl: (url: string) => Promise<void>
  /** The same bargain for the requests a *page* makes: `createBrowserPage`'s `allowRequest`. */
  allowRequest: (url: string) => boolean
  close: () => Promise<void>
}

/**
 * Serves `tests/fixtures/site` over plain HTTP on an ephemeral port, so several test
 * files can run at once without fighting over a fixed port.
 */
export async function serveFixtures(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    void (async () => {
      let asked: URL
      let pathname: string
      try {
        asked = new URL(req.url ?? "/", "http://127.0.0.1")
        pathname = decodeURIComponent(asked.pathname)
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request")
        return
      }
      // The hop a page can take without saying so in its markup: `/bounce?to=<url>` answers a 302
      // to whatever it is handed. That is how a fixture reaches an address the request guard was
      // never shown — the redirect chain is the part of a request the browser follows on its own.
      if (pathname === "/bounce") {
        const to = asked.searchParams.get("to")
        if (to === null) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bounce needs ?to=")
          return
        }
        res.writeHead(302, { location: to }).end()
        return
      }
      const file = resolve(join(SITE_ROOT, pathname === "/" ? "/index.html" : pathname))
      // `resolve` collapses `..`, so this rejects any path that escaped the site root.
      if (file !== SITE_ROOT && !file.startsWith(SITE_ROOT + sep)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden")
        return
      }
      try {
        const body = await readFile(file)
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-length": body.length,
        })
        res.end(body)
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found")
      }
    })()
  })

  await new Promise<void>((ok, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", ok)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture server has no port")

  const baseUrl = `http://127.0.0.1:${address.port}`
  const mine = (url: string) => url === baseUrl || url.startsWith(baseUrl + "/")
  return {
    baseUrl,
    checkUrl: async (url: string) => {
      if (!mine(url)) await assertSafeUrl(url)
    },
    allowRequest: (url: string) => mine(url) || allowPublicRequest(url),
    close: () =>
      new Promise<void>((ok, fail) => {
        // Playwright holds keep-alive sockets open; without this `close` never resolves.
        server.closeAllConnections()
        server.close((err) => (err ? fail(err) : ok()))
      }),
  }
}
