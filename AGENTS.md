# AGENTS.md

Instructions for any coding agent (or human) working in this repository.
This file is the operational reference and architectural constraint guide.

## What this repo is

An Obsidian plugin that renders ` ```tikz ` code blocks by shelling out to a
**locally installed TeX distribution** (TeX Live / MacTeX / MiKTeX) instead of
a browser WASM engine. Compiling happens on desktop only; on mobile the plugin
is a read-only viewer of diagrams a desktop shared through the vault (opt-in). It is a heavy rewrite forked from
[`artisticat1/obsidian-tikzjax`](https://github.com/artisticat1/obsidian-tikzjax):
the settings-tab scaffolding, dark-mode SVG remap, and the `tikz` fence tag
are reused; the entire rendering backend is new.

## Pending for the next release

Apply these together with the next version bump, then delete this section.
Until a release ships them, `manifest.json` on `main` must stay identical to
the latest release's manifest, because the community directory compares the
two. Do not publish a release only for these changes.

- `manifest.json`: set `"name": "Native TikZ"` and `"author": "Ding Zheng Yuan"`,
  and add `"authorUrl": "https://github.com/dingzy53"` after `author`.
- `README.md`, Installation: change **TikZ** to **Native TikZ** in "search for
  **TikZ**" and "enable **TikZ**".
- `manifest.json`: set `"isDesktopOnly": false` (mobile viewer, #3), and in
  `README.md` drop the "desktop only" wording from Requirements/Installation.

## Commands

- `npm install`
- `npm run dev` — esbuild watch build, outputs `main.js` (point a symlink or
  `.obsidian/plugins/<id>/` at the repo for live testing in a real vault)
- `npm run build` — typecheck + production bundle
- `npm run lint` — keep the existing eslint config passing
- `npm test` — run vitest unit tests
- `npm run clean` — remove generated bundle files
- `npm run version` — synchronize version across package.json, manifest.json, and versions.json

## Hard constraints — do not violate these

1. **Compiling is desktop only; mobile only displays.** Node and Electron do
   not exist on mobile, and a top-level `require` of either makes the plugin
   fail to load there. Only `src/desktop.ts` and the modules it reaches
   (`cache.ts`, `compiler/engine.ts`, `compiler/pathResolve.ts`) may import
   them, and `main.ts` loads `desktop.ts` lazily (`await import`) behind
   `Platform.isDesktopApp && !Platform.isMobile` (mobile emulation keeps
   `isDesktopApp` true but blocks Node). Everything else must stay platform-neutral. Enforced
   by the `no-restricted-imports` block in `eslint.config.mjs` and by
   `test/mobileLoad.test.ts`, which runs the bundle with Node blocked. Mobile
   never compiles: it shows shared diagrams or "not rendered yet".
2. **Zero vault pollution by default.** Never write `.svg`/`.pdf`/`.png`/log
   files into any folder visible in the Obsidian file explorer. Compile
   scratch files go in the OS temp dir (`os.tmpdir()`, or
   `~/.cache/obsidian-tikz` when running inside Linux Flatpak); cache files go
   under the plugin's own hidden folder, `<vault>/.obsidian/plugins/<id>/cache/`.
   The single exception is the **opt-in** "Share diagrams with mobile"
   setting (off by default, clearly labelled): it writes only `<sha256>.svg`
   files, through the Vault API, into the user's chosen shared folder, and
   prunes or deletes only files matching that name pattern. It has to be a
   visible folder: Obsidian Sync never copies dot-folders, nor anything in a
   plugin folder except `manifest.json`/`main.js`/`styles.css`/`data.json`
   (checked in Obsidian 1.15's `allowSyncFile`).
3. **`-shell-escape` is off by default, always.** Vault content is untrusted
   input. Enabling shell-escape (or any `\write18`) lets a note execute
   arbitrary shell commands on open. It may exist as an explicit, clearly
   labelled opt-in setting — never a default, never implicit.
4. **Never build shell command strings.** Use `child_process.execFile`/
   `spawn` with an argv array. No `exec()` with interpolated/concatenated
   strings, ever — the tex source is arbitrary vault content.
5. **Never hang.** Every spawned process has a configurable timeout; on
   timeout, kill the process (tree) and show the user a timeout error. No
   silent infinite spinners — that's the exact upstream bug this rewrite
   exists to fix.
6. **Always show the real compiler log on failure**, not a generic message.
7. **SVG output is untrusted.** `optimizeSVG` must keep failing closed
   (`SvgRejectedError`) and `render.ts` must insert via `DOMParser`/`importNode`,
   never `innerHTML`. Widen the element allowlist rather than relaxing it.
8. **Don't claim a TeX read sandbox.** TeX can read any file the user can.
   `openin_any` is a no-op since TeX Live 2026 and broke luaotfload before
   that (#4), so don't reintroduce it or advertise read restriction.
9. Plugin `id` in `manifest.json`: lowercase + hyphens only, must not contain
   `"obsidian"`, must not end in `"plugin"` (Obsidian manifest validation
   will reject it otherwise).

## Layout

```
src/main.ts              Plugin entry: onload/onunload, wires everything up
src/settings.ts          PluginSettingTab on the declarative settings API (1.13+)
src/settingsModel.ts     Settings schema, defaults, mergeSettings/validation
                         (pure, no obsidian import)
