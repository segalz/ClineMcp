import { readFileSync, readdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const Q = Object.fromEntries(JSON.parse(readFileSync(here + (process.env.QFILE ?? "questions.json"), "utf8")).map(q => [q.id, q]));
const rows = [];
for (const f of readdirSync(here + (process.env.OUTDIR ?? "out")).filter(f => f.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(here + (process.env.OUTDIR ?? "out") + "/" + f, "utf8"));
  let answer = j.text, tokens = null, source = null, tools = null;
  if (j.bridge === "cline") {
    try { const o = JSON.parse(j.text); answer = o.text ?? ""; tokens = o.guard?.totalInputTokens; tools = o.guard?.totalToolCalls; source = o.codeMapSource; } catch { answer = j.text; }
  } else {
    const g = j.text.match(/- Guard: (\{.*\})/); if (g) { try { const o = JSON.parse(g[1]); tokens = o.totalInputTokens; tools = o.totalToolCalls; } catch {} }
    source = (j.text.match(/code map: (\w+)/) ?? [])[1];
    const cut = j.text.indexOf("\n\n", j.text.indexOf("- Attempts") >= 0 ? j.text.indexOf("- Attempts") : 0);
    answer = j.text.slice(cut);
  }
  const exp = Q[j.qid].expect;
  const hit = exp.filter(([id, file]) => new RegExp(`\\b(${id})\\b`).test(answer) && (file === "" || answer.includes(file))).length;
  rows.push({ bridge: j.bridge, arm: j.arm, qid: j.qid, ok: !j.isError, score: hit / exp.length, ms: j.ms, tokens, tools, source });
}
rows.sort((a, b) => (a.bridge + a.qid + a.arm).localeCompare(b.bridge + b.qid + b.arm));
for (const r of rows) console.log(r.bridge.padEnd(8), r.qid, r.arm, r.ok ? "ok " : "ERR", r.score.toFixed(2), String(Math.round(r.ms / 1000)).padStart(4) + "s", String(r.tokens ?? "-").padStart(7), "tools=" + (r.tools ?? "-"), r.source ?? "-");
console.log("\nsummary (bridge arm: correct / runs, avg s, avg input tokens, avg tool calls)");
for (const b of ["cline", "opencode"]) for (const a of ["A0", "A1"]) {
  const s = rows.filter(r => r.bridge === b && r.arm === a); if (!s.length) continue;
  const avg = k => Math.round(s.reduce((x, r) => x + (r[k] ?? 0), 0) / s.length);
  console.log(b, a, `${s.reduce((x, r) => x + r.score, 0).toFixed(1)}/${s.length}`, avg("ms") / 1000 + "s", avg("tokens"), "tools " + (s.reduce((x, r) => x + (r.tools ?? 0), 0) / s.length).toFixed(1));
}
