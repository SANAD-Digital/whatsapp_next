# UI Strategy Matrix — `whatsapp_next`

Source of truth: `plan/00-screens-spec.md` (binding). Phase 0 recorded the screen inventory
(§Inventory 0); phase 2 (`ui-matrix-planner`) fills everything else.

## Purpose

Convert the binding screen spec into one row per screen — implementation, list/form treatment,
dialogs, filters, row/bulk actions mapped to `backend-plan.md` §4 API names, kit components,
realtime subscriptions, roles, effort — and cross-check it against the prototype in `docs/` so
that every visible button, tab, column, filter and modal is either assigned to a row or listed as
*deliberately not built* with its spec reference. Disagreements with the spec are **open questions
for Gate 1**, never changes. Assumes the OD-1 evidence as given: Queue is a real DocType; Functions
Center stays a Custom Page.

Abbreviations: **SM** System Manager · **MGR** WhatsApp Manager · **AGT** WhatsApp Agent ·
**VWR** WhatsApp Viewer · **CU** WhatsApp Contact User · **VWR+** = VWR, AGT, MGR, SM.
Effort: **S** ≤ 1 dev-day · **M** 2–3 · **L** 4–6 · **XL** > 6. `*` on a realtime event =
proposed in `backend-plan.md` §6 (its Gap G-3), not yet accepted.

## Inventory

### 0. Screen inventory (phase 0 — screens only)

| # | Screen | Spec § | Implementation | Create | Prototype file (`docs/screen/`) |
|---|---|---|---|---|---|
| 1 | Onboarding Wizard | 2 | Custom Page | — | — (not in prototype; Wizard component in `docs/component/`) |
| 2 | Home / Dashboard | 2 | Custom Page | — | `Hub Screen - Home` |
| 3 | Devices | 2 | Custom Page | yes | `Hub Screen - Devices` |
| 4 | Outbound (الصادر) | 2, 5.3 | Frappe list + form + Drawer | no | `Hub Screen - Outbound` |
| 5 | Inbound (الوارد) | 2, 5.3 | Frappe list + form + Drawer | no | `Hub Screen - Inbound` |
| 6 | Campaigns | 2, 5.4 | Frappe DocType + stats card + ContactPicker | yes | `Hub Screen - Campaigns` |
| 7 | Functions Center | 2, 5.6 | Custom Page (storefront over Functions DocType) | — | `Hub Screen - Functions` |
| 8 | Commands | 2, 5.5 | Frappe list, create/edit in modal | modal only | `Hub Screen - Commands` |
| 9 | Queue | 2, 5.1 | Frappe DocType, status-driven | no | `Hub Screen - Queue` |
| 10 | Templates | 2 | Frappe list + form (modelled on Email Template) | yes | `Hub Screen - Message Templates`, `Hub Screen - Notification Templates` |
| 11 | WhatsApp Simulator | 2 | Custom Page | — | `Hub Screen - WhatsApp Simulator` |
| 12 | Contacts (system) | 2, 4 | Custom Page (contextual permission layer) | yes | `Hub Screen - Contacts` |
| 13 | WhatsApp Numbers (أرقام الواتساب) | 2, 5.2 | Frappe list over materialized DocType + Drawer | system only | `Hub Screen - WhatsApp Contacts` |
| 14 | Contact Groups | 2 | Frappe DocType + ContactPicker | yes | `Hub Screen - Contact Groups` |
| 15 | Subscription, Usage & Settings | 2, 5.7 | Custom Page over existing settings Single | — | `Hub Screen - Settings`, `Hub Screen - Billing` |

Prototype screens with **no spec entry** (spec §2 default applies — native list/form unless
justified in writing at Gate 1): `Hub Screen - All Messages` (covered by the conversation drawer +
unified read layer, spec says a standalone Conversations screen is deliberately not built),
`Hub Screen - Demo` (prototype-only data showcase, not a product screen).

Prototype also contains the full app shell `WhatsApp Hub App-pro` (header + sidebar + navigation)
— in Desk this role is played by the Workspace and the Desk navbar, not by a custom shell.

**Deliberately not built:** standalone Conversations screen (spec §2).

### 1. Per-screen strategy

Rows 10b and 10c are the D-016 placements (Notification, Notification Alert). Page slugs are the
seven fixed in `00-conventions.md` §Naming; no new slug is needed.

#### 1A. Implementation · list treatment · form treatment

| # | Screen | Implementation | List treatment (columns · indicators · `listview_settings`) | Form treatment (script · tabs · read-only rules) |
|---|---|---|---|---|
| 1 | Onboarding Wizard | Custom Page `wa-onboarding` (no DocType; writes `WhatsApp Settings` through `api.onboarding` only) | — | — |
| 2 | Home | Custom Page `wa-home` | — | — |
| 3 | Devices | **Hybrid**: Custom Page `wa-devices` (card grid, pairing) is the product screen; native `WhatsApp Device` list/form kept as read fallback | native: `device_name` (title), `status` indicator (Connected green · Pending QR blue · Disconnected amber · Logged Out red), `phone_e164`, `is_default`, `last_seen`; `listview_settings`: `hide_name_column`, primary action replaced by "Open Devices page" (no Desk New) | all lifecycle fields `read_only`; tabs Device · Connection · Diagnostics; form script buttons Pair / Disconnect / Delete → `api.devices.*`; controller `before_insert` refuses inserts without `frappe.flags.wa_devices_api` (02 §6: create/delete only through the page API) |
| 4 | Outbound | Frappe list + form + Drawer | `display_name` (title, `phone_e164` subtitle), `status` indicator (Sent/Delivered/Read green · Queued/Sending blue · Unsent/Held amber · Failed/Cancelled red), `reference_doctype`, `reference_name`, `device`, `sent_at`∥`creation`, `error_code`, `message_type`, `is_simulated` («مرسل بالنيابة»); `listview_settings`: `get_indicator`, `onload` mounts FilterBar + RowActions + BulkActions + QuickSend page button, row click opens Drawer | no role has W → form read-only by permission; tabs Message · Delivery · Source · Provider; form script buttons Resend / Cancel / Open conversation / Quick send |
| 5 | Inbound | Frappe list + form + Drawer | `display_name`/`phone_e164` («المُرسِل»), `body` excerpt formatter («النص الوارد»), `command` + `command_status` indicator (Executed green · Matched blue · None/Not Matched gray · Blocked amber · Failed red), `contact` («ربط الجهة»), `device`, `received_at` | read-only by permission; form script buttons Open command / Reply (QuickSend) / Link contact |
| 6 | Campaigns | Frappe DocType (list + form) + ListStatsCard + ContactPicker | `campaign_name`, `status` indicator (Draft gray · Scheduled/Queued/Running blue · Paused amber · Completed green · Partially Failed amber · Cancelled red), progress formatter on `sent_count` reading `doc.total_recipients` («التقدّم»), `total_recipients`, `sent_count`, `read_count`, `failed_count`, `device`, `scheduled_at`, `started_at`; «تعديل» badge when `added_count+removed_count+pause_count > 0`; rates/durations (نسبة النجاح/المقروء/الفشل, المدة التقديرية/الفعلية/الفارق) are derived → Progress tab + Report view, not list columns | tabs Campaign (= spec "Data tab") · Messages · Recipients (= spec "Contacts tab") · Progress · Log; Messages child = native grid (≤ 5 rows); Recipients = `PagedChildTable` (grid hidden, R-05) + ContactPicker add/remove; read-only rules follow fields.md §7 machine: messages/recipients editable in Draft/Scheduled, recipients add/remove in Running/Paused, everything locked in terminal states; Log tab = native timeline (`track_changes`) + Audit rows (02 G-04) |
| 7 | Functions Center | **Hybrid**: Custom Page `wa-functions-center` (storefront) + native `WhatsApp Function` list/form (installed record, spec §5.6) | native: `function_name`, `category`, `status` indicator, `installed_version`, `update_available` indicator, `avg_ms`; no Desk New (no create permission); primary action "Open Functions Center" | manifest/version/checksum read-only; `settings` and `outputs` children editable (MGR W); button "Open in Functions Center"; status toggle → `functions.set_status` |
| 8 | Commands | Frappe list; create/edit in modal only (spec §5.5) via `MetaDialog` ("CommandModal") | `code` («الأمر»), `function`, `synonyms`, `requires_linked_contact`, `status` indicator (Active green · Inactive gray), `run_count` («التنفيذات 30ي»); `listview_settings`: New → CommandModal, row click → CommandModal, ListStatsCard; party types (child) shown in row expand from `commands.list_commands` | native form remains reachable: form script makes it read-only while `Active` with a "Stop to edit" button, and on `frm.is_new()` redirects to the modal (R-03); Restore defaults / Test buttons |
| 9 | Queue | Frappe DocType list, status-driven (spec §5.1) | `display_name`/`phone_e164` («الجهة»), `status` indicator (Queued/Sending blue · Paused amber · Deleted gray · Completed green · Dead Letter red), `device`, `campaign`, `scheduled_at`, `priority`, `attempts`, `last_error_code`; default filter `status in (Queued, Sending, Paused)` ("deleted is a state" — visible by changing the filter); `listview_settings`: no New, header = ListStatsCard summary + paused banner + pause/resume + rate slider; row click → Drawer of the linked Outbound (shows «النص الذي سيُرسَل», document, amount) | entirely read-only; form script buttons Pause / Resume / Delete (reason) / Retry dead letter |
| 10a | Message Templates | Frappe list + form (core `Email Template` pattern) | `template_name`, `body` excerpt («بداية النص»), `category`, `message_type`, `use_count`, `modified`; ListStatsCard | `TemplateEditor` block on `body` (variables from `reference_doctype`, sample record, live preview); tabs Template · Attachment · Preview; `disabled` toggle |
| 10b | Notifications (نماذج الإشعارات) | Frappe list + form — **second list under Templates** (D-016, 02 F-02) | `notification_name`, `document_type`, `enabled` indicator, `event` («شرط الإرسال»), `device`, `variables_count`, `send_count` («الاستخدام 30ي»), `modified`; ListStatsCard | tabs Trigger · Message · Recipients · Property · Stats; form script fills Select options (`date_changed`, `datetime_changed`, `value_changed`, `set_property_after_alert`, child `receiver_by_document_field`, `linked_document_field`) from `notifications.get_document_fields`; `template` Link vs inline `message` (02 OQ-9); buttons Preview / Send now |
| 10c | Notification Alerts | Frappe list + form — **third list under Templates**, same pattern as 10b (placement decision, Findings F-02; no prototype screen) | `alert_name`, `enabled` indicator, `periodicity`, `notification_time`, `report`, `device`, `next_run_at`, `last_sent_at` | tabs Schedule · Content · Recipients · Stats; form script: `report_column` options from `alerts.get_report_columns`, dynamic-filter helper text from `alerts.get_dynamic_filter_reference`; buttons Preview / Run now |
| 11 | Simulator | Custom Page `wa-simulator` | — | — |
| 12 | Contacts | Custom Page `wa-contacts` (spec §4 layer; CU holds zero rows on `Contact`, so no native list is possible — F-09) | page-owned `frappe.DataTable` fed by `contacts.list_contacts`: «الجهة», «الرقم», «النوع» (link_doctype), «حالة الربط», «عدد الحسابات المرتبطة», «الحسابات المرتبطة», «الحالة» (`status`, read-only), «محادثة قائمة» (`numbers.conversation_confirmed`), «آخر رسالة», «منذ» | page-owned Drawer form «بيانات الجهة» with only `CONTACT_WRITE_FIELDS` + phones + links (backend §9); never a native Contact form for CU |
| 13 | WhatsApp Numbers | Frappe list over materialized DocType + ConversationDrawer (spec §5.2) | **`link_status` first** with indicator (Linked green · Not Linked amber), `display_name` («الاسم في الواتساب»), `phone_e164`, `contact`, `last_seen` + relative («منذ»), `outbound_count`, `inbound_count`, `number_type`; `listview_settings`: no New (blocked at permission level), row click → ConversationDrawer, ListStatsCard, page button «فتح جهات الاتصال» → `wa-contacts` | read-only by permission; form script buttons Link/Convert · Unlink (MGR) · Confirm conversation · Quick send · Open conversation |
| 14 | Contact Groups | Frappe DocType + ContactPicker | `group_name`, `kind` indicator (Blacklist red · Marketing blue · others gray), `member_count`, `source`, `members_changed_at` («آخر تحديث»); filter tabs by `kind`; ListStatsCard | tabs Group · Members; Members = `PagedChildTable` + ContactPicker add/remove (target `WhatsApp Contact Group`); banner when `kind = Blacklist` («محجوبة من الأوامر والحملات») |
| 15 | Settings (+ Billing) | Custom Page `wa-settings` over the existing Single (spec §5.7; no new storage); native `WhatsApp Settings` form stays for SM as fallback | — (Audit section = page table over `settings.list_audit_log`, with link to native `WhatsApp Audit Log` list) | page only reads/writes through `settings.get_settings(section)` / `settings.save_settings(section, values)`; secrets never displayed (`has_*` booleans) |

