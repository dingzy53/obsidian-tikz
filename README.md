# Native TikZ

[![Release](https://img.shields.io/github/v/release/dingzy53/obsidian-tikz)](https://github.com/dingzy53/obsidian-tikz/releases/latest)
[![Downloads](https://img.shields.io/badge/dynamic/json?label=downloads&logo=obsidian&color=7c3aed&query=%24%5B%22tikz%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://community.obsidian.md/plugins/tikz)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.1%2B-7c3aed?logo=obsidian)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Render ` ```tikz ` code blocks in [Obsidian](https://obsidian.md) with your **locally installed TeX distribution** (TeX Live, MacTeX or MiKTeX) instead of a browser WASM engine. A rewrite of [`artisticat1/obsidian-tikzjax`](https://github.com/artisticat1/obsidian-tikzjax), see [License](#license).

![Mathematics & Geometry](examples/showcase-1.png)

## Features

- Full TikZ and any LaTeX package, compiled by your own TeX installation.
- The real compiler log when a diagram fails, and a timeout instead of an endless spinner.
- Colours adapted for dark themes.
- Click a diagram to open it in a zoomable viewer.
- A render cache inside the plugin folder. Nothing is written into your notes' folders unless you turn on mobile sharing.
- Optional: share rendered diagrams with your phone or tablet through Obsidian Sync, git or Syncthing.

## Requirements

- **Obsidian Desktop** (Windows, macOS, Linux) to compile diagrams. Phones and tablets can display diagrams a desktop shared with them (see [Mobile](#mobile)) but cannot compile.
- A TeX distribution with **`dvisvgm`** installed:
  - **Windows**: [MiKTeX](https://miktex.org/download) or [TeX Live](https://www.tug.org/texlive/windows.html)
  - **macOS**: [MacTeX](https://www.tug.org/mactex/) (or via Homebrew: `brew install --cask mactex-no-gui`)
  - **Linux**: [TeX Live](https://www.tug.org/texlive/)
    - Ubuntu/Debian: `sudo apt install texlive-latex-extra texlive-luatex texlive-pictures dvisvgm`
    - Fedora: `sudo dnf install texlive-scheme-medium dvisvgm`
    - Arch Linux: `sudo pacman -S texlive-basic texlive-latexextra texlive-pictures dvisvgm`
  - *Linux Flatpak note*: If running Obsidian via Flatpak (`md.obsidian.Obsidian`), the plugin automatically executes host TeX binaries via `flatpak-spawn --host` and uses `~/.cache/obsidian-tikz` for scratch files without extra setup.

## Installation

**From the community directory** (recommended)

1. Open **Settings → Community plugins** and turn on community plugins if asked.
2. Select **Browse**, search for **Native TikZ**, then select **Install** and **Enable**.

You can also open the plugin's page: [community.obsidian.md/plugins/tikz](https://community.obsidian.md/plugins/tikz).

**Manually**

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/dingzy53/obsidian-tikz/releases/latest).
2. In **Settings → Community plugins**, select the folder icon next to **Installed plugins**. This opens `<vault>/.obsidian/plugins/`.
3. Create a folder named `tikz` there and put the three files in it.
4. Select the reload icon next to **Installed plugins**, then enable **Native TikZ**.

**Beta versions:** install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add `dingzy53/obsidian-tikz`.

**Update or remove:** select **Check for updates** or **Uninstall** in **Settings → Community plugins**.

## Usage

Place TikZ code inside a ` ```tikz ` block. Standard figures, bare snippets, or complete documents are all supported:

````markdown
```tikz
\begin{document}
\begin{tikzpicture}
  \draw[thick, ->] (0,0) -- (1,1) node[right] {$x$};
\end{tikzpicture}
\end{document}
```
````

Bare TikZ snippets and packages loaded inline are also accepted:

````markdown
```tikz
\usepackage{forest}
\begin{forest}
[VP [NP [Det][N]] [V]]
\end{forest}
```
````

### Zooming

Click a diagram, or select it with Tab and press Enter, to open it in a viewer. It opens fitted to the window, and you can:

- zoom with the mouse wheel or a trackpad pinch, centred on the pointer;
- drag to pan;
- double-click to switch between fit and 2×;
- press `+` / `-` to zoom, `0` to fit, `1` for actual size, and Esc to close.

The viewer uses the already rendered SVG, so nothing is recompiled. Turn it off with **Click to enlarge diagrams**.

### Mobile

Phones and tablets cannot run TeX, so on mobile the plugin only **displays** diagrams that a desktop rendered and shared. Sharing is **off by default**, because it adds visible files to your vault.

1. On a desktop, turn on **Settings → Native TikZ → Mobile → Share diagrams with mobile**. The plugin creates the shared folder (`TikZ cache` by default) and fills it with one `<hash>.svg` per diagram in your notes, copying renders it already has.
2. Use **Render all for mobile** to compile the diagrams you have never opened on that desktop. New and edited diagrams are added as they render, and **Update shared diagrams now** (also run once at startup) removes files no note uses any more. Only files named `<64 hex>.svg` are ever deleted, so anything else you keep in the folder is safe.
3. Let your sync service carry the folder to your phone, then install and enable the plugin there. Diagrams show up as soon as they sync, and anything not shared yet shows **"TikZ diagram not rendered yet"**. Clicking a diagram opens the zoomable viewer, with pinch to zoom.

- **Obsidian Sync**: keep **Images** in selective sync (the default; `.svg` counts as an image). Turn on **Installed community plugin list** to sync the plugin itself and its settings, so the phone uses the same shared folder.
- **git, Syncthing, iCloud** and similar: work as-is, since the folder is an ordinary vault folder.
- **Why a visible folder?** Obsidian Sync never copies folders whose name starts with a dot, and inside a plugin's folder it only copies `manifest.json`, `main.js`, `styles.css` and `data.json`. A hidden cache, including the plugin's own `cache/`, would never reach your phone. You can still add the shared folder to **Settings → Files and links → Excluded files** to keep it out of search and the graph.
- **Turning sharing off** asks whether to delete the shared diagrams (they disappear from synced devices too) or keep them. **Delete shared diagrams** stays in settings while any remain.
- Shared files are treated as untrusted: they go through the same SVG sanitiser as fresh renders before they are displayed.

### Cache & Scratch Files

- **Render cache**: Compiled diagrams (`<hash>.svg`) are saved in `<vault>/.obsidian/plugins/tikz/cache/` (hidden inside the plugin directory; zero vault pollution). Failed compiles are not cached; the error block shows the live compiler log. When the entry limit is reached, the least recently *used* diagrams are dropped first.
- **Compile scratch files**: Temporary TeX build files (`.tex`, `.dvi`, `.log`) live in your OS temp folder (`os.tmpdir()/obsidian-tikz/`, or `~/.cache/obsidian-tikz/` on Flatpak) and are cleaned up immediately upon completion.

## Showcase

Diagrams rendered side-by-side in **Light mode** (left) and **Dark mode** (right) with automatic adaptive contrast:

### Circuits & Scientific Plots
![Circuits & Scientific Plots](examples/showcase-2.png)

### 3D Coordinates & Diagrams
![3D Coordinates & Diagrams](examples/showcase-3.png)

### Automata & Theme Adaptation
![Automata & Theme Adaptation](examples/showcase-4.png)

## Settings

| Setting | Description | Default |
|---|---|---|
| **Dark mode colours** | `Adaptive` (mirrors lightness with contrast floor), `Light canvas` (light panel), or `Off`. | `Adaptive` |
| **Click to enlarge diagrams** | Clicking a diagram (or Enter on it) opens the zoomable viewer. | `true` |
| **Share diagrams with mobile** | Desktop: keep an SVG of every diagram in the shared folder so a phone can show it. Adds visible files to the vault. | `false` |
| **Shared folder** | Vault folder for shared diagrams; must be visible and outside the config folder. Use the same one on every device. | `TikZ cache` |
| **TeX engine** | `dvilualatex` (recommended), `latex`, `xelatex`, or `pdflatex`. | `dvilualatex` |
| **Binary paths** | Custom path overrides for TeX engine and `dvisvgm`, with an **Auto-detect** button. | Auto (`PATH`) |
| **Extra PATH** | Extra directories to append to `PATH` at runtime. | Empty |
| **Default preamble** | Common packages injected when no `\documentclass` is provided. | Standard TikZ packages |
| **Allow shell escape** | Enables `-shell-escape` (danger: executes arbitrary system commands). | `false` |
| **Compile timeout** | Maximum seconds per compilation stage (1–3600) before killing the process tree. Time spent queued does not count. | `20` |
| **Parallel compiles** | How many diagrams compile at once; the rest queue. `0` = automatic (half the CPU cores, 1–4). | `0` |
| **Maximum cache** | Maximum cached SVGs (0 = unlimited). | `500` |

> [!NOTE]
> On macOS, GUI apps launched from Finder or the Dock do not inherit your shell's `PATH`. If binaries show as "not found", click **Detect automatically** or set the path manually (e.g. `/Library/TeX/texbin`).

## Dark mode

- **Adaptive** (default): Automatically mirrors colour lightness while maintaining a 3:1 contrast floor, ensuring labels and shapes remain legible against dark themes.
- **Light canvas**: Keeps original colours untouched and shows the diagram on a light panel (ideal for complex shading, `ball color`, or colormaps).
- **Off**: Leaves colours unchanged.

To force a diagram to look identical in both light and dark themes, give it a background rectangle:
```tikz
\usetikzlibrary{backgrounds}
\begin{tikzpicture}[
    show background rectangle,
    background rectangle/.style={fill=white, draw=none},
  ]
  \draw[thick, ->] (0,0) -- (1,1) node[right] {$x$};
\end{tikzpicture}
```

## Privacy and security

- **Running programs:** the plugin starts only your TeX engine and `dvisvgm`, with an argument list and never through a shell. Under Flatpak it runs them on the host with `flatpak-spawn --host`.
- **Files outside the vault:** compile scratch files go to the system temp folder (`~/.cache/obsidian-tikz/` under Flatpak) and are deleted after each compile. The render cache stays in the plugin folder.
- **Network:** none. If MiKTeX is set to install missing packages, MiKTeX itself may download them.
- **Clipboard:** written only by the **Copy log** button on a failed diagram.

**Security**

- **Shell escape is off by default**: Vault content is untrusted; `-shell-escape` is never enabled unless explicitly turned on by the user.
- **Direct argv execution**: Subprocesses are spawned with an argv array (`spawn`/`execFile`), never interpolated shell strings.
- **File reads are not sandboxed**: Like any TeX run, a diagram can `\input` or `\includegraphics` any file your user account can read, and render it into the note and the plugin cache. TeX Live dropped `openin_any` read restrictions in 2026 as ineffective, so only open vaults you trust. Shell escape stays off either way.
- **SVG sanitization (allowlist, fail-closed)**: The SVG is parsed and only the elements dvisvgm/PGF emit are kept; event handlers, external `href`/`url()` references, `<style>`, `<a>` and animation elements are removed. An SVG that cannot be parsed is rejected rather than displayed, and the result is inserted via `DOMParser`, never `innerHTML`.

## Development

```bash
npm run dev     # watch build (outputs main.js)
npm run build   # typecheck + production bundle
npm run lint    # eslint
npm run lint:review  # what Obsidian's community plugin scanner checks
npm test        # vitest unit tests
npm run m1      # integration tests against your real TeX install
npm run clean   # clean generated bundle files
```

See [AGENTS.md](AGENTS.md) for architectural constraints and contribution rules.

## License

[MIT](LICENSE) © 2026 Ding Zheng Yuan.

This plugin started as a fork of [`artisticat1/obsidian-tikzjax`](https://github.com/artisticat1/obsidian-tikzjax) (MIT, © 2021–2023 artisticat1). The settings scaffolding and the ` ```tikz ` code block tag come from it; the rendering engine was rewritten to use a local TeX installation. Both copyright notices are kept in [LICENSE](LICENSE).
