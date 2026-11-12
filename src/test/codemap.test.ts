import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeMap, CODE_MAP_HEADER, codeMapCommandLineLength, withCodeMap } from "../codemap.js";
import { askClineWorkspace, buildWorkspaceSystemPrompt, WORKSPACE_SYSTEM_PROMPT } from "../workspace.js";
import { applyClineEdits, buildEditSystemPrompt, EDIT_SYSTEM_PROMPT } from "../edits.js";
import { TaskManager, isPromptTooLarge, type Task } from "../tasks.js";
import { WINDOWS_COMMAND_LINE_LIMIT, windowsCommandLineLength, type ClineInvocationOptions } from "../runner.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-codemap-test-"));
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(root, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(root, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(root, "traces");
after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function git(cwd: string, args: string[], input?: string | Buffer): string {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", cwd, ...args], {
    input, encoding: "utf8", windowsHide: true, timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function repository(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(path.join(root, "repo-"));
  git(dir, ["init", "--quiet"]);
  const index: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
    const blob = git(dir, ["hash-object", "-w", "--stdin"], content);
    index.push(`100644 ${blob}\t${file}\n`);
  }
  // Plumbing builds an isolated fixture; no checkout, add, commit, or branch commands are used.
  git(dir, ["update-index", "--index-info"], index.join(""));
  const tree = git(dir, ["write-tree"]);
  const commit = git(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree], "fixture\n");
  git(dir, ["update-ref", "HEAD", commit]);
  return dir;
}

const repo = await repository({
  "a.ts": "export const first = 1;\n\nexport default class Widget {}\nexport interface Shape {}\nexport type Kind = string;\nexport enum Color {}\nexport async function load() {}\n  const nested = 1;\n",
  "z.py": "# Python\nasync def fetch():\n    pass\n\nclass Client:\n    def nested(self): pass\ndef main():\n    pass\n",
  "readme.txt": "one\ntwo",
  "empty.txt": "",
  "source.go": "package main\nfunc (s *Server) Serve() {}\ntype Server struct {}\n",
  "source.rs": "pub fn run() {}\nstruct Item {}\nimpl Item {}\npub(crate) mod inner;\n",
  "Source.java": "public final class Source {}\ninterface Contract {}\n",
  "Source.cs": "public record struct Value(int X);\n",
  "Source.kt": "data class Thing(val x: Int)\nenum class Choice {}\n",
  "source.php": "<?php\nfinal class Item {}\nfunction load() {}\n",
  "source.rb": "module App\nclass Item\ndef self.call\n",
  "node_modules/ignored.ts": "export const secret = 1;",
  "nested/dist/ignored.ts": "export const secret = 1;",
  "build/ignored.ts": "export const secret = 1;",
  "out/ignored.ts": "export const secret = 1;",
  "vendor/ignored.ts": "export const secret = 1;",
  "bundle.min.js": "const ignored = 1;",
  "package-lock.json": "{}",
  "Cargo.lock": "lock",
  "binary.dat": Buffer.from([1, 0, 2, 3]),
  "invalid.dat": Buffer.from([255, 254, 253]),
  "huge.ts": "x".repeat(512 * 1024 + 1),
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`extra/file${String(i).padStart(2, "0")}.ts`, `export const symbol${i} = 1;\n`]))
});

/** Content assertions need a completed best-effort scan under parallel process load.
 * Deadline/cancellation/omission assertions below continue to exercise a single call directly. */
async function requiredCodeMap(cwd: string, options?: Parameters<typeof buildCodeMap>[1]): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const map = await buildCodeMap(cwd, options);
    if (map !== undefined) return map;
  }
  assert.fail("Code map was omitted in all three bounded content scans");
}

test("maps TS and Python declarations with exact line numbers, counts, and prompt priority", async () => {
  const map = await requiredCodeMap(repo, { prompt: "Review z.py then a.ts" });
  assert.ok(map);
  assert.equal(map.split("\n")[0], CODE_MAP_HEADER);
  // Mentioned paths tie-break by path, followed by other paths sorted by path.
  assert.match(map.split("\n")[1], /^a\.ts /);
  assert.match(map.split("\n")[2], /^z\.py /);
  assert.match(map, /a\.ts \(8 lines\): first:1, Widget:3, Shape:4, Kind:5, Color:6, load:7/);
  assert.match(map, /z\.py \(8 lines\): fetch:2, Client:5, main:7/);
  assert.match(map, /readme\.txt \(2 lines\):/);
  assert.match(map, /empty\.txt \(0 lines\):/);
  assert.doesNotMatch(map, /nested:/);
  const pythonFirst = await requiredCodeMap(repo, { prompt: "Inspect z.py" });
  assert.match(pythonFirst!.split("\n")[1], /^z\.py /);
});

