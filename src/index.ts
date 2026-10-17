import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askCline, ClineRunError, formatErrorAsText } from "./runner.js";
import { applyClineEdits, ClineEditsError } from "./edits.js";
import { askClineWorkspace } from "./workspace.js";
import { PROHIBITED_NAMES } from "./settings.js";

const server = new McpServer({ name: "cline-local-bridge", version: "1.0.0" });

const providerModelSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:/@-]{1,120}$/)
  .refine((val) => !PROHIBITED_NAMES.has(val.toLowerCase()), {
    message: "Prohibited provider or model name"
  })
  .optional();

export { formatErrorAsText };

server.registerTool(
  "ask_cline",
  {
    description: "Ask the locally installed Cline CLI for an analysis/chat response. File edits are not approved.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      cwd: z.string().min(1).optional(),
      thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      systemPrompt: z.string().min(1).max(8_000).optional(),
      provider: providerModelSchema,
      model: providerModelSchema
    }
  },
  async (input, extra) => {
    try {
      const result = await askCline(input, extra.signal);
      const response = {
        text: result.text,
        ...(result.model ? { model: result.model } : {}),
        durationMs: result.durationMs,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {})
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    } catch (error) {
      const message = formatErrorAsText(error, "The local Cline bridge failed unexpectedly.");
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
);

server.registerTool(
  "apply_cline_edits",
  {
    description: "Have Cline implement a development task directly in the current Git checkout. Files may change, but commits are forbidden and the resulting diff is returned.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      cwd: z.string().min(1),
      thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      provider: providerModelSchema,
      model: providerModelSchema
    }
  },
  async (input, extra) => {
    try {
      const result = await applyClineEdits(input, extra.signal);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            text: result.text,
            ...(result.model ? { model: result.model } : {}),
            durationMs: result.durationMs,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.cost !== undefined ? { cost: result.cost } : {}),
            gitDiff: result.gitDiff,
            status: result.status,
            headBefore: result.headBefore,
            headAfter: result.headAfter,
            commitWasReverted: result.commitWasReverted,
            ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {})
          }, null, 2)
        }]
      };
    } catch (error) {
      if (error instanceof ClineEditsError) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: error.kind,
              message: error.message,
              ...(error.exitCode !== undefined && error.exitCode !== null ? { exitCode: error.exitCode } : {}),
              ...(error.attempts !== undefined ? { attempts: error.attempts } : {}),
              ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
              ...(error.stdoutTail ? { stdoutTail: error.stdoutTail } : {}),
              ...error.evidence
            }, null, 2)
          }],
          isError: true
        };
      }
      if (error instanceof ClineRunError) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: error.kind,
              message: error.message,
              ...(error.exitCode !== undefined && error.exitCode !== null ? { exitCode: error.exitCode } : {}),
              ...(error.attempts !== undefined ? { attempts: error.attempts } : {}),
              ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
              ...(error.stdoutTail ? { stdoutTail: error.stdoutTail } : {})
            }, null, 2)
          }],
          isError: true
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "unexpected",
            message: error instanceof Error ? error.message : "The Cline editing request failed unexpectedly."
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

server.registerTool(
  "ask_cline_workspace",
  {
    description: "Analyze a Git workspace through Cline in a disposable worktree. The worktree is always removed after the request.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      cwd: z.string().min(1),
      thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      provider: providerModelSchema,
      model: providerModelSchema
    }
  },
  async (input, extra) => {
    try {
      const result = await askClineWorkspace(input, extra.signal);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            text: result.text,
            ...(result.model ? { model: result.model } : {}),
            durationMs: result.durationMs,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.cost !== undefined ? { cost: result.cost } : {}),
            ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {})
          }, null, 2)
        }]
      };
    } catch (error) {
      const message = formatErrorAsText(error, "The isolated Cline workspace review failed unexpectedly.");
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
