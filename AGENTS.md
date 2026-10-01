# AGENTS.md

Instructions for any coding agent (or human) working in this repository.
This file is the operational reference and architectural constraint guide.

## What this repo is

An Obsidian **desktop-only** plugin that renders ` ```tikz ` code blocks by
shelling out to a **locally installed TeX distribution** (TeX Live / MacTeX /
MiKTeX) instead of a browser WASM engine. It is a heavy rewrite forked from
[`artisticat1/obsidian-tikzjax`](https://github.com/artisticat1/obsidian-tikzjax):
the settings-tab scaffolding, dark-mode SVG remap, and the `tikz` fence tag
are reused; the entire rendering backend is new.

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

1. **Desktop only.** `manifest.json` → `"isDesktopOnly": true`. Never add a
   mobile code path; there isn't one for Node child processes.
2. **Zero vault pollution.** Never write `.svg`/`.pdf`/`.png`/log files into
   any folder visible in the Obsidian file explorer. Compile scratch files go
   in the OS temp dir (`os.tmpdir()`, or `~/.cache/obsidian-tikz` when
   running inside Linux Flatpak); cache files go under the plugin's own
   hidden folder, `<vault>/.obsidian/plugins/<id>/cache/`.
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
8. **File reads stay restricted by default.** TeX runs with `openin_any=p`
   unless the user opts out via the "Restrict file access" setting.
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
src/svg.ts               Pure SVG post-processing: dark-mode remap, allowlist
                         sanitising (SVGO tree plugin, fail-closed), id
                         namespacing, SVGO
src/cache.ts             content-hash disk cache (read/write/clear)
src/compiler/
  index.ts               compiler barrel re-exports
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
- Keep `src/compiler/*` and `src/cache.ts` free of any `import "obsidian"` —
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
- No new files appear anywhere under the vault root except inside
  `.obsidian/plugins/<id>/`.
- Settings changes persist across an Obsidian restart.

## When in doubt

Consult `README.md` and this file first. If an architectural decision or constraint
needs to change based on real data, update `README.md` and `AGENTS.md` in the same PR.