test("recognizes the other supported language declarations", async () => {
  const map = await requiredCodeMap(repo);
  for (const expected of ["Serve:2, Server:3", "run:1, Item:2, Item:3, inner:4", "Source:1, Contract:2",
    "Value:1", "Thing:1, Choice:2", "Item:2, load:3", "App:1, Item:2, self.call:3"]) assert.ok(map.includes(expected), expected);
});

test("skips generated directories, minified files, lockfiles, binaries, and oversized files", async () => {
  const map = await requiredCodeMap(repo);
  assert.doesNotMatch(map, /ignored|bundle\.min|package-lock|Cargo\.lock|binary\.dat|invalid\.dat|huge\.ts/);
  assert.ok(map.length <= 6_000);
});

test("drops low-priority symbols before paths and reports omitted files within budget", async () => {
  const full = await requiredCodeMap(repo, { prompt: "z.py" });
  const smaller = await requiredCodeMap(repo, { prompt: "z.py", maxChars: full.length - 15 });
  assert.equal(smaller.split("\n").length, full.split("\n").length);
  assert.match(smaller.split("\n")[1], /fetch:2, Client:5, main:7/);
  assert.doesNotMatch(smaller, /more files/);
  const tiny = await requiredCodeMap(repo, { maxChars: 180 });
  assert.ok(tiny.length <= 180);
  assert.match(tiny, /\.\.\. and \d+ more files$/);
  const shown = tiny.split("\n").length - 2;
  assert.equal(Number(tiny.match(/and (\d+) more/)![1]), full.split("\n").length - 1 - shown);
});

test("non-git, missing files, cancellation, and invalid budgets omit the map without throwing", async () => {
  assert.equal(await buildCodeMap(root), undefined);
  assert.equal(await buildCodeMap(path.join(root, "missing")), undefined);
  assert.equal(await buildCodeMap(repo, { signal: AbortSignal.abort() }), undefined);
  assert.equal(await buildCodeMap(repo, { maxChars: NaN }), undefined);
  assert.equal(await buildCodeMap(repo, { maxChars: 1 }), undefined);
});

test("clamps to the escaped Windows command line and skips under 800 characters of room", async () => {
  const input = { prompt: "\\\"".repeat(4_000), cwd: repo, provider: "test", model: "test" };
  const options: Partial<ClineInvocationOptions> = {
    autoApprove: true, systemPrompt: buildWorkspaceSystemPrompt(repo, "win32"), deps: { entryPath: "C:\\Program Files\\cline\\bin\\cline" }
  };
  const base = codeMapCommandLineLength(input, options, "");
  const target = WINDOWS_COMMAND_LINE_LIMIT - 1_000 - 900;
  input.prompt += "x".repeat(target - base);
  const length = (map: string) => codeMapCommandLineLength(input, options, map);
  const map = await requiredCodeMap(repo, { commandLineLength: length });
  assert.ok(map);
  assert.ok(length(map + "\n\n") <= WINDOWS_COMMAND_LINE_LIMIT - 1_000);
  assert.ok(map.length < 900);
  input.prompt += "x".repeat(101);
  assert.equal(await buildCodeMap(repo, { commandLineLength: length }), undefined);
  assert.equal((await withCodeMap(repo, { ...input, codeMap: false }, options)).promptPreamble, undefined);
});

test("the per-run environment consumes command-line room and drops the map near the limit in both modes", async () => {
  for (const [base, build] of [[WORKSPACE_SYSTEM_PROMPT, buildWorkspaceSystemPrompt], [EDIT_SYSTEM_PROMPT, buildEditSystemPrompt]] as const) {
    const input = { prompt: "", cwd: repo, provider: "test", model: "test" };
    const withoutEnvironment = { autoApprove: true, systemPrompt: base, deps: { entryPath: "mock/cline" } };
    const room = WINDOWS_COMMAND_LINE_LIMIT - 1_000 - 900 - codeMapCommandLineLength(input, withoutEnvironment, "");
    input.prompt = '"'.repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
    assert.ok((await withCodeMap(repo, input, withoutEnvironment)).promptPreamble?.startsWith(CODE_MAP_HEADER));
    const fullOptions = { ...withoutEnvironment, systemPrompt: build(repo, "win32") };
    assert.equal((await withCodeMap(repo, input, fullOptions)).promptPreamble, undefined);
  }
});

