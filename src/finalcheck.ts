import { z } from "zod";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { acquire, ownsCheckoutLock, type CheckoutRelease } from "./checkoutlock.js";
import { takeSnapshot, restoreSnapshot, discardSnapshot, createdFiles, headAndIndexIdentity, type SnapshotHandle, type SnapshotOptions } from "./snapshot.js";
import { resolveVerificationCommand, runVerification, VerificationError, type VerificationResult } from "./verify.js";
import { ClineRunError, DedicatedHubSession, redactSecrets, guardOptionsSchema, type ClineResponse } from "./runner.js";
import type { GuardOptions } from "./guard.js";

/** Extra margin reserved alongside the final check's timeout so each run leaves time to verify. */
export const VERIFY_RESERVE_MARGIN_MS = 10_000;

const VERIFY_COMMAND_HELP = "Program for the final check, run without a shell. It must already be runnable before the edit "
  + "starts (it is checked up front; a tool the edit would install is refused). On Windows, npm/pnpm/yarn and "
  + "node_modules/.bin shims (vitest, tsc, eslint) are resolved to their program.";
export const verificationSchema = z.union([
  z.object({ command: z.string().min(1).refine(v => !v.includes("\0")).describe(VERIFY_COMMAND_HELP),
    args: z.array(z.string().refine(v => !v.includes("\0"))).optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional() }).strict(),
  z.object({ none: z.literal(true), reason: z.string().trim().min(10).max(500) }).strict()
]);
export const maxFixRunsSchema = z.number().int().min(0).max(3);
export type VerifySpec = z.infer<typeof verificationSchema>;
export const editActionSchema = z.enum(["retry", "restore", "keep"]);
export type EditAction = z.infer<typeof editActionSchema>;
export const startTaskObjectSchema = z.object({
  mode: z.enum(["ask", "workspace", "edits"]),
  prompt: z.string().min(1).max(20_000),
  provider: z.string().regex(/^[A-Za-z0-9._:/@-]{1,120}$/),
  model: z.string().regex(/^[A-Za-z0-9._:/@-]{1,120}$/),
  cwd: z.string().min(1).optional(),
  thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  timeoutSeconds: z.number().int().min(1).max(1800).optional(),
  waitSeconds: z.number().int().min(0).max(30).optional(),
  codeMap: z.boolean().optional(),
  guard: guardOptionsSchema.innerType().strict().pipe(guardOptionsSchema).optional(),
  verify: verificationSchema.optional(),
  maxFixRuns: maxFixRunsSchema.optional()
}).strict();
export const startTaskSchema = startTaskObjectSchema.superRefine((input, context) => {
  if (input.mode === "edits" && !input.verify) context.addIssue({ code: z.ZodIssueCode.custom, path: ["verify"], message: "verify is required for edits." });
  if (input.mode !== "edits" && (input.verify || input.maxFixRuns !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["verify"], message: "verify/maxFixRuns require edits mode." });
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) context.addIssue({ code: z.ZodIssueCode.custom, message: "Input exceeds 64 KiB." });
});
export type EditWaitReason = "verify_failed" | "cline_question" | "guard" | "cline_error" | "head_changed" | "budget";
export interface FinalVerification {
  required: boolean; passed: boolean | null; command: Exclude<VerifySpec, { none: true }> | null;
  reason?: string; attempts: Array<VerificationResult & { run: number; error?: string }>;
  fixRuns: number; restored: boolean; kept: boolean;
}
export interface FinalCheckInput {
  prompt: string; cwd: string; verify: VerifySpec; maxFixRuns?: number; timeoutSeconds?: number; guard?: GuardOptions;
}
export interface FinalCheckDeps {
  resolveRoot: (cwd: string, signal: AbortSignal) => Promise<string>;
  run: (prompt: string, signal: AbortSignal, lock: CheckoutRelease, guard: GuardOptions, remainingSeconds: number, run: number, hub: DedicatedHubSession) => Promise<ClineResponse>;
  fits: (prompt: string) => boolean;
  question: (text: string) => { question: string; options?: string[] } | undefined;
  snapshotOptions?: SnapshotOptions; lockDirectory?: string; checkoutLock?: CheckoutRelease;
  verify?: typeof runVerification;
  /** Up-front check that the verify command can start (default: the real resolver; skipped when only `verify` is injected). */
  resolveVerify?: typeof resolveVerificationCommand;
  /** Optional test seam: monotonic clock in ms (default: performance.now). */
  now?: () => number;
}
export function aggregateUsage(target: Record<string, unknown>, source?: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) target[key] = Number(target[key] ?? 0) + value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = target[key] && typeof target[key] === "object" ? target[key] as Record<string, unknown> : Object.create(null);
      target[key] = nested; aggregateUsage(nested, value as Record<string, unknown>);
    }
  }
}

