import { describe, it, expect } from "vitest"
import { buildSystemPrompt, presetGoalTemplate, type Preset } from "../../src/agent/prompts.js"

const PRESETS: Preset[] = ["vendor", "compliance", null]

/** Field names the report/table UI reads; the prompt is where the model learns them. */
const VENDOR_KEYS = [
  "legal_name",
  "query_name",
  "company_number",
  "vat_number",
  "vat_valid",
  "registry_status",
  "address",
  "website",
  "source",
]
const COMPLIANCE_KEYS = ["jurisdiction", "title", "date_or_value", "detail", "source"]

describe("buildSystemPrompt — shared contract", () => {
  it.each(PRESETS)("names Noctua and the job (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("Noctua")
    expect(p).toContain("the owl of Minerva")
    expect(p).toContain("accountant")
  })

  it.each(PRESETS)("is long enough to be worth caching (%s)", (preset) => {
    expect(buildSystemPrompt(preset).length).toBeGreaterThan(1500)
  })

  // The system block is sent with cache_control: identical inputs must yield an identical
  // string, or every turn misses the cache.
  it.each(PRESETS)("is deterministic (%s)", (preset) => {
    expect(buildSystemPrompt(preset)).toBe(buildSystemPrompt(preset))
  })

  it.each(PRESETS)("forbids typing credentials outright (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("Never type passwords")
    expect(p).toContain("API keys")
    expect(p).toContain("card numbers")
    // The escape hatch has to be named, or "never" leaves the model with nowhere to go.
    expect(p).toMatch(/login or payment[^.]*ask_human/)
  })

  it.each(PRESETS)("routes CAPTCHAs and login walls to the human (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/CAPTCHA/)
    expect(p).toMatch(/login wall/)
    expect(p).toContain("ask_human")
  })

  it.each(PRESETS)("pins element refs to the latest listing (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("Element numbers [N] refer to the LATEST page listing only")
    expect(p).toMatch(/never invent/i)
  })

  it.each(PRESETS)("states the one-tool-per-turn loop and the retry budget (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/exactly one tool per turn/i)
    expect(p).toMatch(/do not repeat the same call/i)
    expect(p).toMatch(/second attempt[^.]*ask_human/i)
  })

  // snapshotText numbers from 1; a worked example starting at [0] teaches an off-by-one.
  it.each(PRESETS)("shows a worked observation with 1-based refs (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain('[1] link "Home"')
    expect(p).not.toMatch(/^\[0\] /m)
  })

  // The listing is built from the whole DOM, not the viewport: scrolling reveals pixels and
  // triggers lazy rendering, it does not reveal refs.
  it.each(PRESETS)("describes scrolling as a screenshot concern (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/listing covers the whole page/i)
    expect(p).toMatch(/lazy/i)
    expect(p).not.toMatch(/scroll or navigate to a page that has it/)
  })

  // "Not listed means not on the page" is false when the listing hit its element cap.
  it.each(PRESETS)("allows for a truncated listing (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("(listing truncated at 120 elements)")
    expect(p).toMatch(/unless the listing says it was truncated/i)
  })

  it.each(PRESETS)("reserves wait for a page that is still rendering (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/still loading or rendering/i)
    expect(p).toMatch(/1-3 seconds|1 to 3 seconds/)
    expect(p).toMatch(/does not count as your one retry/i)
    expect(p).toContain("go_back")
  })

  it.each(PRESETS)("teaches record_finding discipline with a source url (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("record_finding")
    expect(p).toMatch(/one call per fact/i)
    expect(p).toMatch(/never (save|record) everything at the end/i)
    expect(p).toMatch(/`source`/)
    expect(p).toMatch(/step number is (attached|added) for you/i)
    // "record the moment you confirm" must yield to a preset that defines one row per entity.
    expect(p).toMatch(/row schema[^.]*wins/i)
  })

  it.each(PRESETS)("prefers official sources (%s)", (preset) => {
    expect(buildSystemPrompt(preset)).toMatch(/official/i)
  })

  // The run opens on about:blank, and no tool "looks at" a page — the listing arrives on its own.
  it.each(PRESETS)("says where the run starts (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/blank tab/i)
    expect(p).toContain("navigate")
  })

  // "Do not post content" must not read as "do not submit the VIES form".
  it.each(PRESETS)("separates ordinary form use from acting in the world (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/search or lookup form/i)
    expect(p).toMatch(/do not create accounts/i)
  })

  it.each(PRESETS)("sends an ambiguous task to the human before guessing (%s)", (preset) => {
    expect(buildSystemPrompt(preset)).toMatch(/ambiguous[^.]*ask_human/i)
  })

  // The loop appends these alongside steering notes; unexplained, they read as page content.
  // The budget note is quoted verbatim so the model recognizes the exact string it will get.
  it.each(PRESETS)("prepares the agent for stuck, circling and budget notes (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/stuck/i)
    expect(p).toMatch(/returned to a page/i)
    expect(p).toContain("BUDGET EXHAUSTED")
  })

  it.each(PRESETS)("asks the agent to pace its step budget (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toMatch(/step budget/i)
    expect(p).toMatch(/pace/i)
  })

  it.each(PRESETS)("makes USER STEERING binding (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("USER STEERING:")
    expect(p).toMatch(/binding/i)
  })

  it.each(PRESETS)("demands an honest finish outcome (%s)", (preset) => {
    const p = buildSystemPrompt(preset)
    expect(p).toContain("finish")
    for (const outcome of ["success", "partial", "failed"]) expect(p).toContain(outcome)
    expect(p).toMatch(/never claim success/i)
  })

  it.each(PRESETS)("closes on the live-reasoning note (%s)", (preset) => {
    expect(buildSystemPrompt(preset).trimEnd()).toMatch(
      /Your reasoning is streamed live to the user — think clearly and narrate decisions briefly\.$/,
    )
  })
})

