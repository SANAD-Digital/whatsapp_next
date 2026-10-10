# سجل الدين التقني — whatsapp_next

- **التاريخ:** 2026-10-10 (نتائج الحزمة الكاملة من تشغيل 2026-10-11 مضافة)
- **النطاق:** التطبيق `apps/whatsapp_next` على الفرع `claude/loving-euler-l9y9pj` بشجرة العمل الحالية غير المُودَعة، والموقع `whatsapp.dev.sanad.digital`، مع فحص للقراءة فقط على `pos.dev.sanad.digital`.
- **المرجع:** `.claude/rules/architecture.md` و`security.md` و`ui.md` و`layout.md`.
- **ما لم يُغيَّر:** لم يُعدَّل أي كود أو إعداد أو بيانات، ولم يُشغَّل migrate ولا build. هذا الملف هو الملف الوحيد الذي كُتب.

## الفحوص التي شُغّلت ونتائجها الخام

| الفحص | النتيجة |
|---|---|
| `ruff check whatsapp_next` (ruff 0.15.22 من `env/bin`) | **16 خطأ**: 10 `I001` (ترتيب الاستيرادات)، 3 `RUF059`، 2 `E731`، 1 `F811`. يُصلح 11 منها تلقائياً |
| `ruff format --check whatsapp_next` | **107 ملفات تحتاج إعادة تنسيق**، و164 ملفاً منسقة |
| `python -m py_compile` على كل ملفات `.py` | ناجح، ولا أخطاء صياغة |
| eslint / prettier | غير مثبتين محلياً، فلم يُشغَّلا |
| مسح الـ endpoints بـ AST (212 `@api_endpoint`) | كل دالة تفحص الأدوار أو تستدعي `permissions.require` أو `has_permission`. الـ guest endpoint الوحيد هو `webhooks/v1/receiver.py:161` |
| `frappe.db.sql` خارج الاختبارات | لا يوجد |
| استيراد وحدات المزوّد خارج `providers/` | لا يوجد إلا في `hooks.py` والاختبارات، وهذا مسموح |
| الترجمة: نصوص `__()`/`_()` غير الموجودة في `translations/ar.csv` ولا في ترجمات Frappe | JS: نصّان أو ثلاثة. Python: نحو 35 نصاً موجّهاً للمستخدم (المسح بتعبير نمطي، فهو تقريبي) |
| ألوان مكتوبة يدوياً خارج `_tokens.scss` | في 6 ملفات SCSS، وفي `public/js/desk/brand.js` |
| حزمة الاختبارات الكاملة (شغّلها المنسّق، 2026-10-11) | **591 اختباراً، 8 إخفاقات، 10 متخطاة**، في نحو 136 ثانية |
| حالة git | 196 مدخلاً في `git status`، منها 132 ملفاً معدّلاً (+5725/−1108) و118 ملفاً غير متتبَّع. لا يوجد أي إيداع |
| استعلامات قراءة فقط | على whatsapp.dev: `WhatsApp Log`=0، `Inbound`=0، `Webhook Event`=0، `Device`=1، `Number`=8، و`@@log_bin`=0. على pos.dev: العمود `group_name` غير موجود |

## الجدول الملخّص

