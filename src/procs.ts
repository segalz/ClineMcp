import { PROCESS_TABLE_TIMEOUT_MS } from "./waits.js";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

export interface ProcListDeps {
  platform?: NodeJS.Platform;
  readdir?: (dir: string) => Promise<string[]>;
  readFile?: (file: string) => Promise<string>;
  uid?: number;
  selfPid?: number;
}

/** Lists cline.exe processes with their command lines (Windows only; empty elsewhere). Undefined when the list could not be read. */
export async function listClineProcesses(timeoutMs = PROCESS_TABLE_TIMEOUT_MS, signal?: AbortSignal, deps: ProcListDeps = {}): Promise<ProcessInfo[] | undefined> {
  const platform = deps.platform ?? process.platform;
  if (platform === "linux") return listLinuxClineProcesses(timeoutMs, signal, deps);
  if (platform !== "win32") return [];
  if (timeoutMs <= 0 || signal?.aborted) return undefined;
  const script = "Get-CimInstance Win32_Process -Filter \"Name='cline.exe'\" | "
    + "ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }";
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    const finish = (value: ProcessInfo[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    const stop = () => { try { child.kill(); } catch { /* gone */ } child.stdout.destroy(); finish(undefined); };
    const timer = setTimeout(stop, Math.min(PROCESS_TABLE_TIMEOUT_MS, timeoutMs));
    signal?.addEventListener("abort", stop, { once: true });
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0) { finish(undefined); return; }
      finish(stdout.split(/\r?\n/).flatMap((line) => {
        const tab = line.indexOf("\t");
        const pid = Number(line.slice(0, tab));
        return tab > 0 && Number.isInteger(pid) && pid > 0 ? [{ pid, commandLine: line.slice(tab + 1) }] : [];
      }));
    });
  });
}

async function listLinuxClineProcesses(timeoutMs: number, signal: AbortSignal | undefined, deps: ProcListDeps): Promise<ProcessInfo[] | undefined> {
  if (timeoutMs <= 0 || signal?.aborted) return undefined;
  const readdirFn = deps.readdir ?? readdir;
  const readFileFn = deps.readFile ?? (f => readFile(f, "utf8"));
  const uid = deps.uid ?? process.getuid?.();
  const selfPid = deps.selfPid ?? process.pid;
  return new Promise<ProcessInfo[] | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { finish(undefined); }, Math.min(PROCESS_TABLE_TIMEOUT_MS, timeoutMs));
    timer.unref?.();
    const stop = () => { finish(undefined); };
    const finish = (value: ProcessInfo[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    signal?.addEventListener("abort", stop, { once: true });
    (async () => {
      let names: string[];
      try { names = await readdirFn("/proc"); } catch { finish(undefined); return; }
      const result: ProcessInfo[] = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === selfPid) continue;
        let raw: string;
        try { raw = await readFileFn(`/proc/${pid}/cmdline`); } catch { continue; }
        const line = formatCommandLine(raw);
        if (line.length === 0 || !line.includes("cline")) continue;
        if (uid !== undefined) {
          let status: string;
          try { status = await readFileFn(`/proc/${pid}/status`); } catch { continue; }
          if (parseProcStatusUid(status) !== uid) continue;
        }
        result.push({ pid, commandLine: line });
      }
      finish(result.sort((a, b) => a.pid - b.pid));
    })();
  });
}


/** PIDs of hub daemons listening on this port (a per-run hub that `cline hub stop` failed to stop). */
export function hubDaemonPidsOnPort(port: number, processes: readonly ProcessInfo[]): number[] {
  const pattern = new RegExp(`--port[\\s=]+${port}(?!\\d)`);
  return processes.filter(({ commandLine }) => commandLine.includes("--cline-hub-daemon") && pattern.test(commandLine))
    .map(({ pid }) => pid);
}

/** Formats a NUL-separated command line into a space-separated string, quoting parts that contain whitespace. */
export function formatCommandLine(raw: string): string {
  return raw.split("\0").filter((part) => part.length > 0).map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

/** Extracts the UID from /proc/<pid>/status contents, or undefined when no Uid line is present. */
export function parseProcStatusUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  return match ? Number(match[1]) : undefined;
}
