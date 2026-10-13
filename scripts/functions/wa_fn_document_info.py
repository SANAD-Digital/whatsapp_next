# ==================== WA-FUNCTION ====================
# @function     document_info
# @title        حالة مستند
# @version      1.0.0
# @description  حالة مستند وتاريخه ومبلغه (فاتورة مبيعات افتراضياً) إذا كان يخص الأستاذ المساعد المرتبط بالرقم
# @party_types  Customer, Supplier
#
# ---------- المتغيرات المستقبَلة ----------
# @param  party_type     | Link:DocType        | required | source=sender   | نوع الأستاذ المساعد
# @param  party          | Dynamic:party_type  | required | source=sender   | الأستاذ المساعد
# @param  document_name  | Data                | required | source=command  | رقم المستند
# @param  document_type  | Link:DocType        | optional |                 | نوع المستند (فارغ = Sales Invoice للعميل، Purchase Invoice للمورد)
# @param  party_field    | Data                | optional |                 | حقل الطرف في المستند (فارغ = customer أو supplier حسب النوع)
# @param  msg_result     | Template            | optional |                 | رسالة حالة المستند
# @param  msg_not_found  | Template            | optional |                 | رسالة المستند غير موجود أو لا يخصك
#
# @default msg_result
# > *{{ doctype_label }} {{ document_name }}*
# > الحالة: {{ status_label }}
# > {% if amount is not none %}المبلغ: {{ amount_formatted }}
# > {% endif %}{% if date %}التاريخ: {{ date }}{% endif %}
#
# @default msg_not_found
# > لم يُعثر على {{ doctype_label }} رقم {{ document_name }}.
#
# ---------- القيم الممكن استخدامها في الرسائل: {{ الاسم }} | الرسائل التي تتوفر فيها | الوصف ----------
# @var  document_name     | all            | رقم المستند كما أُرسل — مثال: ACC-SINV-2026-00012
# @var  doctype           | all            | نوع المستند — مثال: Sales Invoice
# @var  doctype_label     | all            | نوع المستند بلغة المستخدم — مثال: فاتورة المبيعات
# @var  party             | all            | رمز الأستاذ المساعد — مثال: CUST-00012
# @var  party_name        | all            | اسم الأستاذ المساعد — مثال: مؤسسة الأمل
# @var  party_type        | all            | نوع الأستاذ المساعد — مثال: Customer
# @var  status            | msg_result     | حالة المستند كما في النظام — مثال: Paid
# @var  status_label      | msg_result     | الحالة بلغة المستخدم — مثال: مدفوع
# @var  is_draft          | msg_result     | صحيح إذا كان المستند مسودة
# @var  is_cancelled      | msg_result     | صحيح إذا كان المستند ملغى
# @var  amount            | msg_result     | المبلغ رقماً أو لا شيء — مثال: 67000.0
# @var  amount_formatted  | msg_result     | المبلغ منسّقاً — مثال: YER 67,000.00
# @var  currency          | msg_result     | عملة المستند — مثال: YER
# @var  date              | msg_result     | تاريخ المستند — مثال: 07-12-2026
#
# ---------- المخرجات المرسَلة ----------
# @reply  result_text     | text |  | حالة المستند (من msg_result)
# @reply  not_found_text  | text |  | المستند غير موجود أو لا يخص المرسل (من msg_not_found)
# ================== END WA-FUNCTION ==================
#
# Server Script
#   Name        : wa_fn_document_info
#   Script Type : API
#   API Method  : wa_fn_document_info
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل رداً واحداً: result_text أو not_found_text. لا ترسل ملفات.
#
# قاعدة الأمان:
#   «غير موجود» و«يخص طرفاً آخر» يأخذان الرد نفسه (not_found_text) بالنص نفسه،
#   حتى لا يستطيع المرسل أن يعرف أي أرقام المستندات موجودة.
#   تقرأ مجموعة حقول محددة فقط، ولا ترجع المستند كاملاً.
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict
u = frappe.utils
flt = u.flt

READ_FIELDS = ("docstatus", "status", "posting_date", "transaction_date")
AMOUNT_FIELDS = ("grand_total", "rounded_total", "amount", "total")
DEFAULT_DOCTYPE = {"Customer": "Sales Invoice", "Supplier": "Purchase Invoice"}
DEFAULT_PARTY_FIELD = {"Customer": "customer", "Supplier": "supplier"}