| ID | الخطورة | المجال | العنوان | الجهد |
|---|---|---|---|---|
| WN-001 | حرجة | البيانات | حُذفت بيانات whatsapp.dev الحقيقية في 2026-10-10 ولم تُستعد | M |
| WN-002 | حرجة | الاختبارات | الاختبارات تعمل على موقع فيه بيانات حقيقية، وتعتمد عليها وتعدّلها | L |
| WN-003 | حرجة | الأمان/البيانات | تبديل الحساب يُعرف بمقارنة `customer_api_key`، ويحذف دون تأكيد ودون إخبار المستخدم | M |
| WN-004 | عالية | البيانات/الأداء | `purge_account_data` تحذف بـ `frappe.db.delete` داخل طلب تسجيل الدخول، دون hooks أو Deleted Document | M |
| WN-005 | عالية | الصحة/الأمان | `attachments._file_doc` تختار صف File عشوائياً من عدة صفوف بنفس `file_url`، فترفض إرسالاً مشروعاً | S |
| WN-006 | عالية | الخصوصية | ردود الأوامر تُرسل إلى كل أرقام جهة الاتصال متجاوزةً سياسة الأرقام المعروفة، ولا إعداد لإيقافها | S |
| WN-007 | عالية | النظافة | لا شيء مُودَع: فرق ضخم غير مُودَع، ومجلدات بديلة للـ fixtures غير متتبَّعة | M |
| WN-008 | عالية | النشر | pos.dev.sanad.digital لم يُرحَّل، وتنقصه الحقول والتغييرات الجديدة | S |
| WN-009 | متوسطة | الصحة | `History` ليس لها مقابل في مفردات المنصة (اختبار فاشل) | S |
| WN-010 | متوسطة | الاختبارات/المواصفة | ثلاثة اختبارات حقول فاشلة لأن الخطة والمواصفة لم تُحدَّثا بعد التغييرات | S |
| WN-011 | متوسطة | الواجهة | عدّة المكوّنات تكسر قاعدتي التوكنات والـ README (اختباران فاشلان)، ولوحة ألوان ثانية خارج `_tokens.scss` | S |
| WN-012 | متوسطة | البيانات | النسخة الاحتياطية بلا حملات، والاستيراد يستبدل بالاسم دون معاينة، ويُفعّل الإشعارات فوراً، والتدقيق باسم خاطئ | M |
| WN-013 | متوسطة | البنية التحتية | نُقل `developer_mode` إلى 28 ملف `site_config` على مستوى الـ bench | S |
| WN-014 | متوسطة | الامتثال | التسجيل لا يحفظ النشاط ولا قبول الشروط (`TODO(backend)`) | M |
| WN-015 | متوسطة | الترجمة | نحو 35 رسالة خطأ في Python ليس لها ترجمة عربية | S |
| WN-016 | منخفضة | الأداء | قراءات بلا حدّ وتجميع في Python في `get_throughput` و`get_overview` | S |
| WN-017 | منخفضة | جودة الكود | 16 خطأ ruff و107 ملفات غير منسقة، ودالة مساعدة مكررة | S |
| WN-018 | منخفضة | النظافة | `whatsapp_settings.json` أُعيد تسلسله بترتيب مختلف للمفاتيح، فصار الفرق مزعجاً | S |
| WN-019 | منخفضة | النظافة | سكربت `sudo` غير متتبَّع في جذر المستودع | S |
| WN-020 | منخفضة | التوثيق | 143 دالة عامة بلا docstring، أغلبها في المزوّدين | S |

---

## حرجة

### WN-001 — حُذفت بيانات whatsapp.dev الحقيقية ولم تُستعد
- **الوصف:** في 2026-10-10 شُغّل `tests/test_api_onboarding.py`، فاستدعى `onboarding.login` / `complete_signup`، وهاتان تستدعيان `_left_account`. هذه رأت مفتاحاً مختلفاً من المزوّد البديل، فاستدعت `services/backup.purge_account_data`، فحُذف ما يلي: devices 2، WhatsApp Log 9,475، Inbound 24,689، Numbers 1,824، Webhook Events 6,263، Queue 66، Number Checks 238، Status Posts 3.
- **الدليل:**
  - `whatsapp_next/services/onboarding.py:248-252` و`:334-336` و`:347-356`.
  - `whatsapp_next/services/backup.py:195-221`.
  - تعليق الحادثة نفسه موجود في `backup.py:200-202`.
  - استعلام اليوم: `WhatsApp Log`=0، `Inbound`=0، `Webhook Event`=0، `Device`=1.
  - `@@log_bin`=0.
  - آخر نسخة في `sites/whatsapp.dev.sanad.digital/private/backups` هي `20260930_052204-...database.sql.gz`.
  - ملاحظة: لا يوجد في `WhatsApp Audit Log` أي صف `account_switched`، أي أن صف التدقيق لم يبقَ والحذف بقي. أي عبارة أودعت الحذف (DDL ضمني أو `commit` داخل خدمة)؟ — **لم يُتحقق**.
- **الأثر:** ضاعت بيانات 10 أيام (من 30-09 إلى 10-10). لا يمكن الاسترجاع إلا من نسخة 30-09 أو من المنصة. والشاشات والاختبارات المعتمدة على البيانات تفشل (انظر WN-002).
- **الإصلاح المقترح:** الحماية بـ `frappe.flags.in_test` موجودة الآن (`backup.py:203`). يبقى ما يلي:
  1. قرار المالك: إما الاستعادة من نسخة 2026-09-30 إلى موقع منفصل ثم نسخ الجداول الثمانية، أو إعادة استيراد السجل من المنصة عبر `history_import` لكل جهاز.
  2. تفعيل نسخ احتياطي مجدول للموقع.
  3. توثيق الحادثة في `plan/decisions.md`.
