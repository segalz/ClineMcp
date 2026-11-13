import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeMap, buildCodeMapWithSource, CODE_MAP_HEADER, codeMapCommandLineLength, withCodeMap } from "../codemap.js";
import { askClineWorkspace, buildWorkspaceSystemPrompt, WORKSPACE_SYSTEM_PROMPT } from "../workspace.js";
import { applyClineEdits, buildEditSystemPrompt, EDIT_SYSTEM_PROMPT } from "../edits.js";
import { TaskManager, isPromptTooLarge, type Task } from "../tasks.js";
import { runCline, ClineRunError, WINDOWS_COMMAND_LINE_LIMIT, windowsCommandLineLength, type ClineInvocationOptions } from "../runner.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-codemap-test-"));
const originalCodeindex = process.env.CODEINDEX_CLI;
delete process.env.CODEINDEX_CLI;
after(() => { if (originalCodeindex === undefined) delete process.env.CODEINDEX_CLI; else process.env.CODEINDEX_CLI = originalCodeindex; });
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

test("non-git, missing files and invalid budgets omit the map; cancellation propagates", async () => {
  assert.equal(await buildCodeMap(root), undefined);
  assert.equal(await buildCodeMap(path.join(root, "missing")), undefined);
  await assert.rejects(buildCodeMap(repo, { signal: AbortSignal.abort() }), { kind: "cancelled" });
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
    const result = await askClineWorkspace({ cwd: fixture, prompt: "Inspect main.ts", codeMap, ...selection }, undefined, fake.options);
    assert.equal(result.codeMapSource, codeMap === false ? "none" : "regex");
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
  const result = await applyClineEdits({ cwd: fixture, prompt: "Inspect main.ts", verify: { none: true, reason: "Code map integration fixture" }, ...selection }, undefined, fake.options);
  assert.equal(result.codeMapSource, "regex");
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
        const status = await manager.status(started.taskId, 10);
        assert.equal(status.state, "done");
        assert.equal(status.codeMapSource, codeMap === false ? "none" : "regex");
        assert.ok(status.runHistory?.every(run => run.codeMapSource === status.codeMapSource));
        assert.equal(fake.calls.length, 2);
        for (const call of fake.calls) {
          assert.equal(call.args.at(-1)!.includes(CODE_MAP_HEADER), codeMap !== false);
          const cwd = call.args[call.args.indexOf("--cwd") + 1];
          assert.equal(call.args[call.args.indexOf("--system") + 1],
            mode === "workspace" ? buildWorkspaceSystemPrompt(cwd) : buildEditSystemPrompt(cwd));
        }
        assert.match(fake.calls[1].args.at(-1)!, /Continue with z\.py/);
        const result = await manager.result(started.taskId);
        assert.equal(result.codeMapSource, status.codeMapSource);
        assert.equal(result.result?.codeMapSource, status.codeMapSource);
      } finally { await manager.shutdown(1_000); }
    }
  }
});

let cliNumber = 0;
const emitMap = (expression: string) => `process.stdout.write(JSON.stringify({schemaVersion:2, command:"map", map:${expression}}) + "\\n");`;
async function fakeCodeindex(body: string): Promise<string> {
  const cli = path.join(root, `fake codeindex ${++cliNumber}.cjs`);
  await writeFile(cli, body);
  return cli;
}
async function usingCodeindex<T>(cli: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEINDEX_CLI;
  if (cli === undefined) delete process.env.CODEINDEX_CLI; else process.env.CODEINDEX_CLI = cli;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.CODEINDEX_CLI; else process.env.CODEINDEX_CLI = previous; }
}

test("codeindex adapter uses Node, exact arguments/root, and UTF-8 query stdin", async () => {
  const cli = await fakeCodeindex(`let query=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => query += c);
    process.stdin.on("end", () => { ${emitMap('JSON.stringify({executable:process.execPath, args:process.argv.slice(2), query})')} });`);
  await usingCodeindex(cli, async () => {
    const prompt = 'Inspect main.ts; literal "quotes", \\slashes and ????';
    const result = await buildCodeMapWithSource(repo, { prompt });
    assert.equal(result.source, "codeindex");
    const data = JSON.parse(result.map!);
    assert.equal(data.executable, process.execPath);
    assert.equal(data.query, prompt);
    assert.deepEqual(data.args.slice(0, 6), ["map", "--root", repo, "--json", "--budget", "6000"]);
    assert.equal(data.args[6], "--deadline-ms");
    assert.ok(Number(data.args[7]) >= 9_900 && Number(data.args[7]) <= 10_000);
  });
});

test("codeindex silently falls back for missing/unset/relative CLI paths", async () => {
  for (const cli of [undefined, path.join(root, "missing.cjs"), "relative.cjs"]) {
    await usingCodeindex(cli, async () => {
      const result = await buildCodeMapWithSource(repo);
      assert.equal(result.source, "regex");
      assert.match(result.map!, /first:1/);
    });
  }
});

