# Decision Capsule — улучшение продукта: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Укрепить локальный архив решений и привести весь интерфейс к строгой утилитарной дизайн-системе без потери существующего формата.

**Architecture:** Доменная модель задаёт все инварианты, IndexedDB применяет их на границе хранения, а `app.js` отвечает только за состояние и рендер. Изменения сохраняются локально и проверяются Node-тестами плюс браузерным сценарием.

**Tech Stack:** Vanilla ES modules, IndexedDB, Node test runner, static server, Playwright через browser tooling.

---

### Task 1: Закрепить инварианты модели

**Files:**
- Modify: `lib/model.js`
- Test: `tests/model.test.js`

- [x] Add failing tests for canonical ISO timestamps, two-or-more options, result/opening invariants, zero confidence, and monotonic progress transitions.
- [x] Run `npm test -- --test-name-pattern="invariant|progress|confidence"` and confirm the new tests fail for the expected reason.
- [x] Implement strict timestamp/date helpers, `normalizeDraft`, `statusCounts`, `daysUntilReview`, and update `validateCapsule`, `createCapsule`, `openCapsule`, `saveResult` without changing the export envelope version.
- [x] Run `npm test` and confirm the model suite passes.

### Task 2: Make IndexedDB transitions atomic and defensive

**Files:**
- Modify: `lib/repository.js`
- Test: `tests/repository.test.js`

- [x] Add failing tests for invalid `updateProgress`, rejected result-only updates, seal plus draft clear in one operation, and rollback when an import entry is invalid.
- [x] Run the focused repository tests and confirm failure before implementation.
- [x] Implement strict progress validation, `sealCapsule`, transaction abort on operation rejection, and record validation/isolation during `list()`.
- [x] Run `npm test` and confirm all repository tests pass.

### Task 3: Repair archive and draft state behavior

**Files:**
- Modify: `app.js`
- Test: `tests/app-state.test.js` (create if needed for pure extracted helpers)

- [x] Add failing tests for filtered ready sections, search over all text fields, draft resume/clear, debounced ordered saves, and correct duplicate hash import reporting.
- [x] Run focused tests and verify the failures describe the missing behavior.
- [x] Add a single render date, extracted archive filtering/sorting helpers, draft save queue with visible status, resume/clear actions, and use the atomic repository seal call.
- [x] Replace all `Number(value) || 50` patterns with an explicit finite-number check and flush draft changes on step transitions.
- [x] Run `npm test` and confirm all tests pass.

### Task 4: Rebuild the interface around the existing design tokens

**Files:**
- Modify: `index.html`, `styles.css`, `app.js`

- [x] Remove `theme-color` and `description` meta tags; keep charset, viewport and title.
- [x] Simplify Russian copy, localize envelope stamps, remove inline styles, add accessible progress semantics, and add result button state.
- [x] Rework the archive header, summary, filters, search result count, sort control, cards and empty states while preserving the parchment/burgundy/forest visual language.
- [x] Fix contrast tokens, focus outline, wide-screen centering, mobile overflow and dialog focus trap/restore.
- [x] Verify keyboard navigation and no network requests in a local browser.

### Task 5: Verify build and end-to-end lifecycle

**Files:**
- Modify: `README.md` if behavior or copy needs documentation
- Test: `tests/` and browser session

- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Start `npm run dev`, exercise create → reload → ready/open → result → export/import/hash in desktop and mobile viewport.
- [x] Inspect browser console and screenshots for layout, focus, and overflow regressions.
- [x] Record any limitation honestly in the final report.