- **الجهد:** M

### WN-002 — الاختبارات تعمل على موقع يحمل بيانات حقيقية
- **الوصف:**
  - كل الاختبارات `IntegrationTestCase` (84 صنفاً) وتعمل على `whatsapp.dev`، وهو موقع فيه بيانات تشغيل حقيقية.
  - بعضها يعتمد على تلك البيانات، وبعضها يكتب عليها.
  - حماية الحذف في `test_backup` تقوم على `patch.object(frappe.db, "delete")` مع `wa_allow_purge=True`. لو تغيّر تنفيذ الحذف (مثلاً إلى `frappe.qb`) لحُذفت البيانات الحقيقية من جديد.
- **الدليل:**
  - `tests/test_api_simulator.py:200-226`: الاختبار `test_conversations_read_in_a_fixed_number_of_queries` يتطلب أكثر من محادثة موجودة في الموقع، وفشل بـ "0 not greater than 1" بعد حذف WN-001.
  - `tests/test_backup.py:61-80`: الـ purge مفعّل والحماية هي الـ patch وحده.
  - `tests/test_backup.py:42-54`: يصدّر **كل** قوالب وإشعارات وأوامر الموقع الحقيقية ثم يعيد استيرادها، فيعيد حفظها (`backup.py:150-155`).
  - `tests/test_api_templates.py:113`: يحذف كل `Property Setter` على `ToDo.description.permlevel` دون أن يتحقق أنه هو من أنشأه.
- **الأثر:** نتائج اختبارات غير حتمية، وخطر متكرر على البيانات، و`modified` يتغير على سجلات حقيقية.
- **الإصلاح المقترح:**
  - موقع اختبار مخصص (مثلاً `test.whatsapp.dev`) فيه `allow_tests` ولا بيانات حقيقية.
  - الاختبار المعتمد على البيانات يُنشئ بياناته في `setUp`.
  - استيراد النسخة في الاختبار يقتصر على سجلاته.
  - حماية الـ purge تكون بفحص على اسم الموقع، لا بالـ patch وحده.
- **الجهد:** L

### WN-003 — هوية الحساب تُبنى على مفتاح قابل للتدوير، والحذف صامت
- **الوصف:**
  - "حساب آخر" يُقرَّر بمقارنة `customer_api_key` قبل حفظ المفاتيح وبعده.
  - لو دوّرت المنصة مفتاح الربط، فإعادة تسجيل الدخول **لنفس الحساب** تحذف كل الأجهزة والرسائل.
  - المنصة تُرجع `customer` في نتيجة `login` (`onboarding.py:339`)، لكنه لا يُخزَّن ولا يُقارن.
  - لا يوجد أي تأكيد قبل الحذف، ولا رسالة بعده: `account_switched` لا يقرؤه أي ملف JS في المصدر.
  - المسار اليدوي لإدخال المفاتيح لا يستدعي `_left_account` أصلاً، فالسلوك غير متسق. إدخال مفاتيح حساب آخر يدوياً يُبقي أجهزة الحساب القديم ورسائله.
- **الدليل:**
  - `services/backup.py:187-192`: `account_key` مع docstring "stable per account". ثبات المفتاح افتراض لم يُوثَّق من المنصة — **لم يُتحقق**.
  - `services/onboarding.py:334-343` و`:347-356`.
  - `public/js/screens/settings.js:557`: `onboarding.save_credentials` دون purge.
  - `grep account_switched public/js` (باستثناء `dist`): لا نتائج.
- **الأثر:** حذف لا رجعة فيه يمكن أن يقع بإجراء روتيني من جهة المنصة، والمستخدم لا يعرف أنه حدث.
- **الإصلاح المقترح:**
  1. تخزين معرّف عميل ثابت من المنصة (`platform_customer`) في Settings والمقارنة به.
  2. عند اختلاف الحساب: نافذة `ConfirmDialog` تعرض الأعداد التي ستُحذف وتقترح التصدير أولاً، والحذف لا يتم إلا بموافقة صريحة.
  3. توحيد المسار اليدوي مع مسار تسجيل الدخول.
- **الجهد:** M

## عالية