/** Mandatory objective/guidance/check identity are never silently shortened. */
export function buildFixPrompt(objective: string, spec: VerifySpec, attempt: FinalVerification["attempts"][number] | undefined,
  guidance: string, fits: (prompt: string) => boolean, question = "", cwd = ""): string {
  const base = `Objective:\n${objective}\n\nCaller guidance:\n${guidance}` + (question ? `\nCline question:\n${question}` : "") +
    `\n\nVerification cwd: ${cwd}\nVerification command and literal args:\n${JSON.stringify(spec)}\n` +
    "Fix only what the check reports. Fix the code, never weaken or bypass the check. Retain existing partial edits.";
  const status = attempt ? `\nPrevious check: exit=${attempt.exitCode}; signal=${attempt.signal}; timedOut=${attempt.timedOut}; killedForOutput=${attempt.killedForOutput}\n` : "";
  let stdout = attempt?.stdoutTail ?? "", stderr = attempt?.stderrTail ?? "";
  const render = () => base + status + `\nstdout tail:\n${stdout}\nstderr tail:\n${stderr}`;
  while (!fits(render()) && (stdout.length || stderr.length)) {
    stdout = stdout.slice(-Math.floor(stdout.length / 2)); stderr = stderr.slice(-Math.floor(stderr.length / 2));
    if (stdout.length === 1) stdout = "";
    if (stderr.length === 1) stderr = "";
  }
  if (!fits(render())) throw new ClineRunError("launch_failed", "Objective, latest guidance and verification command exceed prompt limits.", { attempts: 0 });
  return render();
}

/**
 * The requested folder spelled under `root`, or undefined when it is outside. Both sides are canonicalised first
 * (symlinks, junctions, macOS /tmp), because Git reports the checkout root resolved. Mirrors openCodeHelperMcp edits.js.
 */
export async function subfolderOf(root: string, directory: string): Promise<string | undefined> {
  const [realRoot, realDirectory] = await Promise.all([realpath(root).catch(() => path.resolve(root)),
    realpath(directory).catch(() => path.resolve(directory))]);
  const inside = path.relative(realRoot, realDirectory);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  return inside ? path.join(root, inside) : root;
}