test("codeindex silently falls back for every nonzero exit and invalid/oversize reply", async t => {
  const failures: Record<string, string> = {
    "nonzero": "process.exit(1)",
    "CLI deadline": "process.exit(3)",
    "CLI cancellation without caller cancellation": "process.exit(4)",
    "CLI insufficient budget": "process.exit(5)",
    "invalid JSON": 'process.stdout.write("not JSON")',
    "null reply": 'process.stdout.write("null")',
    "wrong schema": 'process.stdout.write(JSON.stringify({schemaVersion:1, command:"map", map:"wrong"}))',
    "wrong command": 'process.stdout.write(JSON.stringify({schemaVersion:2, command:"outline", map:"wrong"}))',
    "nonstring map": 'process.stdout.write(JSON.stringify({schemaVersion:2, command:"map", map:123}))',
    "missing map": 'process.stdout.write(JSON.stringify({schemaVersion:2, command:"map"}))',
    "stdout cap": 'process.stdout.write("x".repeat(70 * 1024)); setInterval(() => {}, 1000)',
    "JSON budget cap": emitMap('"x".repeat(6000)'),
    "map cap": emitMap('"x".repeat(6001)'),
    "empty map": emitMap('""')
  };
  for (const [name, script] of Object.entries(failures)) {
    await t.test(name, async () => usingCodeindex(await fakeCodeindex(script), async () => {
      const result = await buildCodeMapWithSource(repo);
      assert.equal(result.source, "regex");
      assert.match(result.map!, /first:1/);
    }));
  }
});

test("ignored stderr cannot exceed the adapter's capture budget", async () => {
  await usingCodeindex(await fakeCodeindex(`process.stderr.write("x".repeat(100000)); ${emitMap('"structural"')}`), async () => {
    assert.deepEqual(await buildCodeMapWithSource(repo), { source: "codeindex", map: "structural" });
  });
});

test("codeindex clamps map, combined text and escaped Windows budgets before invoking", async () => {
  const cli = await fakeCodeindex(`const args=process.argv.slice(2); ${emitMap('JSON.stringify({budget:Number(args[args.indexOf("--budget")+1])})')}`);
  await usingCodeindex(cli, async () => {
    const input = { prompt: "x".repeat(19_000), cwd: repo, ...selection };
    const options = { systemPrompt: "s".repeat(4_000), promptPreamble: "p".repeat(500), deps: { entryPath: "mock/cline" } };
    const prepared = await withCodeMap(repo, input, options);
    assert.equal(prepared.codeMapSource, "codeindex");
    const map = prepared.promptPreamble!.slice(0, -options.promptPreamble.length - 2);
    assert.equal(JSON.parse(map).budget, 498);
    assert.ok(input.prompt.length + options.systemPrompt.length + prepared.promptPreamble!.length <= 24_000);
    assert.equal(JSON.parse((await buildCodeMap(repo, { maxChars: 10_000 }))!).budget, 6000);

    const quoted = { prompt: '\\"'.repeat(4000), cwd: repo, ...selection };
    const winOptions = { systemPrompt: buildWorkspaceSystemPrompt(repo, "win32"), deps: { entryPath: "C:\\Program Files\\cline\\bin\\cline" } };
    quoted.prompt += "x".repeat(31_000 - 900 - codeMapCommandLineLength(quoted, winOptions, ""));
    const commandLineLength = (map: string) => codeMapCommandLineLength(quoted, winOptions, map);
    const result = await buildCodeMapWithSource(repo, { commandLineLength });
    assert.equal(result.source, "codeindex");
    assert.equal(JSON.parse(result.map!).budget, 448);
    assert.ok(commandLineLength(result.map! + "\n\n") <= 31_000);
    quoted.prompt += "x".repeat(101);
    assert.deepEqual(await buildCodeMapWithSource(repo, { commandLineLength }), { source: "none" });
    assert.equal((await withCodeMap(repo, { ...input, codeMap: false }, options)).codeMapSource, "none");
    assert.deepEqual(await buildCodeMapWithSource(repo, { maxChars: 0 }), { source: "none" });
  });
});

test("unfitting structural text is omitted or replaced with a fitting regex map", async () => {
  await usingCodeindex(await fakeCodeindex(emitMap('"structural map"')), async () => {
    const result = await buildCodeMapWithSource(repo, {
      commandLineLength: text => text.includes("structural") ? 32_000 : 100 + text.length
    });
    assert.equal(result.source, "regex");
    assert.match(result.map!, /first:1/);
  });
});

