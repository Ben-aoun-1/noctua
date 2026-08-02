import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest"
import { createBrowserPage } from "../../src/browser/session.js"
import { capture } from "../../src/browser/snapshot.js"
import { assertSafeUrl } from "../../src/safety/urlGuard.js"
import { executeTool, isGuarded, toolDefs, type ToolCtx } from "../../src/agent/tools.js"
import { serveFixtures } from "../fixtures/serve.js"

// Chromium launch is the slow part, so one browser and one server serve every case.
let fx: Awaited<ReturnType<typeof serveFixtures>>
let bp: Awaited<ReturnType<typeof createBrowserPage>>
let ctx: ToolCtx
let asked: string[]

beforeAll(async () => {
  fx = await serveFixtures()
  bp = await createBrowserPage()
})
afterAll(async () => {
  await bp.close()
  await fx.close()
})

/**
 * The fixture server binds 127.0.0.1, which `assertSafeUrl` blocks by design. Tests inject a
 * checker that allows exactly that origin and delegates every other URL to the real guard, so
 * the guard is still the thing being exercised everywhere it matters.
 */
function allowFixtureOrigin(baseUrl: string): (url: string) => Promise<void> {
  return async (url: string) => {
    if (url === baseUrl || url.startsWith(baseUrl + "/")) return
    await assertSafeUrl(url)
  }
}

beforeEach(() => {
  asked = []
  ctx = {
    page: bp.page,
    findings: [],
    askHuman: async (q) => {
      asked.push(q)
      return "  yes, that is the right company  "
    },
    checkUrl: allowFixtureOrigin(fx.baseUrl),
  }
})

describe("tool definitions", () => {
  it("offers exactly the nine tools the loop drives", () => {
    expect(toolDefs.map((t) => t.name)).toEqual([
      "navigate",
      "click",
      "type",
      "scroll",
      "go_back",
      "wait",
      "record_finding",
      "ask_human",
      "finish",
    ])
  })

  it("closes every schema and documents every property for the model", () => {
    for (const def of toolDefs) {
      expect(def.description, `${def.name} needs a description`).toBeTruthy()
      expect(def.input_schema.type).toBe("object")
      expect(def.input_schema.additionalProperties).toBe(false)
      const properties = (def.input_schema.properties ?? {}) as Record<string, { description?: string }>
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description, `${def.name}.${name} needs a description`).toBeTruthy()
      }
    }
  })

  it("marks the arguments the model must always supply", () => {
    const required = Object.fromEntries(toolDefs.map((t) => [t.name, t.input_schema.required ?? []]))
    expect(required).toEqual({
      navigate: ["url"],
      click: ["ref", "why"],
      type: ["ref", "text", "why"],
      scroll: ["direction"],
      go_back: [],
      wait: ["seconds", "reason"],
      record_finding: ["data"],
      ask_human: ["question"],
      finish: ["outcome", "summary"],
    })
  })
})

