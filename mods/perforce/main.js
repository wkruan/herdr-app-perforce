// Perforce for Herdr: pending changelists of the shown space's client, read-only.
//   no props            the side panel (panel.js)
//   { view: "diff", space }  the wide diff pane that follows the panel's selection (diff.js)
//   { menu: [{label, text}] } the right-click copy menu, opened as a popup
import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel, copyMenu } from "./panel.js";
import { DiffPane } from "./diff.js";

export default class Perforce extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.menu ? "menu" : p.view === "diff" ? "diff" : "panel";
    if (this.mode !== "menu") { this.impl = this.mode === "diff" ? new DiffPane() : new Panel(); this.impl.init(cx); }
  }

  render(cx) { return this.mode === "menu" ? copyMenu() : this.impl.render(cx); }
}
