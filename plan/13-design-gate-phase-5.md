# Design gate — phase 5 (static audit of the `sanad.ui` kit, 2026-09-23)

> Output of `design:design-critique` + `design:accessibility-review` + `design:ux-copy` (with `ui-ux-pro-max` ux/icons inputs) run on the kit code and READMEs — no browser was available (R-032). The prioritised fixes in §4 were applied in the same phase; per-component READMEs record what each one took.

# Design gate — `sanad.ui` portable kit (phase 5)

**Scope.** 20 components under `whatsapp_next/public/js/ui/` (index.js + style.scss + README.md each; ContactPicker also `selected.js` + `sources/*.js`), `_core`, and the live-use scripts in `public/js/listview/*.js` and `public/js/form/*.js`. Static audit only (no browser): every finding quotes code with `file:line` (paths relative to `whatsapp_next/public/js/`). Binding context: `.claude/rules/ui.md` (Espresso tokens only, logical properties, `__()` everywhere, loading/empty/error states, keyboard access, mobile-first); `docs/component/*.dc.html` read for intent only.

**Severity.** 🔴 blocks the tick in `plan/10-build-order.md` · 🟡 fix in this phase · 🟢 polish / next pass.

**Verdict in one paragraph.** The kit is unusually disciplined for a first cut: colours come only from Espresso tokens (no hex, no rgba anywhere in `ui/`), layout is logical-property based, every user string goes through `__()` (0 hard-coded labels found by grep), every async pane goes through `EmptyState`, reduced motion is honoured via `--sanad-motion`, and every icon-only button carries an `aria-label`. What still blocks the gate is small and concrete: one unhandled promise rejection in the ContactPicker preview, an error-normaliser that never strips HTML (so error toasts will show literal `<b>` tags), a `PhoneField` that has **no live use** although its README lists three, and a set of bulk-action strings in the Campaign list that concatenate verbs and counts into ungrammatical English (and untranslatable Arabic). Below that sit consistency debts that should be paid while the code is fresh: two different side-panel grammars (Drawer vs ConversationDrawer), four mobile-sheet behaviours for four dialogs, five copies of the same chip CSS, four copies of the same throttled-refresh, and a handful of ARIA choices (FilterBar tabs without panels, the chat `role="log"` re-rendered wholesale) that will make screen readers noisy.

---

## 1. Design critique

### 1.1 First impression

| # | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 1 | 🟢 | The kit reads as native Desk: Espresso tones, `btn btn-sm`, `frappe.ui.Dialog` for every modal, `frappe.ui.form.make_control` for inputs. No second UI world leaks in. | `_core/style.scss:36–49` tone triplets; `MetaDialog/index.js:66`; `FilterBar/index.js:157` | Keep. Record in README that ad-hoc colours are a test failure (`tests/test_kit_portability.py` could grep `#[0-9a-f]{3,6}` in `ui/`). |
| 2 | 🟡 | Two visual grammars for "side panel opened from a list": `Drawer` (title 16 px, footer actions, backdrop .5, 480 px, white body) and `ConversationDrawer` (title 14 px, actions row under the header, backdrop .35, 520 px, gray body). A user opening Outbound rows then Numbers rows sees two different panels. | `Drawer/style.scss:13,44,8` vs `ConversationDrawer/style.scss:18,61,32,107`; close button `btn-xs` at `Drawer/index.js:60` vs `btn-sm` at `ConversationDrawer/index.js:90` | Extract one `.sanad-panel` shell (header / body / footer, backdrop, width var, mobile sheet) in `_core/style.scss`; ConversationDrawer renders its actions in the shared footer or as a header toolbar that Drawer also supports. |
| 3 | 🟡 | Prototype intent ("one overlay object drives drawer *and* modal", `docs/component/Overlay Panel.dc.html`) is only half realised: four dialog surfaces (MetaDialog, ContactPicker, QuickSend, ConfirmDialog/ListStatsCard modal) behave differently under 768 px. | `MetaDialog/style.scss:65–75` (`min-height:100dvh`, no sticky footer) vs `ContactPicker/style.scss:215–221` (`height:100dvh`, sticky footer, `scroll-padding-block-end: 96px`); QuickSend/ConfirmDialog have no sheet rule at all | One `.sanad-sheet` rule in `_core/style.scss` applied by `dialog.$wrapper.addClass("sanad-kit sanad-sheet")` in every kit dialog. |

### 1.2 Usability

| # | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 4 | 🔴 | **Unhandled rejection** in the ContactPicker "Selected" preview: `run_preview()` rethrows after showing the alert, and the debounced caller has no consumer. Triggered on every selection change and on every switch to the Selected tab. | `ContactPicker/selected.js:89` `throw err;` reached from `selected.js:20` `this.schedule_preview = ui.debounce(() => this.run_preview(), …)` called at `ContactPicker/index.js:193` and `:330` without `.catch` (only `continue_()` at `:350–381` catches) | Make `schedule_preview` swallow: `ui.debounce(() => this.run_preview().catch(() => {}), …)`; keep the rethrow for `ensure_preview()`. |
| 5 | 🔴 | Error normaliser never strips HTML: the guard tests `frappe.utils.strip_html`, which does not exist (Frappe defines only `window.strip_html`, `frappe/public/js/frappe/utils/common.js:206`). Server messages such as `<b>Not permitted</b>` reach `Toast`, which escapes them, so users read literal tags. | `_core/index.js:72` `const err = new Error(frappe.utils.strip_html ? strip_html(message) : message);` and `Toast/index.js:27–28` `ui.escape(message)` | `new Error(typeof strip_html === "function" ? strip_html(message) : message)`. |
| 6 | 🔴 | `PhoneField` has **no live use** (kit rule: "at least one live use in a real screen"). Its README lists ContactPicker manual entry and the Numbers link/convert dialog; neither calls it. Meanwhile three different phone-entry patterns exist: QuickSend's plain Data field with a hard-coded Saudi hint, the manual source's textarea with a hard-coded Saudi placeholder *outside* `__()`, and the read-only field in the link dialog. | grep: only `ui/index.js:17` imports it; `PhoneField/README.md:40–43`; `QuickSend/index.js:46` `description: __("International format, e.g. +9665…")`; `ContactPicker/sources/manual.js:24` `placeholder="${ui.escape("+966 5X XXX XXXX\nAhmed;+9665XXXXXXXX")}"` | Wrap QuickSend's `phone` control with `new sanad.ui.PhoneField({ control })` (the hint replaces the description, `resolve_phone` uses `phone_e164`); derive the manual-source example from `sanad.ui.PhoneField.prototype.example()`; fix the README's live-use section. |
| 7 | 🟡 | QuickSend focuses the **last** invalid field, not the first: `validate()` calls `set_error` for each field in order and every `set_error` calls `set_focus`. README promises the first. | `QuickSend/index.js:259–276` loop; `:248` `field.set_focus && field.set_focus();`; `QuickSend/README.md:41` | Collect errors, then focus `errors[0]`. |
| 8 | 🟡 | Dead-looking primary buttons: PagedChildTable toolbar renders `disabled` buttons whose reason is only a `title` (hover). On a dirty or unsaved Campaign the primary "Add recipients" is greyed with no visible explanation; keyboard and touch users never see the reason. | `PagedChildTable/index.js:141–142` `$btn.prop("disabled", !!a.disabled); if (a.title) $btn.attr("title", a.title);`; live: `form/whatsapp_campaign.js:34–37`, `form/whatsapp_contact_group.js:26–29` | Either render the hint as visible text next to the toolbar (`sanad-pct__note`) or keep the button enabled and let the click explain ("Save the campaign first") via `Toast.info`. |
| 9 | 🟡 | Focus restore is fragile in `Drawer`: (a) when a drawer is opened while another is open, the previous one is hidden *before* `this.opener = document.activeElement`, so the opener is an element inside the drawer that is disappearing; (b) `hide()` restores to `this.opener` without checking it is still in the DOM, but RowActions re-decorates rows after every list render, so the row button is usually detached and focus drops to `<body>`. ConversationDrawer already guards with `document.contains`. | `Drawer/index.js:87–89`; `Drawer/index.js:125` vs `ConversationDrawer/index.js:139` | Capture the opener before hiding the previous drawer; on hide, fall back to the list's `.list-row-container[data-name]` for the same docname, else `listview.$result`. |
| 10 | 🟡 | Two independent singletons (`Drawer.current`, `ConversationDrawer.current`) can both be open, giving two `aria-modal` dialogs and two backdrops (Drawer panel 1041 above ConversationDrawer 1040). | `Drawer/index.js:363`, `ConversationDrawer/index.js:369`; z-index `Drawer/style.scss:17` vs `ConversationDrawer/style.scss:4` | A shared `ui.overlay.open(instance)` registry in `_core` that closes the other panel. |
| 11 | 🟡 | Chat rows that are clickable are `role="button"` yet contain `<a>` media / reference links (nested interactive content). Keyboard Enter on a focused inner link bubbles to the row handler (`keydown` is not filtered by `closest("a")`, only `click` is). | `ChatThread/index.js:236` `role="button" tabindex="0"`; links at `:232` and `:262`; handler `:76–82` | Make the bubble content non-interactive when `on_row_click` is set (render the reference chip as text), or move the row action to an explicit "Details" button in `__meta`. |
| 12 | 🟡 | `ListStatsCard` interactive cards set `aria-label = card.label`, which *replaces* the inner text, so screen readers hear "Sending now, button" and never the number. | `ListStatsCard/index.js:53` `aria-label="${ui.escape(card.label)}"` | Drop `aria-label` (the label + value inside the element already name it) or set it to `"{label}: {value}"` after each refresh. |
| 13 | 🟡 | Card error state shows "Unavailable" with the reason only in `title` (hover). | `ListStatsCard/index.js:106` `title="${ui.escape(err.message || "")}"` | Put the message in a visually-hidden span inside the `role="alert"` node. |
| 14 | 🟡 | Silent no-op actions: (a) Command list "Test" does nothing when the form script cannot be evaluated; (b) DashboardBlock Custom cards without a `route` are `<button>`s that ignore the click. | `listview/whatsapp_command_list.js:87` `handler: (doc) => ensure_modal_loaded() && whatsapp_next.command_test_dialog(doc)`; `DashboardBlock/index.js:284` `if (!card.data || !card.data.route) return;` | (a) route to the form with a `Toast.info("Open the command to test it")`; (b) render a non-button card (`role="listitem"` content only) when there is nothing to open. |
| 15 | 🟡 | Campaign list bulk confirmations lose the count and build the verb by concatenation: title `"{0} the selected campaigns?"`; the fallback path that *does* say "Pause 3 campaigns?" is dead when BulkActions exists. | `listview/whatsapp_campaign_list.js:121` vs `:28`; `:115` `if (typeof sanad.ui.BulkActions === "function")` | Give each action its own `confirm: (names) => ({ title: __("Pause {0} campaigns?", [names.length]) … })` and delete `bulk_campaign_action`. |
| 16 | 🟢 | Two ways to "select all" on every candidate table (header checkbox + footer button). | `ContactPicker/sources/_base.js:95` and `contacts.js:52`, `doctype.js:93`, `current.js:60` | Keep the header checkbox only; move "Add all N matching" into the footer with "Add N". |
| 17 | 🟢 | The Excel source mutates Stepper internals (`stepper.opts.finish_label`, `render_state()`), which the Stepper README does not list as public. | `ContactPicker/sources/excel.js:214,243–245` | Add `stepper.set_finish_label(text)` to Stepper. |

### 1.3 Visual hierarchy

| # | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 18 | 🟡 | Drawer header vs ConversationDrawer header (see #2): title size, close button size, alignment (`flex-start` vs `center`) and where actions live differ. | `Drawer/style.scss:31–51`; `ConversationDrawer/style.scss:36–83` | Shared `.sanad-panel__header` (avatar slot optional, title `--text-lg`, badge, tools). |
| 19 | 🟡 | Chip/pill implemented six times with two heights (28 and 32 px): FilterBar tab 28, DashboardBlock period 28, TreeGroupBy 32, PagedChildTable 32, ContactPicker 32, Stepper 32. | `FilterBar/style.scss:39`, `DashboardBlock/style.scss:30`, `TreeGroupBy/style.scss:34`, `PagedChildTable/style.scss:34`, `ContactPicker/style.scss:97`, `Stepper/style.scss:29` | One `.sanad-chip` (+ `--active`, `--danger`) in `_core/style.scss`; all at `var(--sanad-target)`. |
| 20 | 🟡 | Data-table styling copied three times. | `PagedChildTable/style.scss:64–79`, `ContactPicker/style.scss:121–136`, `ListStatsCard/style.scss:63–67` | `.sanad-table` in `_core`. |
| 21 | 🟢 | Spacing that should use `--sanad-gap-*` tokens: `ChatThread/style.scss:42` `padding-inline: 10px`; `StatusBadge/style.scss:17` `10px`; `FilterBar/style.scss:66,70` `30px / 10px`; `MetaDialog/style.scss:34` `18px`; `Drawer/style.scss:27` `80px`; `ContactPicker/style.scss:219` `96px`; inline `ConversationDrawer/index.js:156` `style="width:64px;height:18px"`; and the campaign progress strip which is Bootstrap `.progress` + inline `height: 8px; gap:16px; min-width:72px` instead of `sanad-bulk__progress`. | `form/whatsapp_campaign.js:80–86` | Tokenise spacing; reuse `.sanad-bulk__progress`/`__bar` and `ui.skeleton()` (`form/whatsapp_campaign.js:107` hand-writes skeleton markup). |
| 22 | 🟢 | A neutral state gets a warning icon: "Not linked" is rendered `orange` → amber tone → `es-line-alert-triangle`. | `StatusBadge/index.js:8` `TONE_ICON`; `ConversationDrawer/index.js:161`; `listview/whatsapp_number_list.js:216` | Use `gray` (with `icon:false`) for "Not linked"; reserve amber for Held/Paused. |
| 23 | 🟢 | Icon drift: "Quick send" is `es-line-reply` in the Numbers list but `es-line-chat` in Outbound and ConversationDrawer; "Reply" is `es-line-reply` in Inbound. DashboardBlock mixes the legacy `arrow-down-right` with `es-line-arrow-up-right`. | `listview/whatsapp_number_list.js:185` vs `whatsapp_log_list.js:190`, `ConversationDrawer/index.js:210`; `DashboardBlock/index.js:252` | One icon per verb in a small `ui.icons` map (`quick_send`, `reply`, `contact`, `cancel`, `resend`). |

### 1.4 Consistency

