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
  it("offers exactly the ten tools the loop drives", () => {
    expect(toolDefs.map((t) => t.name)).toEqual([
      "navigate",
      "click",
      "type",
      "select_option",
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

  // The tool description and the system prompt are read together; they must not disagree about
  // where field names come from or about `source` being mandatory.
  it("points record_finding at the task's schema and at source", () => {
    const def = toolDefs.find((t) => t.name === "record_finding")!
    expect(def.description).toMatch(/exactly those field names/)
    expect(def.description).toMatch(/source/)
  })

  it("bounds the wait so the model is told the ceiling, not just clamped at it", () => {
    const seconds = (toolDefs.find((t) => t.name === "wait")!.input_schema.properties ?? {}) as {
      seconds: { minimum?: number; maximum?: number }
    }
    expect(seconds.seconds.minimum).toBe(1)
    expect(seconds.seconds.maximum).toBe(10)
  })

  it("marks the arguments the model must always supply", () => {
    const required = Object.fromEntries(toolDefs.map((t) => [t.name, t.input_schema.required ?? []]))
    expect(required).toEqual({
      navigate: ["url"],
      click: ["ref", "why"],
      type: ["ref", "text", "why"],
      select_option: ["ref", "option", "why"],
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

  it("clicks a ref, waits out the navigation it caused, and names the element", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const link = (await capture(ctx.page)).elements.find((e) => e.name === "Glowbar Ltd")!

    const out = await executeTool("click", { ref: link.ref, why: "open the company record" }, ctx)
    expect(out.summary).toBe(`clicked [${link.ref}] "Glowbar Ltd"`)
    expect(ctx.page.url()).toContain("q=Glowbar")
    // Settled, not merely dispatched: the new document is readable the moment the tool returns.
    expect(await ctx.page.textContent("body")).toContain("Glowbar Ltd")
  })

  it("returns promptly from a click that goes nowhere", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/vendor.html" }, ctx)
    const button = (await capture(ctx.page)).elements.find((e) => e.name === "Request a quote")!

    const startedAt = Date.now()
    await executeTool("click", { ref: button.ref, why: "ask for a quote" }, ctx)
    const elapsed = Date.now() - startedAt

    // The click still happened — the fixture's handler renames the page.
    expect(await ctx.page.title()).toBe("Glowbar — Contacted")
    // ...and cost the grace window, not the full settle timeout.
    expect(elapsed).toBeLessThan(3000)
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
      // The model is told where the tab ended up, so its observation matches the next screenshot.
      `blocked: private ip 10.0.0.1; the tab was returned to ${fx.baseUrl}/registry.html`,
    )
    expect(ctx.page.url()).toBe(fx.baseUrl + "/registry.html")
  })

  it("leaves no blocked page loaded when the landing is refused on the first navigation", async () => {
    // A redirect or DNS rebind on the run's very first navigation: the address passes the guard
    // when the model asks for it, and fails once the browser has landed. Whatever the recovery
    // does, what must not happen is the blocked page staying up for the next screenshot.
    const fresh = await bp.page.context().newPage()
    try {
      let checks = 0
      const rebinding: ToolCtx = {
        page: fresh,
        findings: [],
        askHuman: async () => "",
        checkUrl: async () => {
          checks += 1
          if (checks > 1) throw new Error("blocked: private ip 169.254.169.254")
        },
      }

      await expect(
        executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, rebinding),
      ).rejects.toThrow(/^blocked:/)
      expect(fresh.url()).not.toContain("registry.html")
      expect(await fresh.content()).not.toContain("Fixture Companies Registry")
    } finally {
      await fresh.close()
    }
  })

  it("says so rather than claiming a move when there is nothing to go back to", async () => {
    const fresh = await bp.page.context().newPage()
    try {
      const own: ToolCtx = { ...ctx, page: fresh }
      await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, own)

      // Playwright reports no response for either step; only the URL says which one moved.
      expect((await executeTool("go_back", {}, own)).summary).toBe("went back to about:blank")
      expect((await executeTool("go_back", {}, own)).summary).toBe(
        "no earlier page in history — still at about:blank",
      )
    } finally {
      await fresh.close()
    }
  })

  it("names a stale ref instead of timing out on a missing element", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/index.html" }, ctx)
    // The recovery has to be spelled out: "look again" is not something the toolset can do,
    // whereas the next listing arrives on its own with the right number in it.
    await expect(executeTool("click", { ref: 9999, why: "click nothing" }, ctx)).rejects.toThrow(
      /stale ref \[9999\][^]*use the numbers from the LATEST element listing/,
    )
    await expect(
      executeTool("type", { ref: 9999, text: "x", why: "type nowhere" }, ctx),
    ).rejects.toThrow(/use the numbers from the LATEST element listing/)
    await expect(
      executeTool("select_option", { ref: 9999, option: "x", why: "pick nothing" }, ctx),
    ).rejects.toThrow(/use the numbers from the LATEST element listing/)
  })

  it("selects a dropdown option by its visible label", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const select = (await capture(ctx.page)).elements.find((e) => e.role === "combobox")!

    const out = await executeTool(
      "select_option",
      { ref: select.ref, option: "Scotland", why: "the company is Scottish" },
      ctx,
    )
    expect(out.summary).toBe(`selected "Scotland" in [${select.ref}]`)
    expect(await ctx.page.inputValue("select[name=jurisdiction]")).toBe("sc")
  })

  it("falls back to the option's value when the label does not match", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const select = (await capture(ctx.page)).elements.find((e) => e.role === "combobox")!
    await ctx.page.selectOption("select[name=jurisdiction]", "sc") // move off the default first

    const out = await executeTool(
      "select_option",
      { ref: select.ref, option: "ew", why: "the registry expects the code" },
      ctx,
    )
    expect(out.summary).toBe(`selected "ew" in [${select.ref}]`)
    expect(await ctx.page.inputValue("select[name=jurisdiction]")).toBe("ew")
  })

  it("lists the real options when the model asks for one that does not exist", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const select = (await capture(ctx.page)).elements.find((e) => e.role === "combobox")!

    await expect(
      executeTool(
        "select_option",
        { ref: select.ref, option: "Wales only", why: "guessing at the jurisdiction" },
        ctx,
      ),
    ).rejects.toThrow(/England and Wales[^]*Scotland/)
    // The page is left as it was, so the next screenshot and the observation agree.
    expect(await ctx.page.inputValue("select[name=jurisdiction]")).toBe("ew")
  })

  it("caps the option list in the error rather than pasting a whole country list", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const country = (await capture(ctx.page)).elements.find((e) => e.name.startsWith("country"))!

    const failure = await executeTool(
      "select_option",
      { ref: country.ref, option: "Atlantis", why: "guessing at the member state" },
      ctx,
    ).catch((err: Error) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain("Austria")
    expect(message).toMatch(/… and 12 more$/) // 27 options, 15 shown
    expect(message.length).toBeLessThan(400)
  })

  it("selects an option by its label attribute, which is what the listing showed", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/registry.html" }, ctx)
    const filing = (await capture(ctx.page)).elements.find((e) => e.name.startsWith("filing"))!

    const out = await executeTool(
      "select_option",
      { ref: filing.ref, option: "Annual return (B1)", why: "the client files a B1" },
      ctx,
    )
    expect(out.summary).toBe(`selected "Annual return (B1)" in [${filing.ref}]`)
    expect(await ctx.page.inputValue("select[name=filing]")).toBe("ar")
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
    const scrollY = () => ctx.page.evaluate(() => window.scrollY)
    expect(await scrollY()).toBe(0)

    expect((await executeTool("scroll", { direction: "down" }, ctx)).summary).toBe("scrolled down")
    const afterDown = await scrollY()
    expect(afterDown).toBeGreaterThan(0)

    expect((await executeTool("scroll", { direction: "up" }, ctx)).summary).toBe("scrolled up")
    expect(await scrollY()).toBeLessThan(afterDown)
  })

  it("says the page did not move rather than claiming a scroll", async () => {
    await executeTool("navigate", { url: fx.baseUrl + "/vendor.html" }, ctx)
    const out = await executeTool("scroll", { direction: "up" }, ctx)
    expect(out.summary).toBe("already at the top of the page")
    expect(await ctx.page.evaluate(() => window.scrollY)).toBe(0)
  })

  it("clamps a wait up to the shortest allowed pause", async () => {
    const out = await executeTool("wait", { seconds: 0, reason: "page loading" }, ctx)
    expect(out.summary).toBe("waiting 1s: page loading")
  })

  it("clamps a wait down to the longest allowed pause", async () => {
    const startedAt = Date.now()
    const out = await executeTool("wait", { seconds: 99, reason: "slow report" }, ctx)
    const elapsed = Date.now() - startedAt

    expect(out.summary).toBe("waiting 10s: slow report")
    // The clamp is what is being tested: 99s would blow the run's budget, 10s is the ceiling.
    expect(elapsed).toBeGreaterThan(9_000)
    expect(elapsed).toBeLessThan(12_000)
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
    // Choosing a dropdown value posts nothing on its own — the submit that follows is the gate.
    expect(isGuarded("select_option", { ref: 1, option: "Ireland", why: "member state" })).toBe(
      false,
    )
  })
})
