# herdr-app-perforce

A read-only **Perforce** panel for the [Herdr app](https://herdr.dev): the pending changelists of each space's P4 client, P4V-style, right next to Files and Changes.

![Perforce](preview.png)

- One group per pending changelist (default first), with the files open in each
- Status at a glance: action, out of date, needs resolve, locked / exclusive, opened by others, shelved files
- `+added −deleted` per file and a diff against the have revision; a wide diff pane that follows the selection
- Follows the shown space; polls only while the panel is on screen; never changes anything in Perforce

[中文说明](#中文说明)

## Install

Ask your coding agent:

> Install the Herdr mod at https://github.com/wkruan/herdr-app-perforce

It follows [RECIPE.md](RECIPE.md#install): copy `mods/perforce`, add a **Perforce** button to a clone of your layout, check, switch. Or do those three steps yourself.

Requirements: `p4` on PATH, and workspaces that resolve their client from the folder (P4CONFIG files such as `.p4config`, or P4CLIENT). Spaces on this computer only.

## Use

- **Perforce** in the tab bar opens the panel. Click a file for its diff, click again to close it.
- The expand button (or Enter) opens a wide diff pane beside your terminals.
- Right-click a file or changelist to copy its path, number or description.
- Keyboard after clicking the list: ↑/↓ (k/j) files, ←/→ (h/l) fold, Enter wide diff, r refresh. Commands for your own keys: `perforce.next`, `perforce.prev`, `perforce.fold`, `perforce.unfold`, `perforce.expand`, `perforce.refresh`.

## Update

Replace `~/.config/herdr-app/mods/perforce` with the new `mods/perforce` (or ask your agent to reinstall). Herdr reloads it immediately.

## Development

Edit the live copy in `~/.config/herdr-app/mods/perforce` (Herdr hot reloads it; it does not follow junctions or symlinks), then copy it into this repo with `scripts/pull-from-herdr.ps1` and commit. Run `herdr-app check ~/.config/herdr-app/mods/perforce` before every commit.

## License

MIT

---

## 中文说明

Herdr app 的 **Perforce** 只读面板：在右侧边栏（Files、Changes 旁边）显示当前 Space 对应 P4 client 的 pending changelist，和 P4V 的 Pending 页一样按 CL 分组。

- 每个 pending CL 一组（default 在最前），列出打开的文件
- 状态一目了然：操作类型、落后（need sync）、需要 resolve、锁定 / 独占、他人也打开、shelve
- 每个文件的 `+增 −删` 行数，和 have 版本对比的 diff；可展开为宽 diff pane，跟随选中项
- 跟随当前 Space；只在面板可见时轮询；不会修改 Perforce 中的任何内容

**安装**：对你的 coding agent 说「安装 https://github.com/wkruan/herdr-app-perforce 这个 Herdr mod」，它会按 [RECIPE.md](RECIPE.md#install) 完成：复制 `mods/perforce`、在你的布局副本里加上 **Perforce** 按钮、检查、切换。

**要求**：`p4` 在 PATH 上；工作区能从目录识别 client（`.p4config` 等 P4CONFIG 文件，或 P4CLIENT）。仅支持本机 Space。

**使用**：点 tab 栏的 **Perforce** 打开；点文件看 diff，再点一次关闭；展开按钮（或 Enter）打开宽 diff pane；右键复制路径、CL 号或描述；点过列表后可用 ↑/↓（k/j）切换文件、←/→（h/l）折叠、Enter 展开、r 刷新。

**更新**：用新的 `mods/perforce` 覆盖 `~/.config/herdr-app/mods/perforce`（或让 agent 重新安装），Herdr 会立即热加载。
