export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_human"
  | "paused"
  | "finished"
  | "failed"
  | "stopped"

/** Everything the UI renders comes from this union — nothing is shown that was not logged. */
export type AgentEvent =
  | { type: "run_status"; status: RunStatus }
  | { type: "thinking_delta"; text: string }
  | { type: "action_proposed"; tool: string; args: Record<string, unknown>; guarded: boolean }
  | { type: "action_started"; tool: string; args: Record<string, unknown> }
  | { type: "action_result"; tool: string; ok: boolean; summary: string }
  // `url` is the image's own address; `pageUrl` is the address of the page in it. Optional because
  // logs written before it existed still have to replay — the UI falls back to reading the address
  // out of the navigate/go_back summaries, which is all it ever had.
  | { type: "screenshot"; url: string; step: number; pageUrl?: string }
  | { type: "finding"; data: Record<string, unknown>; step: number }
  | { type: "ask_human"; question: string }
  | { type: "human_answer"; text: string }
  | { type: "steer"; text: string }
  | { type: "budget"; steps: number; maxSteps: number; costUsd: number; maxCostUsd: number }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "done"; outcome: "success" | "partial" | "failed" | "stopped"; summary: string }

/** One JSONL line: `seq` is 1-based and gap-free, and doubles as the SSE event id. */
export interface PersistedEvent {
  seq: number
  ts: number
  event: AgentEvent
}
