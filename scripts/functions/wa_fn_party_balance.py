# ==================== WA-FUNCTION ====================
# @function     party_balance
# @title        استعلام عن رصيد
# @version      2.2.0
# @description  رصيد الأستاذ المساعد بعملة الشركة من تقرير Trial Balance for Party
# @party_types  all
#
# ---------- شروط ظهور الدالة (بدون @requires = متاحة دائماً) ----------
# @requires  report | Trial Balance for Party
#
# ---------- المتغيرات المستقبَلة ----------
# @param  party_type        | Link:DocType        | required | source=sender                 | نوع الأستاذ المساعد
# @param  party             | Dynamic:party_type  | required | source=sender                 | الأستاذ المساعد
# @param  company           | Link:Company        | optional | default=@default_company      | الشركة
# @param  fiscal_year       | Link:Fiscal Year    | optional | default=@current_fiscal_year  | السنة المالية
# @param  from_date         | Date                | optional | default=year_start            | من تاريخ (للسنة الحالية فقط)
# @param  to_date           | Date                | optional | default=today                 | إلى تاريخ (للسنة الحالية فقط)
# @param  account           | Link:Account        | optional |                               | الحساب (فارغ = كل حسابات الطرف)
# @param  show_zero_values  | Check               | optional | default=1                     | إظهار الأرصدة الصفرية
# @param  msg_result        | Template            | optional |                               | رسالة النتيجة
# @param  msg_inactive      | Template            | optional |                               | رسالة الحساب المجمّد أو المعطّل
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
# @var  fiscal_year         | all           | السنة المالية — مثال: 2026
# @var  status              | msg_inactive  | حالة الحساب — مجمّد / معطّل
# @var  from_date           | msg_result    | من تاريخ — مثال: 01-01-2026
# @var  to_date             | msg_result    | إلى تاريخ — مثال: 31-12-2026
# @var  currency            | msg_result    | عملة الشركة — مثال: YER
# @var  opening             | msg_result    | الرصيد الافتتاحي رقماً (موجب مدين، سالب دائن) — مثال: -1500.0
# @var  opening_formatted   | msg_result    | الافتتاحي منسّقاً بلا إشارة — مثال: YER 1,500.00
# @var  opening_side        | msg_result    | جهة الافتتاحي — مدين / دائن / فارغ
# @var  debit               | msg_result    | الحركة المدينة رقماً — مثال: 20000.0
# @var  debit_formatted     | msg_result    | الحركة المدينة منسّقة — مثال: YER 20,000.00
# @var  credit              | msg_result    | الحركة الدائنة رقماً — مثال: 8000.0
# @var  credit_formatted    | msg_result    | الحركة الدائنة منسّقة — مثال: YER 8,000.00
# @var  balance             | msg_result    | الرصيد الختامي رقماً (موجب مدين، سالب دائن) — مثال: 10500.0
# @var  balance_formatted   | msg_result    | الرصيد الختامي منسّقاً بلا إشارة — مثال: YER 10,500.00
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
#   Name        : WA Fn - Party Balance
#   Script Type : API
#   API Method  : wa_fn_party_balance
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#             (run_script يرجع frappe.flags للمستدعي)
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل رداً واحداً فقط: result_text أو inactive_text. لا ترسل ملفات.
#
# السنة المالية والفترة:
#   - الافتراضي @current_fiscal_year = السنة المالية الحالية للشركة
#     (المكافئ على الخادم لـ frappe.boot.current_fiscal_year).
#   - يجب أن تكون السنة المختارة هي الحالية أو سابقة لها، وإلا خطأ.
#   - السنة الحالية: from_date و to_date كما أُرسلا
#     (الافتراضي: from_date = بداية سنة اليوم، to_date = اليوم).
#   - سنة سابقة: from_date و to_date تؤخذ من السنة المالية نفسها (بدايتها ونهايتها)،
#     وأي تاريخين مرسلين يُتجاهلان.
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
# الاستدعاء المباشر /api/method/wa_fn_... يضع اسم الدالة نفسها في form_dict.cmd،
# فيتوقف هنا أياً كان المستخدم (حتى Administrator).
# عند run_script يكون cmd هو اسم المستدعي (المحرك أو شاشة الاختبار)، فتعمل.
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict

# ---------- إعدادات التقرير (عدّلها هنا إن اختلفت أسماء الأعمدة) ----------
REPORT_NAME = "Trial Balance for Party"
COL_OPENING_DR = "opening_debit"
COL_OPENING_CR = "opening_credit"
COL_DEBIT = "debit"
COL_CREDIT = "credit"
COL_CLOSING_DR = "closing_debit"
COL_CLOSING_CR = "closing_credit"

# نصوص احتياطية إذا لم يمرر المحرك النصوص (المحرك يمرر افتراضيات الترويسة عادة)
FALLBACK_RESULT = "*رصيد حسابكم*\n{{ party_name }}\nالرصيد: *{{ balance_formatted }}* {{ side }}"
FALLBACK_INACTIVE = "عذراً {{ party_name }}، حسابكم {{ status }} حالياً."

u = frappe.utils
flt = u.flt

party_type = form.get("party_type")
party = form.get("party")
company = form.get("company") or frappe.db.get_single_value("Global Defaults", "default_company")
fiscal_year = form.get("fiscal_year")
from_date = form.get("from_date")
to_date = form.get("to_date")
account = form.get("account") or None
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

# ---------- السنة المالية الحالية والمختارة ----------
current_fy = None
fy = None
if not error:
    r = frappe.db.sql(
        """
        select fy.name, fy.year_start_date, fy.year_end_date
        from `tabFiscal Year` fy
        where fy.disabled = 0
          and %(d)s between fy.year_start_date and fy.year_end_date
          and (not exists (select 1 from `tabFiscal Year Company` c where c.parent = fy.name)
               or exists (select 1 from `tabFiscal Year Company` c
                          where c.parent = fy.name and c.company = %(company)s))
        order by fy.year_start_date desc
        limit 1
        """,
        {"d": u.nowdate(), "company": company},
        as_dict=True,
    )
    current_fy = r[0] if r else None

    if fiscal_year:
        fy = frappe.db.get_value(
            "Fiscal Year", fiscal_year, ["name", "year_start_date", "year_end_date", "disabled"], as_dict=True
        )
        if not fy or fy.disabled:
            error = "السنة المالية «" + str(fiscal_year) + "» غير موجودة أو معطّلة"
    else:
        fy = current_fy  # احتياط إذا لم يمررها المحرك
        if not fy:
            error = "لا توجد سنة مالية حالية"

# السنة المختارة يجب أن تكون الحالية أو أقدم
if not error and current_fy and fy.year_start_date > current_fy.year_start_date:
    error = "السنة المالية " + str(fy.name) + " بعد السنة الحالية " + str(current_fy.name)

# ---------- الفترة ----------
if not error:
    is_current = bool(current_fy) and fy.name == current_fy.name
    if is_current:
        # السنة الحالية: التاريخان كما أُرسلا (افتراضياً بداية سنة اليوم → اليوم)
        today = u.getdate(u.nowdate())
        to_date = u.getdate(to_date) if to_date else today
        from_date = u.getdate(from_date) if from_date else u.get_year_start(today)
        # بداية السنة الميلادية قد تسبق السنة المالية إن لم تكن ميلادية
        if from_date < fy.year_start_date:
            from_date = fy.year_start_date
    else:
        # سنة سابقة: الفترة كاملة من السنة المالية نفسها، وأي تاريخين مرسلين يُتجاهلان
        from_date = fy.year_start_date
        to_date = fy.year_end_date

    if from_date > to_date:
        error = "تاريخ البداية بعد تاريخ النهاية"
    elif to_date > fy.year_end_date:
        error = "الفترة يجب أن تكون داخل السنة المالية " + str(fy.name)

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
           "fiscal_year": fy.name, "status": status}
    messages.append({
        "reply": "inactive_text",
        "type": "text",
        "text": frappe.render_template(msg_inactive, ctx).strip(),
    })
    data = ctx

# ---------- استدعاء التقرير ----------
if not error and not status:
    report_filters = {
        "company": company,
        "fiscal_year": fy.name,
        "from_date": str(from_date),
        "to_date": str(to_date),
        "party_type": party_type,
        "party": party,
        "show_zero_values": show_zero_values,
    }
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

    currency = frappe.db.get_value("Company", company, "default_currency")
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
        "fiscal_year": fy.name,
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