**Option naming (`wrapper`, `api`, `on_*`).** `wrapper`, `listview`, `frm`, `doctype`, `method`, `condition`, `danger`, `roles`, `perm`, `empty_text`, `size` are consistent across components. Deviations:

| # | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 24 | 🟡 | Callbacks are `on_*` everywhere except `action.onclick` in EmptyState and Toast, and `card.onclick` in ListStatsCard. | `EmptyState/index.js:21`, `Toast/index.js:16`, `ListStatsCard/index.js:16` | Rename to `on_click` (keep `onclick` as a deprecated alias for one release). |
| 25 | 🟡 | The `api` option has two opposite meanings: QuickSend / ConversationDrawer / TemplateEditor map *logical name → API key* (`{preview: "quick_send.preview"}`), ContactPicker maps *API key → dotted path* (`{"picker.preview": "my.app.preview"}`). | `QuickSend/index.js:31`, `ConversationDrawer/index.js:11–16`, `TemplateEditor/index.js:10–14` vs `ContactPicker/index.js:62,93` | Pick the first shape for all; a host that wants a dotted override does it via `sanad.ui.configure({api})`. |
| 26 | 🟢 | `title` means "tooltip" in `toolbar_actions` but "heading" everywhere else; method options are `method` / `page_method` / `counts_method`. | `PagedChildTable/index.js:142` | Rename to `hint`; document the method-option convention in `ui/README.md`. |

**State rendering.** All async panes use `EmptyState` (Drawer, ConversationDrawer, ChatThread, TreeGroupBy, ListStatsCard modal, PagedChildTable, TemplateEditor ×2, DashboardBlock cards + charts, every picker source, command tester). Justified inline exceptions: ListStatsCard card error span, QuickSend recipient skeleton, Manual source `role=alert`. Unjustified: `form/whatsapp_campaign.js:94` renders the progress error as a `text-muted` div and `:107` hand-writes skeleton markup.

**Header / footer layout.** Drawer: header (title + meta) / body / footer actions. ConversationDrawer: header (avatar + title + badge + close) / actions row / body, **no footer**. ContactPicker: Frappe modal header / body with vertical tabs / Frappe footer + counter prepended (`ContactPicker/index.js:219`). MetaDialog: Frappe header / alert slot + tabs / Frappe footer. QuickSend: Frappe header / body / footer with the Simulator link at the start (`QuickSend/style.scss:57`). → Three footer conventions; see #2/#3.

**Spacing tokens.** `--sanad-gap-*` is used for ~90 % of spacing; the residual px list is in #21. Widths/heights in px (icons 12–18, chips 28/32, min-heights for reserved space) are acceptable and intentional.

**Dead buttons.** Checked every rendered action: Drawer/RowActions/ConversationDrawer/ListStatsCard filter on `condition`/`handler`; Stepper toggles Skip; ChatThread only renders "Load older" with `on_load_more`; ContactPicker disables Continue/"Add N" at zero; FilterBar hides Clear; TemplateEditor hides "Use latest" without a DocType. Remaining dead paths are #8, #14, and the never-reached `show()` branch in `form/whatsapp_log.js:62–63` (ConversationDrawer has no `show`).

**z-index stacking (verified against Frappe).** RowActions menu 1035 (`RowActions/style.scss:26`) < ConversationDrawer 1040 (`ConversationDrawer/style.scss:4`) = Drawer backdrop 1040 (`Drawer/style.scss:4`) < Drawer panel 1041 (`Drawer/style.scss:17`) < Desk modals 1050 (`frappe/public/scss/desk/form.scss:7`) < `#alert-container` 2000 (`frappe/public/scss/desk/toast.scss:5`); Desk `.page-head` is 6. Result: ConfirmDialog / QuickSend / MetaDialog stack over both drawers ✓; toasts over everything ✓; the row menu closes on scroll/outside-mousedown before a drawer opens ✓. The only hole is #10 (two panels open at once).

**Duplicated logic that belongs in `_core`.**

