# ==================== WA-FUNCTION ====================
# @function     party_balance_in_party_currency
# @title        استعلام عن رصيد
# @version      2.5.0
# @description  رصيد الأستاذ المساعد بعملته من تقرير Trial Balance for Party in Party Currency
# @party_types  all
#
# ---------- شروط ظهور الدالة (بدون @requires = متاحة دائماً) ----------
# @requires  report | Trial Balance for Party in Party Currency
#
# ---------- المتغيرات المستقبَلة ----------
# @param  party_type        | Link:DocType        | required | source=sender             | نوع الأستاذ المساعد
# @param  party             | Dynamic:party_type  | required | source=sender             | الأستاذ المساعد
# @param  company           | Link:Company        | optional | default=@default_company  | الشركة
# @param  account           | Link:Account        | optional |                           | الحساب (فارغ = كل حسابات الطرف)
# @param  timespan          | Select              | optional | default=this year         | الفترة
# @param  from_date         | Date                | required | depends_on=timespan:select date range | من تاريخ (فقط عند Select Date Range)
# @param  to_date           | Date                | required | depends_on=timespan:select date range | إلى تاريخ (فقط عند Select Date Range)
# @param  show_zero_values  | Check               | optional | default=1                 | إظهار الأرصدة الصفرية
# @param  msg_result        | Template            | optional |                           | رسالة النتيجة
# @param  msg_inactive      | Template            | optional |                           | رسالة الحساب المجمّد أو المعطّل
#
# @options timespan | last 7 days, last 14 days, last 30 days, last 90 days, last week, last month, last quarter, last 6 months, last year, this week, this month, this quarter, this year, next 7 days, next 14 days, next 30 days, next week, next month, next quarter, next 6 months, next year, select date range
#
# @default msg_result
# > *رصيد حسابكم*
# > {{ party_name }}
# > الفترة: من {{ from_date }} إلى {{ to_date }}
# >
# > الرصيد: *{{ balance_formatted }}* {{ side }}
#
# @default msg_inactive
# > عذراً {{ party_name }}،
# > حسابكم {{ status }} حالياً، ولا يمكن عرض الرصيد.
# > يرجى التواصل مع خدمة العملاء.
#
# ---------- القيم الممكن استخدامها في الرسائل: {{ الاسم }} | الرسائل التي تتوفر فيها | الوصف ----------
# @var  party               | all           | رمز الأستاذ المساعد — مثال: CUST-00012
# @var  party_name          | all           | اسم الأستاذ المساعد — مثال: مؤسسة الأمل
# @var  party_type          | all           | نوع الأستاذ المساعد — مثال: Customer
# @var  company             | all           | الشركة — مثال: SND Accounting
# @var  account             | all           | رمز الحساب إن حُدد، وإلا فارغ — مثال: 1310 - Debtors - SND
# @var  account_name        | all           | اسم الحساب إن حُدد، وإلا فارغ — مثال: العملاء
# @var  timespan            | all           | الفترة كما اختيرت — مثال: this year
# @var  status              | msg_inactive  | حالة الحساب — مجمّد / معطّل
# @var  from_date           | msg_result    | من تاريخ — مثال: 01-01-2026
# @var  to_date             | msg_result    | إلى تاريخ — مثال: 31-12-2026
# @var  currency            | msg_result    | عملة الأستاذ المساعد — مثال: USD
# @var  opening             | msg_result    | الرصيد الافتتاحي رقماً (موجب مدين، سالب دائن) — مثال: -1500.0
# @var  opening_formatted   | msg_result    | الافتتاحي منسّقاً بلا إشارة — مثال: $ 1,500.00
# @var  opening_side        | msg_result    | جهة الافتتاحي — مدين / دائن / فارغ
# @var  debit               | msg_result    | الحركة المدينة رقماً — مثال: 20000.0
# @var  debit_formatted     | msg_result    | الحركة المدينة منسّقة — مثال: $ 20,000.00
# @var  credit              | msg_result    | الحركة الدائنة رقماً — مثال: 8000.0
# @var  credit_formatted    | msg_result    | الحركة الدائنة منسّقة — مثال: $ 8,000.00
# @var  balance             | msg_result    | الرصيد الختامي رقماً (موجب مدين، سالب دائن) — مثال: 10500.0
# @var  balance_formatted   | msg_result    | الرصيد الختامي منسّقاً بلا إشارة — مثال: $ 10,500.00
# @var  side                | msg_result    | جهة الرصيد — مدين / دائن / فارغ إذا كان صفراً
# @var  is_debit            | msg_result    | صحيح إذا كان الرصيد مديناً — للشروط: {% if is_debit %}…{% endif %}
# @var  is_credit           | msg_result    | صحيح إذا كان الرصيد دائناً
# @var  is_zero             | msg_result    | صحيح إذا كان الرصيد صفراً
#
# ---------- المخرجات المرسَلة ----------
# @reply  result_text    | text |  | الرصيد (من msg_result)
# @reply  inactive_text  | text |  | الحساب مجمّد أو معطّل (من msg_inactive)
# ================== END WA-FUNCTION ==================
#
# Server Script
#   Name        : WA Fn - Party Balance in Party Currency
#   Script Type : API
#   API Method  : wa_fn_party_balance_in_party_currency
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#             (run_script يرجع frappe.flags للمستدعي)
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل رداً واحداً فقط: result_text أو inactive_text. لا ترسل ملفات.
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
# الاستدعاء المباشر /api/method/wa_fn_... يضع اسم الدالة نفسها في form_dict.cmd،
# فيتوقف هنا أياً كان المستخدم (حتى Administrator).
# عند run_script يكون cmd هو اسم المستدعي (المحرك أو شاشة الاختبار)، فتعمل.
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict

# ---------- إعدادات التقرير (عدّلها هنا إن اختلفت أسماء الأعمدة) ----------
REPORT_NAME = "Trial Balance for Party in Party Currency"
COL_OPENING_DR = "opening_debit"
COL_OPENING_CR = "opening_credit"
COL_DEBIT = "debit"
COL_CREDIT = "credit"
COL_CLOSING_DR = "closing_debit"
COL_CLOSING_CR = "closing_credit"
COL_CURRENCY = ("currency", "party_currency", "account_currency")

TIMESPANS = (
    "last 7 days", "last 14 days", "last 30 days", "last 90 days", "last week", "last month",
    "last quarter", "last 6 months", "last year", "this week", "this month", "this quarter",
    "this year", "next 7 days", "next 14 days", "next 30 days", "next week", "next month",
    "next quarter", "next 6 months", "next year", "select date range",
)
DATE_RANGE = "select date range"

# نصوص احتياطية إذا لم يمرر المحرك النصوص (المحرك يمرر افتراضيات الترويسة عادة)
FALLBACK_RESULT = "*رصيد حسابكم*\n{{ party_name }}\nالرصيد: *{{ balance_formatted }}* {{ side }}"
FALLBACK_INACTIVE = "عذراً {{ party_name }}، حسابكم {{ status }} حالياً."

u = frappe.utils
flt = u.flt

party_type = form.get("party_type")
party = form.get("party")
company = form.get("company") or frappe.db.get_single_value("Global Defaults", "default_company")
account = form.get("account") or None
timespan = (form.get("timespan") or "this year").strip().lower()
# من / إلى تاريخ لا تُقرأ إلا عند timespan = select date range
from_date = form.get("from_date") if timespan == DATE_RANGE else None
to_date = form.get("to_date") if timespan == DATE_RANGE else None
show_zero_values = 1 if form.get("show_zero_values") in (None, "") else u.cint(form.get("show_zero_values"))
msg_result = form.get("msg_result") or FALLBACK_RESULT
msg_inactive = form.get("msg_inactive") or FALLBACK_INACTIVE

error = None
messages = []
data = {}

# ---------- التحقق ----------
if not party_type or not party:
    error = "رقمك غير مرتبط بحساب لدينا"
elif not company:
    error = "لم تُحدَّد الشركة"
elif timespan not in TIMESPANS:
    error = "الفترة «" + str(timespan) + "» غير مدعومة"
elif timespan == DATE_RANGE:
    if not from_date or not to_date:
        error = "الرجاء تحديد من تاريخ وإلى تاريخ"
    elif u.getdate(from_date) > u.getdate(to_date):
        error = "تاريخ البداية بعد تاريخ النهاية"

# ---------- الحساب (اختياري) ----------
account_name = ""
if not error and account:
    acc = frappe.db.get_value("Account", account, ["account_name", "company", "is_group"], as_dict=True)
    if not acc or acc.company != company:
        error = "الحساب غير موجود في الشركة"
    elif acc.is_group:
        error = "لا يمكن استخدام حساب رئيسي"
    else:
        account_name = acc.account_name

