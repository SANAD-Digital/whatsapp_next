# الأوامر والدوال في whatsapp_next — كيف تعمل حالياً

> هذا وصف للكود كما هو اليوم (2026-10-13)، تطبيق Frappe اسمه `whatsapp_next`.
> المثال الحي من موقع التطوير `whatsapp.dev.sanad.digital`.

## 1. الفكرة باختصار

يرسل شخص رسالة واتساب إلى رقم الشركة، مثل «رصيد» أو «كشف 6». النظام يتعرّف على الأمر ويتحقق من
صلاحية المرسل. بعدها يشغّل **دالة**، وهي **Server Script** في Frappe تقرأ البيانات من ERPNext وتُرجع
الرسائل الجاهزة، ثم يتحقق الراوتر من الرسائل ويرسلها إلى المرسل.

ثلاث طبقات:

| الطبقة | ما هي | أين |
|---|---|---|
| **سكربت الدالة** | `Server Script` من نوع API، اسم الـ API Method فيه يبدأ بـ `wa_fn_`، مفعّل، وفي أعلاه ترويسة `WA-FUNCTION` تصف المدخلات والرسائل | سجلات `Server Script` على الموقع (نسخها في المستودع: `scripts/functions/wa_fn_*.py`) |
| **الدالة المثبّتة** `WhatsApp Function` | ربط بالسكربت، ونسخة من الترويسة كما ثُبّتت، وقيم الموقع لمدخلاتها | DocType |
| **الأمر** `WhatsApp Command` | الكلمة التي يكتبها المرسل، وتربطه بدالة مع قواعد الوصول وتخصيص المدخلات والنصوص | DocType |

دالة واحدة يمكن أن يستخدمها أكثر من أمر، ولكل أمر كلمته وصلاحياته وقيمه ونصوصه. مثال: الأمران
«عملاء» و«موردين» يستخدمان الدالة نفسها `party_trial_balance`، وكل واحد يثبّت `party_type` بقيمة مختلفة.

لا توجد دوال Python في التطبيق، ولا ملفات `catalog.json`، ولا hooks لتسجيل الدوال. كل دالة سكربت على الموقع.

---

## 2. الدوال (Functions)

### 2.1 ما الذي يجعل Server Script دالة

`services/functions_catalog.py` يعتبر السكربت دالة إذا تحققت كل الشروط:

- `script_type = "API"`.
- `api_method` يبدأ بـ `wa_fn_` (الثابت `function_header.API_PREFIX`).
- `disabled = 0`.
- في أعلى السكربت ترويسة `WA-FUNCTION` صالحة (القسم 2.2).

القراءة (`discover`) تُخزَّن في الكاش `wa:functions:scripts` حسب `name + modified`. حفظ أي `Server Script`
أو حذفه يمسح هذا الكاش (doc_event في `hooks.py` ← `functions_catalog.clear_cache`). إذا عرّف سكربتان
الـ `@function` نفسه، يُعلَّم الاثنان بخطأ ولا يمكن تثبيت أي منهما.

### 2.2 الترويسة `WA-FUNCTION`

المحلّل في `services/function_header.py` (`parse_function_header`). الترويسة أسطر تعليق بين سطر فيه
`WA-FUNCTION` وسطر فيه `END WA-FUNCTION`. كل سطر بينهما يجب أن يكون تعليقاً (`#`). السطر الفارغ يُتجاهل،
والسطر الذي يبدأ بـ `-` فاصل أقسام. أي خطأ يرجع برسالة فيها رقم السطر.

| الوسم | الصيغة | المعنى |
|---|---|---|
| `@function` | `@function party_balance` | مفتاح الدالة، وهو اسم سجل `WhatsApp Function`. **إلزامي** |
| `@title` | نص | الاسم الظاهر |
| `@version` | `2.2.0` | يُحفظ في `installed_version` |
| `@description` | نص | الوصف |
| `@party_types` | `all` أو `all except Supplier, Employee` أو `Customer, Supplier` | أنواع الأطراف التي تخدمها الدالة. الافتراضي `all` |
| `@requires` | `report \| <اسم>` أو `doctype \| <اسم>` أو `app \| <اسم>` | شرط لظهور الدالة على الموقع: تقرير موجود وغير معطّل، DocType موجود، تطبيق مثبّت. يتكرر |
| `@param` | `name \| fieldtype[:options] \| required/optional \| خيارات \| label` | مدخل. خمسة أعمدة بالضبط |
| `@options` | `@options timespan \| this year, last year, select date range` | قيم مدخل من نوع `Select` (إلزامي له) |
| `@default` | `@default msg_result` أو `@default msg_result ar` ثم أسطر تبدأ بـ `> ` | النص الافتراضي لمدخل، ولغة اختيارية. كل سطر `> ` سطر في النص |
| `@var` | `name \| all أو msg_a, msg_b \| الوصف` | قيمة يمكن استخدامها في قوالب الرسائل `{{ name }}`، ولأي قالب. بعمودين تعني `all` |
| `@reply` | `key \| text \| \| label` أو `key \| report \| report=General Ledger, format=PDF \| label` | رسالة يمكن أن ترسلها الدالة. أي رسالة غير معلنة هنا تُفشل التشغيل |