#### 1B. Dialogs · filters · row actions · bulk actions (each action → API in `backend-plan.md` §4)

| # | Dialogs (prototype title → API) | Filters | Row actions → API | Bulk actions → API |
|---|---|---|---|---|
| 1 | Stepper steps, no dialogs: (0) status `onboarding.get_status` · (1) choose sign-up / sign-in / forgot · (2a) sign-up → `onboarding.start_signup` → code → `get_signup_status` / `complete_signup` · (2b) sign-in → `onboarding.save_credentials` → `settings.test_connection` · (2c) forgot → `onboarding.start_password_reset` · (3) pair device → `devices.create_device` + `start_pairing` (PairingModal reused from 3) · (4) webhook → `settings.setup_webhook` · (5) finish → `onboarding.complete_setup`. Redirect governed by `Settings.redirect_unregistered_to_wizard` (spec #1: enable last) | — | — | — |
| 2 | «استئناف الطابور؟» (رسائل ستُرسل فوراً, معدّل الإرسال, يُخصم من رصيد الباقة, الرصيد بعد الإرسال ← `queue.get_summary`) → `queue.resume_queue`; «تشخيص الجهاز» → route `wa-devices`; «أرسل رسالة اختبار» → QuickSend | period selector («الفترة») = Dashboard Chart timespan | KPI click-through: الأجهزة → `wa-devices`, الطابور/قيد المعالجة → Queue list, الحملات النشطة → Campaign form, ويب هوك → `wa-settings#webhook`, استخدام الباقة → `wa-settings#subscription`, «افتح سجل الصادرة» → Outbound list `status=Failed`, «اقترن جهازاً» → `wa-devices` | — |
| 3 | New device (اسم الجهاز, pairing mode QR ∣ Code) → `devices.create_device` → PairingModal («مسح الرمز» QR image ∣ 8-digit code, expiry countdown) → `devices.start_pairing`, `devices.poll_status` + realtime → «اقترن الجهاز بنجاح» (الاسم, الرقم المقروء); «فصل «X»؟» (رسائل ستتوقف ← `queue.get_summary` by device, نماذج مرتبطة ← count Notification by device, حملات مرتبطة ← count Campaign by device) → `devices.disconnect_device`; «حذف «X»؟» (رسائل مرتبطة في السجل ← count Outbound by device, نماذج ستفقد جهازها, حملات ستتعطل) → `devices.delete_device`; rename → `devices.update_device` (hidden until platform A-05, backend G-6) | status chips متصلة / غير متصلة / بانتظار الاقتران; refresh → `devices.list_devices(refresh=1)` | فصل → `disconnect_device`; إعادة الاقتران → `start_pairing`; الصادر → Outbound list `device=`; الوارد → Inbound list `device=`; حذف → `delete_device`; set default → `set_default`; disable → `set_disabled`; card stats (أُرسل 30ي, فشل, نسبة الفشل, الصادر, الوارد, آخر رسالة) ← `devices.get_device_stats` | — |
| 4 | Drawer ← `messages.get_outbound` (النص المُرسَل, فارق الرد, سجل المحاولات = queue item + webhook events, المبلغ from `reference.amount`); QuickSend ← `quick_send.get_context(phone=)`; cancel reason → `messages.cancel` | FilterBar presets: الحالة (`status`), الجهاز, المصدر (`source_type`), الحملة, الأمر, نوع المستند (`reference_doctype`), الفترة (`creation`), بحث (phone/name), مرسل بالنيابة (`is_simulated`); saved list views per status | إعادة الإرسال → `messages.resend` (terminal only); إرسال رسالة → QuickSend; جهة الاتصال → Contact form (linked) or Numbers drawer (unlinked); إلغاء → `messages.cancel` (MGR) | إعادة إرسال الفاشلة → `messages.resend` per name with progress (Gap G-01), toast «لا رسائل فاشلة ضمن التحديد» when none; export → native Report view |
| 5 | Drawer ← `messages.get_inbound` (النص الوارد, الأمر المطابق / «لا أمر يطابق هذا النص», الردّ المُرسَل, فارق الرد, command trace); reply → QuickSend prefilled; «أضفه كمرادف» → `commands.save_command` with `synonyms` appended (command must be Inactive — OQ-3) | tabs الكل / مطابَق / بلا مطابقة (`command_status`), الأمر, الجهة (`contact`), الجهاز, الفترة (`received_at`), بحث, `is_simulated` | فتح الأمر → CommandModal (read); أضفه كمرادف → see dialogs; ردّ برسالة → QuickSend; جهة الاتصال → `numbers.link_number` modal or Contact form | none in prototype; export → Report view |
| 6 | ListStatsCard modal «جارية الآن» ← `campaigns.get_sending_now` with per-row «إيقاف مؤقت» → `campaigns.pause` and «سجل الصادر» → Outbound list `campaign=`; ContactPicker add/remove (→ `picker.*`, target `WhatsApp Campaign`); «إيقاف «X»» (رسائل ستتوقف, حملات, سبب الإيقاف) → `campaigns.pause(name, reason)`; «استئناف «X»» (رسائل ستُرسل) → `campaigns.resume`; «إلغاء «X»» (رسائل لن تُرسل, رصيد يُوفَّر, «أفهم أن») → `campaigns.cancel(name, reason)`; «اعتماد وبدء الحملة» → `campaigns.start`; Schedule (التاريخ, الوقت) → `campaigns.schedule` / `unschedule`; message preview → `campaigns.preview_message`; «رسائل الحملة» modal → Outbound list `campaign=`; poll results → `campaigns.get_poll_results`; «جلب من قوالب الرسائل» = Template Link on the Messages child row | `status`, `device`, `scheduled_at` range, «نوع البدء» (= `scheduled_at` set / empty) | تعديل المسودة واعتمادها (Draft → form + Start); إيقاف الحملة / إيقاف للتعديل → `pause`; استئناف → `resume`; إلغاء نهائي → `cancel`; رسائل الحملة; عرض في سجل الصادر; «ابدأ فوراً» / «جدولة غداً 9:00» = form buttons Start / Schedule with default | إيقاف / استئناف / إلغاء المحددة → `campaigns.pause` / `resume` / `cancel` per name (Gap G-01) |
| 7 | FunctionDetail modal (tabs التفاصيل: ماذا تفعل / متى تُستخدم / المتغيرات المطلوبة / المخرجات · المعاينة · سجل التحديثات) ← `functions.get_catalog` entry; PreviewModal (diff of settings / outputs / manifest, «أوامر ستستفيد») ← `functions.preview_install`; «تحديث «X»» confirm (دوال ستُحدَّث, أوامر ستستفيد, تبقى بلا تحديث) → `functions.update`; install / remove → `functions.install` / `functions.remove` (409 when Active commands → shown as blocker); settings editor → `functions.save_settings` | tabs الكل / منزّلة / غير منزّلة / تحتاج تحديث (`installed_version`, `update_available`), المجموعة (`category`, TreeGroupBy), search | تحديث إلى X → `preview_install` → `update`; تنزيل / إزالة → `install` / `remove`; تفعيل / إيقاف → `functions.set_status`; «أوامر مرتبطة» → Commands list `function=` | تحديث / تفعيل / إيقاف المحددة → per key (Gap G-01) |
| 8 | CommandModal = `MetaDialog` over `WhatsApp Command` meta, tabs تفاصيل الأمر · الصلاحيات (`requires_linked_contact`, `allowed_party_types`, mode toggle «الكل مسموح — حدّد القائمة السوداء» = `blocked_group` ∣ «الكل ممنوع — حدّد القائمة البيضاء» = `allowed_group`, `reply_device`) · المعاينة (text, sender phone, device → `commands.test_command`; «حفظ خيارات المعاينة في الأمر» = `settings_overrides`); defaults on function pick ← `commands.get_defaults`; save → `commands.save_command`; inline «حفظ وتحديد» new group → `frappe.new_doc("WhatsApp Contact Group")` quick entry; «حذف «X»» (أوامر ستُحذف, منها مفعّلة الآن, تبقى أوامر, «أفهم أن») → `frappe.client.delete` (Active → refused, Gap G-05); "Stop to edit" prompt → `commands.set_status(Inactive)` | tabs المفعّلة / الموقوفة / الكل (`status`), الدالة, search on `code` + `synonyms` | تحرير → modal (Active → stop first); تشغيل / إيقاف → `commands.set_status`; استعادة الافتراضيات → `commands.restore_defaults`; فتح الدالة → `wa-functions-center?function=`; حذف; اختبار → `commands.test_command` | تفعيل / إيقاف / حذف المحددة → per name (Gap G-01) |
| 9 | «إيقاف الطابور مؤقتاً؟» (رسائل ستتوقف فوراً, المعدّل الحالي, الوقت المتبقي للتفريغ ← `queue.get_summary`; سبب الإيقاف — يظهر في سجل التدقيق) → `queue.pause_queue(reason)`; «استئناف الطابور؟» (رسائل ستُرسل فوراً, معدّل الإرسال, يُخصم من رصيد الباقة, الرصيد بعد الإرسال) → `queue.resume_queue`; «إلغاء N» (رسائل ستُلغى, تبقى في الطابور, رصيد يُوفَّر, «أفهم أن», reason) → `queue.delete_items(names∣filters, reason)`; rate slider (bounded by `plan_messages_per_minute`) → `queue.set_rate`; Drawer of linked Outbound | `status` (default live set), `device`, `campaign`, `phone_e164`, `priority`, `last_error_code` | إلغاء هذه الرسالة → `queue.delete_items([name], reason)`; إيقاف / استئناف → `queue.pause_items` / `resume_items`; إعادة المحاولة (Dead Letter only) → `queue.retry_dead_letter`; «النص الذي سيُرسَل» → Drawer | إلغاء / إيقاف / استئناف المحددة → same APIs with `names[]` (native bulk, no loop) |
| 10a | Preview (sample record ← `templates.pick_sample`, variables ← `templates.list_variables`, render ← `templates.preview`); delete confirm (native); «استخدم في رسالة» → QuickSend `template=` | `category`, `message_type`, `disabled`, `reference_doctype` | edit (form), duplicate (native copy), delete (native), use in message | native bulk edit `disabled`; native bulk delete |
| 10b | «المعاينة بقيم مستند حقيقي» (Link picker on `document_type` → `notifications.preview(name, reference_name)`); «أرسل اختباراً» → `notifications.send_now(name, reference_name)`; «حذف N» (نماذج ستُحذف, منها مفعّلة الآن, تبقى نماذج, «أفهم أن») → native bulk delete | نوع المستند, جهاز الإرسال, شرط الإرسال (`event`), الحالة (`enabled`) | تحرير النموذج (form); حذف النموذج; تفعيل / إيقاف → `frappe.client.set_value(enabled)`; row expand «نص الرسالة» + preview | تفعيل / إيقاف المحددة → native bulk edit `enabled`; حذف المحددة → native bulk delete with ConfirmDialog counts |
| 10c | Preview → `alerts.preview`; Run now → `alerts.run_now`; dynamic filters reference → `alerts.get_dynamic_filter_reference` (help dialog) | `enabled`, `periodicity`, `report`, `device` | edit, enable/disable (`set_value`), run now | native bulk edit `enabled` |
| 11 | «رسالة بالنيابة» (أمر من الأوامر المتاحة ← `simulator.get_context.commands` ∣ «أو رسالة عادية ليست أمراً») → `simulator.simulate_inbound(device, sender_phone, text, run_commands)`; «من هي هذه الجهة» (الاسم, التصنيف, الربط بحساب, الرصيد, الرسائل, آخر رسالة, الجهات المرتبطة بها) ← `numbers.get_number` + `contacts.get_contact`; «اختر جهة اتصال» ← `numbers.search_numbers` / `contacts.list_contacts`; «صندوق الاختبار» confirm (المستلمون, الجهاز, يُخصم من الباقة / زائد على الباقة, «أفهم أن») → `simulator.send_test(device, phone, body)`; result strip «افتح في السجل» → Outbound form, «إخفاء» local; guards «لا محادثة مفتوحة / الرسالة فارغة / الجهاز غير متصل» (`WADeviceOfflineError`) | contact list tabs جهات النظام ∣ دليل الجهاز (latter **not built** — spec §3.2 #5), search, device select | send → `simulator.send_test`; رسالة بالنيابة; مسح (local); thread ← `messages.get_conversation`; attachments toolbar (صورة / فيديو / مستند / رسالة صوتية / موقع / جهة اتصال) → Gap G-04 (`send_test` is body-only) | — |
| 12 | Drawer create/edit «بيانات الجهة» (الاسم, رقم الواتساب = PhoneField, الحسابات المرتبطة «+ إضافة» ← `contacts.search_party`, الحالة read-only, محادثة قائمة) → `contacts.create_contact` / `contacts.update_contact` (+ `numbers.confirm_conversation`); «تغيير حالة المحادثة» (الحالة الحالية, الحالة الجديدة, الملاحظات إلزامية) → `numbers.confirm_conversation(phone_e164, confirmed, note)`; «اربطه بحساب» → `contacts.update_contact(links)`; QuickSend; ConversationDrawer ← `messages.get_conversation` (CU needs Viewer — backend OQ-5 / OQ-11 here); delete → CU **not built** (no API), MGR via native Contact | search, النوع (`link_doctype`, TreeGroupBy), حالة الربط, has_whatsapp, blacklisted, الحالة | اربطه بحساب; إرسال رسالة → QuickSend; تحرير; تغيير حالة; محاكي الواتساب → `wa-simulator?contact=`; سجل الرسائل → ConversationDrawer; حظر / إلغاء الحظر → `contacts.toggle_blacklist`. Row expand tabs: الحسابات المرتبطة ← `contacts.get_contact.links`; آخر الرسائل ← `messages.get_conversation`; سجل حالة المحادثة → Gap G-06; سجل التفعيل والتعطيل → **not built** (OQ-4) | ربط المحددة → `contacts.update_contact` per name (Gap G-01); إرسال رسالة للمحددة → Gap G-03 (Campaign draft route) |
| 13 | Link/Convert modal «جهة اتصال جديدة من محادثة واتساب» (search existing Contact → `numbers.link_number` ∣ create: الاسم, رقم الواتساب read-only, الحسابات المرتبطة «+ إضافة» ← `contacts.search_party`, محادثة قائمة → `numbers.convert_number(phone_e164, first_name, party_type, party_name)` + `confirm_conversation`); ConversationDrawer header «رقم مجهول» when Not Linked; unlink confirm → `numbers.unlink_number` (MGR); QuickSend | `link_status`, `number_type`, `last_device`, `last_direction`, `conversation_confirmed`, `last_seen` range, search | فتح جهة الاتصال → Contact form; أضفه كجهة اتصال → Link/Convert; محاكي الواتساب → `wa-simulator?number=`; سجل الرسائل → ConversationDrawer; إرسال رسالة → QuickSend; إلغاء الربط (MGR); تأكيد المحادثة | «إنشاء جهات اتصال للمجهول» → `numbers.convert_number(first_name=display_name)` per Not Linked row with count confirm, toast «لا أرقام مجهولة في التحديد» (Gap G-01) |
| 14 | ContactPicker add/remove (target `WhatsApp Contact Group`); «استيراد من ملف CSV» → new Group form → ContactPicker source 5 (csv) preselected; delete native | `kind` tabs (الكل + 5 kinds), `source`, `disabled` | تعديل المجموعة والأعضاء → form; حملة لهذه المجموعة → `frappe.new_doc("WhatsApp Campaign")` then ContactPicker source 1 preselected with this group; جهات الاتصال → `wa-contacts?group=`; إرسال رسالة لهذه المجموعة → Gap G-03. Row expand: الأعضاء (first 10 ← `picker.get_group_members`), ملاحظة (`description`) | native bulk edit `disabled`; native bulk delete |
| 15 | «تدوير مفاتيح الاعتماد؟» (مفاتيح ستُستبدل, أجهزة مرتبطة ← count Device, الويب هوك ← `webhook_status`, «أفهم أن التكاملات الحالية ستتوقف») → `onboarding.save_credentials`; rotate webhook secret → `settings.rotate_webhook_secret`; «الأحداث المُستقبَلة» checklist ← `settings.list_webhook_events_available` → `settings.set_webhook_events`; «تفعيل الآن» → `settings.setup_webhook` / `settings.set_webhook_status(Active)`; test → `settings.test_connection`, `settings.test_webhook`; «نُسخ رابط الاستقبال» local copy of `webhook_endpoint_url`; Billing «شحن المحفظة» / «ترقية الباقة» / «إعدادات الفاتورة» → **not rendered** until platform A-01..A-04 (backend G-6, OQ-6) | SettingsNav sections: الربط بالمنصة · بيانات الاعتماد · الويب هوك · الطابور · الأوامر · السياسة · مصادر المنتقي (`picker_sources`) · الاحتفاظ · الاشتراك والباقة · سجل التدقيق · (الأدوار = link to Role Permission Manager, **not built**, OQ-7); audit filters (action, user, from, to) → `settings.list_audit_log`; usage period → `settings.get_usage` | خطوات التهيئة ← `onboarding.get_status`; save per section → `settings.save_settings`; مزامنة الاشتراك → `settings.sync_subscription`; audit row → open reference doc; «آخر المحاولات» → Webhook Event list | — |

#### 1C. Components · realtime · roles · effort

| # | Screen | Kit components (`sanad.ui.*`) + page-local | Realtime subscriptions | Roles that see it (actions in brackets) | Effort |
|---|---|---|---|---|---|
| 1 | Onboarding Wizard | Stepper, PhoneField, EmptyState, Toast; PairingModal (from 3) | `wa:device:status`, `wa:pairing:status`* (step 3) | SM (all `api.onboarding` writes); any WhatsApp role sees status | M |
| 2 | Home | DashboardBlock (Number Cards + Dashboard Charts fixtures), ListStatsCard (queue), StatusBadge, ConfirmDialog, QuickSend, EmptyState | `wa:device:status`, `wa:queue:progress`, `wa:message:status`, `wa:campaign:status`*, `wa:inbound:received`* («التدفق المباشر») | VWR+ (resume queue: MGR) | L |
| 3 | Devices | StatusBadge, ConfirmDialog, EmptyState, Toast; page-local DeviceCard, PairingModal (QR + 8-digit code) | `wa:device:status`, `wa:pairing:status`* | VWR+ read (MGR: create/pair/disconnect/delete/default/disable) | L |
| 4 | Outbound | Drawer (record), FilterBar, RowActions, BulkActions, QuickSend, StatusBadge, Toast | `wa:message:status` (row refresh) | VWR+ (AGT: resend, quick send; MGR: cancel) | M |
| 5 | Inbound | Drawer (record), FilterBar, RowActions, ListStatsCard, QuickSend, StatusBadge | `wa:inbound:received`* | VWR+ (AGT: reply; MGR: synonym) | M |
| 6 | Campaigns | ListStatsCard (+ modal), ContactPicker, PagedChildTable, ConfirmDialog, RowActions, BulkActions, StatusBadge, TemplateEditor (preview) | `wa:campaign:status`*, `wa:queue:progress` | MGR (C/W, start/pause/resume/cancel); AGT, VWR read | XL (ContactPicker counted in §3) |
| 7 | Functions Center | TreeGroupBy, FilterBar, BulkActions, ConfirmDialog, StatusBadge, EmptyState; page-local FunctionsCatalog, FunctionDetail, PreviewModal | — (daily `functions_catalog.check_updates`) | MGR (install/update/remove/status/settings); VWR read | L |
| 8 | Commands | MetaDialog (CommandModal), ListStatsCard, FilterBar, RowActions, BulkActions, ConfirmDialog, StatusBadge | — | MGR; AGT, VWR read | L |
| 9 | Queue | ListStatsCard (summary + banner + rate slider), Drawer, RowActions, BulkActions, ConfirmDialog, StatusBadge | `wa:queue:progress` | VWR+ read (MGR: pause/resume/delete/retry/rate) | M |
| 10a | Message Templates | TemplateEditor, ListStatsCard, QuickSend | — | MGR C/W; AGT read (Quick Send) | M |
| 10b | Notifications | ListStatsCard, MetaDialog (preview / send-now), BulkActions, ConfirmDialog, StatusBadge | — | MGR; VWR read | M |
| 10c | Notification Alerts | MetaDialog (preview / run-now), StatusBadge | — | MGR; VWR read | S |
| 11 | Simulator | ChatThread, PhoneField, MetaDialog, ConfirmDialog, StatusBadge, EmptyState; page-local SimulatorComposer | `wa:message:status` (test send is a job — backend F-13), `wa:inbound:received`* | AGT, MGR | L |
| 12 | Contacts | Drawer (form), ConversationDrawer, FilterBar, TreeGroupBy, RowActions, BulkActions, PhoneField, QuickSend, ConfirmDialog; page-local ContactsTable (`frappe.DataTable`) | `wa:inbound:received`* («آخر رسالة» column) | CU, AGT, MGR (conversation tab: needs Viewer — OQ-11) | L |
| 13 | WhatsApp Numbers | ConversationDrawer, ListStatsCard, MetaDialog (link/convert), RowActions, BulkActions, QuickSend, StatusBadge | `wa:inbound:received`* | VWR+, CU (link/convert; unlink MGR) | M |
| 14 | Contact Groups | ContactPicker, PagedChildTable, ListStatsCard, FilterBar, RowActions | — | MGR, AGT, CU (C/R/W); VWR read | M |
| 15 | Settings | MetaDialog, ConfirmDialog, DashboardBlock (usage chart), StatusBadge, Toast; page-local SettingsNav | `wa:device:status` (webhook/device counters) | SM (write); MGR (read, test connection/webhook, sync, audit); VWR usage only | L |

### 2. Prototype cross-check — elements not already assigned above

Everything else visible in `docs/screen/*` maps to a row in §1A–1C (columns, filters, buttons,
modal titles were extracted from the prototype and placed there). This table lists only the
elements that are **deliberately not built** or that need a Gap / Open question.

| Prototype element | Where (`docs/…`) | Assignment |
|---|---|---|
| «كل الرسائل» screen (direction tabs, stats, export) | `screen/Hub Screen - All Messages` | **Not built** — spec §2; need met by ConversationDrawer (13, 12) + native Report view export on 4/5 |
| «وضع العرض التجريبي» (state switches عادي/تحميل/فارغ/خطأ/عدم اتصال) | `screen/Hub Screen - Demo` | **Not built** — prototype tooling; the states themselves are `EmptyState` on every page (ui.md) |
| App shell: sidebar, «more» menu, theme toggle, 12h/24h clock, dev menu, «فتح تذكرة دعم» | `screen/WhatsApp Hub App-pro` 134, 3568–3592 | Workspace + Desk navbar (§5); theme/clock = Desk user settings; support ticket **not built** (no API — OQ-7) |
| Campaign wizard «حملة إرسال جديدة» (المستلمون → الرسالة → التوقيت), presets «ابدأ فوراً / جدولة غداً 9:00» | `Campaigns` 406–453; `App-pro` 4800 | **Not built as a wizard** — spec row 6 = Frappe DocType with Data + Contacts tabs; the form's tabs + Start/Schedule buttons cover the flow (Findings F-07) |
| Campaign «استثناء الأرقام التي ليس بيني وبينها محادثة» («حماية من الحظر») | `Campaigns` 365, 447 | Gap G-02 / OQ-1 |
| Campaign «فلترة حسب نوع الجهة» in recipient step | `Campaigns` 285 | ContactPicker source 3 (Frappe filter UI) |
| Device `battery` | `Devices` 168–169 | **Not built** — 02 G-06 / OQ-7 there |
| Device pairing is QR-only in the prototype | `Devices` 184 | Spec adds the 8-digit code; PairingModal implements both (spec wins) |
| Billing: «شحن المحفظة», «ترقية الباقة», «إعدادات الفاتورة» (التجديد الآلي, تنبيه عند استهلاك, بريد الفواتير), «الاستهلاك اليومي» | `Billing` 37–38, 116–176 | Usage chart ← `settings.get_usage`; plan/wallet cards ← `settings.get_settings("subscription")`; top-up / upgrade / invoice settings **not rendered** until platform A-01..A-04 (backend G-6, OQ-6) |
| Settings «الأدوار» capability matrix, «المستخدمون / تعديل الصلاحيات» | `App-pro` 4077, 4151–4166; `Settings` 173 | **Not built** — Desk Role Permission Manager link in SettingsNav (OQ-7) |
| Simulator «دليل الجهاز» tab, «في دليل الجهاز» | `Simulator` 203; `App-pro` 4512 | **Not built** — spec §3.2 #5: phone contacts are a file import, never live |
| Simulator attachments toolbar (صورة, فيديو, مستند, رسالة صوتية, موقع, جهة اتصال) | `Simulator` 436–441 | Gap G-04 |
| Contacts «الجهة معطّلة», «سجل التفعيل والتعطيل» | `Contacts` 189, 197 | **Not built** — `status` is read-only in `CONTACT_WRITE_FIELDS` (backend §9); OQ-4 |
| Contacts «سجل حالة المحادثة» | `Contacts` 197 | Gap G-06 |
| Contacts delete «حذف» | `Contacts` 98 | CU: **not built** (no API); MGR: native Contact delete |
| «إرسال رسالة للمحددة», «إرسال رسالة لهذه المجموعة», Bulk Send component | `Contacts` 209; `Contact Groups` 112; `component/Bulk Send` | Gap G-03 (Campaign-draft route) |
| Inbound stats «نسبة المطابقة», «متوسط زمن الردّ» | `App-pro` 5722–5725 | Gap G-07 |
| Contacts stats «مربوط / غير مربوط / مرتبط بأكثر من حساب / نسبة التغطية» | `Contacts` 161–164 | Gap G-08 |
| Queue per-row «#», «الإرسال المتوقّع», «نوع المستند / رقم المستند / المبلغ» | `Queue` 139–145 | Position/ETA: ListStatsCard summary + Drawer (OQ-2); document/amount: Drawer via linked Outbound (Gap G-09) |
| Outbound «الوقت المستغرق», «المبلغ» | `Outbound` 124; `App-pro` 6114 | Drawer only (derived in `messages.get_outbound`) |
| Notification stat «نماذج على جهاز غير متصل» | `Notification Templates` 115 | ListStatsCard client-side join (Notification.device × Device.status via `frappe.client.get_list`) |
| Notification preview variables (رقم المستند, المبلغ, اسم الجهة, تاريخ المستند, تاريخ الاستحقاق) | `Notification Templates` 64–68 | `templates.list_variables(document_type)` |
| Command modal whitelist/blacklist mode toggle | `App-pro` 5335–5336 | Permissions tab: `allowed_group` (whitelist mode) vs `blocked_group` (blacklist mode) — UI toggle, two fields |
| Home charts «حجم الرسائل», «الفشل حسب نوع الخطأ» | `Home` 163–180 | Dashboard Chart fixtures over `WhatsApp Outbound Message` (`status` × `creation` timeseries; `error_code` group) — native, Findings F-08 |
| Functions «التنزيل» column, tabs منزّلة / غير منزّلة / تحتاج تحديث | `Functions` 127; `App-pro` 5487 | catalog `installed_version` empty/present, `update_available` |
| Overlay Panel demos (create-contact tabs, edit message, delivery log, choice) | `component/Overlay Panel` | Drawer modes: form (12), record + delivery timeline (4), choice (11 «رسالة بالنيابة») |
| Cards, Charts, Data List, List View, Toolbar, Form, Phone Field, Confirm Dialog, Toasts, States, UI Kit | `component/*` | ListStatsCard, DashboardBlock, native list / `frappe.DataTable`, FilterBar, MetaDialog, PhoneField, ConfirmDialog, Toast, EmptyState, StatusBadge |
| Chat Thread, Template Editor, Command Editor, Group Editor, Function Detail, Wizard, Send Message Dialog | `component/*` | ChatThread, TemplateEditor, CommandModal (MetaDialog), ContactPicker + PagedChildTable, FunctionDetail (page-local), Stepper, QuickSend |

### 3. Component kit (`whatsapp_next/public/js/ui/<Component>/`, namespace `sanad.ui`, bundle `whatsapp_next.bundle.js`)

Portability rules from `.claude/rules/ui.md` apply to every kit row (no `whatsapp_next.*` imports,
meta-driven, `__()`, README + one live use). "Page-local" rows live in `page/<slug>/` under
`whatsapp_next.<page>` and are not part of the kit.

| Component | Constructor options (`{ wrapper, … }`) | Data API | Used by | Prototype file | Effort |
|---|---|---|---|---|---|
| `Drawer` — record / form / choice modes | `{doctype, name?, mode: "record"∣"form"∣"choice", fields? (default: meta `in_list_view` + `bold`), actions[], title, side: "inline-end"}` | `frappe.get_meta`; record payload from a caller-supplied method (`messages.get_outbound` / `get_inbound`) or `frappe.client.get_value` with an explicit field list | 4, 5, 9, 12 | `Overlay Panel` | M |
| `Drawer` **conversation variant** (`ConversationDrawer`) | `{key (phone_e164∣jid), device?, page_length: 50, actions: [link, quick_send, confirm]}` | `messages.get_conversation`, `numbers.get_number`; subscribes `wa:message:status`, `wa:inbound:received`* matched by `sha1(key)` | 13, 12, 4 (from row), 11 (thread reuse via ChatThread) | `Chat Thread` + `Overlay Panel` | M |
| `ContactPicker` — sub-system (table §4) | `{target_doctype, target_name, operation: "add"∣"remove", sources?, preselect?: {source, ref}, on_commit}` | `picker.*` | 6, 14 | `Bulk Send` (recipient step), `Group Editor` | XL |
| `ListStatsCard` | `{listview∣wrapper, cards: [{label, method?∣count: {doctype, filters}∣sum: {doctype, field, filters}, format, onclick∣modal: {method, columns, row_actions}}]}` | `campaigns.get_sending_now`, `queue.get_summary`, `frappe.client.get_count`, `frappe.client.get_list` (aggregate) | 2, 5, 6, 8, 9, 10a, 10b, 13, 14 | `Cards` | S |
| `MetaDialog` | `{doctype, name?, tabs: [{label, fields[] (fieldnames only; df from meta)}], primary_action: {label, method}, extra_actions[], read_only?}` | `frappe.get_meta`, `frappe.model.with_doctype`; save via caller method | 8 (CommandModal), 10b, 10c, 13 (link/convert), 15 | `Command Editor`, `Form` | M |
| `FilterBar` | `{listview∣page, presets: [{fieldname, type: "tabs"∣"select"∣"daterange"∣"search", options?}]}` | native `listview.filter_area`; page callback for custom pages | 4, 5, 7, 8, 12, 14 | `Toolbar` | S |
| `TreeGroupBy` | `{listview∣page, group_by_field, counts_method?}` | `frappe.desk.listview.get_group_by_count`; page summary API | 7 (`category`), 12 (`link_doctype`), 13 (`link_status`) | `Data List` sidebar | S |
| `RowActions` | `{listview, actions: [{label, icon, condition(doc), handler(doc)}]}` | caller | 4, 5, 8, 9, 13, 14 | `Data List` | S |
| `BulkActions` | `{listview, actions: [{label, method, args(names∣filters), per_name?: true, confirm?: ConfirmDialog spec, progress?: true}]}` | `queue.*_items` natively; per-name loops for Gap G-01 with progress bar and selection cap (R-08) | 4, 6, 7, 8, 9, 10b, 13 | `Data List` | S |
| `QuickSend` | `{phone?, contact?, number?, jid?, reference_doctype?, reference_name?, device?, template?}` → dialog: recipient (known/blacklisted badges), device, template, body/attachment, schedule; footer link "Open in Simulator" → `wa-simulator` | `quick_send.get_context`, `quick_send.preview`, `quick_send.send`; toasts warnings (`device_offline`, `queue_paused`) | 4, 2, 13, 12, 5, 10a, 14 | `Send Message Dialog` | M |
| `StatusBadge` | `{doctype, fieldname, value}` → colour from `frappe.listview_settings[doctype].get_indicator` fallback gray; Espresso surface/ink/outline triplet | meta | all lists, cards, drawers | `UI Kit` badges | S |
| `EmptyState` | `{state: "empty"∣"loading"∣"error"∣"offline", title, description, action?}` (skeleton for loading, never a spinner — docs/README) | — | every custom page + drawers | `States` | S |
| `Stepper` | `{steps: [{key, label, render(wrapper), validate() → Promise, can_skip?}], on_finish, on_cancel}` | caller | 1, 3 (PairingModal), ContactPicker confirm | `Wizard` | S |
| `DashboardBlock` (Frappe Custom Block) | `{number_cards: [names], charts: [names], period_filter?: true}` | Number Card / Dashboard Chart fixtures (`fixtures/`) | 2, 15 (usage) | `Cards`, `Charts` | M |
| `Toast` | `{title, indicator, timeout}` → `frappe.show_alert`; bottom-start on RTL | — | all | `Toasts` | S |
| `ConfirmDialog` — **kit candidate** (Gap G-10) | `{title, impact: [{label, value}], reason_field?: true, ack_checkbox?: text, danger?: true, confirm_label}` | counts supplied by caller | 2, 3, 6, 7, 8, 9, 10b, 13, 15 | `Confirm Dialog` | S |
| `PhoneField` — kit candidate | `{country_default (Settings.default_country), on_change({phone, phone_e164, valid})}` (client-side hint; server `phone.normalize` authoritative) | — | 1, 11, 12, 13, ContactPicker source 6 | `Phone Field` | S |
| `PagedChildTable` — kit candidate | `{frm, fieldname, page_method, page_length: 50, columns? (default child meta `in_list_view`), row_actions[], status_indicator}` — hides the native grid and renders a paged read table | `campaigns.get_recipients_page`, `picker.get_group_members` | 6 (recipients), 14 (members) | `Data List` | M |
| `ChatThread` — kit candidate | `{rows: MessageRow[], on_load_more, on_row_click, highlight?}` (bubbles by `direction`, status ticks, day separators) | read-layer rows from caller | 11, ConversationDrawer | `Chat Thread` | M |
| `TemplateEditor` — kit candidate | `{frm, body_field, reference_doctype_field, sample_field?}` — variables sidebar, sample picker, live preview pane | `templates.list_variables`, `templates.pick_sample`, `templates.preview` | 10a, 10b (`message`), 8 (outputs template), 6 (message preview) | `Template Editor` | M |
| Page-local `DeviceCard`, `PairingModal` | `{device, stats, on_action}` / `{device, mode: "QR"∣"Code", expires_at}` | `devices.*` | 3, 1 | `Devices` screen | (in 3) |
| Page-local `FunctionsCatalog`, `FunctionDetail`, `PreviewModal` | `{entries, filters}` / `{entry, tab}` / `{diff, commands_impacted}` | `functions.*` | 7 | `Function Detail`, `Functions` screen | (in 7) |
| Page-local `SettingsNav` | `{sections: [{key, label, render}], active}` (claude.ai-style left nav / right pane; collapses to tabs on mobile) | `settings.*` | 15 | `Settings`, `Billing` screens | (in 15) |
| Page-local `ContactsTable`, `SimulatorComposer` | `frappe.DataTable` wrapper / composer with device select + guards | `contacts.*` / `simulator.*` | 12 / 11 | `Contacts`, `Simulator` screens | (in 12 / 11) |

### 4. ContactPicker sub-system (spec §3.2) — one entry per tab

Modal shell: full-height sheet on mobile, dialog on desktop; source tabs on the inline-start, **Selected** tab always last; one source per operation; the same shell serves **add** and **remove**. Duplicate detection only on `phone_e164` (spec §6.2) as returned by the server.

| Tab / part | Prototype | UI | API | Rows returned carry | Notes |
|---|---|---|---|---|---|
| Shell | `Bulk Send` recipient step, `Group Editor` | title «إضافة مستلمين جدد» / «إزالة مستلمين»; live counter; footer "Confirm N" | `picker.list_sources(target_doctype)` (hides disabled sources) | — | permission = write on target (Campaign MGR; Group MGR/AGT/CU) |
| 1 Contact Groups «مجموعات جهات الاتصال» | `Campaigns` 361, 410 | search box + `kind` filter chips; pick one or more groups → members preview | `picker.search_groups(txt, kind, exclude)`, `picker.get_group_members(group, page)` | `{phone, phone_e164, display_name, contact, source_type: "Contact Group", source_name}` | disabled groups excluded server-side |
| 2 Contacts «جهات اتصال» | `Campaigns` 362, 411 | search by name/phone, `link_doctype` chips (Customer/Supplier/…) | `picker.search_contacts(txt, link_doctype, page)` | source_type `Contact`, `contact` set | CU reads through §4 layer (audit per call, backend OQ-3) |
| 3 System screen «شاشة النظام» | `App-pro` 4762–4765 presets (عملاء عليهم مستحقات, كل العملاء المربوطين, الموردون…) | DocType select (only `Settings.picker_sources`), then **Frappe's own `frappe.ui.FilterGroup`** for that DocType (spec: reuse, do not reimplement), rows table (name, name field, phone) | `settings.list_picker_sources`, `picker.list_doctype_rows(document_type, filters, page)` | source_type `DocType`, `source_doctype`, `source_name` (enables per-recipient Document messages, backend G-10) | server-side mandatory filters merged (backend G-1); presets = saved filter sets stored client-side per user (`frappe.ui.toolbar` "Save filter" reuse) |
| 4 Excel «ملف Excel» | `Bulk Send` 277 (import settings) | `frappe.ui.FileUploader` (private), sheet/column mapping (phone, name), preview with invalid rows | `picker.parse_upload(file_url, kind="excel", mapping)` | source_type `Excel` | ≤ 5 MB / 20 000 rows → `WAFileError` shown inline |
| 5 Phone export «ملف جهات الهاتف» | — (spec only) | upload `.vcf` (primary) or `.csv` (secondary); preview | `picker.parse_upload(file_url, kind="vcf"∣"csv")` | source_type `vCard` | never reads the device live (spec §3.2 #5) |
| 6 Manual «أرقام مكتوبة يدوياً / لصق قائمة» | `Campaigns` 363–364, 412–413 | textarea, one per line `name;phone` or `phone`, PhoneField hint | `picker.parse_manual(text)` | source_type `Manual` | invalid lines listed with reason |
| Selected «الأرقام النهائية / الأرقام الجديدة» | `Campaigns` 366, 415–424 | list with live counter; duplicates against target flagged **red**; counts «ستُضاف N», «موجودة مسبقاً M», «غير صالحة K»; `known_count` badge («لديها محادثة») | `picker.preview(target_doctype, target_name, rows)` | `{available[], already_added[], invalid[], duplicates_in_selection[], known_count}` | remove-mode: shows intersection with target instead |
| Confirm | `Campaigns` 372 «ستُضاف —» | ConfirmDialog stating the exact count, then commit | `picker.commit_add` / `picker.commit_remove` | `{added, skipped_duplicates, skipped_invalid}` / `{removed}` | audit `Campaign Recipients Changed` / `Contact Group Members Changed`; 409 when campaign terminal |
| Remove mode | `Campaigns` 341–349 «المستلمون الحاليون» | same sources; or filter chips by `source_type` / `source_ref` on the target's current rows | `picker.commit_remove(target, phone_e164s∣filters)` | — | Running/Paused campaign → allowed (counters + audit) |

### 5. Workspace / sidebar plan — Desk Workspace "WhatsApp" replaces the prototype shell

| Workspace part | Content | Source |
|---|---|---|
| Workspace fixture | `fixtures/workspace.json` → "WhatsApp", module `WhatsApp Next`, visible to MGR/AGT/VWR/CU; cards below use `only_for` roles | conventions §Module layout |
| Shortcuts row | Home (`/app/wa-home`) · Devices (`/app/wa-devices`) · Simulator (`/app/wa-simulator`) · Settings (`/app/wa-settings`) | spec §2 custom pages |
| Card «الرسائل» | Outbound · Inbound · Queue | rows 4, 5, 9 |
| Card «الجمهور» | Contacts (page) · WhatsApp Numbers · Contact Groups | rows 12, 13, 14 |
| Card «الحملات» | Campaigns | row 6 |
| Card «النماذج» | Message Templates · Notifications · Notification Alerts | rows 10a–10c |
| Card «الأتمتة» | Commands · Functions Center (page) · Installed Functions (`WhatsApp Function` list) | rows 7, 8 |
| Card «النظام» | Settings (page) · Audit Log · Webhook Events | row 15; SM/MGR only |
| Number Cards on the workspace | Queued now · Connected devices · Sent today · Failed today (fixtures over Queue Item / Device / Outbound) | Gap G-12 |
| Sidebar order (mirrors `App-pro` shell) | Home · Outbound · Inbound · Queue · Devices · Contacts · WhatsApp Numbers · Contact Groups · Message Templates · Notifications · Notification Alerts · Commands · Functions Center · Campaigns · Simulator · Settings | `App-pro` 3583–3591 + primary sidebar |
| Prototype header items | theme toggle, 12h/24h clock, dev menu, «more» → Desk navbar / user settings; «فتح تذكرة دعم» not built (OQ-7); Onboarding not listed (reached by redirect only, spec #1) | — |
| Page permissions | each `page/<slug>/<slug>.json` declares `roles` per Matrix 1C (CU: `wa-contacts` only; SM: all; VWR: `wa-home` read) | ui.md |

### 6. Prototype palette → Espresso tokens (verified in `frappe/public/scss/espresso/_colors.scss`, light + dark defined)

| Prototype variable | Espresso token | Use |
|---|---|---|
| `--bg` | `--surface-gray-1` (Desk page background; use Desk `--bg-color` where the page container already sets it) | page canvas |
| `--surface` | `--surface-white` | cards, drawers, dialogs |
| `--sunken` | `--surface-gray-2` | hover, nested panels, code blocks |
| `--border` / `--border-2` | `--outline-gray-1` / `--outline-gray-2` | dividers / input and button outlines |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | `--ink-gray-9` / `--ink-gray-8` / `--ink-gray-6` / `--ink-gray-5` | primary / secondary / tertiary / muted text |
| `--pri`, `--pri-d`, `--on-pri` (teal primary button) | Desk `.btn-primary` class (no colour variable); links/accents `--ink-blue-3`; text on primary `--ink-white` | primary actions |
| `--pri-s` / `--pri-sb` | `--surface-blue-1` / `--outline-blue-1` | selected tabs, info chips |
| `--ok`, `--ok-i` / `--ok-s` / `--ok-sb` | `--ink-green-3` / `--surface-green-1` / `--outline-green-1` | Connected, Sent/Delivered/Read, Linked, Active |
| `--wn`, `--wn-i` / `--wn-s` / `--wn-sb` | `--ink-amber-3` / `--surface-amber-1` / `--outline-amber-1` | Paused, Held, Not Linked, Disconnected, Blocked |
| `--dg`, `--dg-i` / `--dg-s` / `--dg-sb` | `--ink-red-4` / `--surface-red-1` / `--outline-red-1` | Failed, Cancelled, Dead Letter, Logged Out, Blacklist, danger buttons |
| `--nf-*` (info, «الصادر المجدول») | `--ink-blue-3` / `--surface-blue-1` / `--outline-blue-1` | Scheduled, Queued, Sending, Pending QR |
| neutral badge (Draft, Inactive, Deleted, None) | `--ink-gray-6` / `--surface-gray-2` / `--outline-gray-2` | — |
| fonts `IBM Plex Sans Arabic`, `IBM Plex Mono` | Desk font stack (no custom font); numbers `font-variant-numeric: tabular-nums` | conventions §JS style |
| radius 8 / 12 / 999, spacing 4–24, border 1px | Espresso `--border-radius-md` / `--border-radius-lg` / `--border-radius-full`, `--padding-*`, `1px solid var(--outline-gray-1)` | — |
| `[data-theme="dark"]` values | automatic — Espresso redefines the same tokens in dark mode | ui.md |

## Findings

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F-01 | Every prototype button, tab, column, filter and modal maps to a §1 row or to §2 "not built" with a reference; 12 elements are not built (spec-justified), 9 need a Gap, 0 contradict the spec | §1B, §2 | No unassigned UI; Gate 1 only has to confirm the open questions |
| F-02 | `WhatsApp Notification Alert` placement (D-016 deferred to this phase): **third list under Templates**, same list/form pattern as Notifications — it carries recipients/report/device configuration like a Notification, and spec §5.7 forbids adding anything to Settings beyond presentation of the Single | 02 OQ-3, fields.md §22, spec §5.7 | Row 10c; workspace card «النماذج» has three entries; record as a decision at Gate 1 (OQ-8) |
| F-03 | Six prototype bulk actions have single-record APIs only: resend failed (4), campaign pause/resume/cancel (6), function update/status (7), command status (8), contacts link (12), numbers convert (13) | backend §4.4–4.10 vs `Outbound` 193, `Campaigns` 759–761, `Functions` 165–167, `Commands` 154–156, `Contacts` 209, `WhatsApp Contacts` 178 | `BulkActions` runs per-name loops with progress (Gap G-01); Queue is the only screen with native `names[]` bulk |
| F-04 | Native list views cannot show computed rank columns; Queue «#»/«الإرسال المتوقّع» come from `queue.list_queue` (rank ÷ rate) | fields.md §6 note, backend §4.5 | Summary ETA in ListStatsCard, per-row ETA in the Drawer; OQ-2 offers a page-level table alternative |
| F-05 | 10 of 17 rows are native list/form (4, 5, 6, 8, 9, 10a–c, 13, 14); 7 custom pages match the conventions slugs exactly; two rows are hybrids (3, 7) because the spec keeps a DocType behind the page | conventions §Naming, spec §2, §5.6 | No new page slugs; hybrids need a "no Desk New" list treatment |
| F-06 | Prototype pairs by QR only; spec requires QR **and** 8-digit code | `Devices` 184; spec §2 row 3; `devices.create_device(pairing_mode)` | PairingModal has both modes; the spec wins, no question needed |
| F-07 | Prototype creates campaigns through a 3-step wizard; spec fixes "Frappe DocType, Data tab + Contacts tab" | `Campaigns` 406–453; spec §2 row 6 | Wizard not built; the same three steps are the Campaign form's Recipients / Messages / Start-Schedule; spec §7.2 already defers the "wizard vs page" review for Onboarding only |
| F-08 | Home charts («حجم الرسائل» by status over time, «الفشل حسب نوع الخطأ») are expressible as native Dashboard Charts on `WhatsApp Outbound Message` | `Home` 163–180; fields.md §4 (`status`, `error_code`, `creation` indexed) | `DashboardBlock` with fixtures; `home.get_dashboard` serves only the KPI strip and live panels |
| F-09 | The Contacts page cannot use a native list or form: CU holds zero rows on `Contact` and must never see fields outside the declared sets | spec §4; backend §9 | Page-owned `frappe.DataTable` + Drawer form built from the declared field sets; every stat needs an API (Gap G-08) |
| F-10 | Three of the six realtime events the screens need are still *proposed* (`wa:campaign:status`, `wa:inbound:received`, `wa:pairing:status`) | backend §6, G-3 | Home live feed, Devices pairing, Inbound/Numbers/Contacts live rows and Campaign progress poll every 30 s until accepted (OQ-10) |
| F-11 | The prototype `Overlay Panel` demonstrates four drawer variants (form with tabs, record edit, delivery log, choice) — one `Drawer` with `mode` covers all four plus the conversation variant | `component/Overlay Panel` 400–499 | One component, five modes; conversation mode is the only one with realtime |
| F-12 | Prototype confirm dialogs always show impact counts + optional reason + acknowledgement checkbox (14 instances) | `Queue` 161–169, `Campaigns` 872–884, `Commands` 165–172, `Devices` 143–156, `Settings` 199–206 | `ConfirmDialog` becomes a kit component (Gap G-10); counts are always fetched, never hard-coded |

## Gaps

| # | Gap | Proposed home |
|---|---|---|
| G-01 | Bulk variants for `messages.resend`, `campaigns.pause/resume/cancel`, `functions.update/set_status`, `commands.set_status`, `contacts.update_contact` (link), `numbers.convert_number` | Additive `names[]`∣`keys[]`∣`rows[]` arguments in the same API modules (phase 3); until then `BulkActions.per_name` with progress and a selection cap |
| G-02 | Campaign «استثناء الأرقام التي ليس بيني وبينها محادثة» has no field; dispatch skips the known-number policy for Campaign source by design | OQ-1: `WhatsApp Campaign.exclude_unknown_numbers` (Check) applied in `campaign_runner.materialize`; interim: picker Selected tab shows `known_count` and lets the user drop unknown rows |
| G-03 | Multi-recipient send from Contacts (selected rows) and from a Contact Group («Bulk Send» component) — no multi-recipient send API and Outbound has no create permission | Client flow: `frappe.new_doc("WhatsApp Campaign")` → `picker.commit_add` with the selection → open the form (OQ-5) |
| G-04 | Simulator attachments toolbar; `simulator.send_test` takes `body` only | Additive args `message_type, attachment, caption, print_format` (same schema as `quick_send.send`); toolbar hidden until then (no dead buttons) |
| G-05 | Deleting an Active command must be refused server-side | `WhatsApp Command.on_trash` → `WAStateConflictError` (controller validation, phase 3) |
| G-06 | Contacts «سجل حالة المحادثة» — `Conversation Confirmed` audit rows are readable by SM/MGR only (`settings.list_audit_log`) | `numbers.get_conversation_log(phone_e164)` returning masked audit rows for the number (CU-readable); interim: show only the current value + `conversation_confirmed_by/at/note` |
| G-07 | Inbound stats «نسبة المطابقة», «متوسط زمن الردّ» | `messages.get_inbound_summary(filters)` (counts by `command_status`, avg `replied_at − received_at`); interim: counts via `frappe.client.get_count`, no average |
| G-08 | Contacts page summary (مربوط / غير مربوط / مرتبط بأكثر من حساب / نسبة التغطية) | `contacts.get_summary()` inside the permissions layer (declared fields only) |
| G-09 | Queue Drawer needs the linked Outbound's `reference_doctype/name`, `body`, `display_name`, and `amount` per row | `queue.list_queue` rows include `outbound{reference_doctype, reference_name, body_excerpt, amount}`; Drawer calls `messages.get_outbound(outbound_message)` on open |
| G-10 | Kit components not in the ui.md list but needed by ≥ 2 screens: `ConfirmDialog`, `PhoneField`, `PagedChildTable`, `ChatThread`, `TemplateEditor` | Add to the kit under the same portability rules (OQ-9) |
| G-11 | Devices disconnect/delete confirm counts (messages, notifications, campaigns by device) | Client `frappe.client.get_count` ×3 (VWR read on all three DocTypes) — no API needed |
| G-12 | Number Card / Dashboard Chart fixtures for Home and the Workspace | `fixtures/number_card.json`, `fixtures/dashboard_chart.json` (4 cards, 2 charts) |
| G-13 | "No Desk New" for hybrids (Devices, Functions) and modal-only Commands: `listview_settings` cannot remove the New button by itself | `onload`: `listview.page.clear_primary_action()` + own primary; form script on `frm.is_new()` redirects; controllers refuse direct inserts (3) / no create permission (7) |

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-01 | ContactPicker (XL) dominates phase effort and blocks Campaigns and Groups | Build order: shell + Selected + source 6 → 2 → 1 → 3 (Frappe FilterGroup reuse) → 4/5 last; Campaigns/Groups forms ship with sources 1/2/6 first |
| R-02 | Native list formatters get `doc` in Frappe 16, so progress bars work, but rank/ETA (Queue) and cross-DocType joins (Notification device status) do not | Queue: summary + Drawer (OQ-2); Notification stat via client join in ListStatsCard |
| R-03 | Modal-only Commands: `/app/whatsapp-command/new` stays reachable in Desk | Form script redirect on `is_new()`; native form read-only when Active; documented residual path |
| R-04 | Site-room realtime carries names/counters to every Desk user | Pages ignore events unless the user holds a WhatsApp role; drawer matching by `sha1(key)` (backend R-10) |
| R-05 | Campaign/Group forms with 10 k child rows load the whole grid | `PagedChildTable` hides the native grid (`frm.set_df_property(..., "hidden", 1)`) and pages through the API; grid never rendered |
| R-06 | CU without Viewer sees an empty «آخر الرسائل» tab on the Contacts page | Tab hidden when `messages.get_conversation` returns 403 (OQ-11) |
| R-07 | RTL in custom pages and drawers (`inline-end` slide, logical properties) regresses in LTR English | Every kit README shows both directions; CI screenshot of `wa-contacts` in ar/en |
| R-08 | Per-name bulk loops (G-01) on 200+ rows are slow and non-atomic | Selection capped at `page_length`; progress bar; server `names[]` variants in phase 3 |
| R-09 | Dashboard Chart / Number Card fixtures depend on Frappe's chart permissions (`Dashboard Chart` read) for VWR | Grant `Dashboard Chart` / `Number Card` read to the four roles in `fixtures/role.json` custom perms, or fall back to `home.get_dashboard` counts |
| R-10 | Espresso `.btn-primary` is dark gray, not the prototype teal; the owner may expect the prototype colour | Present at Gate 1 with a screenshot; ui.md forbids hard-coded colours, so any brand accent would be a Desk theme, not page CSS |

## Recommendations

| # | Recommendation |
|---|---|
| RC-01 | UI build order: kit basics (StatusBadge, Toast, EmptyState, ConfirmDialog, FilterBar, RowActions, BulkActions, ListStatsCard) → Drawer → QuickSend → native lists 4, 5, 9, 13 → Devices page → MetaDialog → Templates / Notifications / Alerts → Commands → ContactPicker + PagedChildTable → Groups → Campaigns → Functions Center → Contacts page → ChatThread + Simulator → DashboardBlock + Home → Settings → Onboarding last, redirect flag off |
| RC-02 | One `public/js/listview/<doctype>.js` and one `public/js/form/<doctype>.js` per DocType, registered via `doctype_list_js` / `doctype_js`; kit only in `whatsapp_next.bundle.js` (`app_include_js`) |
| RC-03 | Accept the three proposed realtime events at Gate 1 (OQ-10); where an event is missing, pages poll every 30 s and stop polling on `on_page_hide` |
| RC-04 | Phase 3 adds the `names[]` bulk variants (G-01) beside the single-name signatures; `BulkActions` switches from `per_name` to native automatically when the method accepts a list |
| RC-05 | Record at Gate 1 as decisions: Notification Alert = third list under Templates (F-02); Campaign wizard not built, form tabs replace it (F-07); Billing top-up/upgrade/invoice settings not rendered until platform A-01..A-04; Roles section and support ticket not built |
| RC-06 | Ship Number Card + Dashboard Chart fixtures (G-12) and reuse them on Home and the Workspace so there is one definition of "sent today" |
| RC-07 | Every custom page JSON declares `roles` per Matrix 1C; CU gets `wa-contacts` only; page JS checks `frappe.user.has_role` before subscribing to realtime |
| RC-08 | ListStatsCard counts come from `frappe.client.get_count` / aggregate `get_list` (permission-checked by Frappe) rather than new summary APIs, except where the permissions layer forbids it (Contacts, G-08) |

## Open questions (Gate 1 — never silently)

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| OQ-1 | Campaign «استثناء الأرقام التي ليس بيني وبينها محادثة»: add `WhatsApp Campaign.exclude_unknown_numbers` applied at materialize (G-02), or leave it to the picker's `known_count`? | Campaign form, materialize | Add the field, default 0 |
| OQ-2 | Queue per-row position/ETA: (a) native list + summary ETA + Drawer, or (b) page-level DataTable fed by `queue.list_queue` mounted inside the list view (same DocType, native filters kept)? | Queue (9) | (a) |
| OQ-3 | Inbound «أضفه كمرادف» on an Active command: blocked with hint (spec §5.5), or one client flow stop → save → start? | Inbound (5) | Blocked with hint (spec) |
| OQ-4 | Contact enable/disable («الجهة معطّلة», «سجل التفعيل والتعطيل»): extend `CONTACT_WRITE_FIELDS` with `status`, or not built? | Contacts (12) | Not built — §4 condition 1 keeps the write set fixed |
| OQ-5 | Bulk send from Contacts/Groups: Campaign-draft route (G-03), or a `quick_send.send_many` (≤ 50 recipients, audit `Bulk Send`)? | Contacts (12), Groups (14) | Campaign draft |
| OQ-6 | Billing actions (top-up, upgrade, invoice settings): not rendered until platform A-01..A-04, or rendered disabled with a note? | Settings (15) | Not rendered (ui.md: no dead buttons) |
| OQ-7 | Settings «الأدوار» section and shell «فتح تذكرة دعم»: not built (link to Role Permission Manager; no support API)? | Settings (15), Workspace | Not built |
| OQ-8 | Confirm Notification Alert placement as a third list under Templates (F-02; resolves 02 OQ-3) | Row 10c, workspace | Confirm |
| OQ-9 | Accept `ConfirmDialog`, `PhoneField`, `PagedChildTable`, `ChatThread`, `TemplateEditor` into the ui.md kit list (G-10)? | Kit scope | Yes, same portability rules |
| OQ-10 | Accept the proposed realtime events `wa:campaign:status`, `wa:inbound:received`, `wa:pairing:status` (backend G-3)? | Home, Devices, Inbound, Campaigns, Numbers, Contacts, Simulator | Accept; polling fallback otherwise |
| OQ-11 | CU without Viewer: hide the conversation tab/drawer (backend OQ-5 default "deny")? | Contacts (12) | Hide on 403 |
| OQ-12 | Commands native form: keep as read-only fallback with modal redirect on new/edit (R-03), or hide the form route entirely (not possible in Desk without a Page override)? | Commands (8) | Keep fallback, redirect on new |
| OQ-13 | Home charts as Dashboard Chart fixtures (F-08) require VWR read on `Dashboard Chart`/`Number Card` (R-09) — grant via fixtures, or serve series from `home.get_dashboard`? | Home (2), Workspace | Grant read via fixtures |
| OQ-14 | Primary button colour: Espresso `.btn-primary` (dark) vs prototype teal — accept Desk default (R-10)? | All pages | Accept Desk default |