### WN-004 — آلية الحذف: `frappe.db.delete` داخل طلب تسجيل الدخول
- **الوصف:**
  - `purge_account_data` تُفرغ ثمانية جداول بـ `frappe.db.delete(doctype)` دون فلتر. لا تعمل `on_trash`، ولا يُنشأ `Deleted Document`، ولا تدقيق لكل صف، ولا تُنظَّف ملفات `File` المرتبطة.
  - التنفيذ متزامن داخل طلب تسجيل الدخول، وعلى جداول بعشرات الآلاف من الصفوف قد يتجاوز مهلة gunicorn.
  - صف التدقيق الوحيد يُكتب في نفس المعاملة.
- **الدليل:**
  - `services/backup.py:209-218`.
  - صفوف `File` المرفقة بـ `WhatsApp Log` محذوف ما زالت موجودة: مثلاً `0c029a1a55` المرفق بـ `WhatsApp Log ri6uu9joaq`. هي السبب في WN-005.
- **الأثر:** ملفات يتيمة، ولا إمكانية تراجع، وخطر انتهاء المهلة أثناء الحذف.
- **الإصلاح المقترح:**
  - نقل الحذف إلى `frappe.enqueue(queue="long")` بعد تأكيد المستخدم.
  - الحذف على دفعات مع `commit` لكل دفعة.
  - حذف ملفات `File` المرتبطة.
  - كتابة صف تدقيق مستقل قبل البدء.
- **الجهد:** M

### WN-005 — `_file_doc` تختار صف File غير محدد عند تكرار `file_url`
- **الوصف:**
  - Frappe يعيد استخدام `file_url` لصفوف `File` متعددة.
  - `_file_doc` تأخذ أول صف يطابق `file_url` دون ترتيب ولا تفضيل، ثم تفحص `has_permission` عليه.
  - إن وقع الاختيار على نسخة مرفقة بسجل محذوف أو بسجل لا يقرؤه المستخدم، يُرفض إرسال مشروع.
  - هذا سبب فشل `tests/test_api_testlab.py::test_image_uses_the_apps_sample_file`: "Not permitted to send file /private/files/wa-test-lab-sample.png".
- **الدليل:**
  - `services/attachments.py:77-82` (`_file_doc`) و`:85-90` (`require_readable`).
  - `services/testlab.py:706-723`: `sample_file` يبحث بالمرفق، لكن `require_readable` يبحث بالرابط.
  - في قاعدة البيانات توجد أربعة صفوف لملفَّي العيّنة: `270f4a719c` مرفق بـ `WhatsApp Settings`، و`0c029a1a55` مرفق بـ `WhatsApp Log` محذوف (ونفس الشيء لملف pdf).
- **الأثر:** رفض عشوائي لإرسال ملفات صالحة في Test Lab والإرسال السريع والحملات.
- **الإصلاح المقترح:** في `require_readable`، تُعتبر الصلاحية متحققة إذا كان **أي** صف `File` بنفس `file_url` مقروءاً للمستخدم. أو يُمرَّر اسم صف `File` بدل الرابط.
- **الجهد:** S

### WN-006 — ردود الأوامر تذهب إلى كل أرقام جهة الاتصال
- **الوصف:**
  - `_send_replies` ترسل كل رد إلى رقم السائل، ثم إلى كل رقم WhatsApp آخر مسجل لجهة الاتصال (قرار المالك 2026-10-08).
  - لا إعداد لإيقاف ذلك.
  - كل الردود تُبنى بـ `skip_policy=True`، فتتجاوز سياسة `send_only_to_known_numbers` حتى للأرقام الإضافية.
  - الرقم الإضافي المحظور يُتخطى بصمت (`except frappe.ValidationError: continue`) دون أي سجل.
  - الإرسال الفوري (`IMMEDIATE_OUTPUTS`) يتم متزامناً لكل رقم.
- **الدليل:** `services/command_router.py:670-688` و`:691-745` (`skip_policy=True` في `:722`، والتخطي الصامت في `:733-738`، والإرسال المتزامن في `:740-741`)، و`services/dispatch.py:250-257`.
- **الأثر:**
  - كشف بيانات حساسة (كشف حساب، فواتير) لأرقام لم تطلبها، وقد يكون أحدها رقماً قديماً لدى شخص آخر.
  - تكلفة الرسائل وحدود الإرسال تتضاعف.
  - صعوبة في تشخيص الأرقام التي لم يصلها الرد.
