import { spawn, type ChildProcess } from "node:child_process";

/** taskkill uses WMI, which can be denied even for our own children in a restricted Windows token.
 * Toolhelp enumerates only PID/parent pairs and terminates descendants before their parent. */
const WINDOWS_TREE_KILL = `
param([int]$rootId)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CodeMapTree {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  public static void Kill(uint root) {
    var children = new Dictionary<uint, List<uint>>();
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Exception("Process snapshot failed");
    try {
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(entry);
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        if (!children.ContainsKey(entry.parent)) children[entry.parent] = new List<uint>();
        children[entry.parent].Add(entry.pid);
      }
    } finally { CloseHandle(snapshot); }
    KillChildren(root, children, new HashSet<uint>());
  }
  static void KillChildren(uint pid, Dictionary<uint, List<uint>> children, HashSet<uint> seen) {
    if (!seen.Add(pid)) return;
    if (children.ContainsKey(pid)) foreach (uint child in children[pid]) KillChildren(child, children, seen);
    var handle = OpenProcess(1, false, pid);
    if (handle != IntPtr.Zero) try { TerminateProcess(handle, 1); } finally { CloseHandle(handle); }
  }
}
'@
[CodeMapTree]::Kill([uint32]$rootId)
`;

/** Completion is bounded by the adapter's shared deadline. No shell interprets any user data. */
export function killCodeMapTree(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise(resolve => {
    if (!child.pid) { resolve(); return; }
    let killer: ChildProcess | undefined;
    let settled = false;
    let fallbackStarted = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A stuck termination helper must not keep a task slot or the bridge alive.
      killer?.kill(); child.kill();
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, graceMs));
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      child.once("close", finish);
      return;
    }
    const nativeFallback = () => {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      const script = WINDOWS_TREE_KILL.replace("param([int]$rootId)", `$rootId = ${child.pid}`);
      killer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.once("error", finish);
      killer.once("close", finish);
    };
    killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" });
    killer.once("error", nativeFallback);
    killer.once("close", code => { if (code === 0) finish(); else nativeFallback(); });
  });
}
