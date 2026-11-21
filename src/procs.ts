import { PROCESS_TABLE_TIMEOUT_MS } from "./waits.js";
import { spawn } from "node:child_process";

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

/** Lists cline.exe processes with their command lines (Windows only; empty elsewhere). Undefined when the list could not be read. */
export async function listClineProcesses(timeoutMs = PROCESS_TABLE_TIMEOUT_MS, signal?: AbortSignal): Promise<ProcessInfo[] | undefined> {
  if (process.platform !== "win32") return [];
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


/** PIDs of hub daemons listening on this port (a per-run hub that `cline hub stop` failed to stop). */
export function hubDaemonPidsOnPort(port: number, processes: readonly ProcessInfo[]): number[] {
  const pattern = new RegExp(`--port[\\s=]+${port}(?!\\d)`);
  return processes.filter(({ commandLine }) => commandLine.includes("--cline-hub-daemon") && pattern.test(commandLine))
    .map(({ pid }) => pid);
}