- **الإصلاح المقترح:**
  - إعداد في Settings، ومعه حقل في `WhatsApp Command` لنطاق الرد (`السائل فقط` / `كل أرقام جهة الاتصال`).
  - احترام سياسة الأرقام المعروفة للأرقام الإضافية.
  - تسجيل التخطي في الـ Log أو التدقيق.
- **الجهد:** S

### WN-007 — لا شيء مُودَع
- **الوصف:** كل عمل الجلسات الأخيرة غير مُودَع على `claude/loving-euler-l9y9pj`. يشمل ذلك:
  - خدمات جديدة كاملة: `backup` و`command_menu` و`history_import` و`status_posts` و`testlab` و`wa_groups` وغيرها.
  - واجهات `api/v1` جديدة: `number_check` و`status_posts` و`testlab` و`wa_groups`.
  - نقل الـ fixtures إلى مجلدات Frappe الأصلية: `custom_field.json` و`dashboard_chart.json` و`number_card.json` محذوفة، والبدائل `whatsapp_next/whatsapp_next/custom/` و`number_card/` و`dashboard_chart/` **غير متتبَّعة**.
- **الدليل:** `git status --short` يعطي 196 مدخلاً. `git diff --stat HEAD` يعطي 132 ملفاً (+5725/−1108)، و`git ls-files --others` يعطي 118 ملفاً. محتوى البدائل يطابق المحذوف: `Contact Phone-wa_phone_e164`، و4 Number Cards، و2 Dashboard Charts.
- **الأثر:**
  - خطر فقدان العمل.
  - لا مراجعة ممكنة.
  - إيداع جزئي (الحذف دون المجلدات الجديدة) يُسقط الحقل المخصص وبطاقات اللوحة عند الترحيل على المواقع الأخرى.
- **الإصلاح المقترح:** إيداعات صغيرة متتالية حسب المجال، يكون فيها نقل الـ fixtures والمجلدات البديلة في إيداع واحد، ثم PR إلى `main`.
- **الجهد:** M

### WN-008 — pos.dev.sanad.digital غير مُرحَّل
- **الوصف:** الحقول الجديدة غير موجودة على pos.dev: `WhatsApp Inbound Message.group_name` و`WhatsApp Settings.import_past_messages`، وكذلك تغييرات الشريط الجانبي والترتيب.
- **الدليل:**
  - على pos.dev: `show columns from tabWhatsApp Inbound Message like 'group_name'` لا يعيد شيئاً.
  - `tabDocField` لا يحتوي `import_past_messages` ولا `group_name`.
  - الحقول معرفة في `whatsapp_settings.json`، وفي الفرق يظهر `import_past_messages` ضمن `field_order`.
  - تغييرات الشريط والترتيب على pos.dev — **لم يُتحقق** منها مباشرة.
- **الأثر:** الكود المشترك في الـ bench يقرأ أعمدة غير موجودة على pos.dev، فتظهر أخطاء `Unknown column` عند استقبال رسائل المجموعات وفي شاشة الإعدادات.
- **الإصلاح المقترح:** `bench --site pos.dev.sanad.digital migrate`، بقرار من المالك (الترحيل لا يُشغَّل دون طلب).
- **الجهد:** S

## متوسطة

### WN-009 — مصدر `History` بلا مقابل في مفردات المنصة
- **الوصف:**
  - `history_import` يكتب `source_type="History"`، وهذا الخيار موجود في `WhatsApp Log.source_type`.
  - لكن `SndPlatformProvider.PLATFORM_SOURCE_TYPES` لا يحتوي عليه، فيسقط إلى `"External API"`.
  - الاختبار `test_every_client_source_maps_to_platform_vocabulary` فاشل من قبل هذه المراجعة.
- **الدليل:** `providers/snd_platform.py:741-750` و`:760`، و`whatsapp_log.json:428`، و`services/history_import.py:309`، و`tests/test_snd_platform.py:476-483`.
- **الأثر:** صغير، لأن صفوف History لا تُرسل عادة. لكن الاختبار أحمر دائماً، وهذا يُخفي أي إخفاق جديد.
- **الإصلاح المقترح:** يُضاف `"History"` بقيمة موجودة في مفردات المنصة. أو يستثنيه الاختبار صراحةً لأنه لا يُرسل أبداً.
- **الجهد:** S

