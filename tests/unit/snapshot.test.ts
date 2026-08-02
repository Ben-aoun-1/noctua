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
  bp = await createBrowserPage()
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