src/limiter.ts           Bounded-concurrency queue for compiles (pure)
src/render.ts            registerMarkdownCodeBlockProcessor handler,
                         loading state, error block, dark-mode + SVGO
src/zoom.ts              Pure zoom/pan maths for the diagram viewer
src/zoomModal.ts         Diagram viewer modal (zoom, pan, keyboard); adopts the
                         sanitised SVG via DOMParser/importNode
src/desktop.ts           The only door to Node/Electron: local cache, compiler,
                         binary discovery, reveal-in-folder. Loaded lazily on
                         desktop only (rule 1)
src/shared/              Pure helpers for the mobile shared folder: shared key
                         (WebCrypto), note scanner, sync plan, folder validation
src/sharedStore.ts       Shared folder through the Vault API (read on mobile,
                         write/prune on desktop), change events
src/sharedSync.ts        Desktop: scan notes, copy/prune, "render all", cleanup
                         dialog
src/svg.ts               Pure SVG post-processing: dark-mode remap, allowlist
                         sanitising (SVGO tree plugin, fail-closed), id
                         namespacing, SVGO
src/cache.ts             content-hash disk cache (read/write/clear)
src/compiler/
  index.ts               compiler barrel re-exports
  engineSpecs.ts         engine ids/specs and compile result types (pure)
  engine.ts              spawn tex engine + dvisvgm, timeout/kill handling
  pathResolve.ts         binary discovery incl. macOS PATH fallback & Flatpak host spawn
  wrapSource.ts          \documentclass/\begin{document} auto-wrapping
test/                    unit and integration tests (vitest)
manifest.json / esbuild.config.mjs / package.json / version-bump.mjs
.github/workflows/release.yml / .github/workflows/ci.yml
LICENSE
```

## Style

- Strict TypeScript; justify any new `any` with a comment.
- Keep `src/compiler/*`, `src/shared/*` and `src/cache.ts` free of any `import "obsidian"` —
  they should be unit-testable as plain Node modules, independent of the
  Plugin lifecycle.
- Prefer async/await; avoid unhandled promise rejections around
  `child_process` calls (they will crash the render, not just the compile).

## Definition of done for any change

- `npm run build` passes with no type errors.
- `npm run lint` and `npm test` pass.
- Verified in a real vault or integration test suite: at minimum
  a working diagram, a deliberately broken one (real error shown, no hang),
  and a dark-mode toggle check.
- With "Share diagrams with mobile" off (the default), no new files appear
  anywhere under the vault root except inside `.obsidian/plugins/<id>/`.
- Changes on the mobile path: `test/mobileLoad.test.ts` passes, and the
  plugin was checked under Obsidian's mobile emulation (`obsidian dev:mobile on`).
- Settings changes persist across an Obsidian restart.

## When in doubt

Consult `README.md` and this file first. If an architectural decision or constraint
needs to change based on real data, update `README.md` and `AGENTS.md` in the same PR.
