# ==================== WA-FUNCTION ====================
# @function     party_trial_balance
# @title        أرصدة الأستاذ المساعد
# @version      1.0.0
# @description  أكبر أرصدة نوع من الأستاذ المساعد (العملاء أو الموردين…) وإجماليها من بداية السنة المالية حتى اليوم، من تقرير Trial Balance for Party — للموظفين
# @party_types  all
#
# ---------- شروط ظهور الدالة (بدون @requires = متاحة دائماً) ----------
# @requires  report | Trial Balance for Party
#
# ---------- المتغيرات المستقبَلة ----------
# @param  party_type  | Link:DocType  | required | source=command             | نوع الأستاذ المساعد (يحدده الأمر: Customer أو Supplier…)
# @param  company     | Link:Company  | optional | default=@default_company  | الشركة
# @param  limit       | Int           | optional | default=10                | عدد الأرصدة المعروضة (1–30)
# @param  msg_result  | Template      | optional |                           | رسالة الأرصدة
#
# @default msg_result
# > *{{ title }}* حتى {{ to_date }}
# > {% for r in rows %}
# > {{ loop.index }}. {{ r.name }}: {{ r.amount }}{% endfor %}{% if not rows %}
# > لا توجد أرصدة.{% endif %}
# >
# > الإجمالي ({{ of }}): *{{ total_formatted }}*
#
# ---------- القيم الممكن استخدامها في الرسائل: {{ الاسم }} | الرسائل التي تتوفر فيها | الوصف ----------
# @var  title            | msg_result  | العنوان حسب النوع — مثال: أرصدة العملاء
# @var  party_type       | msg_result  | نوع الأستاذ المساعد — مثال: Customer
# @var  company          | msg_result  | الشركة — مثال: SND Accounting
# @var  fiscal_year      | msg_result  | السنة المالية — مثال: 2026
# @var  from_date        | msg_result  | بداية السنة المالية — مثال: 01-01-2026
# @var  to_date          | msg_result  | اليوم — مثال: 13-10-2026
# @var  currency         | msg_result  | عملة الشركة — مثال: YER
# @var  rows             | msg_result  | الأرصدة الأكبر، لكل سطر: r.name / r.party / r.amount (منسّق بإشارته) / r.balance (رقم) — للتكرار: {% for r in rows %}…{% endfor %}
# @var  count            | msg_result  | عدد الأسطر المعروضة — مثال: 10
# @var  of               | msg_result  | عدد كل الأطراف ذات الرصيد — مثال: 42
# @var  total            | msg_result  | إجمالي كل الأرصدة رقماً (موجب مدين، سالب دائن) — مثال: 152000.0
# @var  total_formatted  | msg_result  | الإجمالي منسّقاً بإشارته — مثال: YER 152,000.00
#
# ---------- المخرجات المرسَلة ----------
# @reply  result_text  | text |  | الأرصدة (من msg_result)
# ================== END WA-FUNCTION ==================
#
# Server Script
#   Name        : wa_fn_party_trial_balance
#   Script Type : API
#   API Method  : wa_fn_party_trial_balance
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل رداً واحداً: result_text. لا ترسل ملفات.
#
# للموظفين: لا تقرأ المرسل. الأمر يحدد party_type ويُقصر على مجموعة مسموحة.
# الترتيب: حسب القيمة المطلقة للرصيد الختامي، الأكبر أولاً؛ الإجمالي لكل الأطراف لا للمعروضة فقط.
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict

REPORT_NAME = "Trial Balance for Party"
MAX_LINES = 30
TITLES = {"Customer": "أرصدة العملاء", "Supplier": "أرصدة الموردين", "Employee": "أرصدة الموظفين",
          "Shareholder": "أرصدة المساهمين"}

FALLBACK_RESULT = "*{{ title }}* حتى {{ to_date }}\nالإجمالي ({{ of }}): *{{ total_formatted }}*"

u = frappe.utils
flt = u.flt

party_type = (form.get("party_type") or "").strip()
company = form.get("company") or frappe.db.get_single_value("Global Defaults", "default_company")
limit = max(1, min(u.cint(form.get("limit") or 10), MAX_LINES))
msg_result = form.get("msg_result") or FALLBACK_RESULT

error = None
messages = []
data = {}

# ---------- التحقق ----------
if not party_type:
    error = "الأمر لم يحدد نوع الأستاذ المساعد"
elif not frappe.db.exists("Party Type", party_type):
    error = "«" + party_type + "» ليس نوع أستاذ مساعد"
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
        report_name=REPORT_NAME,
        filters={
            "company": company,
            "fiscal_year": fy.name,
            "from_date": str(from_date),
            "to_date": str(to_date),
            "party_type": party_type,
            "show_zero_values": 0,
        },
    )
    currency = frappe.db.get_value("Company", company, "default_currency")

    rows = []
    for r in (report or {}).get("result") or []:
        # سطر الإجمالي في التقرير اسمه بين علامتي ' (مثل 'Totals') وليس طرفاً
        if not isinstance(r, dict) or not r.get("party") or str(r.get("party")).startswith("'"):
            continue
        balance = flt(flt(r.get("closing_debit")) - flt(r.get("closing_credit")), 2)
        if not balance:
            continue
        rows.append({"party": r.get("party"), "balance": balance})

    total = flt(sum([r["balance"] for r in rows]), 2)
    top = sorted(rows, key=by_size, reverse=True)[:limit]

    # أسماء الأطراف المعروضة فقط
    meta = frappe.get_meta(party_type)
    name_field = None
    for f in (meta.title_field, "customer_name", "supplier_name", "employee_name", "title"):
        if f and meta.has_field(f):
            name_field = f
            break
    names = {}
    if name_field and top:
        for n in frappe.get_all(party_type, filters={"name": ["in", [r["party"] for r in top]]},
                                fields=["name", name_field]):
            names[n.name] = n.get(name_field)

    shown = []
    for r in top:
        shown.append({
            "name": names.get(r["party"]) or r["party"],
            "party": r["party"],
            "balance": r["balance"],
            "amount": u.fmt_money(r["balance"], currency=currency),
        })

    ctx = {
        "title": TITLES.get(party_type) or ("أرصدة " + _(party_type)),
        "party_type": party_type,
        "company": company,
        "fiscal_year": fy.name,
        "from_date": u.formatdate(from_date, "dd-MM-yyyy"),
        "to_date": u.formatdate(to_date, "dd-MM-yyyy"),
        "currency": currency,
        "rows": shown,
        "count": len(shown),
        "of": len(rows),
        "total": total,
        "total_formatted": u.fmt_money(total, currency=currency),
    }

    messages.append({
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(msg_result, ctx).strip(),
    })
    data = ctx

frappe.flags.wa_result = {"error": error, "messages": messages, "data": data}
