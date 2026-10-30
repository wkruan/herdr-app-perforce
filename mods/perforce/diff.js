// The wide diff for the file selected in this space's Perforce panel (props { view: "diff", space }).
// Follows the panel's selection; refreshes while its space is shown and the window is in front.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, theme, settings, window, shared, props } from "herdr";
import * as P4 from "./p4.js";

const REFRESH = 15000, LIMIT = 5000;
const { MOD, icon } = P4;

export class DiffPane {
  init(cx) {
    this.key = null; this.file = null; this.rows = []; this.note = null; this.width = 300; this.loading = false; this.last = 0;
    cx.timer.every(1000, (cx) => {
      if (this.key && this.shown() && Date.now() - this.last >= REFRESH) this.load(cx);
    });
  }

  target() { return shared("perforce.selection")?.[props()?.space] ?? null; }

  // Shown: its space is the active one and a diff pane sits in that space's shown tab.
  shown() {
    const space = spaces().find((s) => s.active);
    if (!space || space.id !== props()?.space || window()?.active === false) return false;
    const tab = space.tabs.find((x) => x.active)?.id;
    return panes().some((p) => p.tab === tab && p.mod === MOD);
  }

  load(cx) {
    const sel = this.target(), key = sel ? `${sel.client}|${sel.depot}` : null;
    this.last = Date.now();
    if (!sel) return;
    const token = (this.token ?? 0) + 1; this.token = token; this.loading = !this.rows.length && !this.note;
    cx.spawn(async (cx) => {
      let file = null, rows = [], note = null;
      try {
        const ws = { client: sel.client, root: sel.root };
        file = await P4.fileInfo(ws, sel.depot);
        if (!file || !file.action) note = "This file is no longer open in the client";
        else { const d = await P4.loadDiff(ws, file, LIMIT); rows = P4.diffRows(d.lines); note = d.note; }
      } catch (e) { note = `Cannot show this diff: ${P4.explain(e.message ?? e)}`; }
      if (this.token !== token || this.key !== key) return;
      this.file = file; this.rows = rows; this.note = note; this.width = P4.diffWidth(rows, 125); this.loading = false;
      cx.notify();
    });
  }

  render(cx) {
    const sel = this.target(), key = sel ? `${sel.client}|${sel.depot}` : null;
    if (key !== this.key) { this.key = key; this.file = null; this.rows = []; this.note = null; this.load(cx); }
    const t = theme(), c = P4.palette(settings().dark !== false), f = this.file, stat = P4.countDiff(this.rows);
    const rel = f?.rel ?? sel?.depot?.split("/").slice(-1)[0] ?? "";
    return v_flex().id("perforce-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(f), (e) => e.child(P4.actionBadge(f.action, t)))
        .child(div().flex_1().min_w(0).truncate().text_ellipsis_start().text_size(12).tooltip(sel?.depot ?? "").child(sel ? rel : "Perforce diff"))
        .when(Boolean(f), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${f.change === "default" ? "default" : `CL ${f.change}`} · have #${f.have ?? "–"} · head #${f.head ?? "–"}`)))
        .children(this.rows.length ? P4.statChips(stat, t, c) : [])
        .child(div().id("p4d-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh").on_click((_e, cx) => this.load(cx)).child(svg(icon("refresh")).size(13))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(div().id("p4d-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("p4d-rows", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => P4.diffRow(row, t, true, c))).size_full())))
        .child(Scrollbar.vertical("p4d-rows").viewport_from_layout().absolute().inset_0())
        .when(!sel || this.loading || (Boolean(this.note) && !this.rows.length), (e) => e.child(div().absolute().top(10).left(0).right(0).px(14).text_color(t.dim)
          .child(!sel ? "Select a file in the Perforce panel" : this.loading ? "Loading diff…" : this.note)))
        .when(Boolean(this.note) && this.rows.length > 0, (e) => e.child(div().absolute().bottom(0).left(0).right(0).px(12).py(3).bg(t.raised).text_color(t.dim).child(this.note))));
  }
}