describe("executeTool", () => {
  it("navigates and reports the landed url and title", async () => {
    const out = await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    expect(out.summary).toBe(`navigated to ${fx.baseUrl}/registry.html ("Fixture Companies Registry")`)
    expect(ctx.page.url()).toBe(fx.baseUrl + "/registry.html")
  })

  it("refuses a private address with the default guard", async () => {
    // No `checkUrl` — production wiring, so `assertSafeUrl` is the one that must say no.
    const production: ToolCtx = { page: bp.page, findings: [], askHuman: async () => "" }
    await expect(executeTool("navigate", { url: "http://127.0.0.1:1/" }, production)).rejects.toThrow(
      /^blocked:/,
    )
  })

  it("types into a ref and submits, following the form to the results page", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const box = (await capture(ctx.page)).elements.find((e) => e.role === "textbox")!

    const out = await executeTool(
      "type",
      { ref: box.ref, text: "Glowbar", submit: true, why: "search the register" },
      ctx,
    )
    expect(out.summary).toContain(`typed "Glowbar" into [${box.ref}]`)
    expect(out.summary).toContain("and submitted")
    expect(ctx.page.url()).toContain("q=Glowbar")
    expect(await ctx.page.textContent("body")).toContain("Glowbar Ltd")
  })

  it("clicks a ref and names the element it clicked", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const link = (await capture(ctx.page)).elements.find((e) => e.name === "Glowbar Ltd")!

    const out = await executeTool("click", { ref: link.ref, why: "open the company record" }, ctx)
    expect(out.summary).toBe(`clicked [${link.ref}] "Glowbar Ltd"`)
    expect(ctx.page.url()).toContain("q=Glowbar")
  })

  it("steps back off a destination the guard refuses", async () => {
    // Stands in for a link or redirect that lands somewhere the model could not have navigated
    // to directly: the check that matters is the one on the URL the browser actually reached.
    const forbidden = `${fx.baseUrl}/company.html`
    const allowed = allowFixtureOrigin(fx.baseUrl)
    ctx.checkUrl = async (url) => {
      if (url.startsWith(forbidden)) throw new Error("blocked: private ip 10.0.0.1")
      await allowed(url)
    }
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const link = (await capture(ctx.page)).elements.find((e) => e.name === "Glowbar Ltd")!

    await expect(executeTool("click", { ref: link.ref, why: "open the record" }, ctx)).rejects.toThrow(
      /^blocked:/,
    )
    expect(ctx.page.url()).toBe(fx.baseUrl + "/registry.html")
  })

  it("names a stale ref instead of timing out on a missing element", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/index.html" }, ctx)
    await expect(executeTool("click", { ref: 9999, why: "click nothing" }, ctx)).rejects.toThrow(
      /stale ref \[9999\]/,
    )
  })

  it("goes back to the previous page", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    await executeTool("navigate", { url: fx.baseUrl + "/company.html" }, ctx)

    const out = await executeTool("go_back", {}, ctx)
    expect(out.summary).toContain("registry.html")
    expect(ctx.page.url()).toBe(fx.baseUrl + "/registry.html")
  })

  it("scrolls the page down and back up", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/vendor.html" }, ctx)
    expect((await executeTool("scroll", { direction: "down" }, ctx)).summary).toBe("scrolled down")
    expect((await executeTool("scroll", { direction: "up" }, ctx)).summary).toBe("scrolled up")
  })

  it("clamps a wait to the allowed range", async () => {
    const out = await executeTool("wait", { seconds: 0, reason: "page loading" }, ctx)
    expect(out.summary).toBe("waiting 1s: page loading")
  })

  it("records findings in order and counts them", async () => {
    const first = await executeTool("record_finding", { data: { name: "Glowbar Ltd" } }, ctx)
    const second = await executeTool("record_finding", { data: { name: "Vendor Ltd" } }, ctx)
    expect(first.summary).toBe("recorded finding #1")
    expect(second.summary).toBe("recorded finding #2")
    expect(ctx.findings).toEqual([{ name: "Glowbar Ltd" }, { name: "Vendor Ltd" }])
  })

  it("rejects a finding that is not an object", async () => {
    await expect(executeTool("record_finding", { data: "Glowbar Ltd" }, ctx)).rejects.toThrow()
    await expect(executeTool("record_finding", { data: [1, 2] }, ctx)).rejects.toThrow()
    expect(ctx.findings).toEqual([])
  })

  it("puts the question to the human and echoes the answer", async () => {
    const out = await executeTool("ask_human", { question: "Is this the right Glowbar?" }, ctx)
    expect(asked).toEqual(["Is this the right Glowbar?"])
    expect(out.summary).toBe("human answered: yes, that is the right company")
  })

  it("returns the finish outcome the loop stops on", async () => {
    const out = await executeTool("finish", { outcome: "partial", summary: "found 2 of 3 rows" }, ctx)
    expect(out.summary).toBe("finished")
    expect(out.finish).toEqual({ outcome: "partial", summary: "found 2 of 3 rows" })
  })

  it("rejects an unknown finish outcome", async () => {
    await expect(executeTool("finish", { outcome: "done", summary: "" }, ctx)).rejects.toThrow()
  })

  it("throws on an unknown tool name", async () => {
    await expect(executeTool("teleport", { url: "https://example.com" }, ctx)).rejects.toThrow(
      /unknown tool/,
    )
  })
})

describe("isGuarded", () => {
  it("gates only a submitting type", () => {
    expect(isGuarded("type", { ref: 1, text: "x", submit: true })).toBe(true)
    expect(isGuarded("type", { ref: 1, text: "x", submit: false })).toBe(false)
    expect(isGuarded("type", { ref: 1, text: "x" })).toBe(false)
    expect(isGuarded("click", { ref: 1, why: "pay now" })).toBe(false)
    expect(isGuarded("navigate", { url: "https://example.com" })).toBe(false)
  })
})
