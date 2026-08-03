import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance, InjectOptions } from "fastify"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { FakeLLM, type LLMFactory, type ScriptedTurn } from "../../src/agent/llm.js"
import { config } from "../../src/config.js"
import type { AgentEvent, PersistedEvent } from "../../src/events/types.js"
import { buildReport, toCsv, toMarkdown } from "../../src/exports/report.js"
import { RunStore, type RunSummary } from "../../src/runs/store.js"
import { buildServer } from "../../src/server.js"

/**
 * The deliverable: an event log in, a report an accountant can read out.
 *
 * The builder and the two serializers are pure and are tested against a synthetic log — every
 * shape a real run can produce, without a real run. The route is tested twice over: against a run
 * this process is driving, and against one it only knows from disk, which is what a run exported
 * the morning after a restart is.
 */

const COOKIE = "noctua_code"
const CODE = config.accessCode
const GOAL = "Verify Glowbar Ltd"

/** Numbers a hand-written event list the way the log would have. */
function log(...events: AgentEvent[]): PersistedEvent[] {
  return events.map((event, i) => ({ seq: i + 1, ts: 1_700_000_000_000 + i, event }))
}

/**
 * A complete run: two steps that produced findings with *different* keys, a step that produced
 * only a screenshot, two budget updates, and an ending. The second finding carries the three
 * characters that break a table or a CSV if nothing escapes them.
 */
const FINDING_TWO = {
  company: "Glowbar, Ltd",
  vat: 'GB "123"',
  note: "line one\nline two | pipe",
}
const RUN = log(
  { type: "run_status", status: "running" },
  { type: "screenshot", url: "/shots/1.jpg", step: 1 },
  { type: "action_result", tool: "navigate", ok: true, summary: "loaded the registry" },
  { type: "budget", steps: 1, maxSteps: 40, costUsd: 0.11, maxCostUsd: 1.5 },
  { type: "screenshot", url: "/shots/2.jpg", step: 2 },
  { type: "finding", data: { company: "Glowbar, Ltd", status: "Active" }, step: 2 },
  { type: "action_result", tool: "record_finding", ok: true, summary: "recorded finding #1" },
  { type: "budget", steps: 2, maxSteps: 40, costUsd: 0.42, maxCostUsd: 1.5 },
  { type: "screenshot", url: "/shots/3.jpg", step: 3 },
  { type: "finding", data: FINDING_TWO, step: 3 },
  { type: "done", outcome: "success", summary: "Both facts check out." },
  { type: "run_status", status: "finished" },
)

describe("buildReport", () => {
  it("reads the ending, the findings, the step log and the spend out of the events", () => {
    const report = buildReport(GOAL, RUN)
    expect(report.goal).toBe(GOAL)
    expect(report.outcome).toBe("success")
    expect(report.summary).toBe("Both facts check out.")
    // The last budget event is the run's final bill, not the first.
    expect(report.costUsd).toBe(0.42)
    expect(report.findings).toEqual([
      { company: "Glowbar, Ltd", status: "Active", step: 2 },
      { ...FINDING_TWO, step: 3 },
    ])
    expect(report.steps).toEqual([
      { step: 1, summary: "loaded the registry", shotUrl: "/shots/1.jpg" },
      { step: 2, summary: "recorded finding #1", shotUrl: "/shots/2.jpg" },
      // Photographed, then the run ended before the step produced a result.
      { step: 3, summary: "", shotUrl: "/shots/3.jpg" },
    ])
  })

  it("calls a run that never reported an ending a failure", () => {
    const report = buildReport(GOAL, log({ type: "run_status", status: "running" }))
    expect(report.outcome).toBe("failed")
    expect(report.summary).toBe("the run ended without a report")
    expect(report.findings).toEqual([])
    expect(report.steps).toEqual([])
    expect(report.costUsd).toBe(0)
  })

  it("carries the run's status, so a run still in the air is not read as a failed one", () => {
    // No `done` yet, so the outcome is the pessimistic default — the status is what says why.
    const flying = buildReport(GOAL, log({ type: "run_status", status: "running" }))
    expect(flying.status).toBe("running")
    expect(flying.outcome).toBe("failed")
    expect(buildReport(GOAL, RUN).status).toBe("finished")
    // A caller with better information wins: meta.json outlives a log that was cut off mid-write.
    expect(buildReport(GOAL, RUN, "stopped").status).toBe("stopped")
    // Nothing announced at all is a run that never started.
    expect(buildReport(GOAL, log({ type: "done", outcome: "failed", summary: "x" })).status).toBe(
      "pending",
    )
  })

  it("keeps the findings of a run that was stopped part-way", () => {
    const report = buildReport(
      GOAL,
      log(
        { type: "screenshot", url: "/shots/1.jpg", step: 1 },
        { type: "finding", data: { company: "Glowbar Ltd" }, step: 1 },
        { type: "done", outcome: "stopped", summary: "1 finding(s) were preserved." },
      ),
    )
    expect(report.outcome).toBe("stopped")
    expect(report.findings).toEqual([{ company: "Glowbar Ltd", step: 1 }])
  })
})