| # | Sev | Duplicate | Copies | `_core` home |
|---|---|---|---|---|
| 27 | 🟡 | `render_list` hook wrapper | `TreeGroupBy/index.js:69–83` ≡ `RowActions/index.js:26–39` | `ui.on_list_render(listview, fn)` |
| 28 | 🟡 | Action visibility (roles / perm / condition, try-catch) | `RowActions/index.js:59–68`, `Drawer/index.js:329–337`, `BulkActions/index.js:30–32`, `ConversationDrawer/index.js:238–245` | `ui.visible_actions(actions, doc, doctype)` |
| 29 | 🟡 | Throttled realtime list refresh | `listview/whatsapp_log_list.js:232–237`, `whatsapp_inbound_message_list.js:143–148`, `whatsapp_queue_item_list.js:155–160`; hand-rolled timer in `whatsapp_number_list.js:238–256` | `ui.throttle` + `ui.bind_list_realtime(listview, event, ms)` (also fixes the leak: handlers are never `off`'d on page hide) |
| 30 | 🟡 | Confirm-conversation dialog | `ConversationDrawer/index.js:252–272` ≡ `listview/whatsapp_number_list.js:27–45` (verbatim) | Numbers list should call `sanad.ui.ConversationDrawer.prototype.confirm_conversation`-style helper exposed as `sanad.ui.actions.confirm_conversation(number, api)` |
| 31 | 🟢 | Cancel-message dialog | `listview/whatsapp_log_list.js:47–66` ≡ `form/whatsapp_log.js:27–42` ≈ `listview/whatsapp_queue_item_list.js:28–46` | `whatsapp_next.messages.cancel` already exists — the form and queue should call it |
| 32 | 🟢 | `fmt_int` / `esc` local helpers while `ui.format_int` / `ui.escape` exist | `listview/whatsapp_campaign_list.js:16`, `form/whatsapp_campaign.js:11`, `listview/whatsapp_inbound_message_list.js:16` | delete |
| 33 | 🟢 | `:focus-visible { outline: 2px solid var(--ink-blue-3) }` repeated ~20× although `_core/style.scss:77–81` defines it for `[tabindex]` | every `style.scss` | extend the core selector to `.sanad-kit :is(button, a, input, select, textarea, [tabindex]):focus-visible` and delete copies |
| 34 | 🟡 | Status → colour maps re-declared per script instead of `ui.indicator_for` (kit rule "meta-driven") | `listview/whatsapp_log_list.js:13–23`, `whatsapp_inbound_message_list.js:10–12` (`OUTBOUND_INDICATOR`), `whatsapp_queue_item_list.js:10`, `whatsapp_campaign_list.js:5`, `form/whatsapp_campaign.js:9`, `ContactPicker/index.js:118` | keep one `get_indicator` per DocType in `listview_settings` and read it through `sanad.ui.indicator_for(doctype, doc)` everywhere |

**Every `sanad.ui.call` wrapped.** 58 call sites audited. All are inside a `try/await`, a `.catch`, a ConfirmDialog `on_confirm` (which catches and toasts), or a Stepper/BulkActions/RowActions/Drawer handler that catches. Two chains rely on an upstream catch and are fine: `ConversationDrawer/index.js:318` (`load_older`) is wrapped by `ChatThread/index.js:100–101`; `whatsapp_log_list.js:38` (`resend`) is only invoked from RowActions/Drawer handlers. The single real gap is #4 (`selected.js`).

---

## 2. Accessibility audit (WCAG 2.1 AA)

Legend: ✅ pass (evidence given once) · finding rows carry severity.

### Perceivable

| Criterion | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| 1.1.1 Non-text content | 🟡 | Dashboard charts are `frappe.Chart` SVGs with no text alternative; the `<section>` has an `<h3>` but is not `aria-labelledby`. | `DashboardBlock/index.js:309–314,413` | `aria-labelledby` on the section; add a visually-hidden `<table>` (labels × datasets) or an `aria-describedby` summary built from `data`. |
| 1.1.1 | ✅ | All decorative icons `aria-hidden`; status ticks `role="img"` + `aria-label`. | `ChatThread/index.js:253`; `StatusBadge/index.js:61` | — |
| 1.3.1 Info & relationships | 🟡 | FilterBar status "tabs" use `role="tablist"/"tab"` but there are no `tabpanel`s and no `aria-controls`; they are filters, not tabs. | `FilterBar/index.js:123–126` | `role="radiogroup"` + `role="radio" aria-checked`, or plain buttons with `aria-pressed`. |
| 1.3.1 | 🟡 | ListStatsCard accessible name drops the value (see #12). | `ListStatsCard/index.js:53` | remove `aria-label`. |
| 1.3.1 | 🟢 | `aria-label` on a plain `<span>` (generic role) is ignored by most AT. | `TreeGroupBy/index.js:152` `<span class="sanad-groupby__count" aria-label="…records">` | visually-hidden text "records" after the number. |
| 1.3.1 | ✅ | Real `<dl>`, `<table>` with `scope="col"`, `<ol role="list">`, `<label for>` in picker fields. | `Drawer/index.js:230`; `PagedChildTable/index.js:221`; `Stepper/index.js:52`; `ContactPicker/sources/doctype.js:27` | — |
| 1.4.1 Use of colour | ✅ | Every tone is paired with a label and (green/red/amber) an icon; flagged picker rows get a chip, not just a tint; active chips add weight. | `StatusBadge/index.js:60–62`; `ContactPicker/selected.js:124–133`; `TreeGroupBy/style.scss:45–50` | — |
| 1.4.3 Contrast (min) | 🟡 | `--ink-gray-5` is `#7c7c7c` (4.29:1 on white; `#808080` on `#171717` in dark ≈ 4.4:1) — below 4.5:1 for 12–13 px text. Used for text in: Stepper "Optional" and to-do step labels; disabled picker rows. | `Stepper/style.scss:53,62`; `ContactPicker/style.scss:139`; token values `frappe/public/scss/espresso/_colors.scss:257,334` | Use `--ink-gray-6` for any text; keep `gray-5` for icons/dots only. |
| 1.4.3 | 🟢 | Loading state dims the whole form to `opacity: .6` (transient, `aria-busy` set). | `MetaDialog/style.scss:56–59` | acceptable; prefer a skeleton overlay if the load is slow. |
| 1.4.11 Non-text contrast | 🟡 | RowActions menu-item focus indicator is an inset shadow in `--outline-blue-1` (a light outline token) after `outline: none` — likely < 3:1 against white. | `RowActions/style.scss:53–54` | `outline: 2px solid var(--ink-blue-3); outline-offset: -2px`. |
| 1.4.13 Content on hover | 🟡 | Information only in `title` tooltips (not dismissible/hoverable/persistent): disabled-toolbar reasons, card error message. | `PagedChildTable/index.js:142`; `ListStatsCard/index.js:106` | Put the text in the DOM (see #8, #13). |
| 1.4.10 Reflow / 1.4.12 | ✅ | Tables scroll in wrappers; drawers become `100dvh` sheets; picker grid collapses; bubble max-width in `ch`. | `PagedChildTable/style.scss:56`; `Drawer/style.scss:159–165`; `ContactPicker/style.scss:222`; `ChatThread/style.scss:56` | 🟢 `Drawer/style.scss:161` uses `100vw` (scrollbar overflow); use `100%` like ConversationDrawer. |

### Operable

| Criterion | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| 2.1.1 Keyboard | 🟡 | Nested interactive content in clickable chat rows (see #11). | `ChatThread/index.js:236` | as #11. |
| 2.1.1 | 🟢 | Drawer choice list supports ↑/↓ only (no Home/End); DashboardBlock period and ContactPicker tab arrow keys are not RTL-aware (ArrowRight always = next) while FilterBar/TreeGroupBy flip correctly. | `Drawer/index.js:313–323`; `DashboardBlock/index.js:116–117`; `ContactPicker/index.js:289–290` vs `FilterBar/index.js:141` | Share one `ui.roving_keys(e, items, {rtl})` helper. |
| 2.1.1 | ✅ | Custom rows/chips/cards are focusable with Enter/Space: stats cards, chat rows, group-by chips, step pills, tabs, menu items, period radios. | `ListStatsCard/index.js:42–48`; `ChatThread/index.js:76–82`; `TreeGroupBy/index.js:170–184`; `RowActions/index.js:170–189` | — |
| 2.1.2 No keyboard trap | ✅ | `ui.trap_focus` returns an untrap; Escape closes Drawer / ConversationDrawer / RowActions; Tab out of the row menu closes it. | `_core/index.js:152–171`; `Drawer/index.js:71–76,115`; `ConversationDrawer/index.js:108–113,131`; `RowActions/index.js:186–188` | — |
| 2.2.1 Timing adjustable | 🟡 | Error toasts (8 s) are sometimes the only copy of a server error (e.g. link/convert failure, party search failure). | `Toast/index.js:9` `error: 8`; `listview/whatsapp_number_list.js:145,157` | For errors that block a task, render inline (`set_error`/EmptyState) or give `Toast.error` a persistent mode (`seconds: 60` with a close action). |
| 2.2.2 Pause, stop, hide | 🟢 | Auto-refresh every 60 s (cards) with no pause control; content updates announce (see 4.1.3). | `listview/whatsapp_campaign_list.js:68`; `ListStatsCard/index.js:113–120` | Pause while a modal is open / document hidden (already done for hidden); remove `aria-live` from values. |
| 2.3.3 / motion | ✅ | `--sanad-motion: 0ms` and skeleton animation off under `prefers-reduced-motion`; all transitions use the token. | `_core/style.scss:17–21,72–74`; `Drawer/style.scss:7,26`; `BulkActions/style.scss:13` | — |
| 2.4.3 Focus order | 🟡 | QuickSend focuses the last invalid field (see #7); Drawer stacking captures the wrong opener (see #9). | `QuickSend/index.js:248`; `Drawer/index.js:87–89` | as above. |
| 2.4.3 | ✅ | Overlays move focus to the close button on open and back to the opener on close; error summaries are `tabindex="-1"` and focused. | `Drawer/index.js:98,124`; `ConversationDrawer/index.js:121,139–141`; `MetaDialog/index.js:311`; `Stepper/index.js:153` | — |
| 2.4.6 Headings & labels | 🟢 | FilterBar selects have no visible label; the first option ("Device: all") doubles as one. | `FilterBar/index.js:167–169` | acceptable for a compact bar; keep `aria-label` (present). |
| 2.4.7 Focus visible | ✅ | 2 px `--ink-blue-3` ring everywhere; the only `outline: none` without a strong replacement is RowActions (1.4.11 above); `ConversationDrawer/style.scss:26` `outline:none` is on the `tabindex="-1"` panel that users never focus. | `_core/style.scss:77–81` | — |
| 2.5.3 Label in name | ✅ | Visible text is contained in the accessible name (pager "Previous" ⊂ "Previous page"; icon-only buttons name the row: "Actions for {title}"). | `PagedChildTable/index.js:73–74`; `RowActions/index.js:86`; `ContactPicker/selected.js:161` | — |
| 2.5.8 Target size (2.2) | 🟢 | All targets ≥ 24 px. Below the kit's own 32 px: FilterBar tab 28, RowActions button 28 (+8 px gap), DashboardBlock period 28, PagedChildTable row action 28, picker remove 28, picker checkbox 16 (row height ≥ 32). | `FilterBar/style.scss:39`; `RowActions/style.scss:8–9`; `DashboardBlock/style.scss:30`; `PagedChildTable/style.scss:83`; `ContactPicker/style.scss:135,142` | unify at `var(--sanad-target)` via `.sanad-chip`. |

### Understandable

| Criterion | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| 3.2.2 On input | 🟡 | FilterBar arrow keys **apply** the filter on every keypress (list reload while merely moving focus). TreeGroupBy correctly only moves focus. | `FilterBar/index.js:147–148` `tabs[idx].focus(); this.set(fieldname, options[idx].value);` vs `TreeGroupBy/index.js:181–183` | Manual activation: arrows move focus, Enter/Space selects (or debounce `set` 300 ms). |
| 3.3.1 Error identification | ✅ | Errors are inline, next to the control, `role="alert"`, with `aria-invalid` + `aria-describedby`. | `MetaDialog/index.js:281–292`; `QuickSend/index.js:239–249`; `PhoneField/index.js:189,246` | — |
| 3.3.2 Labels or instructions | ✅ | Every input has a `<label for>` or `aria-label`; hints are `aria-describedby` (PhoneField, manual textarea). | `ContactPicker/sources/manual.js:24`; `PhoneField/index.js:189` | — |
| 3.3.3 Error suggestion | 🟢 | "No enabled device. Pair a device first." offers no way to do so. | `QuickSend/index.js:140` | EmptyState-style action "Open devices" (route from `config.defaults.devices_route`, already configured in `whatsapp_next_setup.js:39`). |
| 3.3.4 Error prevention | ✅ | Destructive actions go through ConfirmDialog with impact rows, reason, acknowledgement, danger styling. | `ConfirmDialog/index.js:28–65`; `form/whatsapp_campaign.js:205–215` | — |
| 3.1.2 Language of parts | ✅ | Phone numbers and template tokens are `dir="ltr"` islands. | `ContactPicker/sources/_base.js:107`; `TemplateEditor/style.scss:115`; `QuickSend/style.scss:30` | — |

### Robust

| Criterion | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| 4.1.2 Name, role, value | 🟡 | FilterBar tablist without panels (above); nested interactive in chat rows (above). | — | — |
| 4.1.2 | 🟢 | "Show members" toggles `aria-expanded` without `aria-controls`; Drawer choice options are `aria-selected="false"` forever. | `ContactPicker/sources/groups.js:86,103,107`; `Drawer/index.js:303,308` | add `aria-controls`; use plain buttons in a `role="list"` for choices. |
| 4.1.2 | ✅ | Menus (`menu`/`menuitem` + `aria-haspopup`/`aria-expanded`/`aria-controls`), tabs (`aria-selected`, `aria-controls`, focusable `tabpanel`), radiogroup (`aria-checked`), progressbar (`aria-valuenow`), `aria-current="step"`, `aria-busy` on loading regions. | `RowActions/index.js:86,123–125,139`; `ContactPicker/index.js:276–280`; `DashboardBlock/index.js:104`; `BulkActions/index.js:143`; `Stepper/index.js:133`; `EmptyState/index.js:56`; `TreeGroupBy/index.js:98`; `MetaDialog/index.js:184`; `PagedChildTable/index.js:182` | — |
| 4.1.3 Status messages | 🟡 | **Chat log re-rendered wholesale**: `role="log" aria-live="polite" aria-relevant="additions"` on the scroll region, but every prepend/append does `$list.html(html)` — every row is an "addition", so AT reads the whole thread after each realtime message. `ui.announce("{0} new messages")` already covers the event. | `ChatThread/index.js:63,214`; `ConversationDrawer/index.js:336` | Remove `aria-live` from the log (keep `role="log"`), or insert/patch rows incrementally. |
| 4.1.3 | 🟡 | **Toasts announced twice**: Desk's `show_alert` already renders `role="alert"` (`frappe/public/js/frappe/ui/messages.js:443`), then the kit announces again. | `Toast/index.js:41–42` | Drop the `ui.announce` in Toast (keep it for non-alert flows). |
| 4.1.3 | 🟡 | **Selection count announced up to three times**: footer counter `aria-live`, debounced `ui.announce`, and the Selected tab counts strip `aria-live`. | `ContactPicker/index.js:217,86`; `ContactPicker/selected.js:34` | Keep only the debounced `ui.announce`. |
| 4.1.3 | 🟡 | **Live region recreated per tick**: BulkActions replaces the `aria-live` node with `$p.html()` on every iteration; a region must exist before its content changes to be announced reliably. | `BulkActions/index.js:142–146` | Render the container once; update `.sanad-bulk__status` text and `aria-valuenow`. |
| 4.1.3 | 🟡 | Whole result tables inside `aria-live` (groups, manual) and the template preview bubble + errors re-announced on every debounced keystroke. | `ContactPicker/sources/groups.js:28`; `manual.js:29`; `TemplateEditor/index.js:90–91` | Remove `aria-live` from result areas; announce "N groups found" via `ui.announce`; for TemplateEditor announce only when the error list *changes*. |
| 4.1.3 | 🟡 | Card values are `aria-live` and refresh every 60 s (background chatter). | `ListStatsCard/index.js:59`; `listview/whatsapp_campaign_list.js:68` | Remove `aria-live`; announce on explicit refresh only. |
| 4.1.3 | 🟢 | Announcement wording should be full sentences: "{0} new messages", "Period: {0}", "{0} opened". | `ConversationDrawer/index.js:336`; `DashboardBlock/index.js:134`; `Drawer/index.js:208` | "{0} new messages arrived.", "Showing the last {0}.", "{0} details opened." |
| 4.1.3 | ✅ | Good live regions: two persistent polite/assertive regions with 30 ms reset; pager range `aria-live aria-atomic`; Stepper progress line; picker progress text. | `_core/index.js:136–149`; `PagedChildTable/index.js:71`; `Stepper/index.js:51`; `ContactPicker/index.js:218` | — |

---

## 3. UX copy review (English source strings)

837 `__()` occurrences inventoried (`ui/`, `listview/`, `form/`). Overall quality is good: sentence case is the norm, buttons carry verbs, no "OK" / "Are you sure?" anywhere, confirmations state impact rows, and toasts report results. The table lists every string that should change (grouped by reason; `file:line` is the first occurrence).

### 3.1 Strings to change

| file:line | current | recommended | reason |
|---|---|---|---|
| `listview/whatsapp_campaign_list.js:24` | `None of the selected campaigns can be {0}` (with `label.toLowerCase()` → "can be pause") | per action: `None of the selected campaigns can be paused.` / `…resumed.` / `…cancelled.` | concatenated fragment produces ungrammatical English; unconjugatable in Arabic |
| `listview/whatsapp_campaign_list.js:28,37,43,121,125` | `{0} {1} campaigns?`, `{0} {1}`, `{0}: {1} campaigns`, `{0} the selected campaigns?`, `{0} selected` | `Pause {0} campaigns?` / `Pause {0}` / `Paused {0} campaigns` (one full string per verb; count always present) | verb + noun concatenation; confirmation must name action and count |
| `ui/ContactPicker/index.js:206` | `Add to the list` / `Remove from the list` | `Add recipients to {0}` / `Remove recipients from {0}` (default derived from the target: "recipients" for campaigns, "members" for groups) | "the list" is vague; Campaign form never passes a title (`form/whatsapp_campaign.js:24–31`) |
| `ui/ContactPicker/index.js:371` | `{0} {1}` (DocType + name under the confirm title) | `Changes apply to {0} {1}.` | bare concatenation; bidi-fragile in Arabic |
| `ui/ContactPicker/index.js:340` | `{0}… {1}` (server stage + count) | `{0}: {1} rows so far…` with a stage map (`parsing`→`Reading the file`, `normalising`→`Checking numbers`) | fragment; raw stage codes reach `__()` |
| `ui/ContactPicker/index.js:338` | `Parsing {0} file…` | `Reading the {0} file…` | "parsing" is developer jargon |
| `ui/ContactPicker/index.js:406` | `The list changed meanwhile: {0}` | `The list changed while you were choosing. Reopen it and try again. ({0})` | error = what happened + how to fix |
| `ui/ContactPicker/index.js:354` | `None of the selected numbers is in the list.` | `None of the selected numbers is in the list, so there is nothing to remove.` | add the consequence/next step |
| `ui/ContactPicker/index.js:308` | `One source per operation. Switching to {0} clears what you picked.` | `You can add from one source at a time. Switching to {0} clears the {1} numbers you picked.` | plainer; names the count |
| `ui/ContactPicker/index.js:264` | `No picker source is enabled for {0}` | `No source is enabled for {0}. Enable one in the WhatsApp settings.` | empty state without next step |
| `ui/ContactPicker/index.js:400` | `Added {0} ({1} skipped)` with `extra.join(", ")` | build the list with `Intl.ListFormat(frappe.boot.lang)` or one string `Added {0}. Skipped {1} already added and {2} invalid.` | `", "` join is not localisable (Arabic uses "،") |
| `ui/ContactPicker/selected.js:152` | `Check` (column) | `Result` | unclear header |
| `ui/ContactPicker/selected.js:115–120` | `Will be added {0}`, `Already added {0}`, `Invalid {0}`, `With a conversation {0}` | `{0} will be added`, `{0} already added`, `{0} invalid`, `{0} with a conversation` | count-first reads and pluralises better |
| `ui/ContactPicker/selected.js:149` | `No selected number matches` | `No selected number matches your search.` | full sentence, names the cause |
| `ui/ContactPicker/sources/current.js:15,54,61` | `Current rows`, `No rows match`, `Choose {0}` | `Current members` (fallback), `No members match` / `No recipients match` (from target), `Mark {0} for removal` | "rows" is a data term; "Choose" clashes with "Add N" elsewhere |
| `ui/ContactPicker/sources/current.js:60` | `Select all shown` | `Select all on page` | same control, same label as the other sources |
| `ui/ContactPicker/sources/groups.js:123` | `Add members of 1 group` / `Add members of {0} groups` | keep both but route through a `ui.plural(n, …)` helper (see §3.3) | Arabic needs dual and 3–10 forms |
| `ui/ContactPicker/sources/groups.js:136` | `Loading members of {0}… {1}` | `Loading members of {0}: {1} of {2}` (pass `group_name`, not the docname) | fragment; docname shown to user |
| `ui/ContactPicker/sources/groups.js:65` | `Create a contact group first.` | keep, and pass `action: {label: __("New contact group"), on_click: …}` when the user can create | empty state without a next-step action |
| `ui/ContactPicker/sources/excel.js:35` | `First row = column headers. The phone column is detected from its header; choose it in the next step when detection fails.` | `The first row must hold the column headers. The phone column is detected from its header; if that fails, choose it in the next step.` | no "=" in prose |
| `ui/ContactPicker/sources/excel.js:91` | `Private upload, up to 5 MB / 20,000 rows` | `Private upload. Up to 5 MB and 20,000 rows.` | slash-list |
| `ui/ContactPicker/sources/excel.js:101` | `The uploader could not be opened` | `The uploader could not be opened. Reload the page and try again.` | missing how-to-fix |
| `ui/ContactPicker/sources/excel.js:109` | `The file is still being read — wait a moment` | `The file is still being read. Try again in a moment.` | sentence, not dash |
| `ui/ContactPicker/sources/excel.js:154,202` | `The file could not be read` | `The file could not be read. Check that it is a valid {0} file and try again.` | missing how-to-fix |
| `ui/ContactPicker/sources/excel.js:243` | `Added` (finish label after success) | `Added {0} rows` | says what happened |
| `ui/ContactPicker/sources/manual.js:25` | `Write the number with its country code, e.g. +966… Optionally put a name before it, separated by a semicolon: Name;Phone` | `One number per line, with the country code (e.g. {0}). To add a name, write it before the number and separate them with a semicolon: Name;Number` | example must come from the country default (PhoneField), not Saudi hard-code; placeholder at `:24` is outside `__()` |
| `ui/ConversationDrawer/index.js:221` | `Unconfirm conversation` | `Remove confirmation` | the dialog it opens already says "Remove confirmation" (`:262`) |
| `ui/ConversationDrawer/index.js:160`, `listview/whatsapp_number_list.js:210,216,50` | `Not Linked` | `Not linked` (the Select *value* stays "Not Linked"; only the label changes) | sentence case |
| `ui/ConversationDrawer/index.js:309` | `You need the Viewer role to read conversations` | `You do not have permission to read conversations. Ask an administrator for access.` | kit hard-codes a host role name (portability) |
| `ui/ConversationDrawer/index.js:336` | `{0} new messages` | `{0} new messages arrived.` | announcement must be a sentence |
| `ui/ChatThread/index.js:224` | `Outbound message, {0}` / `Inbound message from {0}` | `Sent message, {0}` / `Received message from {0}` | outbound/inbound are system terms; glossary |
| `ui/ChatThread/index.js:89` | `Load older` | `Load older messages` | object of the verb |
| `ui/Drawer/index.js:77,297` | `Choose` (title), `Nothing to choose` | `Choose an option`, `No options available` | fragments |
| `ui/Drawer/index.js:242` | `This record has no preview fields.` | `This record has no fields marked for preview.` | "preview fields" is meta jargon |
| `ui/Drawer/index.js:276` | `Please fill the required fields:` | `Fill in the required fields:` | no "please"; matches `MetaDialog/index.js:301` |
| `ui/ConfirmDialog/index.js:48` | `Confirm` (default primary label) | make `confirm_label` required (throw in dev) | rule: primary button names the verb |
| `ui/ListStatsCard/index.js:106` | `Unavailable` | `Could not load` | says what happened |
| `ui/ListStatsCard/index.js:217` | `Done` (default success toast) | `{0} done` with the action label, or require `success_message` | too vague to be a status |
| `ui/ListStatsCard/index.js:230` | `{0}?` (default confirm title, e.g. "Pause?") | require `confirm.title`; fallback `{0} this row?` | fragment |
| `ui/PagedChildTable/index.js:253` | `0 of 0` | `No rows` | numbers-only status |
| `ui/PhoneField/index.js:235` | `Numbers without a country code get +{0} ({1})` | `Numbers without a country code are sent as +{0} ({1})` | "get" is ambiguous |
| `ui/QuickSend/index.js:46` | `International format, e.g. +9665…` | `With the country code, e.g. {0}` (from PhoneField example) | hard-coded Saudi example; kit rule (portability) |
| `ui/QuickSend/index.js:74` | `Open in Simulator` | `Open in the simulator` | sentence case; "Simulator" is not a proper noun in UI |
| `ui/QuickSend/index.js:140` | `No enabled device. Pair a device first.` | `No device is enabled. Pair or enable a device, then try again.` (+ "Open devices" action) | how-to-fix with a way to do it |
| `ui/QuickSend/index.js:141` | `None — write the message` | `No template (write the message)` | dash construction |
| `ui/QuickSend/index.js:155` | `Enter a phone number to resolve the recipient.` | `Enter a phone number to look up the recipient.` | "resolve" is jargon |
| `ui/QuickSend/index.js:174` | `This number is blacklisted; the message will be refused.` | `This number is blacklisted, so the message cannot be sent.` | consequence in plain words |
| `ui/QuickSend/index.js:204` | `The template body is sent; leave empty or type to override it.` | `The template text is sent. Leave this empty, or type to replace it.` | "body"/"override" jargon |
| `ui/TemplateEditor/index.js:170,232` | `Pick a reference DocType to preview with a real record.` / `…to list its fields.` | `Choose a reference document type …` | "DocType" in user copy |
| `ui/TemplateEditor/index.js:201` | `No {0} records to preview with yet` | `There are no {0} records to preview with yet.` | full sentence |
| `ui/TemplateEditor/index.js:144` | `Sample context is not valid JSON` | `Sample context is not valid JSON. Fix it to include it in the preview.` | how-to-fix |
| `ui/TreeGroupBy/index.js:158` | `{0} more` | `Show {0} more` | verb on button |
| `ui/DashboardBlock/index.js:235` | `N/A` | `Not available` | abbreviation |
| `ui/DashboardBlock/index.js:255` | `{0} % {1}` | `{0}% {1}` (or `frappe.format(v, {fieldtype:"Percent"})`) | no space before %; Arabic "٪" |
| `ui/DashboardBlock/index.js:151` | `{0} {1} was not found` | `{0} "{1}" was not found` | quote the name |
| `form/whatsapp_campaign.js:68` | `about {0} h left` / `about {0} min left` | `About {0} h left` / `About {0} min left` | sentence case |
| `form/whatsapp_campaign.js:78` | `{0} per minute` | `{0} messages per minute` | names the unit |
| `form/whatsapp_campaign.js:218` | `Outbound log` (also `listview/whatsapp_campaign_list.js:98`) | `Sent messages` | glossary: "outbound" is a system term |
| `form/whatsapp_campaign.js:226` | `Message {0} preview` | `Preview of message {0}` | natural order |
| `listview/whatsapp_command_list.js:49` | `Active commands are locked. Stopping it pauses replies until you start it again.` | `Active commands are locked. Stopping this command pauses its replies until you start it again.` | dangling "it" |
| `form/whatsapp_command.js:66` | `Any format; normalised to E.164.` | `Any format works; it is normalised automatically.` | "E.164" is jargon |
| `form/whatsapp_command.js:209` | `Commands are edited in the dialog.` | `Edit this command with "Open editor".` | names the control |
| `form/whatsapp_contact_group.js:57` | `This group is disabled and is not offered as a picker source.` | `This group is disabled. It is not offered when choosing recipients.` | "picker source" is internal |
| `form/whatsapp_log.js:55`, `form/whatsapp_number.js:9`, `listview/whatsapp_number_list.js:178` | `Open conversation` vs `Messages` vs `Messages` | `Open conversation` everywhere | same action, three labels |
| `form/whatsapp_log.js:29`, `listview/whatsapp_log_list.js:50` | `The message leaves the queue and is marked Cancelled.` | `The message leaves the queue and its status becomes Cancelled.` | reads as a stray capital |
| `listview/whatsapp_queue_item_list.js:31` | `The queue row is marked Deleted and the outbound message Cancelled.` | `The message leaves the queue and its status becomes Cancelled.` | users act on messages, not rows |
| `listview/whatsapp_queue_item_list.js:50,63` | `This queue row has no outbound message linked.` / `Queue position and retries are on the queue row.` | `This queue item has no message linked to it.` / `Queue position and retries are shown on the queue item.` | "row" → "queue item" |
| `listview/whatsapp_log_list.js:90,92,94,95` | `Claimed by the dispatcher (attempt {0} of {1})`, `Retry planned ({0})`, `Dead letter: {0}`, `Handed to the platform ({0})` | `Picked up for sending (attempt {0} of {1})`, `Retry scheduled ({0})`, `Gave up after retries: {0}`, `Handed to the sending platform ({0})` | dispatcher / dead letter are internal names |
| `listview/whatsapp_log_list.js:105` | `Webhook {0} ({1})` + `" — " + e.error` (string concat) | `Webhook {0} ({1}): {2}` | concatenation outside `__()` |
| `listview/whatsapp_number_list.js:77` | `How` | `Add by` | one-word label is unclear |
| `listview/whatsapp_number_list.js:117,119` | `Account` / `Type to search the selected account type.` | `Linked record` / `Type to search {0}.` (party type) | "account" clashes with ERPNext Account |
| `listview/whatsapp_number_list.js:50` | `The number stays in the list as Not Linked. The Contact is not deleted.` | `The number stays in the list as not linked. The contact is not deleted.` | sentence case |
| `ui/_core/index.js:70`, `ui/MetaDialog/index.js:335`, `ui/Stepper/index.js:184` | `Something went wrong. Please try again.` | `Something went wrong. Try again.` | drop "please" (house style elsewhere) |

Strings that were checked and **pass** (kept for the record): all ConfirmDialog titles in live scripts ("Pause the campaign?", "Cancel this message?", "Unlink {0}?"), all ack checkboxes ("I understand …"), the QuickSend field errors (`:261–273`), the warning toasts (`:305–306`), the picker upload notes, "Save the document first / Rows can be added after the first save.", "Stopped at {0} records. Narrow the filters to add the rest.", every `Retry`, `Keep it` / `Keep them` as cancel labels.

### 3.2 Glossary (canonical terms)

| Term | Use for | Never |
|---|---|---|
| **message** | one WhatsApp message; "sent message" / "received message" in user copy | "outbound/inbound" in user-facing sentences (fine in status badges and technical timelines) |
| **number** | a WhatsApp number (E.164) or a group chat; "phone number" when the user types one | "phone" for a device |
| **contact** | an ERPNext Contact record | "account" |
| **recipient** | a number on a campaign's list | "row" |
| **member** | a number in a contact group | "recipient" for groups |
| **device** | a paired WhatsApp device | "phone", "session" |
| **queue / queue item** | the outbound queue and one item in it | "queue row" |
| **template / template text** | a message template and its body | "body" |
| **command / function** | an inbound command and the function it runs | — |
| **group** (contact group) vs **group chat** | picker source vs WhatsApp group JID | plain "group" for a JID |
| **link / unlink · linked / not linked** | number ↔ contact relationship | "convert" in UI copy (server verb only) |
| **confirm conversation / remove confirmation** | the `conversation_confirmed` flag | "unconfirm" |
| **source** | one of the six picker sources | "tab" |
| **document type** | a DocType in user copy; "system screen" only as the picker source name (spec term) | "DocType" |
| **sent messages** | the WhatsApp Log list | "outbound log" |

### 3.3 Localisation notes for Arabic

1. **Plural forms.** Frappe's `__()` has no plural support and Arabic has six categories (0, 1, 2, 3–10, 11–99, 100+). Strings such as `{0} messages`, `{0} members`, `{0} campaigns` will read wrongly for 1, 2 and 3–10. Add `ui.plural(n, {one, two, few, many, other})` to `_core` (select by `n`, each form its own `__()` key, e.g. `__("{0} messages")` / `__("One message")` / `__("Two messages")` / `__("{0} messages (few)")`), and route every count string through it; `groups.js:123` already branches on `n === 1`, showing the need.
2. **Gender-neutral verbs.** Arabic imperatives are gendered (أرسلْ / أرسلي). Translate button verbs as verbal nouns (إرسال، حفظ، إلغاء، متابعة، إضافة، إزالة), which is also Desk's convention; avoid "you" constructions in confirmations ("أنت متأكد") — the kit already avoids "Are you sure?".
3. **Bidi and fragments.** Any string that is only a placeholder pair (`{0} {1}`, `{0}… {1}`, `{0}: {1}`) reorders under RTL when the values are Latin (IDs, phone numbers, file names). Use full sentences and wrap Latin values in `<bdi>` or `⁨…⁩` (FSI/PDI); phones are already `dir="ltr"` islands in tables and in `ConversationDrawer/index.js:153`, but not in toasts/confirm impact rows (`ConversationDrawer/index.js:260`, `listview/whatsapp_number_list.js:34,53`).
4. **Punctuation.** Do not join lists with `", "` or `" — "` in JS (`ContactPicker/index.js:400`, `whatsapp_log_list.js:105`); Arabic uses "،" and "؛". Percent sign is "٪" and follows the number: use `frappe.format(v, {fieldtype: "Percent"})` rather than `{0}%` (`form/whatsapp_campaign.js:78`, `DashboardBlock/index.js:255`).
5. **Numerals and dates.** `ui.format_int` and `frappe.datetime` already follow the user's number/date format; raw numbers still leak in `listview/whatsapp_log_list.js:208,210–211` and `whatsapp_queue_item_list.js:134–137` (`n`, `names.length - n` passed unformatted).
6. **Length.** Arabic labels run ~25 % longer; count-in-label buttons ("Retry dead letter (12)") and the 200 px picker tab rail (`ContactPicker/style.scss:26`) should be checked at 375 px; the rail already collapses to a horizontal scroller under 768 px.
7. **Direction-aware keys and icons.** Chevrons are flipped (`ListStatsCard/style.scss:58`, `PagedChildTable/style.scss:98`) and FilterBar/TreeGroupBy flip arrow keys; DashboardBlock and ContactPicker tabs do not (§2, 2.1.1).
8. **Examples in copy.** Country examples must come from `frappe.boot.sysdefaults.country` through PhoneField (`example()`), never a literal `+966…` (`QuickSend/index.js:46`, `manual.js:24–25`).

---

## 4. Prioritised fixes (max 15, by impact)

1. `ui/ContactPicker/selected.js:20` — debounce `run_preview().catch(() => {})` so the preview never rejects unhandled (the `throw` at `:89` stays for `ensure_preview`).
2. `ui/_core/index.js:72` — use the global `strip_html` (`frappe.utils.strip_html` does not exist), so error toasts stop showing literal HTML tags.
3. `ui/QuickSend/index.js:46,94` and `ui/ContactPicker/sources/manual.js:24–25` — adopt `sanad.ui.PhoneField` (wrap the `phone` control; derive the manual-entry example from `example()`), giving PhoneField its required live use and removing the hard-coded Saudi examples; correct `ui/PhoneField/README.md:40–43`.
4. `listview/whatsapp_campaign_list.js:24,28,37,43,121,125` — one full string per action with the count ("Pause {0} campaigns?"), delete the dead `bulk_campaign_action` path.
5. `ui/ChatThread/index.js:63` — remove `aria-live` from the `role="log"` region (or insert rows incrementally at `:214`); `ui/Toast/index.js:42` — drop the duplicate `ui.announce` (Desk's alert is already `role="alert"`).
6. `ui/FilterBar/index.js:123–148` — replace `tablist/tab` with `radiogroup/radio` (or `aria-pressed` buttons) and stop applying the filter on arrow-key focus moves.
7. `ui/ListStatsCard/index.js:53,59,106` — drop the value-hiding `aria-label`, drop per-card `aria-live`, put the error message in the DOM instead of `title`.
8. `_core` — add `ui.throttle`, `ui.on_list_render`, `ui.visible_actions`, `.sanad-sheet`, `.sanad-chip`, `.sanad-table`, and a single `:focus-visible` rule; replace the copies listed in §1.4 #19–20, #27–29, #33.
9. `ui/Drawer/*` + `ui/ConversationDrawer/*` — one `.sanad-panel` shell (title 16 px, 32 px close, backdrop .5, footer slot, `100%` mobile width) and one overlay registry so only one `aria-modal` panel is open; capture the opener before hiding the previous drawer (`Drawer/index.js:87–89`) and guard restore with `document.contains` (`Drawer/index.js:125`).
10. `ui/QuickSend/index.js:248,259–276` — focus only the first invalid field; add the shared sheet class to QuickSend and ConfirmDialog.
11. `ui/PagedChildTable/index.js:141–142` + `form/whatsapp_campaign.js:34–37`, `form/whatsapp_contact_group.js:26–29` — show the disabled reason as visible text (or keep the button enabled and explain on click) instead of a hover `title`.
12. Live-region hygiene — `ui/BulkActions/index.js:142–146` (keep the node, update text), `ui/ContactPicker/index.js:217` + `selected.js:34` (single announce channel), `ui/ContactPicker/sources/groups.js:28` / `manual.js:29` (remove `aria-live`), `ui/TemplateEditor/index.js:90–91` (announce only on error change).
13. Contrast and focus — replace `--ink-gray-5` text with `--ink-gray-6` (`ui/Stepper/style.scss:53,62`, `ui/ContactPicker/style.scss:139`); `ui/RowActions/style.scss:53–54` use a 2 px `--ink-blue-3` outline instead of `outline: none` + faint inset shadow.
14. Status colours — read them through `sanad.ui.indicator_for` from one `get_indicator` per DocType instead of the six local maps (`listview/whatsapp_log_list.js:13`, `whatsapp_inbound_message_list.js:10–12`, `whatsapp_queue_item_list.js:10`, `whatsapp_campaign_list.js:5`, `form/whatsapp_campaign.js:9`, `ui/ContactPicker/index.js:118`); render "Not linked" as gray without the warning icon.
15. Copy sweep per §3.1 — highest value first: "Not Linked" → "Not linked", "Unconfirm conversation" → "Remove confirmation", "Add to the list" → "Add recipients to {0}", "The list changed meanwhile", jargon (dispatcher, dead letter, resolve, DocType, outbound log), `ConfirmDialog` default "Confirm" → required `confirm_label`, and add `ui.plural()` for the Arabic count strings.