FALLBACK_RESULT = "{{ doctype_label }} {{ document_name }}\nالحالة: {{ status_label }}"
FALLBACK_NOT_FOUND = "لم يُعثر على {{ doctype_label }} رقم {{ document_name }}."

party_type = form.get("party_type")
party = form.get("party")
document_name = (form.get("document_name") or "").strip()
doctype = (form.get("document_type") or "").strip() or DEFAULT_DOCTYPE.get(party_type) or "Sales Invoice"
party_field = (form.get("party_field") or "").strip() or DEFAULT_PARTY_FIELD.get(party_type) or ""
msg_result = form.get("msg_result") or FALLBACK_RESULT
msg_not_found = form.get("msg_not_found") or FALLBACK_NOT_FOUND

error = None
messages = []
data = {}
meta = None

# ---------- التحقق ----------
if not party_type or not party:
    error = "رقمك غير مرتبط بحساب لدينا"
elif not document_name:
    error = "الرجاء إرسال رقم المستند"
elif not frappe.db.exists("DocType", doctype):
    error = "الدالة غير مُعدّة: نوع المستند «" + doctype + "» غير موجود"
else:
    meta = frappe.get_meta(doctype)
    # بلا حقل طرف لا شيء يثبت أن المستند يخص المرسل: نرفض، ولا نجيب عن كل مستندات النوع
    if not party_field or not meta.has_field(party_field):
        error = "الدالة غير مُعدّة: حقل الطرف «" + party_field + "» غير موجود في " + doctype

# ---------- اسم الأستاذ المساعد ----------
party_name = party
if not error:
    pmeta = frappe.get_meta(party_type)
    for f in (pmeta.title_field, "customer_name", "supplier_name"):
        if f and pmeta.has_field(f):
            v = frappe.db.get_value(party_type, party, f)
            if v:
                party_name = v
                break

# ---------- قراءة المستند (حقول محددة فقط) ----------
if not error:
    fields = ["name", party_field]
    for f in READ_FIELDS:
        if meta.has_field(f) or f == "docstatus":
            fields.append(f)
    amount_fields = [f for f in AMOUNT_FIELDS if meta.has_field(f)]
    fields = fields + amount_fields
    if meta.has_field("currency"):
        fields.append("currency")
    row = frappe.db.get_value(doctype, document_name, fields, as_dict=True)

    base = {
        "document_name": document_name,
        "doctype": doctype,
        "doctype_label": _(doctype),
        "party": party,
        "party_name": party_name,
        "party_type": party_type,
    }

    # رد واحد لـ «غير موجود» و«ليس لك»
    field = meta.get_field(party_field)
    wrong_type = field.fieldtype == "Link" and field.options and field.options != party_type
    if not row or wrong_type or row.get(party_field) != party:
        messages.append({
            "reply": "not_found_text",
            "type": "text",
            "text": frappe.render_template(msg_not_found, base).strip(),
        })
        data = base
    else:
        docstatus = u.cint(row.get("docstatus"))
        status = row.get("status") or {0: "Draft", 1: "Submitted", 2: "Cancelled"}.get(docstatus)
        amount = None
        for f in amount_fields:
            if row.get(f) is not None:
                amount = flt(row.get(f))
                break
        currency = row.get("currency") or None
        date = row.get("posting_date") or row.get("transaction_date")

        ctx = dict(base)
        ctx.update({
            "document_name": row.get("name"),
            "status": status,
            "status_label": _(status) if status else "",
            "is_draft": docstatus == 0,
            "is_cancelled": docstatus == 2,
            "amount": amount,
            "amount_formatted": u.fmt_money(amount, currency=currency) if amount is not None else "",
            "currency": currency or "",
            "date": u.formatdate(date, "dd-MM-yyyy") if date else "",
        })
        messages.append({
            "reply": "result_text",
            "type": "text",
            "text": frappe.render_template(msg_result, ctx).strip(),
        })
        data = ctx

frappe.flags.wa_result = {"error": error, "messages": messages, "data": data}
