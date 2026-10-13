# ==================== WA-FUNCTION ====================
# @function     ping
# @title        فحص الاتصال
# @version      1.0.0
# @description  يعيد النص الذي يرسله المرسل مع وقت الخادم، للتأكد من أن الأوامر تصل وتُجاب
# @party_types  all
#
# ---------- المتغيرات المستقبَلة ----------
# @param  text        | Data                | optional | source=command  | النص المرسل (فارغ = pong)
# @param  party_type  | Link:DocType        | optional | source=sender   | نوع الأستاذ المساعد (إن كان الرقم مرتبطاً)
# @param  party       | Dynamic:party_type  | optional | source=sender   | الأستاذ المساعد (إن كان الرقم مرتبطاً)
# @param  msg_result  | Template            | optional |                 | رسالة الرد
#
# @default msg_result
# > pong: {{ echo }} ({{ at }})
#
# ---------- القيم الممكن استخدامها في الرسائل: {{ الاسم }} | الرسائل التي تتوفر فيها | الوصف ----------
# @var  echo          | msg_result  | النص المرسل، أو pong إذا لم يُرسل نص — مثال: مرحبا
# @var  at            | msg_result  | وقت الخادم — مثال: 2026-10-13 14:05
# @var  sender_known  | msg_result  | صحيح إذا كان الرقم مرتبطاً بأستاذ مساعد
# @var  display_name  | msg_result  | اسم الأستاذ المساعد إن كان الرقم مرتبطاً، وإلا فارغ — مثال: مؤسسة الأمل
# @var  party         | msg_result  | رمز الأستاذ المساعد أو فارغ — مثال: CUST-00012
# @var  party_type    | msg_result  | نوع الأستاذ المساعد أو فارغ — مثال: Customer
#
# ---------- المخرجات المرسَلة ----------
# @reply  result_text  | text |  | الرد (من msg_result)
# ================== END WA-FUNCTION ==================
#
# Server Script
#   Name        : wa_fn_ping
#   Script Type : API
#   API Method  : wa_fn_ping
#
# العقد:
#   يُشغَّل بـ run_script("<اسم السكربت>") من المحرك أو من شاشة الاختبار،
#   بعد أن يضع المستدعي المتغيرات في frappe.form_dict.
#   المدخلات: frappe.form_dict بأسماء @param (بعد أن يملأ المحرك الافتراضيات)
#   المخرجات: frappe.flags.wa_result = {"error", "messages", "data"}
#   اسم الـ API Method يبدأ دائماً بـ wa_fn_ — الحماية تعتمد على ذلك.
#   ترسل رداً واحداً: result_text. لا تقرأ أي بيانات غير اسم الأستاذ المساعد.
# ============================================================

# ---------- حماية: لا تعمل من الرابط المباشر ----------
if (frappe.form_dict.get("cmd") or "").startswith("wa_fn_"):
    frappe.throw("Not allowed", frappe.PermissionError)

form = frappe.form_dict
u = frappe.utils

FALLBACK_RESULT = "pong: {{ echo }} ({{ at }})"

text = (form.get("text") or "").strip()
party_type = form.get("party_type") or ""
party = form.get("party") or ""
msg_result = form.get("msg_result") or FALLBACK_RESULT

# ---------- اسم الأستاذ المساعد (إن كان الرقم مرتبطاً) ----------
display_name = ""
if party_type and party and frappe.db.exists("DocType", party_type):
    meta = frappe.get_meta(party_type)
    name_fields = []
    for f in (meta.title_field, "customer_name", "supplier_name", "employee_name", "title"):
        if f and f not in name_fields and meta.has_field(f):
            name_fields.append(f)
    p = frappe.db.get_value(party_type, party, ["name"] + name_fields, as_dict=True)
    if p:
        display_name = party
        for f in name_fields:
            if p.get(f):
                display_name = p.get(f)
                break

ctx = {
    "echo": text or "pong",
    "at": u.format_datetime(u.now_datetime(), "yyyy-MM-dd HH:mm"),
    "sender_known": bool(display_name),
    "display_name": display_name,
    "party": party,
    "party_type": party_type,
}

frappe.flags.wa_result = {
    "error": None,
    "messages": [{
        "reply": "result_text",
        "type": "text",
        "text": frappe.render_template(msg_result, ctx).strip(),
    }],
    "data": ctx,
}
