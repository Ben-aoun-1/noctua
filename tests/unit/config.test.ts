import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `config` reads the environment once, at import — so every case here needs its own module
 * instance rather than a mutated object.
 */
async function loadConfig(value: string): Promise<typeof import("../../src/config.js").config> {
  vi.resetModules()
  // Empty reads as unset: `num` takes any falsy value as "not configured".
  vi.stubEnv("NOCTUA_MAX_WAIT_MIN", value)
  return (await import("../../src/config.js")).config
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("config — the wait limit", () => {
  it("defaults to ten minutes", async () => {
    expect((await loadConfig("")).waitMinutes).toBe(10)
  })

  it("takes a configured number of minutes", async () => {
    expect((await loadConfig("2")).waitMinutes).toBe(2)
  })

  /**
   * This one is the whole reason the guard exists. The wait limit is the deadline after which an
   * unanswered approval is *denied*: read `0`, a negative or a typo literally and every approval
   * is refused the instant it is asked, which breaks the run in a way nobody would connect to a
   * stray environment variable. There is no "wait for ever" — that is the bug this limit fixes —
   * so an unusable value falls back to the default.
   */
  it.each(["0", "-5", "abc", "  "])("falls back to the default on %o", async (value) => {
    expect((await loadConfig(value)).waitMinutes).toBe(10)
  })
})
