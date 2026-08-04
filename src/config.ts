const num = (v: string | undefined, d: number) => (v ? Number(v) : d)

/**
 * A duration that is only meaningful above zero.
 *
 * `NOCTUA_MAX_WAIT_MIN=0` reads literally as "give up on the human immediately", which denies
 * every approval the instant it is asked — a broken run nobody would trace back to a stray
 * environment variable. There is no "wait for ever" setting, because waiting for ever is the bug
 * this limit exists to fix, so an unusable value falls back to the default instead.
 */
const positive = (v: string | undefined, d: number) => {
  const n = num(v, d)
  return Number.isFinite(n) && n > 0 ? n : d
}

export const config = {
  port: num(process.env.PORT, 8080),
  dataDir: process.env.DATA_DIR ?? "./data",
  accessCode: process.env.ACCESS_CODE ?? "dev-code",
  model: process.env.NOCTUA_MODEL ?? "claude-sonnet-5",
  effort: process.env.NOCTUA_EFFORT ?? "medium",
  maxSteps: num(process.env.NOCTUA_MAX_STEPS, 40),
  maxRunCostUsd: num(process.env.NOCTUA_MAX_RUN_COST, 1.5),
  maxWallMinutes: num(process.env.NOCTUA_MAX_WALL_MIN, 15),
  waitMinutes: positive(process.env.NOCTUA_MAX_WAIT_MIN, 10),
  dailyCostCapUsd: num(process.env.NOCTUA_DAILY_COST_CAP, 20),
  maxConcurrentRuns: num(process.env.NOCTUA_MAX_CONCURRENT, 2),
}