**أنواع المدخلات**: `Link` و `Dynamic` و `Date` و `Check` و `Int` و `Data` و `Select` و `Template`.
`Link:Company` يتحقق من وجود السجل. `Dynamic:party_type` يأخذ نوعه من مدخل آخر.

**خيارات `@param`** (العمود الرابع، `key=value` مفصولة بفواصل):

- `source=sender` أو `source=command` (الافتراضي). مدخلات `sender` **تُملأ من الـ Contact فقط**:
  `party_type` و `party` من روابط الـ Contact الخاص بالمرسل. لا يمكن أن تأتي من نص الرسالة، ولا من الأمر،
  ولا من قيم الموقع.
- `default=...`: قيمة ثابتة، أو رمز: `@default_company`، `@current_fiscal_year`، `@system_language`،
  `@param:<اسم>`. للتاريخ كلمات: `today` / `اليوم`، `yesterday` / `أمس`، `week_start`، `month_start`،
  `year_start`، `-7d`.
- `depends_on=<مدخل>:<قيمة>`: المدخل لا يُستخدم إلا إذا كانت قيمة المدخل المذكور (المعلَن قبله) هي هذه القيمة.

**مدخلات `Template`** قوالب Jinja للرسائل. لا يكتبها المرسل أبداً. النص الافتراضي من `@default <param> <lang>`،
وإلا من `@default <param>`.

### 2.3 عقد التشغيل — `services/function_runner.py`

```
function_runner.run_function(server_script, params, spec)
   └─ frappe.utils.safe_exec.run_script(server_script, **params, cmd=None)
        المدخلات: frappe.form_dict بأسماء @param (كل مدخل في الترويسة موجود، و None إذا كان فارغاً)
        المخرجات: frappe.flags.wa_result = {"error": str|None, "messages": [...], "data": {...}}
```

- الدالة **ترجع رسائل جاهزة فقط ولا ترسل شيئاً**. الإرسال من عمل الراوتر.
- `error` نص فشل متوقَّع يُرسل للمرسل كما هو، مثل «رقمك غير مرتبط بحساب لدينا».
- `data` للسجل وللتجربة فقط.
- شكل الرسالة:
  - نص: `{"reply": "result_text", "type": "text", "text": "..."}`
  - تقرير: `{"reply": "statement_pdf", "type": "report", "report_name": "General Ledger", "filters": {...}, "format": "PDF", "file_name": "...", "caption": "..."}`.
    `report_name` يجب أن يطابق المعلَن في `@reply`. `format` إما `PDF` أو `Excel`.
- `function_header.validate_messages` يتحقق من كل رسالة: معلنة في `@reply`، والنص غير فارغ، والتقرير هو
  المعلَن. أي خطأ يُفشل التشغيل كله ولا يُرسل شيء. الردود التي عطّلها الأمر (`disabled_replies`) تُحذف بصمت.
- إذا رمى السكربت استثناءً، أو لم يضع `wa_result`، يصل المرسل النص العام «Could not complete the request.»
  ويُسجَّل الخطأ في Error Log بعنوان `WhatsApp function <script> failed`.
- رسالة `report` تُطبع في `services/report_file.py` (`render_report_file`): يُشغَّل التقرير
  (`frappe.desk.query_report.run`) باسم مستخدم الخدمة، ويُحوَّل إلى جدول PDF (من اليمين لليسار إذا كانت لغة
  الرد عربية) أو ملف Excel، ويُحفظ ملفاً خاصاً ويُرسل كمستند مع `caption`. فشل الطباعة يرسل النص العام بدلاً منه.

### 2.4 قيم التشغيل — من أين تأتي

`function_runner.prepare(command, sender, given)` ← `merged_values` ← `function_header.build_params`.
الأولوية لكل مدخل من نوع `command`:

1. ما كتبه المرسل (`parse_args`، أو أجوبة الأسئلة).
2. `settings_overrides` في الأمر. المدخل المثبَّت هنا **لا يستطيع المرسل تغييره**.
3. `values` في الدالة المثبّتة (قيم الموقع).
4. `default` في الترويسة.

