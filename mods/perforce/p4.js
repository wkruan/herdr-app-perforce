// Read-only Perforce helpers shared by the Perforce panel and its wide diff pane.
// Nothing here opens, reverts, shelves or submits: only info, changes, fstat, describe, diff and print.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile } from "herdr";

// This mod's folder name. If you install it under another name, change it here only.
export const MOD = "perforce";
export const icon = (name) => `mods/${MOD}/${name}.svg`;

export const BINARY = /binary|apple|resource/i;
export const isBinary = (type) => BINARY.test(type || "");
const NO_HAVE = new Set(["add", "branch", "import"]);
const GONE = new Set(["delete", "move/delete", "purge", "archive"]);

function parse(stdout) {
  const out = [];
  for (const line of (stdout || "").split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line p4 split oddly; skip it */ }
  }
  return out;
}

// Turns p4 failures into one line a person can act on.
export function explain(text) {
  const s = String(text || "").trim();
  if (/session has expired|P4PASSWD|password.*(invalid|unset)|login again|not logged in|ticket/i.test(s)) return "Not logged in — run p4 login";
  if (/connect to server failed|TCP connect|connection refused|timed out|WSAE|unreachable/i.test(s)) return "Cannot reach the Perforce server";
  if (/ENOENT|not recognized|cannot find|No such file or directory/i.test(s) && /p4/i.test(s)) return "p4 is not on PATH";
  return s.split(/\r?\n/).find(Boolean) || "Perforce command failed";
}

// p4 with JSON tagged output. Warnings (severity 2, e.g. "file(s) not opened") are not errors.
export async function tagged(args, ws) {
  const r = await exec("p4", ["-Mj", "-ztag", ...(ws?.client ? ["-c", ws.client] : []), ...args], { cwd: ws?.root ?? ws?.cwd });
  const recs = parse(r.stdout);
  const errors = recs.filter((x) => (x.severity ?? 0) >= 3).map((x) => String(x.data ?? "").trim());
  if (!recs.length && r.stderr.trim()) errors.push(r.stderr.trim());
  else if (r.stderr.trim() && /error|failed/i.test(r.stderr)) errors.push(r.stderr.trim());
  return { recs: recs.filter((x) => x.severity === undefined), error: errors.length ? explain(errors.join("\n")) : null };
}

async function plain(args, ws) {
  const r = await exec("p4", ["-c", ws.client, ...args], { cwd: ws.root });
  return { text: r.stdout, error: r.code !== 0 || (!r.stdout && r.stderr.trim()) ? explain(r.stderr || r.stdout) : null };
}

const norm = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
export const under = (path, root) => { const a = norm(path), b = norm(root); return Boolean(b) && (a === b || a.startsWith(b + "\\")); };

// The client whose root holds this folder, or null. Contacts the server once (p4 info).
export async function resolveClient(cwd) {
  const { recs, error } = await tagged(["info"], { cwd });
  if (error) throw new Error(error);
  const i = recs[0];
  if (!i?.clientName || i.clientName === "*unknown*" || !i.clientRoot || !under(cwd, i.clientRoot)) return null;
  return { client: i.clientName, root: i.clientRoot, user: i.userName, stream: i.clientStream ?? null };
}

export function fileFrom(r, ws) {
  const others = [];
  for (let i = 0; r[`otherOpen${i}`] !== undefined; i++) others.push(`${r[`otherOpen${i}`]} (${r[`otherAction${i}`] ?? "open"})`);
  const prefix = `//${ws.client}/`;
  const rel = String(r.clientFile || r.depotFile).startsWith(prefix) ? r.clientFile.slice(prefix.length) : r.depotFile;
  const have = r.haveRev ? Number(r.haveRev) : null, head = r.headRev ? Number(r.headRev) : null;
  return {
    depot: r.depotFile, local: r.path ?? null, rel, action: r.action, change: r.change ?? "default",
    type: r.type ?? r.headType ?? "", have, head, headAction: r.headAction ?? null, moved: r.movedFile ?? null,
    outdated: have !== null && head !== null && have < head,
    unresolved: "unresolved" in r, ourLock: "ourLock" in r, otherLock: "otherLock" in r, others,
    exclusive: /\+\w*l/.test(r.type ?? r.headType ?? ""),
  };
}

