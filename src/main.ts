import { FakeLLM, type LLMFactory, type ScriptedTurn } from "./agent/llm.js"
import { config } from "./config.js"
import { buildServer } from "./server.js"

/**
 * Short enough to type on a phone, long enough that guessing it over HTTP is hopeless. Nothing
 * throttles attempts, so length is the whole defence.
 */
const MIN_ACCESS_CODE_CHARS = 12

/**
 * The access code is the only thing between the internet and a browser agent that spends money.
 * `config` falls back to a code that is published in this repository, which is fine on a laptop
 * and unacceptable on a public host — so a production boot without a real one fails here, loudly,
 * rather than coming up unlocked.
 */
if (process.env.NODE_ENV === "production") {
  const code = process.env.ACCESS_CODE ?? ""
  if (code === "") {
    throw new Error("ACCESS_CODE must be set in production — the built-in default code is public")
  }
  if (code.length < MIN_ACCESS_CODE_CHARS) {
    throw new Error(
      `ACCESS_CODE must be at least ${MIN_ACCESS_CODE_CHARS} characters in production — ` +
        `it is the only thing guarding a browser agent that spends money, and nothing rate-limits guesses`,
    )
  }
}

/**
 * A scripted run for working on the UI: findings, a question that waits for a human, and an
 * ending, with no API key, no tokens and no site to depend on. Enabled with `NOCTUA_FAKE=1`.
 *
 * It never navigates — the loop's screenshots are of the blank tab it starts on. The point is the
 * event stream, which is all the cockpit renders from.
 */
const DEMO_SCRIPT: ScriptedTurn[] = [
  {
    thinking: "Glowbar's registry entry is open. The legal name and number match the invoice.",
    toolName: "record_finding",
    toolInput: {
      data: {
        legal_name: "Glowbar Ltd",
        company_number: "09876543",
        status: "Active",
        source: "https://example.com/registry/glowbar",
      },
    },
  },
  {
    thinking: "Now the VAT number, checked against the EU validation service rather than assumed.",
    toolName: "record_finding",
    toolInput: {
      data: {
        legal_name: "Glowbar Ltd",
        vat_number: "GB123456789",
        vat_valid: "true",
        source: "https://example.com/vies/GB123456789",
      },
    },
  },
  {
    thinking: "Two entries share the name. Guessing would put the wrong company on an invoice.",
    toolName: "ask_human",
    toolInput: {
      question:
        "Two Glowbar entries exist: 09876543 (Active, London) and 04455661 (Dissolved, Leeds). " +
        "Which one is your vendor?",
    },
  },
  {
    thinking: "Both facts carry a source, so the report stands on its own.",
    toolName: "finish",
    toolInput: {
      outcome: "success",
      summary:
        "Glowbar Ltd (09876543) is active and its VAT number GB123456789 validates. " +
        "Both findings link to the page they were read from.",
    },
  },
]

const llmFactory: LLMFactory | undefined =
  process.env.NOCTUA_FAKE === "1" ? () => new FakeLLM(DEMO_SCRIPT) : undefined

const app = await buildServer({ llmFactory })
await app.listen({ port: config.port, host: "0.0.0.0" })
console.log(`noctua listening on http://0.0.0.0:${config.port}`)