# ---------- اسم الطرف وحالته ----------
party_name = party
status = None
if not error:
    # كل أنواع الأطراف مسموحة: الاسم من title_field أو الحقول المعروفة
    meta = frappe.get_meta(party_type)
    name_fields = []
    for f in (meta.title_field, "customer_name", "supplier_name", "employee_name", "title"):
        if f and f not in name_fields and meta.has_field(f):
            name_fields.append(f)
    fields = ["name"] + name_fields
    for f in ("disabled", "is_frozen", "status"):
        if meta.has_field(f):
            fields.append(f)
    p = frappe.db.get_value(party_type, party, fields, as_dict=True)
    if not p:
        error = "لم يُعثر على حسابكم"
    else:
        for f in name_fields:
            if p.get(f):
                party_name = p.get(f)
                break
        if p.get("disabled"):
            status = "معطّل"
        elif p.get("is_frozen"):
            status = "مجمّد"
        elif party_type == "Employee" and p.get("status") and p.get("status") != "Active":
            status = "معطّل"

# ---------- الحساب مجمّد أو معطّل: رسالة واحدة ولا تقرير ----------
if not error and status:
    ctx = {"party": party, "party_name": party_name, "party_type": party_type,
           "company": company, "account": account or "", "account_name": account_name,
           "timespan": timespan, "status": status}
    messages.append({
        "reply": "inactive_text",
        "type": "text",
        "text": frappe.render_template(msg_inactive, ctx).strip(),
    })
    data = ctx

# ---------- الفترة ----------
# select date range: التاريخان المرسَلان، ويُمرَّران للتقرير
# غير ذلك: التقرير يحسب الفترة من timespan، والتاريخان هنا للعرض في الرسالة فقط
if not error and not status:
    if timespan == DATE_RANGE:
        from_date = u.getdate(from_date)
        to_date = u.getdate(to_date)
    else:
        date_range = u.get_timespan_date_range(timespan)
        from_date = u.getdate(date_range[0])
        to_date = u.getdate(date_range[1])

# ---------- استدعاء التقرير ----------
if not error and not status:
    report_filters = {
        "company": company,
        "party_type": party_type,
        "party": party,
        "timespan": timespan,
        "show_zero_values": show_zero_values,
    }
    if timespan == DATE_RANGE:
        report_filters["from_date"] = str(from_date)
        report_filters["to_date"] = str(to_date)
    if account:
        report_filters["account"] = account

    report = frappe.call(
        "frappe.desk.query_report.run",
        report_name=REPORT_NAME,
        filters=report_filters,
    )

    row = {}
    for r in (report or {}).get("result") or []:
        if isinstance(r, dict) and r.get("party") == party:
            row = r
            break

    currency = None
    for c in COL_CURRENCY:
        if row.get(c):
            currency = row.get(c)
            break
    currency = currency or frappe.db.get_value("Company", company, "default_currency")

    opening = flt(flt(row.get(COL_OPENING_DR)) - flt(row.get(COL_OPENING_CR)), 2)
    debit = flt(row.get(COL_DEBIT), 2)
    credit = flt(row.get(COL_CREDIT), 2)
    balance = flt(flt(row.get(COL_CLOSING_DR)) - flt(row.get(COL_CLOSING_CR)), 2)

    ctx = {
        "party": party,
        "party_name": party_name,
        "party_type": party_type,
        "company": company,
        "account": account or "",
        "account_name": account_name,
        "timespan": timespan,
        "from_date": u.formatdate(from_date, "dd-MM-yyyy"),
        "to_date": u.formatdate(to_date, "dd-MM-yyyy"),
        "currency": currency,
        "opening": opening,
        "opening_formatted": u.fmt_money(abs(opening), currency=currency),
        "opening_side": "مدين" if opening > 0 else ("دائن" if opening < 0 else ""),
        "debit": debit,
        "debit_formatted": u.fmt_money(debit, currency=currency),
        "credit": credit,
        "credit_formatted": u.fmt_money(credit, currency=currency),
        "balance": balance,
        "balance_formatted": u.fmt_money(abs(balance), currency=currency),
        "side": "مدين" if balance > 0 else ("دائن" if balance < 0 else ""),
        "is_debit": balance > 0,
        "is_credit": balance < 0,
        "is_zero": balance == 0,
    }

    messages.append({
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(msg_result, ctx).strip(),
    })
    data = ctx

frappe.flags.wa_result = {"error": error, "messages": messages, "data": data}
