# Live runs against the real web

*The smoke session that gated the deploy, kept as written on the day.*


Five runs with the real Claude API (`claude-sonnet-5`, effort `medium`): one fixture rehearsal,
three live-web runs, and one re-run of the rehearsal to verify a fix. **Real spend: $0.61.**
Everything below is what the runs actually did, including the parts that went badly.

---

## Per-run transcript summary

| # | Run | Goal | Steps | Cost | Wall | Outcome |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 0 | Fixture rehearsal (vendor) | Verify Glowbar Ltd on the bundled registry | **20** | **$0.235** | 86 s | success — 1 correct row, **15 steps wasted in a loop** |
| A | Live · compliance | UK VAT threshold + standard rate from gov.uk | 6 | $0.081 | 19 s | success — 2 findings, both sourced |
| B | Live · vendor | Monzo Bank Limited (09446231) on Companies House | 8 | $0.086 | 36 s | success — 1 row, **company number missing from it** |
| — | *(void)* | two-vendor run served by a stale `NOCTUA_FAKE=1` server | 3 | *(not real)* | — | stopped; see stumble 6 |
| 0′ | Fixture rehearsal, after hardening | same goal as run 0 | **6** | **$0.083** | 28 s | success — same row, no loop |
| C | Live · vendor ×2 | Monzo (by number) + Starling (by name) on Companies House | 8 | $0.128 | 643 s wall / ~40 s agent | success — 2 rows, both with company numbers |

Run ids: `10e5d689` (0), `3faec4b5` (A), `2acaec94` (B), `05663fda` (0′), `4ae63579` (C).

**How runs were driven.** A, B and C went through the HTTP API exactly as the cockpit does
(`POST /api/auth` → `POST /api/runs` → SSE/event log → `POST /api/runs/:id/control`). The fixture
rehearsals called `runAgent` directly with a `checkUrl` that allows the fixture origin: the fixture
server binds `127.0.0.1`, which `assertSafeUrl` blocks by design, and there is no way to inject that
allowance through the route. Everything below the route — loop, prompts, tools, browser, LLM,
event log, `meta.json`, report — is the same code path, and both rehearsal runs land in `./data`,
list in the cockpit history, and replay.

**Facts verified against reality.** £90,000 VAT registration threshold and 20% standard rate on
gov.uk; MONZO BANK LIMITED 09446231, Active, Broadwalk House, 5 Appold Street, London EC2A 2AG;
STARLING BANK LIMITED 09092149, Active, 5th Floor London Fruit And Wool Exchange, 1 Duval Square,
London E1 6PW. Every finding carried a `source` pointing at the official page, and every one
carried the step number whose screenshot shows the fact on screen. MD/CSV/JSON exports all render;
the CSV header is the union of the row keys with `step` last, and opens cleanly.

**Companies House was not hostile.** No CAPTCHA, no JS wall, no bot interstitial — both
`/company/<number>` and the name search worked in a plain headless Chromium. The brief's contingency
was not needed.

---

## Every stumble observed

### 1. The agent looped for 15 steps re-reading pages it had already read *(fixed)*

Run 0 oscillated registry record → vendor site → registry index → registry record → vendor site,
six times, before finally recording. 20 steps for a job that needs 5.

Root cause is architectural, not model whim: `History` replays the last 5 turns verbatim and
condenses everything older into one line *per action* (`step 7: clicked [3] "Visit the company
website"`), and the only screenshot in the array is the current one. A fact read and not written
down is gone the moment the agent navigates away. The vendor preset then made that certain by
ordering the work "read the registry, look at the vendor's own site, and only then call
record_finding" — so the row's facts were always two pages behind the page the agent was on.

**Fix (prompts.ts).** Two edits: the base prompt now states that a page's words are only in front
of you while you are on it, tells the agent to quote values it will need into its own reply before
leaving a page, and adds the rule "if you are about to open a page you have already read to read
the same thing again — you had it and lost it; write down what you have instead"; and the vendor
preset now says to run the VAT check and the vendor's own site *first*, open the registry record
*last*, and record while that page is still in front of you.