### WN-010 — اختبارات الحقول متأخرة عن المواصفة (3 إخفاقات)
- **الوصف:** الاختبارات في `tests/test_fields_group_a.py` تقارن الـ DocTypes بالخطة، والخطة لم تُحدَّث بعد تغييرات مقصودة:
  - `test_every_field_exists_with_type_and_options`: `message_type` أصبح فيه `Buttons\nList`.
  - `test_naming_and_flags`: `sort_field` أصبح `modified`، وهذا قرار المالك للترتيب الافتراضي، والخطة ما زالت تتوقع `creation`.
  - `test_no_unplanned_value_fields`: حقول جديدة مثل `group_name` و`import_past_messages` غير مذكورة في الخطة.
- **الدليل:** نتيجة الحزمة 2026-10-11، و`tests/test_fields_group_a.py`.
- **الأثر:** الخطة لم تعد مرجعاً موثوقاً، والإخفاقات الدائمة تخفي التراجعات الحقيقية.
- **الإصلاح المقترح:** تحديث خطة الحقول (`plan/`) والبيانات التي يقرؤها الاختبار، مع تسجيل القرارات في `plan/decisions.md`. الاختبار نفسه سليم.
- **الجهد:** S

### WN-011 — قواعد عدّة المكوّنات والتوكنات (اختباران فاشلان)
- **الوصف:**
  - `GroupCreate/README.md` ليس فيه قسم `## Live use`، فيفشل `test_every_component_is_complete`.
  - `ChatThread/style.scss` فيه ألوان احتياطية مكتوبة يدوياً، فيفشل `test_kit_uses_only_espresso_tokens_and_logical_properties`.
  - إضافة إلى ذلك، توجد لوحة ألوان ثانية (`--sanad-accent*`، `--sanad-chart-palette`) معرفة خارج `_tokens.scss`، وألوان العلامة مكتوبة في JS.
- **الدليل:**
  - `public/js/ui/GroupCreate/README.md`: لا قسم `## Live use`، والاختبار في `tests/test_kit_portability.py:82`.
  - `public/js/ui/ChatThread/style.scss:131,134,140,145,158,178,214,233,276`: مثلاً `#53bdeb` و`#16a34a`.
  - `public/scss/whatsapp_next.bundle.scss:33-49`.
  - `public/js/desk/brand.js:13-15`.
  - `#fff` يتكرر في `public/scss/screens/_campaign_builder.scss:387,641,695,696,974,1407,1596` و`_onboarding.scss:120,134,229`.
- **الأثر:** خرق `ui.md` ("`_tokens.scss` هو المكان الوحيد للون")، والوضع الداكن غير متسق.
- **الإصلاح المقترح:**
  - إضافة قسم Live use إلى README.
  - نقل ألوان العلامة ولوحة المخططات إلى `_tokens.scss` كـ `--wa-*`.
  - استبدال `#fff` بـ `var(--wa-on-pri)` أو ما يقابله.
  - حذف القيم الاحتياطية المكتوبة يدوياً.
- **الجهد:** S

### WN-012 — ثغرات النسخ الاحتياطي والاستيراد
- **الوصف:**
  1. النسخة لا تشمل `WhatsApp Campaign`. `DOCTYPES` فيها ستة أنواع فقط.
  2. الاستيراد يستبدل كل سجل له نفس الاسم (`doc.update` + `save(ignore_permissions)`)، دون تشغيل تجريبي ولا معاينة للفرق.
  3. الإشعارات والتنبيهات المستوردة تحتفظ بـ `enabled`، فتبدأ بالإرسال على الموقع الجديد فوراً.
  4. الحقول تُقبل من الملف دون قائمة سماح (باستثناء حقول الجهاز)، وهذا خلاف "Never accept a field name from the client" في `security.md`. الخطر محدود لأن الاستيراد يتطلب `System Manager`.
  5. التصدير متاح لـ `WhatsApp Manager`، ويشمل أرقام أعضاء المجموعات (بيانات شخصية)، ويُسجَّل في التدقيق كـ `Settings Changed`.
  6. التصدير يقرأ كل المجموعات بأعضائها في الذاكرة داخل الطلب.
- **الدليل:**
  - `services/backup.py:29-36` (`DOCTYPES`)، و`:96-109` (التصدير)، و`:142-162` (الاستبدال).
  - `api/v1/settings.py:369-376` (`export_backup`: `roles=MANAGER`، والتدقيق باسم "Settings Changed").
  - حقل `enabled` في `whatsapp_notification.json:65` و`whatsapp_notification_alert.json:56`.
