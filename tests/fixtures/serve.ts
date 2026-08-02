import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

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
  close: () => Promise<void>
}

/**
 * Serves `tests/fixtures/site` over plain HTTP on an ephemeral port, so several test
 * files can run at once without fighting over a fixed port.
 */
export async function serveFixtures(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    void (async () => {
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname)
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request")
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

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((ok, fail) => {
        // Playwright holds keep-alive sockets open; without this `close` never resolves.
        server.closeAllConnections()
        server.close((err) => (err ? fail(err) : ok()))
      }),
  }
}
