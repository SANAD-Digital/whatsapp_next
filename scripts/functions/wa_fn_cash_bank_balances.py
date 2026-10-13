# ==================== WA-FUNCTION ====================
# @function     cash_bank_balances
# @title        أرصدة الصناديق أو البنوك
# @version      1.0.0
# @description  رصيد كل صندوق أو كل بنك وإجماليها من بداية السنة المالية حتى اليوم، من تقرير Cash Trial Balance أو Bank Trial Balance — للموظفين
# @party_types  all
#
# ---------- شروط ظهور الدالة (بدون @requires = متاحة دائماً) ----------
# @requires  report | Cash Trial Balance
# @requires  report | Bank Trial Balance
#
# ---------- المتغيرات المستقبَلة ----------
# @param  account_type  | Select        | required | source=command             | النوع (يحدده الأمر): cash = الصناديق، bank = البنوك
# @param  company       | Link:Company  | optional | default=@default_company  | الشركة
# @param  limit         | Int           | optional | default=20                | عدد الحسابات المعروضة (1–30)
# @param  msg_result    | Template      | optional |                           | رسالة الأرصدة
#
# @options account_type | cash, bank
#
# @default msg_result
# > *{% if is_cash %}أرصدة الصناديق{% else %}أرصدة البنوك{% endif %}* حتى {{ to_date }}
# > {% for r in rows %}
# > {{ r.name }}: {{ r.amount }}{% endfor %}{% if not rows %}
# > {% if is_cash %}لا توجد حسابات صناديق بأرصدة.{% else %}لا توجد حسابات بنكية بأرصدة.{% endif %}{% endif %}
# >
# > الإجمالي: *{{ total_formatted }}*
#
# ---------- القيم الممكن استخدامها في الرسائل: {{ الاسم }} | الرسائل التي تتوفر فيها | الوصف ----------
# @var  account_type     | msg_result  | النوع — cash / bank
# @var  is_cash          | msg_result  | صحيح للصناديق — للشروط: {% if is_cash %}…{% endif %}
# @var  is_bank          | msg_result  | صحيح للبنوك
# @var  company          | msg_result  | الشركة — مثال: SND Accounting
# @var  fiscal_year      | msg_result  | السنة المالية — مثال: 2026
# @var  from_date        | msg_result  | بداية السنة المالية — مثال: 01-01-2026
# @var  to_date          | msg_result  | اليوم — مثال: 13-10-2026
# @var  rows             | msg_result  | الحسابات، لكل سطر: r.name / r.amount (منسّق بعملته) / r.balance (رقم) / r.currency — للتكرار: {% for r in rows %}…{% endfor %}
# @var  count            | msg_result  | عدد الأسطر المعروضة — مثال: 4
# @var  of               | msg_result  | عدد كل الحسابات — مثال: 4
# @var  totals           | msg_result  | الإجمالي لكل عملة، لكل سطر: t.currency / t.amount (منسّق) / t.total (رقم)
# @var  total_formatted  | msg_result  | الإجماليات منسّقة، مفصولة بـ + إذا تعددت العملات — مثال: YER 334,986.00 + $ 1,100.00
#
# ---------- المخرجات المرسَلة ----------
# @reply  result_text  | text |  | الأرصدة (من msg_result)
# ================== END WA-FUNCTION ==================
#
# Server Script
#   Name        : wa_fn_cash_bank_balances
#   Script Type : API
#   API Method  : wa_fn_cash_bank_balances
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل رداً واحداً: result_text. لا ترسل ملفات.
#
# للموظفين: لا تقرأ المرسل. الأمر يحدد account_type ويُقصر على مجموعة مسموحة.
# الصناديق والبنوك هي طرق الدفع (Mode of Payment) من نوع Cash أو Bank كما في تقريري snd_accounting.
# الترتيب: حسب القيمة المطلقة للرصيد، الأكبر أولاً. الإجمالي لكل عملة على حدة.
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict

REPORTS = {"cash": "Cash Trial Balance", "bank": "Bank Trial Balance"}
MAX_LINES = 30

FALLBACK_RESULT = "*{% if is_cash %}أرصدة الصناديق{% else %}أرصدة البنوك{% endif %}*\nالإجمالي: *{{ total_formatted }}*"

u = frappe.utils
flt = u.flt

account_type = (form.get("account_type") or "").strip().lower()
company = form.get("company") or frappe.db.get_single_value("Global Defaults", "default_company")
limit = max(1, min(u.cint(form.get("limit") or 20), MAX_LINES))
msg_result = form.get("msg_result") or FALLBACK_RESULT

error = None
messages = []
data = {}

# ---------- التحقق ----------
if account_type not in REPORTS:
    error = "النوع يجب أن يكون cash أو bank"
elif not company:
    error = "لم تُحدَّد الشركة"

# ---------- السنة المالية الحالية ----------
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
    fy = r[0] if r else None
    if not fy:
        error = "لا توجد سنة مالية حالية"


def by_size(row):
    return abs(row["balance"])


# ---------- استدعاء التقرير ----------
if not error:
    to_date = u.getdate(u.nowdate())
    from_date = fy.year_start_date
    report = frappe.call(
        "frappe.desk.query_report.run",
        report_name=REPORTS[account_type],
        filters={"company": company, "from_date": str(from_date), "to_date": str(to_date)},
    )
    company_currency = frappe.db.get_value("Company", company, "default_currency")

    rows = []
    for r in (report or {}).get("result") or []:
        if not isinstance(r, dict) or not (r.get("party") or r.get("party_name")):
            continue
        # سطر إجمالي إن وُجد: اسمه بين علامتي ' (مثل 'Total')
        if str(r.get("party") or "").startswith("'"):
            continue
        if r.get("closing") is not None:
            balance = flt(r.get("closing"), 2)
        else:
            balance = flt(flt(r.get("closing_debit")) - flt(r.get("closing_credit")), 2)
        rows.append({
            "name": r.get("party_name") or r.get("party"),
            "balance": balance,
            "currency": r.get("currency") or company_currency,
        })

    # الإجمالي لكل عملة، بترتيب ظهورها
    totals = []
    by_currency = {}
    for r in rows:
        if r["currency"] not in by_currency:
            by_currency[r["currency"]] = {"currency": r["currency"], "total": 0.0}
            totals.append(by_currency[r["currency"]])
        by_currency[r["currency"]]["total"] = flt(by_currency[r["currency"]]["total"] + r["balance"], 2)
    if not totals:
        totals.append({"currency": company_currency, "total": 0.0})
    for t in totals:
        t["amount"] = u.fmt_money(t["total"], currency=t["currency"])

    shown = []
    for r in sorted(rows, key=by_size, reverse=True)[:limit]:
        shown.append({
            "name": r["name"],
            "balance": r["balance"],
            "currency": r["currency"],
            "amount": u.fmt_money(r["balance"], currency=r["currency"]),
        })

    ctx = {
        "account_type": account_type,
        "is_cash": account_type == "cash",
        "is_bank": account_type == "bank",
        "company": company,
        "fiscal_year": fy.name,
        "from_date": u.formatdate(from_date, "dd-MM-yyyy"),
        "to_date": u.formatdate(to_date, "dd-MM-yyyy"),
        "rows": shown,
        "count": len(shown),
        "of": len(rows),
        "totals": totals,
        "total_formatted": " + ".join([t["amount"] for t in totals]),
    }

    messages.append({
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(msg_result, ctx).strip(),
    })
    data = ctx

frappe.flags.wa_result = {"error": error, "messages": messages, "data": data}
