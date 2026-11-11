/** Shared working rules for tool-enabled runs; ask mode is intentionally unchanged. */
export const WORKING_RULES = [
  "Working rules (each tool step resends the whole conversation, so fewer, larger steps cost less):",
  "1. Batch: put all independent reads and searches into one step.",
  "2. To find or list a pattern across files, use one search_codebase call with all the regexes you need instead of reading files.",
  "3. If a Code map is given, its names and line numbers are exact for HEAD: use them directly and do not re-verify them.",
  "4. When you must read, read a file under about 600 lines whole in one call; for a longer file read only the ranges you need, each at least 200 lines. Never page through a file in small slices and never re-read lines you already have.",
  "5. Never repeat a failing call. After 2 failures on the same file or command, change approach or stop and report what failed.",
  "6. Stop as soon as the requested output is complete and follow the requested output format exactly."
].join("\n");

export function buildEnvironmentLine(cwd: string, mode: "workspace" | "edits", platform: NodeJS.Platform = process.platform): string {
  const location = mode === "workspace" ? "a disposable Git worktree of the repository" : "the repository checkout";
  const os = platform === "win32"
    ? "The OS is Windows; shell commands run on Windows, so do not use Unix-only tools such as find, grep or sed."
    : `The OS is ${platform}.`;
  return `Environment: the working directory is ${cwd} (${location}). Use paths relative to it, or absolute paths under it. ${os}`;
}
