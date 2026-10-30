// Perforce pending changelists for the shown space's client, read-only, with diffs against have.
// Polls only while this panel is on screen and the window is in front.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, theme, settings, layout, window, run, shared, setShared, openOverlay, closeOverlay, props, nextCommand } from "herdr";
import * as P4 from "./p4.js";

const POLL = 5000, STATS = 15000, BIG_CL = 200, CL_ROW = 30, FILE_ROW = 26;
const { MOD, icon } = P4;
const SELECTION = "perforce.selection";

// On screen: no hidden node above it, and every stack above it shows its branch.
function visibleMod(node, mod) {
  if (!node || node.hidden) return false;
  if (node.type === "block") return node.content?.mod === mod;
  const kids = node.children ?? [];
  if (node.type === "stack") return visibleMod(kids.find((c) => c.id === node.active) ?? kids[0], mod);
  return kids.some((c) => visibleMod(c, mod));
}

// Where to look for a client: the focused pane, then the space's panes in order.
function candidates(space) {
  const tabs = new Set(space.tabs.map((t) => t.id)), f = focused(), out = [];
  if (f?.space === space.id && f.cwd) out.push(f.cwd);
  for (const p of panes()) if (tabs.has(p.tab) && p.cwd) out.push(p.cwd);
  return [...new Set(out)];
}

export function copyMenu() {
  const t = theme(), { menu, overlay } = props();
  return v_flex().id("p4-menu").w_full().p(4).gap(1).text_size(12.5).text_color(t.foreground).children(menu.map((item, i) =>
    h_flex().id(`p4-menu-${i}`).h(28).px(10).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.write_to_clipboard(item.text); closeOverlay(overlay); })
      .child(div().truncate().child(item.label))));
}

