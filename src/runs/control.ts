export type ApprovalDecision = "approved" | "denied"

/** What `askHuman` resolves with when the run is stopped instead of answered. */
const STOPPED_ANSWER = "(run stopped)"

/**
 * The human's side of a run: pause/resume, approval gates, questions and steering notes.
 *
 * The agent loop is the only consumer of the awaiting half (`waitWhilePaused`, `requestApproval`,
 * `askHuman`, `drainSteer`); the HTTP control route drives the other half. Everything the loop
 * awaits is settled by `stop()` too, so a stopped run unwinds instead of hanging on a gate no
 * human is ever going to answer.
 */
export class RunControl {
  mode: "auto" | "approve" = "auto"

  private stopped = false
  private paused = false
  private pausedWaiters: (() => void)[] = []
  private approvalResolve: ((d: ApprovalDecision) => void) | null = null
  private humanResolve: ((text: string) => void) | null = null
  private steerQueue: string[] = []

  /** Terminal: settles every outstanding gate so the loop reaches its stop check promptly. */
  stop(): void {
    this.stopped = true
    this.paused = false
    this.releasePauseWaiters()
    this.resolveApproval("denied")
    this.answerHuman(STOPPED_ANSWER)
  }

  isStopped(): boolean {
    return this.stopped
  }

  /** Pausing a stopped run is ignored — it would re-block a loop that is already unwinding. */
  pause(): void {
    if (!this.stopped) this.paused = true
  }

  resume(): void {
    this.paused = false
    this.releasePauseWaiters()
  }

  isPaused(): boolean {
    return this.paused
  }

  waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.pausedWaiters.push(resolve)
    })
  }

  requestApproval(): Promise<ApprovalDecision> {
    if (this.stopped) return Promise.resolve("denied")
    // A second request while one is pending can only mean the first is abandoned; settle it
    // rather than leaving an awaiter that nothing can ever resolve.
    this.resolveApproval("denied")
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolve = resolve
    })
  }

  resolveApproval(decision: ApprovalDecision): void {
    const resolve = this.approvalResolve
    this.approvalResolve = null
    resolve?.(decision)
  }

  askHuman(): Promise<string> {
    if (this.stopped) return Promise.resolve(STOPPED_ANSWER)
    this.answerHuman("(question superseded)")
    return new Promise<string>((resolve) => {
      this.humanResolve = resolve
    })
  }

  answerHuman(text: string): void {
    const resolve = this.humanResolve
    this.humanResolve = null
    resolve?.(text)
  }

  addSteer(text: string): void {
    this.steerQueue.push(text)
  }

  drainSteer(): string[] {
    const queued = this.steerQueue
    this.steerQueue = []
    return queued
  }

  private releasePauseWaiters(): void {
    const waiters = this.pausedWaiters
    this.pausedWaiters = []
    for (const resolve of waiters) resolve()
  }
}
