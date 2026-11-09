# Pop Shell

> **This repository is a fork of [pop-os/shell](https://github.com/pop-os/shell.git)** with GNOME Shell 51 / Fedora 45 support and additional customizations:
> - COSMIC-aligned keyboard shortcuts
> - Active Hint controls (color, radius, border width, show on maximized/single)
> - Move the built-in display below or to the right of the primary display
> - Cross-workspace tile movement via `Super` + `Shift` + `Direction`
> - Updated panel menu

Pop Shell is a keyboard-driven layer for GNOME Shell which allows for quick and sensible navigation and management of windows. The core feature of Pop Shell is the addition of advanced tiling window management — a feature that has been highly sought within our community. For many — ourselves included — i3wm has become the leading competitor to the GNOME desktop.

Tiling window management in GNOME is virtually nonexistent, which makes the desktop awkward to interact with when your needs exceed that of two windows at a given time. Luckily, GNOME Shell is an extensible desktop with the foundations that make it possible to implement a tiling window manager on top of the desktop.

Therefore, we see an opportunity here to advance the usability of the GNOME desktop to better accommodate the needs of our community with Pop Shell. Advanced tiling window management is a must for the desktop, so we've merged i3-like tiling window management with the GNOME desktop for the best of both worlds.

---

## Supported Versions

- GNOME Shell **45, 46, 47, 48, 49, 50, 51**
- Tested on **Fedora 45** with GNOME Shell 51.1

---

## Installation

### Prerequisites

- Node.js + npm
- TypeScript (installed via `npm install`)
- `make` (optional, for `make local-install`)

### Build

```bash
cd pop_shell
npm install
export PATH="$PWD/node_modules/.bin:$PATH"
PROJECTS="color_dialog floating_exceptions" ./scripts/transpile.sh
```

### Install (local user)

```bash
rm -rf ~/.local/share/gnome-shell/extensions/pop-shell@system76.com
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r _build ~/.local/share/gnome-shell/extensions/pop-shell@system76.com
gnome-extensions enable pop-shell@system76.com
```

Or with Make:

```bash
make local-install
```

### Activate

- **Wayland:** log out and back in (or reboot).
- **X11:** `Alt+F2`, then `r` and Enter.

Verify:

```bash
gnome-extensions info pop-shell@system76.com
```

Should show `State: ACTIVE`.

### Configure GNOME shortcuts

To avoid conflicts between GNOME's default shortcuts and Pop Shell's, run:

```bash
make configure
# or
sh scripts/configure.sh
```

Answer `y` when prompted. This aligns GNOME's workspace shortcuts to the COSMIC scheme.

### Uninstall

```bash
gnome-extensions disable pop-shell@system76.com
rm -rf ~/.local/share/gnome-shell/extensions/pop-shell@system76.com
```

---

## Usage

Tiling is **disabled by default**. To enable:

- Press `Super` + `Y`, or
- Click the Pop Shell icon in the top bar and toggle "Tile Windows".

### Keyboard Shortcuts

Pop Shell follows the [Pop!\_OS COSMIC keyboard shortcuts](https://system76.com/support/pop-cosmic-keyboard-shortcuts/) for navigating and moving tiled windows. `<Direction>` refers to the arrow keys, the numpad arrow keys, or their Vim equivalents (`h`, `j`, `k`, `l`).

| Shortcut | Action |
| --- | --- |
| `Super` + `<Direction>` | Focus the window in that direction |
| `Super` + `Alt` + `<Direction>` | Focus the display in that direction |
| `Super` + `Ctrl` + `<Direction>` | Switch to the workspace in that direction |
| `Super` + `Shift` + `<Direction>` | Move the focused window in that direction, then to the adjacent display/workspace |
| `Super` + `Shift` + `Alt` + `<Direction>` | Move the focused window to the display in that direction |
| `Super` + `Shift` + `Ctrl` + `<Direction>` | Move the focused window to the workspace in that direction |
| `Super` + `O` | Toggle the orientation of a fork's tiling orientation |
| `Super` + `G` | Toggle a window between floating and tiling |
| `Super` + `Y` | Toggle auto-tiling |
| `Super` + `S` | Toggle stacking mode |
| `Super` + `Return` | Launch a new terminal window |
| `Super` + `Shift` + `Return` | Enter window management mode |
| `Super` + `F` | Launch a new Files window |
| `Super` + `/` | Open the launcher |
| `Super` + `Q` | Close window |
| `Super` + `M` | Maximize window |

### Panel Menu Settings

Click the Pop Shell icon in the top bar for quick settings:

- **Tile Windows** – toggle auto-tiling
- **Floating Window Exceptions** – manage floating apps
- **Shortcuts** – overview of shortcuts
- **Show Active Hint** – toggle active window border
- **Active Border Radius / Width** – adjust the active hint border
- **Show Active Hint on Maximized/Single** – show border even for single/maximized windows
- **Active Hint Color** – pick the border color
- **Gaps** – inner/outer gap size
- **Move Built-in Display Below/Right of Primary** – rearrange the built-in display relative to the primary display

### Built-in Display Movement

On multi-monitor setups, the built-in display (e.g. laptop panel) can be quickly repositioned:

- **Move Built-in Display Below Primary** – places the built-in display under the primary display
- **Move Built-in Display Right of Primary** – places it to the right of the primary display

The change is applied persistently via `gdctl` (GNOME Display Control).

---

## Shared Features

Features that are shared between stacking and auto-tiling modes.

### Directional Keys

These are key to many of the shortcuts utilized by tiling window managers. This document will henceforth refer to these keys as `<Direction>`, which default to the following keys:

- `Left` or `h`
- `Down` or `j`
- `Up` or `k`
- `Right` or `l`

### Window Focus Switching

When not in window management mode, pressing `Super` + `<Direction>` will shift window focus to a window in the given direction.

### Window Management Mode

> This mode is activated with `Super` + `Shift` + `Return`.

Window management mode activates additional keyboard control over the size and location of the currently-focused window.

Activating this enables the following behaviors:

- `<Direction>` – move the overlay / resize the window
- `Shift` + `<Direction>` – resize the overlay
- `Ctrl` + `<Direction>` – select a window for swapping
- `O` – toggle tiling orientation
- `Return` – apply changes
- `Esc` – cancel changes

### Launcher

Pop Shell provides an integrated launcher which interfaces directly with our [pop-launcher](https://github.com/pop-os/launcher) service.

### Inner and Outer Gaps

Gaps improve the aesthetics of tiled windows and make it easier to grab the edge of a specific window. Configurable in the extension's popup menu.

### Hiding Window Title Bars

Windows with server-side decorations may have their title bars completely hidden. Toggle in the extension's popup menu.

---

## Floating Mode

This is the default mode of Pop Shell, which combines traditional stacking window management, with optional tiling window management features.

---

## Tiling Mode

Disabled by default, this mode manages windows using a tree-based tiling window manager. Similar to i3, each node of the tree represents two branches. A branch may be a window, a fork containing more branches, or a stack that contains many windows.

### Keyboard Shortcuts

See the [Keyboard Shortcuts](#keyboard-shortcuts) table above.

### Customizing the Floating Window List

There is a file `$XDG_CONFIG_HOME/pop-shell/config.json` where you can add exceptions:

```json
{
  "class": "<WM_CLASS String from xprop>",
  "title": "<Optional Window Title>"
}
```

---

## Developers

Due to the risky nature of plain JavaScript, this GNOME Shell extension is written in [TypeScript](https://www.typescriptlang.org/).

Dependencies:

- Node.js LTS+
- npm
- `npm install` (installs TypeScript 7.0.2)

Build:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
PROJECTS="color_dialog floating_exceptions" ./scripts/transpile.sh
```

Or with Make:

```bash
make
```

## License

Licensed under the GNU General Public License, Version 3.0, ([LICENSE](LICENSE) or https://www.gnu.org/licenses/gpl-3.0.en.html)

### Contribution

Any contribution intentionally submitted for inclusion in the work by you shall be licensed under the GNU GPLv3.