// Every pending change of this client and every file it has open. `sig` changes when anything shown does.
export async function fetchState(ws) {
  const [changes, opened] = await Promise.all([
    tagged(["changes", "-s", "pending", "-c", ws.client, "-l"], ws),
    tagged(["fstat", "-Ro", "-Op", `//${ws.client}/...`], ws),
  ]);
  const error = changes.error || opened.error;
  if (error) return { error };
  const files = opened.recs.filter((r) => r.depotFile && r.action).map((r) => fileFrom(r, ws));
  const list = changes.recs.filter((r) => r.change).map((r) => ({ change: r.change, desc: String(r.desc ?? "").trim(), time: Number(r.time) || 0 }));
  const sig = JSON.stringify([list, files]);
  return { error: null, changes: list, files, sig };
}

// Changed lines per text file (p4 diff -ds), in batches so the command line stays short.
export async function diffStats(ws, files, cap = 300) {
  const wanted = files.filter((f) => !isBinary(f.type) && f.have !== null && !NO_HAVE.has(f.action) && !GONE.has(f.action)).slice(0, cap);
  const stats = {};
  for (let i = 0; i < wanted.length; i += 40) {
    const { recs } = await tagged(["diff", "-ds", ...wanted.slice(i, i + 40).map((f) => f.depot)], ws);
    let current = null;
    for (const r of recs) {
      if (r.depotFile) { current = r.depotFile; continue; }
      if (!current || typeof r.data !== "string") continue;
      const add = /add \d+ chunks (\d+) lines/.exec(r.data), del = /deleted \d+ chunks (\d+) lines/.exec(r.data), chg = /changed \d+ chunks (\d+) \/ (\d+) lines/.exec(r.data);
      stats[current] = { add: Number(add?.[1] ?? 0) + Number(chg?.[2] ?? 0), del: Number(del?.[1] ?? 0) + Number(chg?.[1] ?? 0) };
      current = null;
    }
  }
  // New files: their whole text is added (local read, no server).
  const fresh = files.filter((f) => !isBinary(f.type) && f.local && !GONE.has(f.action) && (NO_HAVE.has(f.action) || f.have === null)).slice(0, 100);
  await Promise.all(fresh.map(async (f) => {
    const text = await readTextFile(f.local).catch(() => null);
    if (text && !text.includes("\0")) stats[f.depot] = { add: text.split("\n").length - Number(text.endsWith("\n")), del: 0 };
  }));
  return stats;
}

// Shelved file counts for this client's changes that have any.
export async function shelvedCounts(ws) {
  const { recs, error } = await tagged(["changes", "-s", "shelved", "-c", ws.client], ws);
  if (error || !recs.length) return {};
  const described = await tagged(["describe", "-S", "-s", ...recs.map((r) => r.change).filter(Boolean)], ws);
  const out = {};
  for (const r of described.recs) {
    if (!r.change) continue;
    out[r.change] = Object.keys(r).filter((k) => /^depotFile\d+$/.test(k)).length;
  }
  return out;
}

// The file as it is now, for a pane that only knows its depot path.
export async function fileInfo(ws, depot) {
  const { recs, error } = await tagged(["fstat", "-Op", depot], ws);
  if (error) throw new Error(error);
  const r = recs.find((x) => x.depotFile);
  return r ? fileFrom(r, ws) : null;
}

const clean = (line) => {
  const s = line.replace(/\t/g, "    ");
  return s.length > 4000 ? s.slice(0, 4000) + "… (line truncated)" : s;
};
const textLines = (text) => text.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").split(/\r?\n/);