async function waitForFile(file: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try { if ((await readFile(file, "utf8")).length) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Fake CLI did not create ${file}`);
}

async function hangingTree(): Promise<{ cli: string; heartbeat: string }> {
  const heartbeat = path.join(root, `heartbeat-${++cliNumber}.txt`);
  const grandchild = `const fs=require("node:fs"); const beat=()=>fs.appendFileSync(${JSON.stringify(heartbeat)}, "."); beat(); setInterval(beat,25);`;
  const cli = await fakeCodeindex(`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {stdio:"ignore"}); setInterval(() => {}, 1000);`);
  return { cli, heartbeat };
}

async function assertTreeStopped(heartbeat: string): Promise<void> {
  const after = await readFile(heartbeat, "utf8");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(heartbeat, "utf8"), after, "descendant must stop writing after adapter settlement");
}

test("adapter deadline kills the process tree, then uses regex inside the shared preparation bound", async () => {
  const { cli, heartbeat } = await hangingTree();
  await usingCodeindex(cli, async () => {
    const started = performance.now();
    const pending = buildCodeMapWithSource(repo, { deadlineMs: 2500 });
    await waitForFile(heartbeat);
    const result = await pending;
    assert.equal(result.source, "regex");
    assert.ok(performance.now() - started < 3000);
    await assertTreeStopped(heartbeat);
  });
});

test("caller cancellation kills the process tree and propagates without returning fallback", async () => {
  const { cli, heartbeat } = await hangingTree();
  await usingCodeindex(cli, async () => {
    const controller = new AbortController();
    const pending = buildCodeMapWithSource(repo, { signal: controller.signal });
    const rejected = assert.rejects(pending, { kind: "cancelled", codeMapSource: "none" });
    await waitForFile(heartbeat);
    controller.abort();
    await rejected;
    await assertTreeStopped(heartbeat);
    await assert.rejects(buildCodeMapWithSource(repo, { signal: AbortSignal.abort() }), { kind: "cancelled" });
  });
});

test("preparation respects the remaining run budget and is charged before Cline starts", async () => {
  await usingCodeindex(await fakeCodeindex(`setTimeout(() => { ${emitMap('"structural"')} }, 150)`), async () => {
    const fake = fakeOptions();
    const prepared = await withCodeMap(repo, { prompt: "Inspect", timeoutSeconds: 1, ...selection }, fake.options);
    assert.equal(prepared.codeMapSource, "codeindex");
    assert.ok(prepared.preparationMs! >= 150);
    assert.ok(prepared.preparationMs! < 1000);
    // A run whose preparation consumed its budget must never reach the Cline spawn.
    await assert.rejects(runCline({ prompt: "Inspect", timeoutSeconds: 1, ...selection }, undefined,
      { ...prepared, preparationMs: 1001 }), (error: unknown) => {
        assert.ok(error instanceof ClineRunError);
        assert.equal(error.codeMapSource, "codeindex");
        return true;
      });
    assert.equal(fake.calls.length, 0);
  });
  await usingCodeindex(await fakeCodeindex(`setInterval(() => {}, 1000)`), async () => {
    const started = performance.now();
    const prepared = await withCodeMap(repo, { prompt: "Inspect", timeoutSeconds: 180, ...selection },
      { deps: { totalBudgetMs: 600 } });
    assert.ok(performance.now() - started < 1100);
    assert.ok(prepared.preparationMs! < 1100);
  });
});

test("structural provenance and exact roots reach sync and async workspace/edits, including resumes", async () => {
  const cli = await fakeCodeindex(emitMap('"structural root=" + process.argv[process.argv.indexOf("--root")+1]'));
  await usingCodeindex(cli, async () => {
    const fake = fakeOptions();
    const workspace = await askClineWorkspace({ cwd: repo, prompt: "Inspect", ...selection }, undefined, fake.options);
    const worktree = fake.calls[0].args[fake.calls[0].args.indexOf("--cwd") + 1];
    assert.equal(workspace.codeMapSource, "codeindex");
    assert.ok(fake.calls[0].args.at(-1)!.includes(`structural root=${worktree}`));
    assert.notEqual(worktree, repo);
    await assert.rejects(access(worktree));
    const edits = await applyClineEdits({ cwd: repo, prompt: "Inspect", verify: { none: true, reason: "Structural map fixture" }, ...selection }, undefined, fake.options);
    assert.equal(edits.codeMapSource, "codeindex");
    assert.ok(fake.calls[1].args.at(-1)!.includes(`structural root=${repo}`));
    for (const mode of ["workspace", "edits"] as const) {
      const calls = fakeOptions(["QUESTION: Continue?", "done"]);
      const manager = new TaskManager({ runOptions: calls.options, traceBase: path.join(root, "structural-traces"), gitDiffStat: async () => undefined });
      try {
        const started = manager.start({ mode, prompt: "Inspect", cwd: repo, ...selection,
          ...(mode === "edits" ? { verify: { none: true as const, reason: "Structural map fixture" } } : {}) });
        const waiting = await manager.status(started.taskId, 10);
        assert.equal(waiting.state, "input_required");
        assert.equal(waiting.codeMapSource, "codeindex");
        assert.equal((await manager.result(started.taskId)).codeMapSource, "codeindex");
        await manager.send(started.taskId, "Continue");
        const status = await manager.status(started.taskId, 10);
        assert.equal(status.state, "done");
        assert.equal(status.codeMapSource, "codeindex");
        assert.ok(status.runHistory?.every(run => run.codeMapSource === "codeindex"));
        const result = await manager.result(started.taskId);
        assert.equal(result.codeMapSource, "codeindex");
        assert.equal(result.result?.codeMapSource, "codeindex");
      } finally { await manager.shutdown(1000); }
    }
  });
});
