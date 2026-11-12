import { z } from "zod";
import { guardOptionsSchema, ClineRunError } from "./runner.js";
import type { RestoreReport, SnapshotHandle } from "./snapshot.js";
import type { VerificationResult } from "./verify.js";

export const stepPathSchema = z.string().min(1).max(4096).refine(file => {
  if (/^[\\/]|[:\x00-\x1f<>"|?*]/.test(file)) return false;
  return file.split(/[\\/]/).every(part => !!part && part !== "." && part !== ".." &&
    !/[. ]$/.test(part) && part.toLowerCase() !== ".git" &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(part));
}, "Expected a relative path without traversal, .git, device names or ADS.");

export const stepSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  instruction: z.string().min(1).max(4000),
  paths: z.array(stepPathSchema).max(32).optional(),
  verify: z.object({
    command: z.string().min(1).refine(value => !value.includes("\0")),
    args: z.array(z.string().refine(value => !value.includes("\0"))).optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional()
  }).strict()
}).strict();
export const stepsSchema = z.array(stepSchema).min(1).max(16).refine(
  steps => new Set(steps.map(step => step.id)).size === steps.length, "Step ids must be unique.");
export type StepDefinition = z.infer<typeof stepSchema>;
export type StepAction = "retry" | "skip" | "stop";
export type WaitReason = "verify_failed" | "guard" | "cline_error" | "head_changed" | "budget" | "cline_question";
export type PlanOutcome = "completed" | "completed_with_skips" | "stopped";
export interface StepRecord {
  id: string;
  state: "pending" | "running" | "verified" | "skipped" | "failed";
  attempts: number;
  summary?: string;
  changedFiles?: string[];
  verify?: Pick<VerificationResult, "passed" | "exitCode" | "timedOut" | "stdoutTail" | "stderrTail">;
  restore?: RestoreReport;
}
export interface PlanView {
  total: number;
  currentIndex: number;
  currentId: string;
  phase: "snapshot" | "run" | "verify" | "restore" | "waiting" | "done";
  attempt: number;
  steps: StepRecord[];
}
export interface StepExecution {
  definitions: StepDefinition[];
  snapshot?: SnapshotHandle;
  identity?: { head: string; indexHash: string | null };
  launches: number;
  usage: Record<string, unknown>;
  cost: number;
  durationMs: number;
  prompt?: string;
}

// The object itself is passed to MCP so unknown top-level fields are rejected before any stripping.
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
  steps: stepsSchema.optional()
}).strict();
export const startTaskSchema = startTaskObjectSchema.superRefine((input, context) => {
  if (input.steps && input.mode !== "edits") context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "steps require mode edits." });
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Input exceeds 64 KiB." });
  }
});

/** Optional ledger context is removed before any mandatory step/objective/guidance is shortened. */
export function buildStepPrompt(objective: string, step: StepDefinition, records: StepRecord[], context: string,
  fits: (prompt: string) => boolean, resume?: (fits: (suffix: string) => boolean) => string): string {
  const base = `Objective:\n${objective}\n\nCurrent step: ${step.id}\nInstruction:\n${step.instruction}` +
    (step.paths?.length ? `\nPath hints:\n${step.paths.join("\n")}` : "");
  const ledgerHeader = "\n\nVerified steps:\n";
  let ledger = records.filter(record => record.state === "verified")
    .map(record => `${record.id}: ${record.summary ?? ""}; changed files: ${(record.changedFiles ?? []).map(file => file.replace(/[\r\n]/g, " ")).join(", ")}`)
    .join("\n").slice(0, 4000 - ledgerHeader.length);
  const assemble = (suffix: string) => base + (ledger ? ledgerHeader + ledger : "") + (suffix ? `\n\n${suffix}` : "");
  while (ledger && !fits(assemble(context))) ledger = ledger.slice(0, Math.floor(ledger.length * 0.7));
  const suffix = resume ? resume(value => fits(assemble(value))) : context;
  const prompt = assemble(suffix);
  if (!fits(prompt)) throw new ClineRunError("launch_failed", "Objective, step and caller guidance exceed the prompt or command-line limit.", { attempts: 0 });
  return prompt;
}

/** Preserve provider-specific numeric usage fields, including nested breakdowns. */
export function sumUsage(target: Record<string, unknown>, usage: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) target[key] = (typeof target[key] === "number" ? target[key] as number : 0) + value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = target[key] && typeof target[key] === "object" ? target[key] as Record<string, unknown> : Object.create(null);
      target[key] = nested;
      sumUsage(nested, value as Record<string, unknown>);
    }
  }
}
