# PLAN: QA audit fixes (tikz)

> Branch: `fix/qa-audit-fixes` (from `feat/e2e-testing`) · Date: 2026-11-24 · Status: Implemented and verified.

## Scope from `OBSIDIAN_PLUGINS_QA_REPORT.md`

- **P3 / Compiler & mobile UX**:
  - Add `\pgfplotsset{compat=1.18}` to `DEFAULT_PREAMBLE` and upgrade exact `LEGACY_DEFAULT_PREAMBLE` matches in `mergeSettings` (`src/compiler/wrapSource.ts`, `src/settingsModel.ts`, `test/wrapSource.test.ts`).
  - Persist compact `sharedErrors` sibling metadata in `data.json` when mobile sharing is enabled so mobile displays desktop compile error cards instead of `"TikZ diagram not rendered yet"`, pruning stale/resolved entries on success, sync, and cleanup (`src/settingsModel.ts`, `src/render.ts`, `src/sharedSync.ts`, `src/main.ts`).
- **Settings UI & documentation polish**:
  - Replace the 2 narrow `Default preamble` rows with one full-width `render` row (`if (!this.isDesktop()) return;`) containing `"Restore default"` and the monospace textarea (`src/settings.ts`, `styles.css`).
  - Omit `min`/`max` on numeric settings (`compileTimeoutSeconds`, `maxConcurrentCompiles`, `maxCacheEntries`) so custom period-ended `validate` messages are shown directly (`src/settings.ts`).
  - Collapse the 2 platform info rows into a single `Environment` row using `Platform.isMacOS` (`src/settings.ts`).
  - Shorten setting descriptions to one crisp sentence each and expand full details under `## Settings explained` in `README.md`.
  - Normalize British spelling (`colour`/`centred`) to US English (`color`/`centered`) across UI text and `README.md`.

## Order of Work

1. `[x]` Add `\pgfplotsset{compat=1.18}` and `LEGACY_DEFAULT_PREAMBLE` migration (`src/compiler/wrapSource.ts`, `src/settingsModel.ts`, `test/wrapSource.test.ts`).
2. `[x]` Persist `sharedErrors` in settings and surface desktop compile errors on mobile (`src/settingsModel.ts`, `src/render.ts`, `src/sharedSync.ts`, `src/main.ts`).
3. `[x]` Redesign full-width preamble row, collapse `Environment` info row, omit number `min`/`max`, normalize US English, and add `## Settings explained` (`src/settings.ts`, `styles.css`, `README.md`).
4. `[x]` Run `npm run build && npm run check:mobile && npm run lint && npm run lint:review && npm test`, mark plan verified, and push `fix/qa-audit-fixes`.
