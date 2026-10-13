# ==================== WA-FUNCTION ====================
# @function     party_statement
# @title        كشف حساب
# @version      1.0.0
# @description  آخر حركات الأستاذ المساعد خلال الأشهر الأخيرة مع الرصيد الختامي، من تقرير General Ledger
# @party_types  all
#
# ---------- شروط ظهور الدالة (بدون @requires = متاحة دائماً) ----------
# @requires  report | General Ledger
#
# ---------- المتغيرات المستقبَلة ----------
# @param  party_type       | Link:DocType        | required | source=sender             | نوع الأستاذ المساعد
# @param  party            | Dynamic:party_type  | required | source=sender             | الأستاذ المساعد
# @param  company          | Link:Company        | optional | default=@default_company  | الشركة
# @param  months           | Int                 | optional | default=6                 | عدد الأشهر الأخيرة (1–24)
# @param  limit            | Int                 | optional | default=10                | عدد الحركات المعروضة (1–30)
# @param  send_pdf         | Check               | optional | default=0                 | إرسال الكشف ملف PDF أيضاً
# @param  msg_result       | Template            | optional |                           | رسالة الكشف
# @param  msg_pdf_caption  | Template            | optional |                           | تعليق ملف الـ PDF
#
# @default msg_result
# > *كشف حساب {{ party_name }}*
# > من {{ from_date }} إلى {{ to_date }}{% if entries %} — {{ count }} حركة{% endif %}
# > {% for e in entries %}
# > {{ e.date }} | {{ e.voucher }}
# > مدين {{ e.debit }} · دائن {{ e.credit }} · الرصيد {{ e.balance }}
# > {% endfor %}{% if not entries %}
# > لا توجد حركات في هذه الفترة.{% endif %}
# >
# > الرصيد الختامي: *{{ closing_formatted }}* {{ side }}
#
# @default msg_pdf_caption
# > كشف حساب {{ party_name }} من {{ from_date }} إلى {{ to_date }}
#
# ---------- القيم الممكن استخدامها في الرسائل: {{ الاسم }} | الرسائل التي تتوفر فيها | الوصف ----------
# @var  party              | all  | رمز الأستاذ المساعد — مثال: CUST-00012
# @var  party_name         | all  | اسم الأستاذ المساعد — مثال: مؤسسة الأمل
# @var  party_type         | all  | نوع الأستاذ المساعد — مثال: Customer
# @var  company            | all  | الشركة — مثال: SND Accounting
# @var  months             | all  | عدد الأشهر — مثال: 6
# @var  from_date          | all  | من تاريخ — مثال: 13-04-2026
# @var  to_date            | all  | إلى تاريخ — مثال: 13-10-2026
# @var  currency           | all  | العملة — مثال: YER
# @var  entries            | msg_result  | آخر الحركات، لكل حركة: e.date / e.voucher / e.voucher_type / e.debit / e.credit / e.balance (منسّقة) — للتكرار: {% for e in entries %}…{% endfor %}
# @var  count              | msg_result  | عدد الحركات المعروضة — مثال: 10
# @var  closing            | msg_result  | الرصيد الختامي رقماً (موجب مدين، سالب دائن) — مثال: -11296.0
# @var  closing_formatted  | msg_result  | الرصيد الختامي منسّقاً بلا إشارة — مثال: YER 11,296.00
# @var  side               | msg_result  | جهة الرصيد — مدين / دائن / فارغ إذا كان صفراً
#
# ---------- المخرجات المرسَلة ----------
# @reply  result_text    | text   |                                    | الكشف نصاً (من msg_result)
# @reply  statement_pdf  | report | report=General Ledger, format=PDF  | الكشف ملف PDF (عند send_pdf)
# ================== END WA-FUNCTION ==================
#
# Server Script
#   Name        : wa_fn_party_statement
#   Script Type : API
#   API Method  : wa_fn_party_statement
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل result_text دائماً، و statement_pdf (رد report يطبعه التطبيق) عند send_pdf = 1.
#
# الفترة: من (اليوم − months شهراً) إلى اليوم.
# الرصيد الختامي: سطر الإقفال في التقرير = آخر سطر بلا رقم قيد وفيه رصيد
#   (عنوانه مترجم، فلا يُبحث عنه بالكلمة الإنجليزية).
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict

REPORT_NAME = "General Ledger"
CATEGORIZE_BY = "Categorize by Voucher (Consolidated)"
MAX_MONTHS = 24
MAX_LINES = 30