- **الأثر:** استعادة ناقصة، واستبدال غير مقصود لإعدادات قائمة، وإرسال غير متوقع بعد الاستيراد.
- **الإصلاح المقترح:**
  - وضع `dry_run` يُرجع created/updated/conflicts قبل التنفيذ.
  - تعطيل الإشعارات والتنبيهات المستوردة افتراضياً.
  - قائمة حقول مسموحة لكل DocType من الـ meta.
  - إجراء تدقيق مستقل (`Backup Exported`/`Backup Imported`).
  - قرار صريح بشأن الحملات.
  - التصدير في `enqueue` عند الحجم الكبير.
- **الجهد:** M

### WN-013 — `developer_mode` منقول إلى ملفات المواقع
- **الوصف:** لإصلاح مصادقة socket.io، أُزيل `developer_mode` من `common_site_config.json` وأُضيف إلى ملفات المواقع. النسخة الوحيدة من الإعداد القديم موجودة في scratchpad.
- **الدليل:** `grep -c developer_mode sites/common_site_config.json` يعطي 0، و`grep -l '"developer_mode"' sites/*/site_config.json` يعطي **28** ملفاً. العدد المذكور سابقاً 27، والفرق قد يكون موقعاً كان مفعّلاً عليه من قبل — **لم يُتحقق**.
- **الأثر:** تغيير على مستوى الـ bench خارج المستودع، دون توثيق ولا نسخة دائمة. موقع جديد يُنشأ لاحقاً لن يرث الوضع، والسبب الجذري لمشكلة socket.io لم يُعالج.
- **الإصلاح المقترح:** توثيق التغيير وسببه في `developer-docs/troubleshooting.md`، وحفظ نسخة من الإعداد القديم خارج scratchpad، وفتح مهمة للسبب الجذري.
- **الجهد:** S

### WN-014 — التسجيل لا يحفظ النشاط ولا قبول الشروط
- **الوصف:** معالج التسجيل يجمع النشاط وقبول الشروط، ولا يحفظ أياً منهما. هذا مؤشَّر بـ `TODO(backend)`.
- **الدليل:** `whatsapp_next/page/wa_onboarding/wa_onboarding.js:22` و`:57` و`:1068`.
- **الأثر:** لا دليل على قبول المستخدم للشروط، وهذه فجوة امتثال.
- **الإصلاح المقترح:** حقل على المنصة، أو صف تدقيق محلي بالمستخدم والوقت ونسخة الشروط، ويُرسل عند `complete_signup`.
- **الجهد:** M

### WN-015 — رسائل Python بلا ترجمة عربية
- **الوصف:** نحو 35 نصاً في `_()` غير موجود في `translations/ar.csv` ولا في ترجمات Frappe، وأغلبها رسائل تحقق تصل للمستخدم.
- **الدليل:**
  - `services/interactive.py:38,51,61,65,67,80,88,92,96,99,116`.
  - `services/commands.py:131,150,158,161,214`.
  - `whatsapp_next/doctype/whatsapp_command/whatsapp_command.py:124,131,138,145,150`.
  - `services/onboarding.py:318`، و`services/alerts_editor.py:301`، و`services/attachments.py:91`، و`api/v1/simulator.py:38`.
  - في JS: `public/js/ui/ContactPicker/sources/manual.js:36` و`public/js/ui/RowActions/index.js:68`.
  - المسح بتعبير نمطي ولا يلتقط النصوص متعددة الأسطر.
- **الأثر:** رسائل إنجليزية داخل واجهة عربية.
- **الإصلاح المقترح:** `bench get-untranslated ar` ثم إكمال `ar.csv`، وإضافة اختبار يقارن النصوص بالملف.
- **الجهد:** S

## منخفضة

