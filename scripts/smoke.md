# Noctua — demo-day smoke checklist

Five minutes of live runs that prove the whole thing works, with the goals that have actually been
flown against the real web and the real model. Figures below are measured, not estimated.

---

## 1. Start it

```sh
# One server, and only one. A stale watcher from an earlier session will fight for :8080 —
# and if that one was started with NOCTUA_FAKE=1, your "live" run silently replays a script.
pkill -f 'src/main.ts'                       # then check nothing is left
curl -s localhost:8080/healthz               # must fail before you start
env -u NOCTUA_FAKE npm run dev               # loads .env; listens on :8080

npm --prefix web run dev                     # optional: Vite on :5173, proxies /api → :8080
```

`.env` must carry `ANTHROPIC_API_KEY` and `ACCESS_CODE`. Confirm the server is real before you
demo — the surest tell is the first run's cost line moving in uneven increments; the scripted
demo LLM bills a flat $0.01 a turn and never leaves `about:blank`.

Open <http://localhost:5173> (or <http://localhost:8080> if `web/dist` is built), enter the access
code, pick a card.

## 2. The three goals

Run them in this order — each is a strictly bigger claim than the one before.

### A · Compliance brief (safest, fastest, no gate)

> Find the current UK VAT registration threshold and the standard UK VAT rate from gov.uk, and
> record each as a finding with its source URL.

- Preset **compliance**.
- **Expect:** 6 steps · **$0.08** · **~20 s** · 2 findings.
- Rows: `United Kingdom / VAT registration threshold / £90,000` and
  `United Kingdom / Standard VAT rate / 20%`, each sourced to a `www.gov.uk` URL.
- No approval prompt — it navigates straight to known pages, so nothing is submitted.

### B · Vendor due diligence, one company (the flagship)

> Verify vendor: Monzo Bank Limited, company number 09446231. Use
> find-and-update.company-information.service.gov.uk to confirm the legal name, company number,
> status and registered address, then record one vendor row with its source.

- Preset **vendor**.
- **Expect:** 8 steps · **$0.09** · **~35 s** · 1 row.
- Row: `MONZO BANK LIMITED / 09446231 / Active / Broadwalk House, 5 Appold Street, London, England,
  EC2A 2AG`, sourced to the Companies House company page.
- Companies House serves the company page to a plain headless browser: no CAPTCHA, no JS wall.
  Going straight to `/company/<number>` skips the search form, so this one does not stop for
  approval either.

### C · Two vendors, one table (proves the table shape)

> Verify two vendors on find-and-update.company-information.service.gov.uk and record one vendor
> row for each: Monzo Bank Limited (company number 09446231), and Starling Bank Limited (search it
> by name). For each, confirm the legal name, company number, status and registered address.

- Preset **vendor**.
- **Expect:** 8 steps · **$0.13** · ~40 s of agent time · 2 rows.
- **This one stops and waits for you.** Searching by name means typing into a form and pressing
  Enter, which is a guarded action: the run goes `awaiting_approval` and the control bar lights up
  APPROVE. Click it. Nothing times out while it waits, so an unattended run sits there for ever.
- Rows: Monzo as above, plus `STARLING BANK LIMITED / 09092149 / Active / 5th Floor London Fruit
  And Wool Exchange, 1 Duval Square, London, United Kingdom, E1 6PW`.

Then hit **MD**, **CSV** and **JSON** in the report pane: the CSV opens in Excel with a
`legal_name, company_number, …, source, step` header, one row per vendor, and `step` is the
receipt — click that number in the UI to see the screenshot the row was read off.

## 3. What "working" looks like

- Every finding carries a `source` URL pointing at the official page, not a search result.
- Every finding carries a step number, and that step's screenshot shows the fact on screen.
- The closing summary names what was verified and what was not (`vat_number: unknown` is a correct
  answer when Companies House does not publish one — that honesty is the product).
- Budget line stays around **$0.10 of $1.50**. A run that reaches even $0.50 is thrashing; stop it.

## 4. Known-fragile spots, and what to do instead

| Spot | What you will see | Fallback |
| --- | --- | --- |
| Any goal needing a site search | `awaiting_approval` on the first form submit | Approve it. To avoid the pause entirely, give the company **number** and let it go straight to `/company/<number>` (goal B). |
| `ask_human` on an ambiguous goal | Run parks in `awaiting_human`, nothing times out | Answer in the whisper box. Naming the exact company and jurisdiction in the goal prevents it. |
| VIES (`ec.europa.eu/.../vies`) | Not exercised in these runs — heavier JS and rate limits than Companies House | Do not demo a VAT check cold. Companies House is the reliable registry; VAT validity legitimately reports `unknown`. |
| Multi-page gathering | Agent must be *on* the registry page when it writes the row, or it re-fetches pages it already read | Keep goals to one registry per vendor. If it starts revisiting pages, steer: "record what you already have". |
| A stale `NOCTUA_FAKE=1` server | Run "succeeds" in ~10 s with Glowbar Ltd findings it never visited | That is the scripted demo. Kill every `src/main.ts` and restart (§1). |
| Site redesign on the day | `stale ref [n]`, or a listing without the element | The loop feeds the error back and re-aims; only intervene if it repeats. Fixture rehearsal below always works. |

## 5. Offline rehearsal (no network, no registry risk)

The bundled fixture site is a whole registry that never changes. It binds `127.0.0.1`, which the
URL guard blocks by design, so it is driven with the guard relaxed for that one origin rather than
through the HTTP API:

```sh
npx vitest run tests/integration/loop.test.ts   # scripted model, no key, no tokens
```

For a real-model rehearsal against the fixture, call `runAgent(run, new AnthropicLLM(), { checkUrl })`
with a `checkUrl` that allows the fixture's base URL and delegates everything else to
`assertSafeUrl` — 6 steps, ~$0.08, and it exercises the same loop, prompts, tools and report the
live runs do.

## 6. Budget

Daily cap is $20 (`NOCTUA_DAILY_COST_CAP`), per-run $1.50 / 40 steps / 15 minutes. The three goals
above cost **$0.30 together**. Rehearse as often as you like.