القوالب (`Template`) لها ترتيب خاص، بلغة التشغيل (`language` في `settings_overrides` إن وُجد، وإلا
`command_reply_language`):

1. جدول `templates` في الأمر: الصف بنفس اللغة، ثم اللغة الأساسية (`ar` من `ar-SA`)، ثم الصف بلا لغة.
2. قيمة الموقع: نص واحد، أو `{لغة: نص}` و `""` لكل اللغات.
3. `@default <param> <lang>` ثم `@default <param>`.

مدخلات `sender` تؤخذ دائماً من المرسل، مهما كان في القيم. المدخل الذي لا يتحقق `depends_on` له يُترك.
بعد الدمج تُحوَّل القيم إلى أنواعها (`coerce`)، وما بقي فارغاً من المدخلات الإلزامية يرجع في `missing`.

### 2.5 التثبيت والتحديث — `services/functions_catalog.py`

- `install(server_script)`: يقرأ الترويسة وينشئ `WhatsApp Function` باسم `@function`، `Active`. **يرفض**:
  سكربتاً معطّلاً، أو `@requires` غير متحقق، أو سكربتاً **بلا سطر الحماية** (القسم 6)، أو `@function` يعرّفه
  سكربت آخر، أو دالة مثبّتة من قبل.
- ما يُحفظ: `server_script`، و `manifest` (الترويسة محلَّلة JSON)، و `manifest_checksum` (sha256 لنص
  الترويسة فقط، فتعديل الكود تحت الترويسة لا يُعدّ تحديثاً)، و `installed_version` من `@version`، و `values`.
- `diff(server_script)`: قبل التثبيت أو التحديث، الفروق في المدخلات (حسب الاسم) والردود (حسب المفتاح)، والأوامر
  المتأثرة، وهل الدالة متاحة على الموقع.
- `update(function_key)`: يعيد قراءة السكربت. **قيم الموقع تبقى للمدخلات التي بقي اسمها**، والباقي يُحذف.
  يرفض إذا صار السكربت يعرّف `@function` آخر.
- `remove`: يرفض ما دام هناك أمر Active يستخدم الدالة. لا يحذف السكربت نفسه.
- `save_values`: يكتب قيم الموقع ويتحقق من نوعها حسب الترويسة.
- `check_updates()`: مهمة يومية (و زر في المركز) تضع `update_available` إذا تغيّر checksum الترويسة، وتعدّ
  الدوال التي اختفى سكربتها.
- `storefront()`: ما يعرضه مركز الدوال. لكل سكربت حالة: `available` أو `unavailable` (مع الأسباب) أو `invalid`
  (مع خطأ الترويسة) أو `update` أو `missing`.
- كل عملية تُسجَّل في الـ audit: `Function Installed / Updated / Removed`.

**التجربة** (`function_runner.trial`، زر «جرّب» في المركز): نفس خطوات الأمر، خطوة خطوة: الترويسة ←
`@requires` ← `@party_types` ← الطرف ← المدخلات ← التشغيل باسم مستخدم الخدمة ← `@reply`. التشغيل داخل
savepoint يُلغى في النهاية، فلا يُحفظ شيء ولا يُرسل شيء، ولا يُحسب في عدادات الدالة.

### 2.6 الدوال المتاحة حالياً

| function_key | السكربت | ماذا تفعل | `@party_types` | الردود |
|---|---|---|---|---|
| `ping` | `wa_fn_ping` | ترجع النص المرسل مع وقت الخادم | all | `result_text` |
| `document_info` | `wa_fn_document_info` | حالة مستند ومبلغه، **بشرط أن يخص طرف المرسل** (Sales Invoice للعميل، Purchase Invoice للمورد) | Customer, Supplier | `result_text`، `not_found_text` |
| `party_balance` | `wa_fn_party_balance` | رصيد الطرف بعملة الشركة من Trial Balance for Party | all | `result_text`، `inactive_text` |
| `party_balance_in_party_currency` | `wa_fn_party_balance_in_party_currency` | رصيد الطرف بعملته | all | `result_text`، `inactive_text` |
| `party_statement` | `wa_fn_party_statement` | آخر حركات الطرف من General Ledger مع الرصيد، و PDF اختياري | all | `result_text`، `statement_pdf` (report) |
| `party_trial_balance` | `wa_fn_party_trial_balance` | أكبر أرصدة نوع طرف يحدده الأمر (`party_type`) | all | `result_text` |
| `cash_bank_balances` | `wa_fn_cash_bank_balances` | أرصدة الصناديق أو البنوك (`account_type` يحدده الأمر) | all | `result_text` |