FALLBACK_RESULT = "*كشف حساب {{ party_name }}*\nالرصيد الختامي: *{{ closing_formatted }}* {{ side }}"
FALLBACK_CAPTION = "كشف حساب {{ party_name }}"

u = frappe.utils
flt = u.flt

party_type = form.get("party_type")
party = form.get("party")
company = form.get("company") or frappe.db.get_single_value("Global Defaults", "default_company")
months = max(1, min(u.cint(form.get("months") or 6), MAX_MONTHS))
limit = max(1, min(u.cint(form.get("limit") or 10), MAX_LINES))
send_pdf = u.cint(form.get("send_pdf"))
msg_result = form.get("msg_result") or FALLBACK_RESULT
msg_pdf_caption = form.get("msg_pdf_caption") or FALLBACK_CAPTION

error = None
messages = []
data = {}

# ---------- التحقق ----------
if not party_type or not party:
    error = "رقمك غير مرتبط بحساب لدينا"
elif not company:
    error = "لم تُحدَّد الشركة"

# ---------- اسم الطرف ----------
party_name = party
if not error:
    meta = frappe.get_meta(party_type)
    name_fields = []
    for f in (meta.title_field, "customer_name", "supplier_name", "employee_name", "title"):
        if f and f not in name_fields and meta.has_field(f):
            name_fields.append(f)
    p = frappe.db.get_value(party_type, party, ["name"] + name_fields, as_dict=True)
    if not p:
        error = "لم يُعثر على حسابكم"
    else:
        for f in name_fields:
            if p.get(f):
                party_name = p.get(f)
                break

# ---------- استدعاء التقرير ----------
if not error:
    today = u.getdate(u.nowdate())
    from_date = u.getdate(u.add_months(today, -months))
    to_date = today
    report_filters = {
        "company": company,
        "from_date": str(from_date),
        "to_date": str(to_date),
        "party_type": party_type,
        "party": [party],
        "categorize_by": CATEGORIZE_BY,
    }
    report = frappe.call(
        "frappe.desk.query_report.run",
        report_name=REPORT_NAME,
        filters=report_filters,
    )
    rows = [r for r in (report or {}).get("result") or [] if isinstance(r, dict)]

    # الحركات: الأسطر التي لها تاريخ ورقم قيد، والأخيرة منها فقط
    vouchers = [r for r in rows if r.get("posting_date") and r.get("voucher_no")]
    last = vouchers[-limit:] if vouchers else []

    # سطر الإقفال: آخر سطر بلا رقم قيد وفيه رصيد
    closing_row = {}
    for i in range(len(rows) - 1, -1, -1):
        r = rows[i]
        if not r.get("voucher_no") and r.get("balance") is not None:
            closing_row = r
            break

    currency = (closing_row.get("presentation_currency") or closing_row.get("account_currency")
                or frappe.db.get_value("Company", company, "default_currency"))
    closing = flt(closing_row.get("balance"), 2)

    entries = []
    for r in last:
        entries.append({
            "date": u.formatdate(r.get("posting_date"), "dd-MM-yyyy"),
            "voucher": r.get("voucher_no"),
            "voucher_type": r.get("voucher_type") or "",
            "debit": u.fmt_money(flt(r.get("debit")), currency=currency),
            "credit": u.fmt_money(flt(r.get("credit")), currency=currency),
            "balance": u.fmt_money(flt(r.get("balance")), currency=currency),
        })

    ctx = {
        "party": party,
        "party_name": party_name,
        "party_type": party_type,
        "company": company,
        "months": months,
        "from_date": u.formatdate(from_date, "dd-MM-yyyy"),
        "to_date": u.formatdate(to_date, "dd-MM-yyyy"),
        "currency": currency,
        "entries": entries,
        "count": len(entries),
        "closing": closing,
        "closing_formatted": u.fmt_money(abs(closing), currency=currency),
        "side": "مدين" if closing > 0 else ("دائن" if closing < 0 else ""),
    }

    messages.append({
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(msg_result, ctx).strip(),
    })

    # الكشف ملفاً: التطبيق يطبع التقرير بنفس المرشحات
    if send_pdf:
        messages.append({
            "reply": "statement_pdf",
            "type": "report",
            "report_name": REPORT_NAME,
            "filters": report_filters,
            "format": "PDF",
            "file_name": "كشف حساب " + str(party_name) + " " + ctx["to_date"],
            "caption": frappe.render_template(msg_pdf_caption, ctx).strip(),
        })
    data = ctx

frappe.flags.wa_result = {"error": error, "messages": messages, "data": data}
