# Noctua — Design Spec

**Date:** 2026-08-02 · **Deadline:** submit by Fri 2026-08-07
**Context:** Hiring challenge from Minerva Intelligence (YC X25, tryminerva.ai — AI-native accounting: CAS/bookkeeping, tax, CFO advisory for accounting firms and SMBs; evaluator is co-founder Om Agarwal). Build an AI agent that takes a plain-English goal and autonomously executes it in a browser, with a transparent, steerable interface. Evaluation weighs the interface, judgment/orchestration, and speed of execution. Public hosted link required.

## 1. Identity

**Noctua** — the owl of Minerva, the classical symbol of watchful diligence (Minerva's own logo is an engraved Minerva head; step 02 of their "How it works" is literally titled DILIGENCE). Tagline: *"Give Noctua a chore. Watch it fly."* The name, copy, and visual language are built for the evaluator: a submission that feels native to Minerva's brand.

## 2. Design language (echoing tryminerva.ai)

Tokens extracted from their live site:

| Token | Value | Use |
|---|---|---|
| Ivory | `#F1ECE6` | Page background (their exact body bg) |
| Ink | `#171717` | Text, filled buttons (their exact ink) |
| Muted ink | `#171717` at 30–50% opacity | Secondary text, micro-labels |
| Sand wash | `#E3DCCB` | Section panels, hero blocks |
| Cream card | `#FAF7F0` | Cards, panes |
| Sage green | `#4A6B4F` | Success states (added; harmonizes with cream) |
| Bronze | `#B08D3E` | Warnings, approval-pending (added) |
| Oxide red | `#9C3D2E` | Errors (added) |

- **Fonts (all exact matches, free, self-hosted — no CDN):** **Instrument Serif** (display — their exact headline font), **Geist** (UI/body — their exact body font), **Geist Mono** (data, logs, URLs, figures — sibling of Geist).
- **Motifs:** editorial whitespace; hairline `1px` dividers in ink@10%; UPPERCASE tracked micro-labels for panel headers (`REASONING`, `LIVE VIEW`, `FINDINGS`); giant ghost serif numerals for run steps (like their "01 TALK / 02 DILIGENCE"); black `#171717` buttons with 4px radius and cream text; a line-art engraved owl medallion as Noctua's mark (evokes their Minerva-head medallion without copying it); no gradients, no shadows — flat, warm, quiet luxury.

## 3. Architecture

One Docker container on the OVH VPS (isolated from Paraclaire):

- **Backend:** Node 22 + TypeScript + Fastify. Serves built SPA statically, REST API, SSE stream. Playwright (headless Chromium) in-process, one browser context per run.
- **Agent:** Claude tool-use loop on `claude-sonnet-5` (env flag to switch model for demo day). Anthropic SDK, streaming with interleaved thinking.
- **Frontend:** React + Vite + Tailwind.
- **Transport:** SSE out (reasoning tokens, actions, screenshots), POST in (controls). SSE reconnect + `Last-Event-ID` replay.
- **Persistence:** every run's events append to JSONL on disk; screenshots as JPEG files served by URL. Enables refresh-without-loss, post-run replay with timeline scrubber, and honest debugging.

### Backend modules

```
server.ts            Fastify bootstrap, auth gate, static, routes
routes/runs.ts       POST /api/runs · GET /api/runs · GET /api/runs/:id/events (SSE)
                     POST /api/runs/:id/control · GET /api/runs/:id/export.{md,json,csv}
agent/loop.ts        turn state machine (observe → think → act)
agent/tools.ts       tool definitions + Playwright executors
agent/prompts.ts     system prompt, preset report schemas
agent/history.ts     rolling context: last 5 turns verbatim, older summarized;
                     only the current screenshot goes to the model
browser/session.ts   Playwright lifecycle, crash restart
browser/snapshot.ts  interactive-element map from a11y tree with numbered refs
events/bus.ts        emitter → JSONL append + SSE fanout
runs/store.ts        run registry, budgets, states
safety/gate.ts       access code, SSRF/private-IP blocklist, caps
```

## 4. Agent loop

Each turn: **observe → think → act**.

1. **Observe:** URL + title, numbered interactive-element map (`[12] button "Add to cart"`), screenshot (resized to 1024px-wide JPEG via the sharp library). Refs are stable within a page state; model acts by ref, never by guessed selector.
2. **Think:** Claude receives goal, findings-so-far (compact JSON), rolling history, current observation. Reasoning streams to UI live.
3. **Act:** exactly one tool per turn:

| Tool | Notes |
|---|---|
| `navigate(url)` | validated against SSRF blocklist |
| `click(ref)` | |
| `type(ref, text, submit?)` | `submit:true` presses Enter — guarded action |
| `scroll(direction)` | |
| `go_back()` | |
| `wait(seconds, reason)` | JS-heavy pages; reason shown in UI |
| `record_finding(data)` | structured JSON row, accumulates live in UI; failed runs keep findings |
| `ask_human(question)` | pauses run, question surfaces in UI |
| `finish(summary, outcome)` | outcome: success / partial / failed |

Run states: `running → awaiting_approval | awaiting_human | paused → running → finished | failed | stopped`.

## 5. Event model

SSE event types: `run_status`, `thinking_delta`, `action_proposed` (approval mode + guarded actions), `action_started`, `action_result`, `screenshot` (URL, not base64), `finding`, `ask_human`, `steer_ack`, `budget`, `error`, `done`. All persisted; the UI is a pure render of the event log (which is what makes replay free).

## 6. Human control

- **Modes:** Autopilot (default) ↔ Step-approval; toggle live mid-run.
- **Guarded actions:** form submits and anything irreversible always require approval, even in Autopilot.
- **Pause / Resume / Stop** always visible.
- **Steer box:** free-text guidance injected into the agent's next turn.
- **`ask_human`:** the agent can pause and ask the user — control flows both directions.

## 7. Error handling

- Playwright errors return to Claude as observations → it visibly retries a different way.
- **Stuck detection:** no URL change + no new findings for 4 turns → forced reflection turn ("reconsider or ask the human").
- Browser crash → context restart, resume with history; unrecoverable → honest failure report **plus all findings so far**. Every terminal state produces a report. No silent failures.
- **Budgets per run:** max 40 steps, 15 min wall-time, ~$1.50 API cost (tracked from usage). Exhaustion forces `finish` with partial results + explanation. Live gauges in UI.

## 8. Results

`finish` renders a deliverable-grade report: executive summary, findings table, and a step-by-step screenshot storyboard. Exports: Markdown, JSON, and **ledger-ready CSV** (columns an accountant can import directly). The report closes with a Minerva-style "DILIGENCE" card — ghost serif numeral, uppercase label, summary of checks performed — echoing their How-it-works section.

## 9. Showcase goals

Landing screen: two preset cards + free-form goal box.

- **Vendor due diligence (headline):** "Verify these vendors: [name + VAT/registration numbers]." Noctua validates VAT numbers on VIES (the EU's official public form — real multi-step form filling), looks companies up in public registries (e.g., UK Companies House search), visits vendor websites, and compiles a **vendor-master table**: legal name, VAT valid ✓/✗, registered address, status, source links. A real AP/month-end chore accountants dread.
- **Compliance brief:** "Client is opening [entity type] in [jurisdiction] — compile registration steps, filing deadlines, and rates from official sources." Produces a structured compliance calendar with citations.

Presets prime report schemas only — navigation stays fully agentic. Free-form box proves generality on the live call.

## 10. Access & safety

- Access-code gate (code shared with the submission link); session cookie.
- Per-run caps + global daily token ceiling; concurrent runs capped at 2 (VPS RAM).
- SSRF protection: no localhost/private/link-local targets, http(s) only.
- Agent never enters credentials or payment data; CAPTCHAs are reported to the human, never bypassed.

## 11. Testing

- **Unit (vitest):** snapshot builder ref stability, budget/stuck logic, event bus replay, history summarization triggers.
- **Integration:** full loop against a bundled fixture site (a mini "company registry" with a search form + company detail pages, and a small vendor website) with a scripted fake LLM — exercises real Playwright form-filling + snapshot + events, deterministic and free.
- **E2E before submission:** real runs of both showcase goals against live brands.
- TDD for core units per superpowers.

## 12. Deployment

- Multi-stage Dockerfile (build SPA → runtime with Chromium deps); container mem limit 2 GB; `--disable-dev-shm-usage`.
- Compose on the OVH VPS next to Paraclaire (RAM headroom check first), DuckDNS subdomain + HTTPS via existing proxy pattern, `/healthz`, uptime check before submission.

## 13. Submission polish

- README written like an engineering blog post: architecture diagram (mermaid), design decisions, trade-offs, demo GIF.
- "About Noctua" panel in the UI: plain-language how-it-works for non-technical evaluators.
- Prepared 90-second demo script + fallback recorded run (replay mode doubles as the fallback if live demo hiccups).

## 14. Out of scope (YAGNI)

Multi-user accounts; site logins by the agent; CAPTCHA handling beyond escalation; >2 concurrent runs; mobile-first layouts (desktop-first, reasonably responsive); Browserbase/hosted browsers; run scheduling.