ما يجمع هذه الدوال:

- **الطرف يُحدَّد من الـ Contact المرتبط برقم المرسل** (مدخلات `source=sender`). لا يُؤخذ من نص الرسالة.
- `document_info` ترجع الرد نفسه (`not_found_text`) سواء كان المستند غير موجود أو يخص طرفاً آخر،
  حتى لا يستطيع أحد معرفة أي المستندات موجودة.
- الدوال المحاسبية تعلن تقاريرها في `@requires`، فلا تظهر على موقع ليس فيه التقرير.

### 2.7 كتابة دالة جديدة — مثال كامل

```python
# ==================== WA-FUNCTION ====================
# @function     stock_level
# @title        الكمية المتوفرة
# @version      1.0.0
# @description  الكمية الفعلية لصنف في كل المخازن
# @party_types  Employee
# @requires     doctype | Bin
#
# @param  item_code   | Link:Item  | required | source=command | الصنف
# @param  msg_result  | Template   | optional |                | رسالة النتيجة
#
# @default msg_result
# > {{ item_code }}: {{ qty }}
# @default msg_result ar
# > الكمية المتوفرة من {{ item_code }}: {{ qty }}
#
# @var    item_code    | msg_result | رمز الصنف
# @var    qty          | msg_result | الكمية الفعلية
# @reply  result_text  | text |  | الكمية (من msg_result)
# ================== END WA-FUNCTION ==================

# حماية: لا تعمل من الرابط المباشر /api/method/wa_fn_...
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict
item_code = form.get("item_code")
msg_result = form.get("msg_result") or "{{ item_code }}: {{ qty }}"

qty = 0
for row in frappe.get_all("Bin", filters={"item_code": item_code}, fields=["actual_qty"]):
    qty = qty + frappe.utils.flt(row.actual_qty)

ctx = {"item_code": item_code, "qty": qty}
frappe.flags.wa_result = {
    "error": None,
    "messages": [{
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(msg_result, ctx).strip(),
    }],
    "data": ctx,
}
```

الخطوات:

1. أنشئ `Server Script`: Script Type = API، API Method = `wa_fn_stock_level`، Allow Guest مطفأ، مفعّل.
   (يجب أن يكون `server_script_enabled` مفعّلاً في إعدادات الموقع.)
2. افتح مركز الدوال: تظهر الدالة `available`. «ثبّت»، ثم «جرّب».
3. أنشئ أمراً عليها من محرر الأوامر.

**قيود بيئة Server Script** (RestrictedPython في `safe_exec`). الكود الذي يخالفها يفشل عند التشغيل:

- **لا `str.format`**: اجمع النصوص بـ `+` و `str(...)`، أو استخدم `frappe.render_template`.
- **لا فك tuple في الإسناد**: `a, b = x` لا يعمل. اكتب `a = x[0]` و `b = x[1]`.
- **لا `**kwargs`**: مرّر الوسائط بأسمائها صراحة.
- تجنّب `import`، واستخدم ما يتيحه `frappe` و `frappe.utils` داخل البيئة.
- السكربت يعمل باسم مستخدم الخدمة، فما يقرأه محدود بصلاحياته.

### 2.8 نسخ السكربتات في المستودع

`scripts/functions/wa_fn_*.py` هي نسخة المستودع من سكربتات الدوال. على الموقع، سجلات `Server Script` هي المرجع.

- `scripts/setup_functions.py` ينشئ أو يحدّث سجل `Server Script` لكل ملف (الاسم = اسم الملف، API، مفعّل،
  Allow Guest مطفأ). تشغيله مرة ثانية لا يغيّر شيئاً:
  ```bash
  cd /home/snd/frappe-bench
  echo 'ns = {}; exec(open("/home/snd/frappe-bench/apps/whatsapp_next/scripts/setup_functions.py").read(), ns); ns["run"]()' \
      | bench --site whatsapp.dev.sanad.digital console
  ```
  `ns["run"](["wa_fn_ping"])` يحدّه بالأسماء المذكورة.
- `scripts/setup_commands.py` يثبّت الدوال من سكربتاتها أو يحدّثها، ثم يبني الأوامر الثمانية (القسم 3.2)
  عبر `services.commands.save` ويشغّلها. لمواقع التطوير فقط:
  ```bash
  cd /home/snd/frappe-bench
  cp apps/whatsapp_next/scripts/setup_commands.py apps/whatsapp_next/whatsapp_next/_setup_cmds.py
  bench --site whatsapp.dev.sanad.digital execute whatsapp_next._setup_cmds.run --kwargs '{"company": "SANAD Digital (Demo)"}'
  rm apps/whatsapp_next/whatsapp_next/_setup_cmds.py
  ```