// The diff against the have revision, as unified lines (or a note when there is nothing to draw).
export async function loadDiff(ws, f, limit = 1500) {
  const revs = `have #${f.have ?? "–"} · head #${f.head ?? "–"}`;
  if (isBinary(f.type)) return { lines: [], note: `Binary file (${f.type}) · ${f.action} · ${revs}` };
  let lines;
  if (GONE.has(f.action)) {
    if (f.have === null) return { lines: [], note: `${f.action} · no have revision to show` };
    const r = await plain(["print", "-q", `${f.depot}#${f.have}`], ws);
    if (r.error) throw new Error(r.error);
    const body = textLines(r.text);
    lines = [`@@ -1,${body.length} +0,0 @@`, ...body.map((l) => `-${l}`)];
  } else if (NO_HAVE.has(f.action) || f.have === null) {
    const text = f.local ? await readTextFile(f.local).catch(() => null) : null;
    if (text === null) return { lines: [], note: "Cannot preview this file (missing, larger than 1 MiB, or unreadable)" };
    if (text.includes("\0")) return { lines: [], note: `No text preview (${f.type || "binary or UTF-16"})` };
    const body = textLines(text);
    lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
  } else {
    const r = await plain(["diff", "-du", f.depot], ws);
    if (r.error && !r.text) throw new Error(r.error);
    const all = r.text.replace(/\r?\n$/, "").split(/\r?\n/), first = all.findIndex((l) => l.startsWith("@@"));
    if (first < 0) return { lines: [], note: f.moved ? `Moved from ${f.moved} · no content changes` : "No content changes against the have revision" };
    lines = all.slice(first);
  }
  const truncated = lines.length > limit;
  return { lines: lines.slice(0, limit).map(clean), note: truncated ? `Showing the first ${limit.toLocaleString()} lines` : null };
}

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, next: next++, text };
    if (kind === " ") return { kind, old: old++, next: next++, text };
    return { kind: "", text: line };
  });
}

export const diffWidth = (rows, gutter) => Math.max(300, ...rows.map((r) => r.text.length * 7 + gutter));
export const countDiff = (rows) => rows.reduce((n, r) => (r.kind === "+" ? n.add++ : r.kind === "-" ? n.del++ : 0, n), { add: 0, del: 0 });

// Solid diff colors (GitHub-like), readable on dark and light themes alike.
export function palette(dark) {
  return dark
    ? { addBg: "#2d4236", delBg: "#51292b", add: "#68b78d", del: "#ea7f81" }
    : { addBg: "#e6ffec", delBg: "#ffebe9", add: "#1a7f37", del: "#cf222e" };
}

export function diffRow(row, t, wide, c) {
  if (row.kind === "@") return div().w_full().pl(15).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
  const plus = row.kind === "+", minus = row.kind === "-", color = plus ? c.add : minus ? c.del : null;
  const num = (n) => div().w(wide ? 40 : 34).flex_none().text_right().text_color(color ?? t.dim).child(n === undefined ? "" : String(n));
  return h_flex().w_full().h(20).flex_none()
    .when(plus, (e) => e.bg(c.addBg)).when(minus, (e) => e.bg(c.delBg))
    .child(div().w(3).h_full().flex_none().when(Boolean(color), (e) => e.bg(color)))
    .child(h_flex().h_full().flex_none().gap(6).pr(8).border_r(1).border_color(color ? color + "40" : t.border)
      .when(wide, (e) => e.child(num(row.old)).child(num(row.next)))
      .when(!wide, (e) => e.child(num(minus ? row.old : row.next))))
    .child(div().w(18).flex_none().text_center().text_color(color ?? t.dim).child(plus || minus ? row.kind : ""))
    .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(t.foreground).child(row.text));
}

// "+12 −3"; a zero side is left out.
export function statChips(stat, t, c) {
  if (!stat) return [];
  return [
    ...(stat.add ? [div().flex_none().text_size(11).text_color(c.add).child(`+${stat.add}`)] : []),
    ...(stat.del ? [div().flex_none().text_size(11).text_color(c.del).child(`−${stat.del}`)] : []),
  ];
}

export const ACTIONS = {
  edit: ["M", "ansi4"], add: ["A", "ansi2"], delete: ["D", "ansi1"], branch: ["B", "ansi2"], integrate: ["I", "ansi6"],
  "move/add": ["R", "ansi5"], "move/delete": ["R", "ansi1"], import: ["A", "ansi6"], purge: ["X", "ansi1"], archive: ["X", "dim"],
};
export const actionBadge = (action, t) => {
  const [letter, color] = ACTIONS[action] ?? ["?", "dim"];
  return div().w(14).flex_none().text_size(11).font_semibold().text_color(t[color] ?? t.dim).child(letter);
};
