import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `config` reads the environment once, at import — so every case here needs its own module
 * instance rather than a mutated object.
 */
async function loadConfig(
  env: Record<string, string>,
): Promise<typeof import("../../src/config.js").config> {
  vi.resetModules()
  // Empty reads as unset: `num` takes any falsy value as "not configured".
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import("../../src/config.js")).config
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("config — the wait limit", () => {
  it("defaults to ten minutes", async () => {
    expect((await loadConfig({ NOCTUA_MAX_WAIT_MIN: "" })).waitMinutes).toBe(10)
  })

  it("takes a configured number of minutes", async () => {
    expect((await loadConfig({ NOCTUA_MAX_WAIT_MIN: "2" })).waitMinutes).toBe(2)
  })

  /**
   * This one is the whole reason the guard exists. The wait limit is the deadline after which an
   * unanswered approval is *denied*: read `0`, a negative or a typo literally and every approval
   * is refused the instant it is asked, which breaks the run in a way nobody would connect to a
   * stray environment variable. There is no "wait for ever" — that is the bug this limit fixes —
   * so an unusable value falls back to the default.
   */
  it.each(["0", "-5", "abc", "  "])("falls back to the default on %o", async (value) => {
    expect((await loadConfig({ NOCTUA_MAX_WAIT_MIN: value })).waitMinutes).toBe(10)
  })
})

/**
 * The budgets are the *only* thing standing between a public link and an unbounded bill, and the
 * loop compares every one of them with `>`, which is false for NaN. So a value `Number()` cannot
 * read does not misconfigure a cap — it removes it. That is not a hypothetical: docker compose
 * hands `env_file` values over with their inline comments attached, so `NOCTUA_MAX_RUN_COST=1.5 #
 * dollars` is exactly what a deployment reads.
 */
describe("config — the budgets", () => {
  const budgets = [
    ["NOCTUA_MAX_STEPS", "maxSteps", 40],
    ["NOCTUA_MAX_RUN_COST", "maxRunCostUsd", 1.5],
    ["NOCTUA_MAX_WALL_MIN", "maxWallMinutes", 15],
    ["NOCTUA_DAILY_COST_CAP", "dailyCostCapUsd", 20],
    ["NOCTUA_MAX_CONCURRENT", "maxConcurrentRuns", 2],
  ] as const

  it.each(budgets)("%s takes a configured value", async (key, field) => {
    expect((await loadConfig({ [key]: "3" }))[field]).toBe(3)
  })

  it.each(budgets)("%s falls back to its default when unset", async (key, field, fallback) => {
    expect((await loadConfig({ [key]: "" }))[field]).toBe(fallback)
  })

  describe.each(["1.5 # dollars", "abc", "0", "-1", "  "])("on %o", (value) => {
    it.each(budgets)("%s keeps its cap", async (key, field, fallback) => {
      expect((await loadConfig({ [key]: value }))[field]).toBe(fallback)
    })
  })
})

/**
 * An effort level the API does not know is rejected on every single turn, so a typo here fails
 * every run this deployment ever starts — with an error nobody would read back to an environment
 * variable. It is checked once, at boot, and said out loud.
 */
describe("config — the model and the effort level", () => {
  it("takes each effort level the API accepts", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect((await loadConfig({ NOCTUA_EFFORT: level })).effort).toBe(level)
    }
  })

  it.each(["", "  ", "extreme", "MEDIUM"])("falls back to medium on %o", async (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect((await loadConfig({ NOCTUA_EFFORT: value })).effort).toBe("medium")
    // Silence would leave a deployment running at an effort nobody chose; blank is not a typo.
    expect(warn.mock.calls.length).toBe(value.trim() === "" ? 0 : 1)
  })

  it("takes a configured model, trimmed", async () => {
    expect((await loadConfig({ NOCTUA_MODEL: " claude-opus-5 " })).model).toBe("claude-opus-5")
  })

  it.each(["", "   "])("falls back to the default model on %o", async (value) => {
    expect((await loadConfig({ NOCTUA_MODEL: value })).model).toBe("claude-sonnet-5")
  })
})