---

## 3. الأوامر (Commands)

### 3.1 حقول `WhatsApp Command`

| الحقل | المعنى |
|---|---|
| `code` | كلمة الأمر، وهي اسم السجل. تُحوَّل إلى casefold |
| `synonyms` | كلمات بديلة، كل واحدة في سطر. لا تتكرر كلمة بين أمرين |
| `function` | الدالة المثبّتة التي يشغّلها |
| `status` | `Active` أو `Inactive`. **الأمر Active مقفل للتعديل**، والمحرر يوقفه ثم يحفظه ثم يعيد تشغيله |
| `requires_linked_contact` | يجب أن يكون للرقم Contact |
| `allowed_party_types` | أنواع الأطراف المسموح لها: Customer, Supplier, Employee, Sales Person, User. يجب أن تكون ضمن `@party_types` للدالة |
| `allowed_group` / `blocked_group` | مجموعة جهات اتصال مسموح لها أو محظورة |
| `access_modes` + `access_entries` | لكل نوع طرف وضع: `Allow All` تعني أن القائمة قائمة حظر، و `Deny All` تعني أنها قائمة سماح. المدخلات جهات اتصال أو مجموعات |
| `disabled_inputs` | مدخلات لا يستطيع المرسل كتابتها في هذا الأمر (أسماء `@param`، كل اسم في سطر) |
| `ask_inputs` | مدخلات يسأل النظام عنها إذا لم تُكتب. الصيغة: `months: 1=شهر, 3=3 أشهر` |
| `settings_overrides` | JSON `{param: value}` يثبّت قيم مدخلات لهذا الأمر فقط، ومعها `language` اختياري |
| `templates` | جدول `WhatsApp Command Template` (`param`، `language`، `text`): نصوص هذا الأمر لقوالب الدالة. صف واحد لكل قالب ولغة |
| `disabled_replies` | مفاتيح `@reply` لا يرسلها هذا الأمر، كل مفتاح في سطر |
| `show_in_menu`, `menu_order`, `menu_description` | الظهور في القائمة الرئيسية |
| `run_count`, `last_run_at`, `defaults_restored_at` | عدادات |

الـ controller يتحقق من الأسماء مقابل ترويسة الدالة: `disabled_inputs` و `ask_inputs` من المدخلات التي يكتبها
المرسل، و `disabled_replies` من `@reply`، و `templates.param` من مدخلات `Template`، ومفاتيح
`settings_overrides` من مدخلات `command` (أو `language`). حفظ الأمر يمسح كاش خريطة الكلمات `wa:commands:map`.
«استعادة الافتراضي» تفرّغ `templates` و `settings_overrides`.

### 3.2 الأوامر المعرّفة على الموقع الآن

| الأمر | المرادفات | الدالة | ما يثبّته الأمر | من يستطيع |
|---|---|---|---|---|
| فحص | ping, بنق | ping | — | الجميع، ولا يشترط Contact |
| رصيد | رصيدي, كم علي, balance | party_balance | المرسل يكتب `to_date` فقط | Customer مرتبط |
| كشف | كشف حساب, كشفي, statement | party_statement | يسأل عن الأشهر (1/3/6/12) | Customer مرتبط |
| فاتورة | فاتورتي, حالة الطلب, invoice, doc | document_info | المرسل يكتب رقم المستند فقط | Customer أو Supplier مرتبط |
| عملاء | أرصدة العملاء, customers | party_trial_balance | `party_type = Customer` | أعضاء مجموعة «فريق المحاسبة» فقط |
| موردين | أرصدة الموردين, suppliers | party_trial_balance | `party_type = Supplier` | «فريق المحاسبة» |
| صندوق | الصندوق, cash | cash_bank_balances | `account_type = cash` | «فريق المحاسبة» |
| بنك | البنوك, bank | cash_bank_balances | `account_type = bank` | «فريق المحاسبة» |

يعيد `scripts/setup_commands.py` بناء هذه المجموعة (القسم 2.8)، ويمكن تشغيله أكثر من مرة دون آثار جانبية.

### 3.3 الإعدادات العامة (`WhatsApp Settings` → تبويب Commands)

