import { describe, it, expect, beforeAll, afterAll } from "vitest"
import sharp from "sharp"
import { createBrowserPage } from "../../src/browser/session.js"
import { capture, snapshotText } from "../../src/browser/snapshot.js"
import { serveFixtures } from "../fixtures/serve.js"

// Chromium launch is the slow part, so one browser and one server serve every case.
let fx: Awaited<ReturnType<typeof serveFixtures>>
let bp: Awaited<ReturnType<typeof createBrowserPage>>
beforeAll(async () => {
  fx = await serveFixtures()
  bp = await createBrowserPage({ allowRequest: fx.allowRequest })
})
afterAll(async () => {
  await bp.close()
  await fx.close()
})

describe("snapshot", () => {
  it("captures numbered interactive elements and a screenshot", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    expect(snap.title).toContain("Registry")
    const search = snap.elements.find((e) => e.role === "textbox")
    expect(search).toBeDefined()
    expect(snap.screenshotJpeg.length).toBeGreaterThan(1000)
    expect(snapshotText(snap)).toMatch(/\[\d+\] textbox/)
    const el = await bp.page.$(`[data-noctua-ref="${search!.ref}"]`)
    expect(el).not.toBeNull()
  })

  it("downscales the screenshot to a 1024px-wide jpeg", async () => {
    await bp.page.goto(fx.baseUrl + "/company.html")
    const snap = await capture(bp.page)
    const meta = await sharp(snap.screenshotJpeg).metadata()
    expect(meta.format).toBe("jpeg")
    expect(meta.width).toBe(1024) // 1280px viewport, downscaled for the model's image budget
  })

  it("numbers refs 1..n and names elements from their text, placeholder or value", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    expect(snap.elements.map((e) => e.ref)).toEqual(snap.elements.map((_, i) => i + 1))
    expect(snap.elements.some((e) => e.role === "link" && e.name === "Home")).toBe(true)
    expect(snap.elements.some((e) => e.role === "button" && e.name === "Search")).toBe(true)
    // The search box has no text content — its name comes from the placeholder.
    const search = snap.elements.find((e) => e.role === "textbox")!
    expect(search.name.length).toBeGreaterThan(0)
    expect(search.name.length).toBeLessThanOrEqual(80)
  })

  it("names a dropdown by its choices, so the model can pick one without opening it", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    const select = snap.elements.find((e) => e.role === "combobox")!
    expect(select.name).toBe("jurisdiction — options: England and Wales|Scotland")
    expect(select.name.length).toBeLessThanOrEqual(80)
  })

  it("keeps a long option list inside the name cap and says how many it hid", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    const country = snap.elements.find((e) => e.name.startsWith("country"))!
    const all = await bp.page.$$eval("#country option", (options) =>
      options.map((option) => option.textContent!.trim()),
    )
    expect(all).toHaveLength(27)

    expect(country.name.length).toBeLessThanOrEqual(80)
    const marker = country.name.match(/…\(\+(\d+) more\)$/)
    expect(marker, `expected a "+N more" marker in ${JSON.stringify(country.name)}`).not.toBeNull()

    // Every label the model is shown must be a whole one — a half-spelled country is worse than
    // no country, because the model would then try to select it.
    const shown = country.name
      .slice("country — options: ".length)
      .replace(/\|?…\(\+\d+ more\)$/, "")
      .split("|")
      .filter((label) => label !== "")
    expect(shown.length).toBeGreaterThan(0)
    for (const label of shown) expect(all).toContain(label)
    expect(shown.length + Number(marker![1])).toBe(all.length)
  })

  it("advertises an option by the label playwright will match, not its text", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    const filing = snap.elements.find((e) => e.name.startsWith("filing"))!
    // The option reads "AR — B1" on screen but carries label="Annual return (B1)".
    expect(filing.name).toBe("filing — options: Annual return (B1)|Confirmation statement")
  })

  it("admits when the listing was cut off at the element cap", async () => {
    await bp.page.goto(fx.baseUrl + "/crowded.html")
    const snap = await capture(bp.page)
    expect(snap.elements).toHaveLength(120)
    expect(snap.truncated).toBe(true)
    const lines = snapshotText(snap).split("\n")
    expect(lines[lines.length - 1]).toBe("(listing truncated at 120 elements)")
  })

  it("says nothing about truncation on a page that fits", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    expect(snap.truncated).toBe(false)
    expect(snapshotText(snap)).not.toContain("truncated")
  })

  it("renders URL, TITLE and one line per element", async () => {
    await bp.page.goto(fx.baseUrl + "/index.html")
    const snap = await capture(bp.page)
    const text = snapshotText(snap)
    const lines = text.split("\n")
    expect(lines[0]).toBe(`URL: ${snap.url}`)
    expect(lines[1]).toBe(`TITLE: ${snap.title}`)
    expect(lines[2]).toBe("")
    expect(lines.slice(3)).toHaveLength(snap.elements.length)
    expect(lines[3]).toMatch(/^\[1\] \w+ ".*"$/)
  })

  it("skips hidden elements and re-tags the DOM on every capture", async () => {
    await bp.page.goto(fx.baseUrl + "/vendor.html")
    const first = await capture(bp.page)
    expect(first.elements.some((e) => e.name === "Hidden action")).toBe(false)
    expect(first.elements.some((e) => e.name === "Display none action")).toBe(false)

    // A stale ref from a previous capture must never survive into the next one.
    const staleRef = first.elements.length + 500
    await bp.page.evaluate((ref) => {
      document.querySelector("h1")!.setAttribute("data-noctua-ref", String(ref))
    }, staleRef)
    const second = await capture(bp.page)
    expect(second.elements.map((e) => e.ref)).toEqual(first.elements.map((e) => e.ref))
    expect(await bp.page.$(`[data-noctua-ref="${staleRef}"]`)).toBeNull()
    const tagged = await bp.page.$$eval("[data-noctua-ref]", (els) => els.length)
    expect(tagged).toBe(second.elements.length)
  })

  it("refuses refs for elements a click cannot land on", async () => {
    await bp.page.goto(fx.baseUrl + "/vendor.html")
    const snap = await capture(bp.page)
    const named = snap.elements.map((e) => e.name)
    expect(named).not.toContain("Zero size link") // laid out, but 0×0 — Playwright would time out
    expect(named).not.toContain("Disabled action")
    expect(named).not.toContain("Aria hidden action")
    // ...while the clickable control in the same block is still offered.
    expect(named).toContain("Request a quote")
  })

  it("truncates long names to 80 characters and never names an input from its password", async () => {
    await bp.page.goto(fx.baseUrl + "/vendor.html")
    const snap = await capture(bp.page)

    const long = snap.elements.find((e) => e.name.startsWith("Download the full"))!
    expect(long).toBeDefined()
    expect(long.name).toHaveLength(80)
    expect(long.name).toBe(
      "Download the full fixture-grade lighting product catalogue for the current finan",
    )

    const password = snap.elements.find((e) => e.name === "secret")!
    expect(password).toBeDefined() // named from the `name` attribute, having skipped `value`
    expect(snapshotText(snap)).not.toContain("hunter2")
    expect(snap.elements.every((e) => !e.name.includes("hunter2"))).toBe(true)
  })

  it("follows the registry search form to the company page", async () => {
    await bp.page.goto(fx.baseUrl + "/registry.html")
    const snap = await capture(bp.page)
    const box = snap.elements.find((e) => e.role === "textbox")!
    const submit = snap.elements.find((e) => e.role === "button" && e.name === "Search")!
    await bp.page.fill(`[data-noctua-ref="${box.ref}"]`, "Glowbar")
    await Promise.all([
      bp.page.waitForURL(/company\.html/),
      bp.page.click(`[data-noctua-ref="${submit.ref}"]`),
    ])
    const after = await capture(bp.page)
    expect(after.url).toContain("q=Glowbar")
    expect(await bp.page.textContent("body")).toContain("Glowbar Ltd")
    expect(after.elements.length).toBeGreaterThan(0)
  })
})