### WN-016 — قراءات بلا حدّ وتجميع في Python
- **الوصف:** `queue.get_throughput` يحمّل كل صفوف `Completed` في آخر 180 دقيقة كحد أقصى (`limit_page_length=0`) ثم يعدّها في Python. `campaigns` يحمّل كل حملات الفترة ويجمع العدادات في Python. `notifications_editor` يحمّل كل DocTypes.
- **الدليل:** `api/v1/queue.py:149-162`، و`api/v1/campaigns.py:208-224`، و`services/notifications_editor.py:414-420`. التجميع في الحالتين الأوليين يتم داخل `api/`، خلافاً لقاعدة "No business logic in api/".
- **الأثر:** حمل خطي مع حجم الإرسال، ومنطق في طبقة الـ API.
- **الإصلاح المقترح:** `frappe.qb` مع `GROUP BY` (على الدقيقة) أو `Sum`، ونقل التجميع إلى `services/`.
- **الجهد:** S

### WN-017 — ruff: أخطاء وتنسيق
- **الوصف:**
  - 16 خطأ lint، منها:
    - `F811`: `api/v1/settings.py:378` يستورد `audit` مرة ثانية داخل الدالة، وهو مستورد أصلاً في `:19`.
    - `E731` في `providers/snd_platform.py:950`: الـ lambda `digits` تكرر الدالة `_digits` الموجودة في نفس الملف (`:768`).
    - `RUF059` في `tests/test_command_menu.py:121` و`tests/test_command_sessions.py:82,102`.
  - 107 ملفات غير منسقة حسب `ruff format`.
- **الدليل:** مخرجات `env/bin/ruff check --statistics` و`ruff format --check`.
- **الأثر:** فروق مزعجة عند أول تنسيق، وتكرار صغير في الكود.
- **الإصلاح المقترح:** `ruff check --fix` ثم `ruff format` في إيداع مستقل بعد إيداع العمل الحالي (WN-007)، وإضافة pre-commit.
- **الجهد:** S

### WN-018 — `whatsapp_settings.json` أُعيد تسلسله
- **الوصف:** فرق الملف يخلط إضافة حقول حقيقية مع إعادة ترتيب المفاتيح داخل التعريفات، مثل ظهور `"default"` قبل غيره.
- **الدليل:** `git diff --stat` على `whatsapp_next/whatsapp_next/doctype/whatsapp_settings/whatsapp_settings.json` يعطي 147+/10−.
- **الأثر:** المراجعة أصعب، واحتمال تعارضات دمج.
- **الإصلاح المقترح:** إعادة الحفظ من Desk (DocType editor) حتى يعود تنسيق Frappe القياسي، أو فصل إعادة الترتيب في إيداع خاص.
- **الجهد:** S

### WN-019 — سكربت `sudo` غير متتبَّع في جذر المستودع
- **الوصف:** الملف `.codex-ssh-stability-setup.sh` (3 KB، تاريخه 3 أكتوبر) يتطلب `sudo` ولا علاقة له بالتطبيق.
- **الدليل:** `git status` (`??`)، والسطر 4 من الملف: `if [[ ${EUID} -ne 0 ]]`.
- **الأثر:** خطر إيداعه بالخطأ مع `git add -A`.
- **الإصلاح المقترح:** نقله خارج المستودع، أو إضافته إلى `.gitignore`.
- **الجهد:** S

### WN-020 — دوال عامة بلا docstring
- **الوصف:** 143 دالة عامة بلا docstring. أغلبها تنفيذات `BaseProvider` في `providers/snd_platform.py` (41) و`providers/meta_cloud.py` (39)، وتوثيقها موروث من `base.py`. والباقي في `services/functions_catalog.py` (7) و`services/command_sessions.py` (4) و`services/campaign_runner.py` (4) وغيرها.
- **الدليل:** مسح AST، مثلاً `services/command_sessions.py:103,108,118,122` و`services/campaign_runner.py:71,179,227,535`.
- **الأثر:** خلاف بسيط مع "Every public function has a docstring" في `architecture.md`.
- **الإصلاح المقترح:** docstrings للخدمات، واستثناء تنفيذات المزوّد الموثقة في `base.py` بتوثيق القاعدة.
- **الجهد:** S

---

### ما فُحص ولم يظهر فيه دين
- لا `frappe.db.sql` خارج الاختبارات.
- لا استيراد لوحدات المزوّد خارج `providers/` و`hooks.py`.
- كل endpoint يفحص الصلاحيات.
- `order_by` القادم من العميل محصور بقائمة (`services/permissions.py:374-376`، `api/v1/campaigns.py:309-311`).
- مستقبل الـ webhook يتحقق من HMAC وحداثة الطلب، ويحدّ المعدل، ويستخدم `enqueue`.
- رسائل `log_error` لا تحمل أجسام الرسائل.
