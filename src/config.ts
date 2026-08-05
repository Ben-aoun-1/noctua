const num = (v: string | undefined, d: number) => (v ? Number(v) : d)

/**
 * A limit that is only meaningful above zero.
 *
 * Every cap in the loop is compared with `>`, and `>` is false for NaN — so a value `Number()`
 * cannot read does not misconfigure a budget, it *removes* it, on a host that is spending money.
 * That is not a hypothetical: docker compose hands `env_file` values over with their inline
 * comments attached, so `NOCTUA_MAX_RUN_COST=1.5 # dollars` is what a deployment actually reads.
 *
 * Zero and negatives are the same accident from the other side. `NOCTUA_MAX_WAIT_MIN=0` reads
 * literally as "give up on the human immediately", which denies every approval the instant it is
 * asked — a broken run nobody would trace back to a stray environment variable. There is no
 * "unlimited" setting anywhere here, because unlimited is the bug these limits exist to fix, so an
 * unusable value falls back to the default instead.
 */
const positive = (v: string | undefined, d: number) => {
  const n = num(v, d)
  return Number.isFinite(n) && n > 0 ? n : d
}

/** Every effort level the Messages API accepts; anything else is rejected on every single turn. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

type Effort = (typeof EFFORTS)[number]

const DEFAULT_EFFORT: Effort = "medium"

/**
 * The reasoning effort, checked at boot rather than by the first turn of the first run.
 *
 * An unrecognised level is a 400 on every request, so a typo here does not degrade a deployment —
 * it stops one, with an error nobody would read back to an environment variable. Falling back
 * silently would be the other half of that trap, so the substitution is said out loud.
 */
const effortOf = (v: string | undefined): Effort => {
  const name = (v ?? "").trim()
  if (name === "") return DEFAULT_EFFORT
  if ((EFFORTS as readonly string[]).includes(name)) return name as Effort
  console.warn(
    `NOCTUA_EFFORT="${name}" is not one of ${EFFORTS.join(" | ")} — using ${DEFAULT_EFFORT}`,
  )
  return DEFAULT_EFFORT
}

/** A key an env file defines but leaves blank is not a setting; whitespace around one is a typo. */
const text = (v: string | undefined, d: string) => (v && v.trim() !== "" ? v.trim() : d)

export const config = {
  port: num(process.env.PORT, 8080),
  dataDir: process.env.DATA_DIR ?? "./data",
  // `??` would take `ACCESS_CODE=` — an env-file key someone meant to fill in later — as a
  // configured secret, and the empty string is a secret anyone can submit.
  accessCode: text(process.env.ACCESS_CODE, "dev-code"),
  model: text(process.env.NOCTUA_MODEL, "claude-sonnet-5"),
  effort: effortOf(process.env.NOCTUA_EFFORT),
  maxSteps: positive(process.env.NOCTUA_MAX_STEPS, 40),
  maxRunCostUsd: positive(process.env.NOCTUA_MAX_RUN_COST, 1.5),
  maxWallMinutes: positive(process.env.NOCTUA_MAX_WALL_MIN, 15),
  waitMinutes: positive(process.env.NOCTUA_MAX_WAIT_MIN, 10),
  dailyCostCapUsd: positive(process.env.NOCTUA_DAILY_COST_CAP, 20),
  maxConcurrentRuns: positive(process.env.NOCTUA_MAX_CONCURRENT, 2),
}