| الحقل | القيمة الحالية | المعنى |
|---|---|---|
| `enable_commands` | 1 | المفتاح الرئيسي للأوامر |
| `command_service_user` | wa-commands@… | **المستخدم الذي تعمل الدوال باسمه.** لا يكون Administrator ولا System Manager، ويجب أن يكون مفعّلاً |
| `command_reply_language` | ar | لغة كل الردود، ولغة اختيار القوالب |
| `command_help_token` | ؟ | كلمة المساعدة، إضافة إلى `* ? help مساعدة` |
| `send_receipt_reply` + `receipt_reply` | «تم استلام طلبك…» | رد فوري قبل النتيجة |
| `unknown_command_reply` | فارغ | الرد على رسالة ليست أمراً |
| `main_menu_mode` | Buttons on the reply | `Off` أو `List after every reply` أو `Buttons on the reply` |
| `main_menu_words` | القائمة، مرحبا، السلام عليكم… | كلمات تفتح القائمة |
| `global_blacklist_group` | — | مجموعة محظورة من كل الأوامر |

---

## 4. مسار رسالة واردة خطوة بخطوة

```
Webhook → services/inbound.py (_after_insert)
   └─ should_route()? → frappe.enqueue("command_router.route", queue="short", job_id="wa-cmd-<inbound>")
        └─ services/command_router.route()   (يعمل في الـ worker فقط، ويُرفض داخل طلب ويب)
```

**`should_route`**: الأوامر مفعّلة، والرسالة من نوع `Text` أو `Interactive Reply`، وليست فارغة. في
**المجموعات** يجب أن تبدأ الرسالة بـ `#` أو `/` أو `!`. في المحادثة الفردية يُوجَّه كل نص.

**`route()`** يعمل داخل `in_reply_language()`، فتُكتب الردود بلغة الإعدادات:

1. **القائمة الرئيسية**: إذا كانت الرسالة من كلمات القائمة أو ضغطة على زر `__menu__`، يُرسل List
   بأوامر القائمة وتُمسح أي جلسة مفتوحة.
2. **جلسة مفتوحة**: إذا كان النظام ينتظر جواباً على سؤال، تُعتبر الرسالة جواباً، إلا إذا كانت أمراً
   جديداً فتُلغى الجلسة.
3. **المطابقة** (`match`): تُؤخذ **الكلمة الأولى فقط** من النص، وتُحذف منها البادئات `# / !`، وتُبحث في
   خريطة `code + synonyms`.
   - كلمة مساعدة وحدها تُرجع قائمة كل الأوامر.
   - `كشف ؟` أو `؟ كشف` أو `كشف؟` تُرجع طريقة استخدام هذا الأمر (`usage_text`)، وتُبنى من ترويسة
     الدالة المثبّتة.
   - ضغطة زر أو صف في قائمة تُقرأ بالـ `id` إذا كان سطر أمر، وإلا بالعنوان ككلمة أمر.
   - إذا لم تطابق الرسالة أي أمر تصبح الحالة `Not Matched`، ويُرسل `unknown_command_reply` إن كان معرّفاً.
4. **التحقق من الوصول** (`check_access`) بترتيب ثابت. أول شرط يفشل هو سبب الحظر:
   `Commands Disabled` ← النوع ليس نصاً (`Not Allowed`) ← القائمة السوداء العامة (`Blacklist`) ←
   `blocked_group` (`Blacklist`) ← `allowed_group` (`Not Allowed`) ← `requires_linked_contact` (`Not Linked`) ←
   `allowed_party_types` للأمر (`Party Type`) ← قائمة الحظر أو السماح لنوع الطرف ← **الدالة**
   (`function_block`): مثبّتة و Active ولها `server_script`، وكل `@requires` متحقق على الموقع، وإلا
   `Function Inactive` (والأسباب تُكتب في `command_error`)؛ ونوع طرف المرسل ضمن `@party_types`، وإلا `Party Type`.
   - **من هو المرسل** (`sender_for`): الـ Contact المرتبط بالرسالة، ثم Dynamic Links الخاصة به.
     تُفضَّل الأنواع المسموحة للأمر، ثم الطرف الذي يكون هذا الـ Contact هو `primary contact` له، وإلا
     أول رابط.
   - عند الحظر، وإذا كان `send_receipt_reply` مفعّلاً، يُرسل الرد «لا يمكنك استخدام هذا الأمر (السبب)».
5. **قراءة المدخلات** (`parse_args`): المدخلات المفتوحة للمرسل هي مدخلات `command` في الترويسة، **ما عدا**
   القوالب، وما عطّله الأمر (`disabled_inputs`)، وما ثبّته (`settings_overrides`). أولاً `key=value` لهذه
   المدخلات فقط (أي `key=value` آخر يُتجاهل: الطرف والقوالب لا تأتي من نص المرسل أبداً)، ثم بالترتيب، وآخر
   مدخل نصي يأخذ بقية النص. التحويل حسب النوع في الترويسة:
   - `Int` رقم صحيح، `Check` نعم/لا، `Select` من `@options`، `Link` يتحقق من وجود السجل.
   - `Date` تاريخ أو كلمة نسبية: `today`، `اليوم`، `أمس`، `month_start`، `-3m`، `-7d`.
   بعدها `function_runner.prepare` يدمج القيم ويملأ الافتراضيات (القسم 2.4).
   - إذا نقص مدخل `sender` (الرقم غير مرتبط بطرف) تصبح الحالة `Blocked` بسبب `Not Linked`.