describe("toMarkdown", () => {
  const md = toMarkdown(buildReport(GOAL, RUN))
  const lines = md.split("\n")

  it("opens with the title, the goal, the outcome and the summary", () => {
    expect(lines[0]).toBe("# Noctua — run report")
    expect(md).toContain(`**Goal:** ${GOAL}`)
    expect(md).toContain("**Outcome:** success")
    expect(md).toContain("$0.42")
    expect(md).toContain("Both facts check out.")
  })

  it("puts every finding key in the table header, in the order first seen, step last", () => {
    expect(md).toContain("| company | status | vat | note | step |")
    expect(md).toContain("| --- | --- | --- | --- | --- |")
  })

  it("leaves a cell empty where a finding had no such key", () => {
    expect(md).toContain("| Glowbar, Ltd | Active |  |  | 2 |")
  })

  it("escapes the characters that would otherwise break the table", () => {
    expect(md).toContain('| Glowbar, Ltd |  | GB "123" | line one<br>line two \\| pipe | 3 |')
  })

  it("numbers the step log and links each screenshot", () => {
    expect(md).toContain("1. **Step 1** — loaded the registry ([screenshot](/shots/1.jpg))")
    expect(md).toContain("2. **Step 2** — recorded finding #1 ([screenshot](/shots/2.jpg))")
    expect(md).toContain("3. **Step 3** ([screenshot](/shots/3.jpg))")
  })

  it("keeps a summary that is itself markdown from taking the document over", () => {
    const ended = log({
      type: "done",
      outcome: "failed",
      summary: "## Findings\n| a | b |\n| --- | --- |",
    })
    const taken = toMarkdown(buildReport(GOAL, ended))
    expect(taken).toContain("\\## Findings \\| a \\| b \\| \\| --- \\| --- \\|")
    // One `## Findings` in the document, and it is the one this file wrote.
    expect(taken.match(/^## Findings$/gm)).toHaveLength(1)
  })

  it("neutralises html and backticks in a cell", () => {
    const nasty = log({
      type: "finding",
      data: { note: "<img src=x onerror=alert(1)> `rm -rf`" },
      step: 1,
    })
    const md2 = toMarkdown(buildReport(GOAL, nasty))
    expect(md2).toContain("| &lt;img src=x onerror=alert(1)&gt; \\`rm -rf\\` | 1 |")
  })

  it("says so plainly when a run found nothing, rather than printing an empty table", () => {
    const ended = log({ type: "done", outcome: "failed", summary: "Nothing could be confirmed." })
    const bare = toMarkdown(buildReport(GOAL, ended))
    expect(bare).toContain("No findings were recorded")
    expect(bare).not.toContain("| --- |")
  })
})

describe("toCsv", () => {
  const csv = toCsv(buildReport(GOAL, RUN).findings)
  const rows = csv.split("\r\n")

  it("writes one header and one row per finding, CRLF-separated", () => {
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe("company,status,vat,note,step")
  })

  it("quotes a field containing a comma", () => {
    expect(rows[1]).toBe('"Glowbar, Ltd",Active,,,2')
  })

  it("doubles embedded quotes and quotes a field containing a newline", () => {
    expect(rows[2]).toBe('"Glowbar, Ltd",,"GB ""123""","line one\nline two | pipe",3')
  })

  it("renders null and undefined as an empty field, and anything else as JSON", () => {
    const odd = [{ a: null, b: undefined, c: { nested: true }, d: 3, e: false, step: 1 }]
    const rows2 = toCsv(odd).split("\r\n")
    expect(rows2[0]).toBe("a,b,c,d,e,step")
    expect(rows2[1]).toBe(',,"{""nested"":true}",3,false,1')
  })

  it("has nothing to say about a run with no findings", () => {
    expect(toCsv([])).toBe("")
  })

  it("leaves the step column out when no finding carries one", () => {
    const rows2 = toCsv([{ a: "1" }, { b: "2" }]).split("\r\n")
    expect(rows2[0]).toBe("a,b")
    expect(rows2[1]).toBe("1,")
  })

  /**
   * The rows come off pages the agent was pointed at, and land in a spreadsheet an accountant
   * opens without thinking about it. A leading `=` there is code, not text.
   */
  it("defuses a value a spreadsheet would otherwise run as a formula", () => {
    const rows2 = toCsv([
      {
        a: '=HYPERLINK("http://evil.example","click")',
        b: "+1234",
        c: "@cmd",
        d: "-2+3",
        step: 1,
      },
    ]).split("\r\n")
    expect(rows2[1]).toBe(
      `"'=HYPERLINK(""http://evil.example"",""click"")","'+1234","'@cmd","'-2+3",1`,
    )
  })

  it("defuses a leading tab or carriage return too, which Excel skips past", () => {
    expect(toCsv([{ a: "\t=1+1" }]).split("\r\n")[1]).toBe('"\'\t=1+1"')
    expect(toCsv([{ a: "\r=1+1" }]).split("\r\n")[1]).toBe('"\'\r=1+1"')
  })

  it("leaves an ordinary value alone", () => {
    expect(toCsv([{ a: "Glowbar Ltd", b: "3.50", c: "e=mc2" }]).split("\r\n")[1]).toBe(
      "Glowbar Ltd,3.50,e=mc2",
    )
  })
})

/* ---------------------------------------------------------------- the route */

const FINISH_SCRIPT: ScriptedTurn[] = [
  {
    thinking: "The registry entry is open.",
    toolName: "record_finding",
    toolInput: { data: { company: "Glowbar Ltd", vat_valid: "true" } },
  },
  {
    thinking: "That is the whole task.",
    toolName: "finish",
    toolInput: { outcome: "success", summary: "Glowbar Ltd checks out." },
  },
]

const defaults = { ...config }
afterEach(() => {
  Object.assign(config, defaults)
})

/**
 * The data directory of the app most recently built. Held here rather than read back off `config`,
 * which the `afterEach` above puts back to its default between tests.
 */
let dataDir = ""

async function newApp(llmFactory?: LLMFactory): Promise<FastifyInstance> {
  dataDir = mkdtempSync(join(tmpdir(), "noctua-report-"))
  config.dataDir = dataDir
  return buildServer({ llmFactory: llmFactory ?? (() => new FakeLLM([])) })
}

function authed(app: FastifyInstance, opts: InjectOptions) {
  return app.inject({ ...opts, cookies: { [COOKIE]: CODE } })
}

/** Two bytes that are unmistakably the start of a JPEG, standing in for a step's screenshot. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb])

/** A finished run as a restart finds it: meta.json, events.jsonl and a shot, nothing in memory. */
function seedDiskRun(events: PersistedEvent[] = RUN): string {
  const id = randomUUID()
  const dir = join(dataDir, "runs", id)
  mkdirSync(join(dir, "shots"), { recursive: true })
  writeFileSync(join(dir, "shots", "1.jpg"), JPEG)
  const meta: RunSummary = {
    id,
    goal: GOAL,
    preset: "vendor",
    createdAt: Date.now(),
    status: "finished",
    costUsd: 0.42,
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta))
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  return id
}

const exportUrl = (id: string, format?: string) =>
  `/api/runs/${id}/export${format === undefined ? "" : `?format=${format}`}`

describe("export route, for a run only disk remembers", () => {
  it("builds the markdown report from the file the last process left", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await authed(app, { method: "GET", url: exportUrl(id, "md") })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/markdown")
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="noctua-${id.slice(0, 8)}.md"`,
    )
    expect(res.body).toContain("# Noctua — run report")
    // The goal comes from meta.json — nothing in the event log knows it.
    expect(res.body).toContain(GOAL)
    expect(res.body).toContain("| company | status | vat | note | step |")
  })

  it("serves the same report as JSON", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await authed(app, { method: "GET", url: exportUrl(id, "json") })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("application/json")
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="noctua-${id.slice(0, 8)}.json"`,
    )
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(
      ["costUsd", "findings", "goal", "outcome", "status", "steps", "summary"].sort(),
    )
    expect(body.goal).toBe(GOAL)
    expect(body.outcome).toBe("success")
    // Straight off meta.json, which is the only place a run this process never drove records it.
    expect(body.status).toBe("finished")
    expect(body.costUsd).toBe(0.42)
    expect(body.findings).toHaveLength(2)
    expect(body.steps).toHaveLength(3)
  })

  it("serves a CSV Excel will open without mangling it", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await authed(app, { method: "GET", url: exportUrl(id, "csv") })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/csv")
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="noctua-${id.slice(0, 8)}.csv"`,
    )
    // A UTF-8 byte order mark: without it Excel reads é and £ as mojibake.
    expect(res.body.charCodeAt(0)).toBe(0xfeff)
    const rows = res.body.slice(1).split("\r\n")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe("company,status,vat,note,step")
  })

  it("defaults to markdown when no format is asked for", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await authed(app, { method: "GET", url: exportUrl(id) })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/markdown")
  })

  it("400s a format it cannot write", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await authed(app, { method: "GET", url: exportUrl(id, "pdf") })
    expect(res.statusCode).toBe(400)
  })

  it("404s a run that neither memory nor disk has heard of", async () => {
    const app = await newApp()
    const res = await authed(app, { method: "GET", url: exportUrl(randomUUID(), "md") })
    expect(res.statusCode).toBe(404)
  })

  it("404s an id that is not a run id, without going near the filesystem", async () => {
    const app = await newApp()
    // If the shape check did not come first, this would be a path join with a caller's `..` in it.
    const readMeta = RunStore.prototype.readMeta
    RunStore.prototype.readMeta = () => {
      throw new Error("the filesystem was touched for an id that is not a run id")
    }
    try {
      for (const id of ["..", "..%2F..%2Fetc%2Fpasswd", "..%2Fmeta.json", "nope", "%2Fetc"]) {
        const res = await authed(app, { method: "GET", url: exportUrl(id, "md") })
        expect(res.statusCode, id).toBe(404)
      }
    } finally {
      RunStore.prototype.readMeta = readMeta
    }
  })

  it("needs the cookie", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await app.inject({ method: "GET", url: exportUrl(id, "md") })
    expect(res.statusCode).toBe(401)
  })

  /** Without this, every screenshot link in a report exported after a restart is a broken image. */
  it("serves the screenshots of a run only disk remembers", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    const res = await authed(app, { method: "GET", url: `/api/runs/${id}/shots/1.jpg` })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("image/jpeg")
    expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it("refuses a missing shot, a traversal and an unknown run just as firmly off disk", async () => {
    const app = await newApp()
    const id = seedDiskRun()
    for (const file of ["9.jpg", "..%2F..%2Fmeta.json", "..%2Fmeta.json", "..", "meta.json"]) {
      const res = await authed(app, { method: "GET", url: `/api/runs/${id}/shots/${file}` })
      expect(res.statusCode, file).toBe(404)
    }
    const url = `/api/runs/${randomUUID()}/shots/1.jpg`
    expect((await authed(app, { method: "GET", url })).statusCode).toBe(404)
  })
})

describe("replaying a run only disk remembers", () => {
  let app: FastifyInstance
  let base: string

  beforeAll(async () => {
    app = await newApp()
    await app.listen({ port: 0, host: "127.0.0.1" })
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await app.close()
  })

  it("streams the whole log of a finished run this process never drove", async () => {
    const id = seedDiskRun()
    const { res, text } = await readSse(`${base}/api/runs/${id}/events?from=1`, '"type":"done"')
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(text).toContain("id: 1\n")
    expect(text).toContain('"type":"finding"')
    expect(text).toContain("Both facts check out.")
  })

  it("still 404s a run that is nowhere", async () => {
    const res = await fetch(`${base}/api/runs/${randomUUID()}/events`, {
      headers: { cookie: `${COOKIE}=${CODE}` },
    })
    expect(res.status).toBe(404)
    await res.body?.cancel()
  })
})

/** Reads an event stream until `needle` shows up (or the deadline passes), then hangs up. */
async function readSse(
  url: string,
  needle: string,
  timeoutMs = 5_000,
): Promise<{ res: Response; text: string }> {
  const ac = new AbortController()
  const res = await fetch(url, { headers: { cookie: `${COOKIE}=${CODE}` }, signal: ac.signal })
  let text = ""
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  if (res.ok && res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + timeoutMs
    while (!text.includes(needle) && Date.now() < deadline) {
      pending ??= reader.read()
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))
      })
      const chunk = await Promise.race([pending, idle])
      clearTimeout(timer)
      if (chunk === null) break
      pending = null
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  }
  ac.abort()
  pending?.catch(() => undefined)
  return { res, text }
}

describe("export route, for a run this process is driving", () => {
  let app: FastifyInstance
  let id: string

  beforeAll(async () => {
    app = await newApp(() => new FakeLLM(FINISH_SCRIPT))
    const created = await authed(app, {
      method: "POST",
      url: "/api/runs",
      payload: { goal: GOAL, preset: "vendor" },
    })
    expect(created.statusCode).toBe(201)
    id = created.json().id as string
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const listed = await authed(app, { method: "GET", url: "/api/runs" })
      const summary = (listed.json() as RunSummary[]).find((r) => r.id === id)
      if (summary && summary.status === "finished") return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("the run never finished")
  }, 40_000)

  afterAll(async () => {
    await app.close()
  })

  it("exports markdown built from the log the loop just wrote", async () => {
    const res = await authed(app, { method: "GET", url: exportUrl(id, "md") })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/markdown")
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="noctua-${id.slice(0, 8)}.md"`,
    )
    expect(res.body).toContain(GOAL)
    expect(res.body).toContain("Glowbar Ltd checks out.")
    expect(res.body).toContain("| company | vat_valid | step |")
    // The screenshot link is the live route, so the report is browsable as well as printable.
    expect(res.body).toContain(`([screenshot](/api/runs/${id}/shots/1.jpg))`)
  })

  it("exports JSON with the run's real spend on it", async () => {
    const res = await authed(app, { method: "GET", url: exportUrl(id, "json") })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("application/json")
    const body = res.json()
    expect(body.goal).toBe(GOAL)
    expect(body.outcome).toBe("success")
    expect(body.status).toBe("finished")
    expect(body.costUsd).toBeGreaterThan(0)
    expect(body.findings).toEqual([{ company: "Glowbar Ltd", vat_valid: "true", step: 1 }])
  })

  it("exports the ledger-ready CSV", async () => {
    const res = await authed(app, { method: "GET", url: exportUrl(id, "csv") })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/csv")
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="noctua-${id.slice(0, 8)}.csv"`,
    )
    expect(res.body.slice(1).split("\r\n")).toEqual([
      "company,vat_valid,step",
      "Glowbar Ltd,true,1",
    ])
  })
})