describe("buildSystemPrompt — vendor preset", () => {
  const p = buildSystemPrompt("vendor")

  it("declares the exact vendor finding schema", () => {
    expect(p).toContain('"kind": "vendor"')
    for (const key of VENDOR_KEYS) expect(p).toContain(key)
  })

  it("defines the vat_valid vocabulary", () => {
    expect(p).toContain("vat_valid")
    expect(p).toContain('"yes"')
    expect(p).toContain('"no"')
    expect(p).toContain('"unknown"')
  })

  it("points at official registries before the vendor's own site", () => {
    expect(p).toContain("ec.europa.eu/taxation_customs/vies")
    expect(p).toContain("find-and-update.company-information.service.gov.uk")
    expect(p.indexOf("VIES")).toBeLessThan(p.indexOf("vendor's own website"))
  })

  // The paragraph above the list says to read the vendor's own site and *then* open the registry
  // record it writes the row from. A numbered list claiming to be "this order" with the website
  // fourth told it the opposite, and the model has to resolve the contradiction on the fly.
  it("lists its sources without contradicting when the row gets written", () => {
    expect(p).not.toMatch(/in this order/i)
    expect(p).toMatch(/before you open the registry record/i)
  })

  it("asks for a vendor-master table recap at the end", () => {
    expect(p).toMatch(/vendor-master table/)
  })

  // What VIES wants typed and what the row must record differ; say so, or it reads as a conflict.
  it("keeps the typed VAT number distinct from the recorded one", () => {
    expect(p).toMatch(/without the two-letter country prefix/)
    expect(p).toMatch(/record .*with (its|the) prefix/i)
  })

  it("drives the VIES member-state dropdown with select_option", () => {
    expect(p).toContain("select_option")
  })

  // Base says "record the moment you confirm"; a vendor row is only whole after every check.
  it("makes a vendor row one row, written after the checks are done", () => {
    expect(p).toMatch(/exactly once/)
    expect(p).toMatch(/registry page that establishes the legal identity/)
  })

  it("does not leak the compliance schema", () => {
    expect(p).not.toContain("date_or_value")
    expect(p).not.toContain("compliance calendar")
  })
})

describe("buildSystemPrompt — compliance preset", () => {
  const p = buildSystemPrompt("compliance")

  it("declares the exact compliance finding schema", () => {
    for (const kind of ['"deadline"', '"rate"', '"step"']) expect(p).toContain(kind)
    for (const key of COMPLIANCE_KEYS) expect(p).toContain(key)
  })

  it("restricts sources to official government pages", () => {
    expect(p).toMatch(/only official government sources/i)
  })

  it("asks for a compliance calendar at the end", () => {
    expect(p).toContain("compliance calendar")
  })

  it("does not leak the vendor schema", () => {
    expect(p).not.toContain("vat_valid")
    expect(p).not.toContain("vendor-master table")
  })
})

describe("buildSystemPrompt — no preset", () => {
  const p = buildSystemPrompt(null)

  it("carries no preset schema block", () => {
    expect(p).not.toContain("vat_valid")
    expect(p).not.toContain("date_or_value")
    expect(p).not.toContain("vendor-master table")
    expect(p).not.toContain("compliance calendar")
  })

  it("is a strict prefix-and-suffix of the preset prompts (one shared base)", () => {
    // Presets add a block; they never rewrite the shared contract.
    const vendor = buildSystemPrompt("vendor")
    const head = p.slice(0, p.indexOf("Your reasoning is streamed live"))
    expect(vendor.startsWith(head)).toBe(true)
    expect(vendor.length).toBeGreaterThan(p.length)
  })
})

describe("presetGoalTemplate", () => {
  it("prefills the vendor goal box", () => {
    expect(presetGoalTemplate("vendor")).toBe(
      "Verify these vendors and build a vendor-master table: [vendor names + VAT/registration numbers]",
    )
  })

  it("prefills the compliance goal box", () => {
    expect(presetGoalTemplate("compliance")).toBe(
      "Client is opening [entity type] in [jurisdiction] — compile registration steps, filing deadlines, and rates from official sources.",
    )
  })

  it("leaves the free-form box empty", () => {
    expect(presetGoalTemplate(null)).toBe("")
  })
})