**Verified:** re-running the identical goal went 20 steps → **6**, $0.235 → **$0.083**, 86 s → 28 s,
with the same correct row. The agent visited the vendor site first and recorded on the registry page.

### 2. The stuck detector cannot see an A→B→A oscillation *(not fixed — out of scope)*

`loop.ts` increments `stuckTurns` only when `snap.url === lastUrl` and the finding count has not
moved. An agent alternating between two URLs never trips it, which is why run 0 burned 15 steps
without ever being told it looked stuck — the one signal designed to catch this exact failure was
blind to it. A window of the last N URLs (revisiting any of them with no new finding counts as no
progress) would catch it. Left alone deliberately: the brief scoped hardening to `prompts.ts`, and
the prompt fix above removed the behaviour in practice. Worth doing in `loop.ts` before deploy.

### 3. A verified UK company number never reached the vendor row *(fixed)*

Run B was given company number 09446231, confirmed it on the registry, put it in its closing prose —
and recorded `vat_number: "unknown"` with the number appearing nowhere in the row. The schema had no
field for a registration number; `vat_number` was documented as "the VAT or registration number",
and the model read it (reasonably) as meaning VAT. For a vendor-master table that is the single most
important identifier silently dropped.

**Fix (prompts.ts).** Added `company_number` to the vendor schema with its own description, and
sharpened `vat_number` to say a company number is not a VAT number and belongs in the field above.
`tests/unit/prompts.test.ts` now asserts the key, so a future prompt edit cannot drop it.

**Verified:** run C recorded `09446231` and `09092149` in `company_number`, with `vat_number`
honestly `unknown`. The fixture re-run recorded `company_number: "unknown"` — correct, that page
genuinely has no number on it.

### 4. Cookie banners cost a step per site, and the prompt half-forbade dismissing them *(fixed)*

Every live site opened with a consent banner, and the agent spent a step dismissing each one — 1 of
6 steps in run A, 2 of 8 in run B. Meanwhile the Safety section said "if a CAPTCHA, a login wall, or
a **consent** or identity gate blocks your way, stop and call ask_human". The agent clicked through
anyway, which was the right call, but the prompt was telling it to escalate.

**Fix (prompts.ts).** The escalation list is now "a CAPTCHA, a login wall, or an age or identity
gate", followed by an explicit carve-out: a cookie or privacy banner is not one of those; dismiss it
with its own button, once per site, and carry on.

### 5. A guarded action parks the run for ever, and no budget rescues it *(documented, not changed)*

Run C searched Companies House by name — `type` with `submit: true`, which `isGuarded` gates — so
the run went `awaiting_approval` and sat there until I approved it (~9 minutes of its 643 s wall
time). `ask_human` behaves the same way. Both block inside the loop body, and the wall-clock and
cost budgets are only evaluated at the top of the loop, so neither can end a waiting run: only a
human clicking APPROVE/STOP will.

That is the intended policy (a human must authorise anything that submits), but it has two
consequences worth stating plainly: **any vendor goal that searches by name will pause**, and an
unattended run is not time-bounded. `scripts/smoke.md` calls this out and gives the workaround for a
demo — supply the company number so the agent goes straight to `/company/<number>`.

### 6. A stale `NOCTUA_FAKE=1` dev server hijacked a "live" run *(environment, not product)*

Editing `prompts.ts` restarted every `tsx --watch` server on the machine at once — including
leftovers from earlier sessions — and one of them, started with `NOCTUA_FAKE=1`, won port 8080. The
next run "succeeded" in seconds with the scripted Glowbar demo findings and then parked on the
script's `ask_human`. Nothing in the API or the UI distinguishes a fake server from a real one.
Caught it because the findings were fictional. Killed everything, restarted one server with
`env -u NOCTUA_FAKE`, re-ran for real. This is now the first item in `scripts/smoke.md`.