export class Panel {
  init(cx) {
    this.cache = new Map(); this.collapsed = JSON.parse(localStorage.getItem("collapsed") ?? "{}");
    this.reset(); this.size = { width: 368, height: 600 };
    this.lastPoll = 0; this.lastStats = 0; this.visible = false;
    cx.timer.every(1000, (cx) => this.tick(cx));
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    // "perforce.next" etc. from keys.json or `herdr-app do`.
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(c, cx); } });
  }

  reset() {
    this.ws = null; this.none = false; this.remote = false; this.sig = null; this.changes = []; this.files = []; this.stats = {}; this.statsSig = "";
    this.shelved = {}; this.rows = []; this.groupBy = new Map(); this.fileBy = new Map(); this.sizes = []; this.error = null; this.sel = null; this.picked = false;
    this.diff = { rows: [], note: null, width: 300, loading: false }; this.loaded = false;
  }

  // Shown decides whether to load at all; the window being in front only gates the periodic poll.
  isShown() { return visibleMod(layout(), MOD); }
  isActive() { return window()?.active !== false; }

  // Cheap: no p4 unless shown, and then only on schedule or when something changed.
  tick(cx, force = false) {
    try { this.schedule(cx, force); } catch (e) { this.error = P4.explain(e?.message ?? e); this.busy = false; }
  }

  schedule(cx, force) {
    if (!this.isShown()) { this.visible = false; return; }
    const space = spaces().find((s) => s.active)?.id ?? null, now = Date.now();
    const fresh = !this.visible || space !== this.space || !this.loaded;
    this.visible = true;
    if (!force && !fresh && !this.isActive()) return;
    if (force || fresh || now - this.lastPoll >= POLL) this.refresh(cx, force || fresh || now - this.lastStats >= STATS);
  }

  async resolveSpace(space) {
    for (const cwd of candidates(space)) {
      const hit = this.cache.get(cwd);
      if (hit && Date.now() - hit.at < (hit.ws ? 120000 : 15000)) { if (hit.ws) return hit.ws; continue; }
      const ws = await P4.resolveClient(cwd);
      this.cache.set(cwd, { at: Date.now(), ws });
      if (ws) return ws;
    }
    return null;
  }

  refresh(cx, withStats) {
    if (this.busy) { this.again = this.again || withStats || true; return; }
    this.busy = true; this.lastPoll = Date.now();
    const space = spaces().find((s) => s.active);
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        if (!space) return;
        if (space.id !== this.space) { this.space = space.id; this.reset(); changed = true; withStats = true; }
        if (space.machine) { if (!this.remote) { this.reset(); this.remote = true; changed = true; } return; }
        let ws;
        try { ws = await this.resolveSpace(space); }
        catch (e) { if (this.error !== String(e.message ?? e)) { this.error = String(e.message ?? e); changed = true; } return; }
        if (this.space !== space.id) return;
        if (ws?.client !== this.ws?.client) { this.reset(); this.ws = ws; changed = true; withStats = true; }
        if (!ws) { if (!this.none) { this.none = true; changed = true; } return; }
        const st = await P4.fetchState(ws);
        if (this.space !== space.id || this.ws !== ws) return;
        if (st.error) { if (this.error !== st.error) { this.error = st.error; changed = true; } return; }
        if (this.error) { this.error = null; changed = true; }
        if (st.sig !== this.sig) {
          this.sig = st.sig; this.changes = st.changes; this.files = st.files; this.loaded = true;
          this.rebuild(); changed = true; withStats = true;
          const still = this.sel && this.files.find((f) => f.depot === this.sel);
          if (this.sel && !still) this.select(null);
          else if (still) this.loadDiff(cx);
          if (!this.sel && !this.picked && this.files.length) this.select(this.firstFile());
          if (this.sel && !this.diff.rows.length && !this.diff.note) this.loadDiff(cx);
        } else if (!this.loaded) { this.loaded = true; changed = true; }
        if (withStats) {
          this.lastStats = Date.now();
          const [stats, shelved] = await Promise.all([P4.diffStats(ws, this.files), P4.shelvedCounts(ws)]);
          if (this.ws !== ws) return;
          const sig = JSON.stringify([stats, shelved]);
          if (sig !== this.statsSig) {
            const before = this.sel ? JSON.stringify(this.stats[this.sel] ?? null) : null;
            this.statsSig = sig; this.stats = stats; this.shelved = shelved; this.rebuild(); changed = true;
            if (this.sel && JSON.stringify(stats[this.sel] ?? null) !== before && before !== null) this.loadDiff(cx);
          }
        }
      } catch (e) { this.error = P4.explain(e.message ?? e); changed = true; }
      finally {
        this.busy = false; this.manual = false;
        if (changed) cx.notify();
        if (this.again) { this.again = false; this.tick(cx, true); }
      }
    });
  }

  groups() {
    const by = new Map([["default", []]]);
    for (const c of [...this.changes].sort((a, b) => Number(b.change) - Number(a.change))) by.set(c.change, []);
    for (const f of this.files) { if (!by.has(f.change)) by.set(f.change, []); by.get(f.change).push(f); }
    return [...by.entries()]
      .map(([change, files]) => ({ change, files: files.sort((a, b) => a.rel.localeCompare(b.rel)), desc: this.changes.find((c) => c.change === change)?.desc ?? "" }));
  }

  isCollapsed(g) {
    const k = `${this.ws?.client}:${g.change}`;
    return k in this.collapsed ? this.collapsed[k] : g.files.length > BIG_CL;
  }

  // One flat list of change and file rows, rebuilt only when data or folding changes.
  rebuild() {
    const rows = [], groups = this.groups();
    this.groupBy = new Map(groups.map((g) => [g.change, g]));
    this.fileBy = new Map(this.files.map((f) => [f.depot, f]));
    for (const g of groups) {
      const collapsed = this.isCollapsed(g);
      rows.push({ kind: "cl", g, collapsed });
      if (!collapsed) for (const f of g.files) rows.push({ kind: "file", f });
    }
    this.rows = rows; this.sizes = rows.map((r) => (r.kind === "cl" ? CL_ROW : FILE_ROW));
  }

  // Rows can't own handlers inside a virtual list: the list reports the row's key.
  itemClick(key, cx) {
    this.handle.focus();
    if (key.startsWith("cl:")) { const g = this.groupBy.get(key.slice(3)); if (g) this.toggle(g, cx); }
    else { const f = this.fileBy.get(key.slice(2)); if (f) this.pick(f, cx); }
  }

  itemMenu(key) {
    if (key.startsWith("cl:")) {
      const g = this.groupBy.get(key.slice(3));
      if (g && g.change !== "default") this.menu([{ label: `Copy change number (${g.change})`, text: g.change }, { label: "Copy description", text: g.desc }]);
      return;
    }
    const f = this.fileBy.get(key.slice(2));
    if (f) this.menu([
      { label: "Copy depot path", text: f.depot },
      ...(f.local ? [{ label: "Copy local path", text: f.local }] : []),
      { label: "Copy file name", text: f.rel.split("/").pop() },
    ]);
  }

  // Keyboard: ↑/↓ (k/j) move between files, ←/→ (h/l) fold or open a change, Enter opens the wide diff, r refreshes.
  key(e, cx) {
    if (e.modifiers?.control || e.modifiers?.alt || e.modifiers?.platform) return;
    const map = { down: "next", j: "next", up: "prev", k: "prev", enter: "expand", r: "refresh", left: "fold", h: "fold", right: "unfold", l: "unfold" };
    const c = map[e.key];
    if (!c) return;
    cx.stop_propagation(); this.command(c, cx);
  }

  command(c, cx) {
    if (c === "refresh") { this.cache.clear(); this.manual = true; this.tick(cx, true); cx.notify(); return; }
    if (c === "expand") { if (this.sel) this.expand(); return; }
    const files = this.rows.map((r, i) => [r, i]).filter(([r]) => r.kind === "file");
    if (c === "next" || c === "prev") {
      if (!files.length) return;
      const at = files.findIndex(([r]) => r.f.depot === this.sel);
      const to = at < 0 ? (c === "next" ? 0 : files.length - 1) : Math.max(0, Math.min(files.length - 1, at + (c === "next" ? 1 : -1)));
      if (to === at) return;
      this.picked = true; this.select(files[to][0].f.depot); this.loadDiff(cx);
      this.scroll.scroll_to_item(files[to][1], "center"); cx.notify();
      return;
    }
    if (c === "fold" || c === "unfold") {
      const f = this.fileBy.get(this.sel), g = f ? this.groupBy.get(f.change) : this.groupBy.get(this.rows[0]?.g?.change);
      if (g && this.isCollapsed(g) !== (c === "fold")) this.toggle(g, cx);
    }
  }

  firstFile() { return this.rows.find((r) => r.kind === "file")?.f.depot ?? null; }

  toggle(g, cx) {
    this.collapsed[`${this.ws.client}:${g.change}`] = !this.isCollapsed(g);
    localStorage.setItem("collapsed", JSON.stringify(this.collapsed));
    this.rebuild(); cx.notify();
  }

  // The selection is shared so the wide diff pane of this space follows it.
  select(depot) {
    this.sel = depot; this.diff = { rows: [], note: null, width: 300, loading: Boolean(depot) };
    const all = { ...(shared(SELECTION) ?? {}) };
    if (depot && this.ws) all[this.space] = { client: this.ws.client, root: this.ws.root, depot };
    else delete all[this.space];
    setShared(SELECTION, all);
  }

  pick(f, cx) {
    this.picked = true;
    this.select(this.sel === f.depot ? null : f.depot);
    if (this.sel) this.loadDiff(cx);
    cx.notify();
  }

  loadDiff(cx) {
    const ws = this.ws, depot = this.sel, f = this.files.find((x) => x.depot === depot);
    if (!ws || !f) return;
    const token = (this.token ?? 0) + 1; this.token = token;
    cx.spawn(async (cx) => {
      let diff;
      try {
        const { lines, note } = await P4.loadDiff(ws, f, 1500);
        const rows = P4.diffRows(lines);
        diff = { rows, note, width: P4.diffWidth(rows, 75), loading: false };
      } catch (e) { diff = { rows: [], note: `Cannot show this diff: ${P4.explain(e.message ?? e)}`, width: 300, loading: false }; }
      if (this.token !== token || this.sel !== depot) return;
      this.diff = diff; cx.notify();
    });
  }

  expand() {
    const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
    if (!tab) return;
    const inTab = panes().filter((p) => p.tab === tab.id), open = inTab.find((p) => p.mod === MOD);
    if (open) return run("pane.focus", { pane: open.pane });
    const f = focused(), base = inTab.find((p) => p.pane === f?.pane && !p.mod) ?? inTab.find((p) => !p.mod) ?? inTab[0];
    run("pane.split", { direction: "right", ...(base ? { pane: base.pane } : {}), mod: MOD, props: { view: "diff", space: space.id } });
  }

  menu(items) {
    openOverlay({ mod: MOD, kind: "popup", width: 230, height: items.length * 29 + 10, props: { menu: items } });
  }

  clRow(row, t) {
    const { g, collapsed } = row, title = g.change === "default" ? "default" : g.change, first = g.desc.split("\n")[0], shelved = this.shelved[g.change] ?? 0;
    return h_flex().w_full().overflow_hidden().h(CL_ROW).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(g.change === "default" ? "Default changelist" : `Change ${g.change}\n\n${g.desc}`)
      .child(svg(icon(collapsed ? "chevron-right" : "chevron-down")).size(13).flex_none().text_color(t.dim))
      .child(div().flex_none().font_semibold().text_size(12).text_color(t.foreground).child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(g.change === "default" ? "" : first || "(no description)"))
      .when(shelved > 0, (e) => e.child(h_flex().flex_none().gap(3).px(5).rounded(4).items_center().text_size(10.5).bg(t.ansi5 + "26").text_color(t.ansi5).tooltip(`${shelved} shelved file${shelved === 1 ? "" : "s"}`)
        .child(svg(icon("shelf")).size(11)).child(`${shelved} shelved`)))
      .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(g.files.length)));
  }

  fileRow({ f }, t, c) {
    const parts = f.rel.split("/"), name = parts.pop(), dir = parts.length ? parts.join("/") + "/" : "";
    const stat = this.stats[f.depot], binary = P4.isBinary(f.type);
    const info = [f.depot, `${f.action} · ${f.type || "?"} · have #${f.have ?? "–"} · head #${f.head ?? "–"}`];
    if (f.moved) info.push(`${f.action === "move/add" ? "Moved from" : "Moved to"} ${f.moved}`);
    if (f.outdated) info.push(`Out of date: have #${f.have}, head #${f.head}${f.headAction ? ` (${f.headAction})` : ""}`);
    if (f.unresolved) info.push("Needs resolve");
    if (f.ourLock) info.push("Locked by you");
    if (f.otherLock) info.push("Locked by another user");
    if (f.exclusive && !f.ourLock) info.push("Exclusive checkout (+l)");
    if (f.others.length) info.push(`Also opened by ${f.others.join(", ")}`);
    const mark = (name, color, tip) => div().flex_none().tooltip(tip).child(svg(icon(name)).size(12).text_color(color));
    return h_flex().w_full().overflow_hidden().h(FILE_ROW).flex_none().pl(24).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(this.sel === f.depot, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip(info.join("\n"))
      .child(P4.actionBadge(f.action, t))
      .child(h_flex().flex_1().min_w(0).child(div().min_w(0).flex_shrink(1).truncate().text_ellipsis_start().text_color(t.dim).child(dir)).child(div().flex_shrink(0).min_w(0).max_w(200).truncate().text_color(f.action.includes("delete") ? t.muted : t.foreground).child(name)))
      .when(f.outdated, (e) => e.child(mark("outdated", t.ansi3, `Out of date: have #${f.have}, head #${f.head}`)))
      .when(f.unresolved, (e) => e.child(mark("alert", t.ansi1, "Needs resolve")))
      .when(f.ourLock || f.otherLock || f.exclusive, (e) => e.child(mark("lock", f.otherLock ? t.ansi1 : t.muted, f.otherLock ? "Locked by another user" : f.ourLock ? "Locked by you" : `Exclusive checkout (${f.type})`)))
      .when(f.others.length > 0, (e) => e.child(h_flex().flex_none().gap(2).items_center().text_size(10.5).text_color(t.ansi4).tooltip(`Also opened by ${f.others.join(", ")}`).child(svg(icon("users")).size(12)).child(String(f.others.length))))
      .when(binary, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("bin")))
      .children(P4.statChips(stat, t, c));
  }

  emptyText() {
    if (this.remote) return "Perforce panel works for spaces on this computer only";
    if (this.error && !this.loaded) return this.error;
    if (this.none) return "No Perforce workspace in this space — open a terminal inside a client root";
    if (!this.loaded) return "Loading pending changes…";
    return "No pending changes";
  }

  render(cx) {
    // Timers can sleep while the window is in the background, so a render also starts what's due:
    // a first show, a space switch, a load that never landed, or a stale list when the window comes back.
    const active = spaces().find((s) => s.active)?.id ?? null, idle = !this.busy && Date.now() - this.lastPoll;
    if (this.isShown() && (!this.visible || active !== this.space || (!this.loaded && idle > 2000) || (this.isActive() && idle > POLL))) this.tick(cx);
    const t = theme(), c = P4.palette(settings().dark !== false), sel = this.sel && this.files.find((f) => f.depot === this.sel);
    const listContent = this.sizes.reduce((a, b) => a + b, 0) + 8;
    const listH = sel ? Math.max(90, Math.min(listContent, Math.max(140, (this.size.height - 42) * 0.45))) : null;
    const total = this.files.length;
    const selStat = sel ? this.stats[sel.depot] ?? (this.diff.rows.length ? P4.countDiff(this.diff.rows) : null) : null;
    return v_flex().id("perforce").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      // Header
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Perforce"))
        .when(Boolean(this.ws), (e) => e.child(div().min_w(0).flex_shrink(1).px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).truncate()
          .tooltip(`${this.ws.client}\n${this.ws.root}${this.ws.stream ? `\n${this.ws.stream}` : ""}`).child(this.ws.client)))
        .child(div().flex_1())
        .when(this.loaded, (e) => e.child(div().flex_none().text_size(11).text_color(t.muted).child(`${total} file${total === 1 ? "" : "s"}`)))
        .child(div().id("p4-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
          .on_click((_e, cx) => { this.cache.clear(); this.manual = true; this.tick(cx, true); cx.notify(); })
          .child(this.manual || (this.busy && !this.loaded) ? svg(icon("spinner")).size(13).spin(900) : svg(icon("refresh")).size(13))))
      .when(Boolean(this.error && this.loaded), (e) => e.child(div().flex_none().px(12).py(5).text_size(11).bg(t.ansi1 + "18").text_color(t.ansi1).child(`Stale · ${this.error}`)))
      // Pending changelists
      .child(div().relative().min_h(0).border_b(sel ? 1 : 0).border_color(t.border).when(listH !== null, (e) => e.h(listH).flex_none()).when(listH === null, (e) => e.flex_1())
        .when(this.rows.length > 0, (e) => e
          .child(v_virtual_list("p4-list", this.rows.length, this.sizes, (i) => (this.rows[i].kind === "cl" ? `cl:${this.rows[i].g.change}` : `f:${this.rows[i].f.depot}`),
            (range) => this.rows.slice(range.start, range.end).map((r) => (r.kind === "cl" ? this.clRow(r, t) : this.fileRow(r, t, c))))
            .track_scroll(this.scroll)
            .on_item_click((key, cx) => this.itemClick(key, cx))
            .on_item_secondary_click((key) => this.itemMenu(key))
            .size_full())
          .child(Scrollbar.vertical("p4-list").absolute().inset_0()))
        .when(!this.rows.length, (e) => e.child(div().p(12).text_color(this.error && !this.loaded ? t.ansi1 : t.dim).child(this.emptyText()))))
      // Diff against have
      .when(Boolean(sel), (e) => e
        .child(h_flex().h(32).flex_none().pl(12).pr(6).gap(6).items_center().border_b(1).border_color(t.border)
          .child(P4.actionBadge(sel.action, t))
          .child(div().flex_1().min_w(0).truncate().text_size(12).tooltip(sel.depot).child(sel.rel.split("/").pop()))
          .children(P4.statChips(selStat, t, c))
          .child(div().id("p4-expand").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Open in a wide diff pane").on_click(() => this.expand()).child(svg(icon("expand")).size(13)))
          .child(div().id("p4-close-diff").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close diff").on_click((_e, cx) => { this.picked = true; this.select(null); cx.notify(); }).child(svg(icon("x")).size(13))))
        .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
          .child(div().id("p4-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diff.width).h_full().child(v_virtual_list("p4-diff", this.diff.rows.length, 20, (i) => String(i),
              (range) => this.diff.rows.slice(range.start, range.end).map((row) => P4.diffRow(row, t, false, c))).size_full())))
          .child(Scrollbar.vertical("p4-diff").viewport_from_layout().absolute().inset_0())
          .when(this.diff.loading || (Boolean(this.diff.note) && !this.diff.rows.length), (e) => e.child(div().absolute().top(8).left(0).right(0).px(12).text_color(t.dim).child(this.diff.loading ? "Loading diff…" : this.diff.note)))
          .when(Boolean(this.diff.note) && this.diff.rows.length > 0, (e) => e.child(div().absolute().bottom(0).left(0).right(0).px(12).py(3).bg(t.raised).text_color(t.dim).child(this.diff.note)))));
  }
}