6. **مدخل ناقص**: إذا نقص مدخل إلزامي أو مدخل مذكور في `ask_inputs`، وكانت المحادثة فردية، **لا يُنفَّذ
   الأمر**. تُحفظ جلسة في الكاش لمدة 600 ثانية (`services/command_sessions.py`)، ويُرسل سؤال:
   - تاريخ: List بخيارات جاهزة (اليوم، بداية الشهر…) مع «تاريخ آخر» و«إلغاء».
   - خياران أو أقل (من `ask_inputs`، أو `@options`، أو نعم/لا لـ `Check`): أزرار.
   - أكثر من خيارين: List.
   - إذا كانت الباقة لا تدعم الرسائل التفاعلية: نص بخيارات مرقّمة ويُجاب بالرقم.
   - كلمة «إلغاء» أو `cancel` تنهي الجلسة.
   - بعد اكتمال الأجوبة يُعاد التحقق من الوصول، وتُملأ الافتراضيات، ثم يُنفَّذ الأمر.
   في المجموعات لا يُسأل: المدخل الإلزامي الناقص يُفشل الأمر برسالة «… is required».
7. **التنفيذ** (`_run` ثم `execute` ثم `function_runner.execute`):
   - تصبح الحالة `Matched` ويُرسل رد الاستلام فوراً.
   - يظهر «يكتب…» عند المرسل.
   - **تتبدّل الجلسة إلى `command_service_user`**، ويُشغَّل السكربت بـ `run_script`، ثم تُعاد الجلسة
     الأصلية في `finally`، ومعها sid و form_dict.
   - تُتحقَّق الرسائل من `@reply` وتُحذف الردود المعطّلة في `disabled_replies` (القسم 2.3).
   - تُحدَّث `call_count` و `avg_ms` و `error_count` و `last_error` في UPDATE واحد آمن من التزامن.
     التجربة (dry run) لا تُحسب.
8. **صياغة الرد** (`render_outputs` ← `function_runner.replies_of`): كل رسالة بترتيبها:
   - `text`: رسالة نصية.
   - `report`: ملف PDF أو Excel من التقرير، يُرسل كمستند مع `caption`. في التجربة لا يُطبع.
   - إذا كان هناك `error` يُرسل نص الخطأ وحده.
9. **القائمة على الرد** (`command_menu.decorate`): في وضع «Buttons on the reply» يحمل آخر رد نصي
   أزرار الأوامر، إذا كانت 3 أو أقل، وإلا زر «القائمة الرئيسية» يفتح List.
10. **الإرسال** (`_send_replies` عبر `dispatch`):
    - يُرسل الرد **من نفس الجهاز الذي استقبل الرسالة**، ويقتبس رسالة الأمر.
    - **يُرسل أيضاً إلى كل أرقام واتساب الأخرى لنفس الـ Contact**، ما عدا رد الاستلام، وما عدا المجموعات
      والمحاكي.
    - ردود `receipt` و `unknown` و `help` تُرسل فوراً (`send_now`). باقي الردود تدخل الطابور بأولوية 1.
11. **الحالة** في `WhatsApp Inbound Message.command_status`:
    `None → Not Matched | Blocked | Awaiting Input | Matched → Executed | Failed`، مع `command` و
    `command_args` و `command_error` و `block_reason` و `reply_outbound`. يُزاد `run_count` في الأمر.

---

## 5. الواجهات والـ API

- **مركز الدوال** (Page `wa_functions_center`) و `api/v1/functions.py`: `get_catalog`، `get_manifest`،
  `preview_install` (الفروقات)، `install`، `update`، `update_many`، `check_updates`، `remove`، `set_status`،
  `set_status_many`، `save_values`، `try_function`. التفاصيل في [api/functions.md](api/functions.md).
- **الأوامر** و `api/v1/commands.py`: `list_commands`، `get_defaults`، `get_editor`، `get_function_spec`،
  `save_editor`، `save_command`، `set_status`، `restore_defaults`، `delete_command` (يُرفض إذا كان للأمر سجل
  تشغيل، والبديل إيقافه)، `preview_command` (تشغيل مسودة الأمر كأن مرسلاً معيناً أرسلها، دون إرسال)، و
  `test_command` (`command_router.dry_run(text, phone)`، لا يحفظ ولا يرسل). التفاصيل في [api/commands.md](api/commands.md).
