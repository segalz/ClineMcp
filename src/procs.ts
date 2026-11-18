import { spawn } from "node:child_process";

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

/** Lists cline.exe processes with their command lines (Windows only; empty elsewhere or on error). */
export async function listClineProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='cline.exe'\" | "
    + "ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }";
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve([]); }, 15_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split(/\r?\n/).flatMap((line) => {
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