### 7. Smaller things, left alone

- Run A's narration said "I need to scroll to see the threshold content" and the same turn clicked
  *Reject additional cookies*. Cosmetic mismatch between prose and action; the reasoning pane shows
  it.
- Run 0 spent two steps searching (type, then click *Search*) where `type` with `submit: true` is
  one. The tool description already documents `submit`; the model preferred the button.
- The Markdown export flattens the closing summary's newlines into one paragraph. Readable, but a
  multi-vendor summary arrives as a wall of text. Report-builder concern, not prompt.
- No `stale ref`, no timeout, no blocked URL, no refusal, no wrong-tool call occurred in any live
  run. The failure modes the loop was built to absorb never fired.

---

## What changed

`src/agent/prompts.ts` only, plus one test assertion. No `config.ts` change: budgets were never
close (worst run used 8% of the cost cap), and `effort: medium` produced efficient, correct runs —
the loop was a memory problem, not a thinking-depth one.

1. **Base · new paragraph in "Recording findings"** — a page's words are only in front of you while
   you are on it; quote values you will need before leaving; do not reopen a page to re-read what you
   already had. *(stumble 1)*
2. **Base · Safety** — "consent gate" → "age or identity gate", plus an explicit cookie/privacy
   banner carve-out. *(stumble 4)*
3. **Vendor · schema** — added `company_number`; `vat_number` now says a company number is not a VAT
   number. *(stumble 3)*
4. **Vendor · ordering** — VAT check and vendor site first, registry record last, record while on it.
   *(stumble 1)*
5. **Vendor · source list item 4** — "Only then the vendor's own website" → "The vendor's own
   website … never as the source for legal identity", so the trust hierarchy survives without
   implying the website must be visited last. *(stumble 1)*
6. `tests/unit/prompts.test.ts` — `company_number` added to the asserted vendor keys.

Full suite green: **331 tests, 12 files**.

---

## What remains fragile

- **The stuck detector is still blind to oscillation** (stumble 2). The prompt now prevents the
  behaviour, but the safety net underneath it does not work. One-line fix in `loop.ts`; do it.
- **A waiting run is not time-bounded** (stumble 5). Approval and `ask_human` both block the loop,
  and no budget can end them. Fine while someone is watching; not fine unattended.
- **Facts survive only 5 turns.** Anything gathered across more than ~4 pages is at the mercy of the
  agent having written it down. Multi-entity goals stay reliable because each entity's row is closed
  before the next begins — but a goal that needs six pages before one row can be written would fail
  the same way run 0 did, and no prompt sentence makes that structurally safe.
- **VIES was never exercised live.** The vendor preset points at it first for EU VAT numbers; both
  live vendor runs were UK, so `vat_valid` was honestly `unknown` every time. The VIES path — member
  state dropdown, `select_option`, rate limiting — has only ever run against the fixture. Do not
  demo a cold VAT check.
- **One registry, one day.** Companies House and gov.uk behaved on 2026-08-04. Neither is under our
  control, and a redesign moves every element number.

---

## Artifacts

- `scripts/smoke.md` — reproducible demo-day checklist: startup (including the stale-server trap),
  the three exact goals with measured step/cost/time expectations, expected row shapes, and the
  fragile spots with fallbacks.
- Screenshots (real live runs, 1440×950 @2x):
  `shot-cockpit-vendor.png` (run C — Companies House in the live view, two sourced vendor rows with
  receipts), `shot-cockpit-compliance.png` (run A — gov.uk VAT rates, both findings),
  `shot-1-landing.png`. All in the session scratchpad.
- Spend: **$0.61** real API cost across five runs (the void run's $0.03 was fabricated by the
  scripted LLM, not billed). Daily cap untouched.