- الصلاحيات عبر `@api_endpoint(roles=...)`: القراءة لدور Viewer وما فوقه، والكتابة لدور Manager.
- كل تعديل يُسجَّل في الـ audit: `Command Changed`، `Command Deleted`، `Command Defaults Restored`،
  `Function Installed / Updated / Removed`.

---

## 6. قواعد أمان مقصودة في التصميم

- **سطر الحماية**: كل سكربت دالة يبدأ بعد الترويسة مباشرة بـ:
  ```python
  if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
      frappe.throw("Not allowed", frappe.PermissionError)
  ```
  الاستدعاء المباشر `/api/method/wa_fn_...` يضع اسم السكربت نفسه في `cmd`، فيتوقف لأي مستخدم، حتى
  Administrator. الراوتر يمرّر `cmd=None`. **التثبيت والتحديث يرفضان سكربتاً بلا هذا السطر**
  (`function_header.guard_present`، خلال 40 سطراً بعد `END WA-FUNCTION`).
- لا يوجد في التطبيق endpoint يبدأ اسمه بـ `wa_fn_`.
- الأمر يخزّن مفتاح الدالة فقط. السكربت يُقرأ من سجل الدالة المثبّتة، ولا يُشغَّل أي مسار مكتوب في طلب أو رسالة.
- الدوال تعمل بمستخدم خدمة محدود الصلاحيات، لا بالمدير.
- طرف المرسل يُحدَّد من ربط الـ Contact، ولا يُقبل من نص الرسالة. والقوالب (Jinja) لا تأتي من نص المرسل أبداً.
- الدالة لا ترسل إلا ردوداً معلنة في `@reply`. أي رسالة أخرى تُفشل التشغيل كله.
- الرد نفسه للمستند غير الموجود وللمستند الذي يخص غير المرسل.
- التوجيه الحي يعمل في الـ worker فقط. داخل طلب ويب يُسمح بالتجربة فقط، و«جرّب» في المركز يُلغى بـ rollback.

---

## 7. ملاحظات وقصور معروف حالياً

1. **المرادفات التي فيها أكثر من كلمة لا تعمل كعبارة.** المطابقة تأخذ الكلمة الأولى فقط:
   - «كم علي» لا تطابق شيئاً، والنتيجة `Not Matched`.
   - «كشف حساب» تطابق «كشف» وتقرأ «حساب» كقيمة لأول مدخل مفتوح، فتفشل إذا لم يكن نصياً.
   - المرادفات المتأثرة: «كم علي»، «كشف حساب»، «حالة الطلب»، «أرصدة العملاء»، «أرصدة الموردين».
2. `unknown_command_reply` فارغ، فالرسالة التي ليست أمراً لا يُرد عليها.
3. في المجموعات لا تُسأل المدخلات الناقصة، ويجب أن تبدأ الرسالة بـ `# / !`.
4. «Reply Device» لكل أمر أُلغي من المنتج. الرد دائماً من الجهاز الذي استقبل الرسالة.
5. تعديل سكربت الدالة على الموقع لا يغيّر الدالة المثبّتة إذا تغيّرت الترويسة: يظهر «تحديث متاح» حتى يضغط
   المدير «حدّث». أما تعديل الكود تحت الترويسة فيُستخدم في التشغيل التالي مباشرة.

## 8. الملفات للرجوع إليها

```
whatsapp_next/services/function_header.py     ← محلّل الترويسة: @requires و @party_types و build_params و validate_messages و guard_present
whatsapp_next/services/functions_catalog.py   ← اكتشاف السكربتات والتثبيت والتحديث والقيم و check_updates و storefront
whatsapp_next/services/function_runner.py     ← دمج القيم وتشغيل السكربت (run_script) وتحويل الرسائل إلى ردود و«جرّب»
whatsapp_next/services/report_file.py         ← طباعة رد report إلى PDF أو Excel
whatsapp_next/services/command_router.py      ← قلب التوجيه (match, check_access, function_block, parse_args, execute, route)
whatsapp_next/services/command_sessions.py    ← أسئلة المدخلات الناقصة
whatsapp_next/services/command_menu.py        ← القائمة الرئيسية
whatsapp_next/services/commands.py            ← حفظ الأوامر والمحرر والمعاينة
whatsapp_next/services/inbound.py             ← should_route + enqueue
whatsapp_next/api/v1/{commands,functions}.py
scripts/functions/wa_fn_*.py                  ← نسخ سكربتات الدوال
scripts/setup_functions.py, scripts/setup_commands.py
```