test("isPromptTooLarge counts a map as part of the escaped preamble", () => {
  const task = { mode: "workspace", cwd: repo, provider: "p", model: "m" } as Task;
  const prompt = "x".repeat(19_000);
  assert.equal(isPromptTooLarge(prompt, task, "", "win32"), false);
  assert.equal(isPromptTooLarge(prompt, task, "", "win32", undefined, "\"".repeat(6_000)), true);
  assert.equal(isPromptTooLarge(prompt, task, "\"".repeat(6_000), "win32"), true);
});

function fakeOptions(replies: string[] = ["done"]) {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const options: Partial<ClineInvocationOptions> = {
    promptPreamble: "Existing preamble\n\n", maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
    checkoutLockDirectory: path.join(root, "locks"),
    deps: {
      entryPath: "mock/cline", access: async () => {},
      spawn: ((executable: string, args: string[]) => {
        calls.push({ executable, args });
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.destroy = () => {};
        child.stderr.destroy = () => {};
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "run_result", finishReason: "completed", text: replies.shift() ?? "done" }) + "\n"));
          child.emit("close", 0);
        });
        return child;
      }) as any
    }
  };
  return { options, calls };
}

const selection = { provider: "test", model: "test" };
test("workspace integration: map from HEAD reaches Cline before the caller prompt, and opt-out omits it", async () => {
  const fixture = await repository({ "main.ts": "export const atHead = 1;\n" });
  await writeFile(path.join(fixture, "main.ts"), "export const dirty = 2;\n");
  const fake = fakeOptions();
  for (const codeMap of [undefined, false]) {
    await askClineWorkspace({ cwd: fixture, prompt: "Inspect main.ts", codeMap, ...selection }, undefined, fake.options);
    const call = fake.calls.at(-1)!;
    const prompt = call.args.at(-1)!;
    assert.ok(prompt.endsWith("Existing preamble\n\nInspect main.ts"));
    assert.equal(prompt.includes(CODE_MAP_HEADER), codeMap !== false);
    if (codeMap !== false) {
      assert.match(prompt, /atHead:1/);
      assert.doesNotMatch(prompt, /dirty:1/);
    }
    const worktree = call.args[call.args.indexOf("--cwd") + 1];
    assert.equal(call.args[call.args.indexOf("--system") + 1], buildWorkspaceSystemPrompt(worktree));
    assert.notEqual(worktree, fixture);
    await assert.rejects(access(worktree));
    assert.ok(windowsCommandLineLength(call.executable, call.args) <= WINDOWS_COMMAND_LINE_LIMIT - 1_000);
  }
});

test("edits integration reads the current checkout", async () => {
  const fixture = await repository({ "main.ts": "export const atHead = 1;\n" });
  await writeFile(path.join(fixture, "main.ts"), "\nexport const dirty = 2;\n");
  const fake = fakeOptions();
  await applyClineEdits({ cwd: fixture, prompt: "Inspect main.ts", verify: { none: true, reason: "Code map integration fixture" }, ...selection }, undefined, fake.options);
  assert.match(fake.calls[0].args.at(-1)!, /dirty:2/);
  assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf("--system") + 1], buildEditSystemPrompt(fixture));
});

test("async workspace and edits preserve codeMap on initial and resumed runs", async () => {
  for (const mode of ["workspace", "edits"] as const) {
    for (const codeMap of [undefined, false]) {
      const fake = fakeOptions(["QUESTION: Continue?", "done"]);
      const manager = new TaskManager({ runOptions: fake.options, traceBase: path.join(root, "async-traces"), gitDiffStat: async () => undefined });
      try {
        const started = manager.start({ mode, prompt: "Inspect a.ts", cwd: repo, codeMap,
          ...(mode === "edits" ? { verify: { none: true as const, reason: "Code map integration fixture" } } : {}), ...selection });
        assert.equal((await manager.status(started.taskId, 10)).state, "input_required");
        await manager.send(started.taskId, "Continue with z.py");
        assert.equal((await manager.status(started.taskId, 10)).state, "done");
        assert.equal(fake.calls.length, 2);
        for (const call of fake.calls) {
          assert.equal(call.args.at(-1)!.includes(CODE_MAP_HEADER), codeMap !== false);
          const cwd = call.args[call.args.indexOf("--cwd") + 1];
          assert.equal(call.args[call.args.indexOf("--system") + 1],
            mode === "workspace" ? buildWorkspaceSystemPrompt(cwd) : buildEditSystemPrompt(cwd));
        }
        assert.match(fake.calls[1].args.at(-1)!, /Continue with z\.py/);
        await manager.result(started.taskId);
      } finally { await manager.shutdown(1_000); }
    }
  }
});