/** Stateful across async waits; a single baseline and lease survive every repair. */
export class FinalCheckLifecycle {
  readonly verification: FinalVerification;
  /** The checkout (lock, identity, snapshot). */
  root: string;
  /** The requested folder, maybe a monorepo package inside `root`: the Cline run and the check work here. */
  workDir: string;
  lock?: CheckoutRelease; snapshot?: SnapshotHandle;
  identity?: Awaited<ReturnType<typeof headAndIndexIdentity>>;
  phase: "snapshot" | "run" | "verify" | "restore" | "waiting" | "done" = "snapshot";
  waitReason?: EditWaitReason; question?: { question: string; options?: string[] }; error?: unknown;
  evidence: Record<string, unknown> = {}; result?: ClineResponse;
  readonly hubWarnings: string[] = [];
  codeMapSource: NonNullable<ClineResponse["codeMapSource"]> = "none";
  usage: Record<string, unknown> = Object.create(null); cost = 0; durationMs = 0;
  totalToolCalls = 0; totalInputTokens = 0; launches = 0; activeMs = 0; automaticFixes = 0;
  private budgetInputTokens = 0;
  cancelled = false;
  /** New, non-ignored files present when the edit finished (absent when there are none). */
  createdFiles?: string[];
  private releaseOwnLock = false;
  constructor(readonly input: FinalCheckInput, readonly deps: FinalCheckDeps) {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) throw new ClineRunError("launch_failed", "Input exceeds 64 KiB.");
    input.verify = verificationSchema.parse(input.verify);
    maxFixRunsSchema.parse(input.maxFixRuns ?? 2);
    this.root = input.cwd; this.workDir = path.resolve(input.cwd);
    this.verification = { required: !("none" in input.verify), passed: null,
      command: "none" in input.verify ? null : input.verify,
      ...("none" in input.verify ? { reason: input.verify.reason } : {}), attempts: [], fixRuns: 0, restored: false, kept: false };
  }
  private wait(reason: EditWaitReason, error?: unknown): void {
    this.phase = "waiting"; this.waitReason = reason; this.error = error;
    this.evidence = { ...this.evidence, message: redactSecrets(String(error ?? reason)),
      ...(this.question ? { question: this.question } : {}),
      ...(this.snapshot ? { snapshotDirectory: this.snapshot.directory } : {}) };
  }
  private async unchanged(wait = this.wait.bind(this)): Promise<boolean> {
    if (!this.identity) return true;
    try {
      const current = await headAndIndexIdentity(this.root);
      if (current.head === this.identity.head && current.indexHash === this.identity.indexHash) return true;
      this.evidence = { ...this.evidence, before: this.identity, after: current };
    } catch (error) { this.evidence.identityError = redactSecrets(String(error)); }
    wait("head_changed", new ClineRunError("edits_inspection_failed", "HEAD/index changed or could not be inspected; no reset or restoration performed."));
    return false;
  }
  preview(guidance = ""): string {
    const prompt = buildFixPrompt(this.input.prompt, this.input.verify, this.verification.attempts.at(-1), guidance,
      this.deps.fits, this.question?.question, this.workDir);
    const interruption = this.error ? `\nPrevious interruption (diagnostic evidence):\n${redactSecrets(String(this.error)).slice(0, 2000)}` : "";
    return this.deps.fits(prompt + interruption) ? prompt + interruption : prompt;
  }
  async execute(signal: AbortSignal, guidance?: string): Promise<void> {
    const hub = new DedicatedHubSession();
    // Each execute reports only its own hub-stop failures (an earlier execute already reported its own).
    this.hubWarnings.length = 0;
    // Status can read phase while cleanup is pending. Publish the wait only after the hub has stopped.
    let pendingWait: { reason: EditWaitReason; error?: unknown } | undefined;
    const wait = (reason: EditWaitReason, error?: unknown) => { pendingWait = { reason, error }; };
    const now = this.deps.now ?? (() => performance.now());
    const started = now();
    const remaining = (this.input.timeoutSeconds ?? 600) * 1000 - this.activeMs;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let expired = remaining <= 0;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, Math.max(1, remaining));
    const check = () => {
      if (signal.aborted) throw new ClineRunError("cancelled", "The edit lifecycle was cancelled.");
      if (expired || controller.signal.aborted) throw new ClineRunError("budget_exceeded", "Overall active-time budget exhausted.");
    };
    try {
      check();
      if (!this.lock) {
        this.root = await this.deps.resolveRoot(this.input.cwd, controller.signal); check();
        const workDir = await subfolderOf(this.root, this.input.cwd);
        if (workDir === undefined) throw new ClineRunError("workspace_not_git", "The requested cwd is not inside its Git checkout.");
        this.workDir = workDir;
        this.lock = ownsCheckoutLock(this.deps.checkoutLock, this.root) ? this.deps.checkoutLock
          : await acquire(this.root, { lockDirectory: this.deps.lockDirectory });
        this.releaseOwnLock = this.lock !== this.deps.checkoutLock;
      }
      // A check that cannot even start makes the run pointless: refuse before the snapshot and any launch.
      const resolveVerify = this.deps.resolveVerify ?? (this.deps.verify ? undefined : resolveVerificationCommand);
      if (resolveVerify && !this.snapshot && this.launches === 0 && !("none" in this.input.verify)) {
        const spec = this.input.verify;
        try { await resolveVerify(spec.command, spec.args ?? [], this.workDir); }
        catch (error) {
          if (!(error instanceof VerificationError)) throw error;
          wait("verify_failed", error); this.release(); return;
        }
        check();
      }
      if (!this.snapshot) {
        this.phase = "snapshot";
        this.identity = await headAndIndexIdentity(this.root); check();
        this.snapshot = await takeSnapshot(this.root, { ...this.deps.snapshotOptions, signal: controller.signal }); check();
      }
      let repair = this.launches > 0;
      let prompt = repair ? this.preview(guidance) : this.input.prompt;
      if (!this.deps.fits(prompt)) throw new ClineRunError("launch_failed", "Edit prompt exceeds prompt limits.");
      this.question = undefined; this.waitReason = undefined; this.error = undefined;
      const manual = guidance !== undefined;
      const verifyReserveMs = "none" in this.input.verify ? 0 : (this.input.verify.timeoutSeconds ?? 60) * 1000 + VERIFY_RESERVE_MARGIN_MS;
      while (true) {
        check();
        if (!await this.unchanged(wait)) return;
        check();
        const calls = (this.input.guard?.maxToolCalls ?? 150) - this.totalToolCalls;
        const tokens = (this.input.guard?.maxInputTokens ?? 1_500_000) - this.budgetInputTokens;
        if (calls <= 0 || tokens <= 0) { wait("guard", new ClineRunError("budget_exceeded", "Cumulative edit guard budget exhausted.")); return; }
        const remainingSeconds = Math.floor((remaining - (now() - started) - verifyReserveMs) / 1000);
        if (remainingSeconds < 1) {
          wait("budget", new ClineRunError("budget_exceeded", "Not enough time left for a run and its final check."));
          return;
        }
        this.phase = "run";
        this.launches++;
        if (repair) this.verification.fixRuns++;
        this.result = undefined;
        let response: ClineResponse | undefined, failure: unknown;
        try {
          response = await this.deps.run(prompt, controller.signal, this.lock!, { ...this.input.guard, maxToolCalls: calls, maxInputTokens: tokens },
            remainingSeconds, this.launches, hub);
          this.result = response;
        } catch (error) { failure = error; }
        const metrics = (response ?? failure) as Partial<ClineResponse> | undefined;
        this.codeMapSource = metrics?.codeMapSource ?? "none";
        this.totalToolCalls += metrics?.guard?.totalToolCalls ?? 0;
        this.totalInputTokens += metrics?.guard?.totalInputTokens ?? 0;
        this.budgetInputTokens += metrics?.guard?.budgetInputTokens ?? metrics?.guard?.totalInputTokens ?? 0;
        aggregateUsage(this.usage, metrics?.usage ?? (metrics?.guard ? { inputTokens: metrics.guard.totalInputTokens } : undefined));
        if (typeof metrics?.cost === "number") this.cost += metrics.cost;
        this.durationMs += metrics?.durationMs ?? 0;
        check();
        if (!await this.unchanged(wait)) return;
        check();
        if (failure) {
          const reason: EditWaitReason = failure instanceof ClineRunError
            ? (["loop_detected", "budget_exceeded"].includes(failure.kind) ? "guard"
              : failure.kind === "timeout" ? "budget" : "cline_error")
            : "cline_error";
          wait(reason, failure); return;
        }
        if (this.totalToolCalls > (this.input.guard?.maxToolCalls ?? 150) || this.budgetInputTokens > (this.input.guard?.maxInputTokens ?? 1_500_000)) {
          wait("guard", new ClineRunError("budget_exceeded", "Cumulative edit guard budget exceeded.")); return;
        }
        this.question = this.deps.question(response!.text);
        if (this.question) { wait("cline_question"); return; }
        if ("none" in this.input.verify) { await this.complete(); return; }
        // A run that may have started a process (a command tool, or a run without a guard report) must not leave
        // it running during the check: stop the hub and its job, which kills those processes, as before S16. The
        // next fix run then gets a fresh hub; file-only runs keep theirs (plan S16 review).
        if ((metrics?.guard?.processToolCalls ?? 1) > 0) { await hub.stop(); check(); }
        this.phase = "verify";
        const verifyStarted = now();
        let verified: VerificationResult & { error?: string };
        try { verified = await (this.deps.verify ?? runVerification)(this.input.verify, this.workDir, controller.signal); }
        catch (error) {
          if (!(error instanceof VerificationError)) throw error;
          const message = redactSecrets(error.message);
          verified = { passed: false, exitCode: null, signal: null, timedOut: false, killedForOutput: false,
            durationMs: now() - verifyStarted, stdoutTail: "", stderrTail: message, error: message };
        }
        if (verified.killConfirmed === false) {
          this.evidence.processesStillAlive = verified.stillAlive ?? [];
          if (verified.killUnverified) this.evidence.killUnverified = true;
        }
        verified.stdoutTail = redactSecrets(verified.stdoutTail); verified.stderrTail = redactSecrets(verified.stderrTail);
        this.verification.attempts.push({ ...verified, run: this.launches });
        this.verification.passed = verified.passed;
        check();
        if (!await this.unchanged(wait)) return;
        check();
        if (verified.passed) { await this.complete(); return; }
        if (verified.error || manual || this.automaticFixes >= (this.input.maxFixRuns ?? 2)) {
          wait("verify_failed", verified.error ? new VerificationError("verification_launch_failed", verified.error) : undefined); return;
        }
        prompt = this.preview();
        this.automaticFixes++; repair = true;
      }
    } catch (error) {
      // A stopped run whose processes could not be confirmed dead: keep that visible even when cancelled.
      if (error instanceof ClineRunError && (error.processesStillAlive?.length || error.killUnverified)) {
        this.evidence.processesStillAlive = error.processesStillAlive ?? [];
        if (error.killUnverified) this.evidence.killUnverified = true;
      }
      if (!signal.aborted) wait(expired ? "budget" : "cline_error", error);
    } finally {
      try {
        await hub.stop();
        this.hubWarnings.push(...hub.warnings);
        if (signal.aborted && this.phase !== "done") {
          this.cancelled = true; this.error = new ClineRunError("cancelled", "The edit lifecycle was cancelled."); await this.restore();
        } else if (pendingWait) this.wait(pendingWait.reason, pendingWait.error);
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort); this.activeMs += now() - started;
      }
    }
  }
  async restore(): Promise<boolean> {
    if (this.snapshot) {
      if (!await this.unchanged()) return false;
      this.phase = "restore";
      try {
        const report = await restoreSnapshot(this.snapshot); this.evidence.restore = report;
        if (report.failed.length) { this.wait("cline_error", new Error("Baseline restoration incomplete.")); return false; }
        this.verification.restored = true;
      } catch (error) { this.wait("cline_error", error); return false; }
    }
    await this.complete(); return true;
  }
  async keep(): Promise<void> {
    this.verification.kept = true;
    if (!await this.unchanged()) {
      // Keeping is allowed to end the task, but an identity refusal must retain recovery bytes.
      this.phase = "done"; this.waitReason = undefined; this.question = undefined; return;
    }
    await this.complete();
  }
  async complete(): Promise<void> {
    // Completion is the commit point; cancellation after this phase waits for disposal.
    this.phase = "done"; this.waitReason = undefined; this.question = undefined;
    // Verified edits must never be restored because the recovery folder could not be deleted.
    const snapshot = this.snapshot;
    this.snapshot = undefined; delete this.evidence.snapshotDirectory;
    if (snapshot) {
      // Report every new file the edit left behind (a stray debug script, too); a report failure changes nothing.
      try { const created = await createdFiles(snapshot); if (created.length) this.createdFiles = created; }
      catch { /* report-only */ }
      try { await discardSnapshot(snapshot); }
      catch (error) { (this.evidence as Record<string, unknown>).snapshotCleanupError = `${snapshot.directory}: ${(error as Error)?.message ?? String(error)}`; }
    }
  }
  release(): void { if (this.releaseOwnLock) this.lock?.(); this.lock = undefined; }
}
