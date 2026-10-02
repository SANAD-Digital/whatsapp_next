# Live BUSINESS test: a realistic trading company's day on top of `live_e2e.py`'s engine — real
# ERPNext documents (sales order, delivery note, invoices, receipts) in the demo company, and the
# REAL WhatsApp messages the app sends about them: notifications with the print-format PDF,
# report alerts, product campaigns, templates, a bulk send. Content is Arabic, as a Yemeni solar
# equipment trader would write it.
#
#   cd ~/frappe-bench
#   env/bin/python apps/whatsapp_next/scripts/live_business.py --out <dir> --pw-dir <dir> --only setup
#   …                                                         --only invoices | orders | payments | reminder
#   …                                                         --only alerts | campaign_offer | campaign_poll | templates | bulk
#   …                                                         --only commands_plan          # the owner's phone list
#   …                                                         --only verify_inbound --since "2026-10-01 22:00:00"
#   …                                                         --only consistency screens cleanup
#
# How it acts: WhatsApp actions and ERPNext documents go over HTTP as `e2e-biz@example.com` (an
# accountant: accounting / selling / stock roles + WhatsApp Manager, language Arabic, time zone
# Asia/Aden on a site that runs Asia/Kolkata) — the same whitelisted calls the Desk makes
# ("Create → Delivery Note", "Create → Payment", `frappe.client.submit`). The database is read
# in-process only to verify, and once as Administrator for what needs System Manager (the user, a
# print format, a letter head).
#
# Hard limits, enforced in code:
#   * recipients: only +967770788938 and +967777667663 — every payload is scanned before it leaves,
#     a notification is previewed on its document and must resolve to exactly the expected number
#     before the document is submitted, and after every scenario the rows this run caused are
#     scanned (a foreign open one is cancelled and the run stops);
#   * device: only WA-DEV-014; at most 60 real messages for the whole task, send actions ≥ 8 s apart;
#   * accounting documents only in `SANAD Digital (Demo)`; nothing pre-existing is cancelled.
#     Every record created carries `E2E-BIZ` where the DocType has a free-text field and is listed
#     in state.json; `cleanup` disables the notifications / alerts and restores the owner's one.

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import live_e2e as base  # noqa: E402
from live_e2e import ApiError, BudgetError, Engine, GuardError, Scenario  # noqa: E402

MARK = "E2E-BIZ"
COMPANY = "SANAD Digital (Demo)"
ABBR = "SDD"
DEVICE = base.DEVICE
SENDER = "+967782309999"
MAX_REAL = 60
GAP_SECONDS = 8
USER = "e2e-biz@example.com"
USER_ROLES = (
	"WhatsApp Manager", "WhatsApp Agent", "WhatsApp Contact User",
	"Accounts Manager", "Accounts User", "Sales Manager", "Sales User", "Sales Master Manager",
	"Stock Manager", "Stock User", "Item Manager", "Purchase Manager", "Purchase User", "Purchase Master Manager",
)
USER_TZ = "Asia/Aden"
WAREHOUSE = f"Stores - {ABBR}"
TAX_TEMPLATE = f"Yemen Tax - {ABBR}"
LETTER_HEAD = f"{MARK} ترويسة سند الرقمية"
RECEIPT_FORMAT = f"{MARK} سند قبض"
ITEM_GROUP = "منظومات الطاقة الشمسية"
SUPPLIER = "مؤسسة الشروق لاستيراد أنظمة الطاقة"
OWNER_SI_NOTIFICATION = "فاتورة بيع إشعار"  # the owner's own notification on Sales Invoice / Submit

# the two people, their existing Contacts, and the customer each buys for in this test
PEOPLE = {
	"A": {
		"phone": "+967770788938",
		"contact": "Albashq Alshwmy-Grant Plastics Ltd.",
		"name": "Albashq Alshwmy",
		"customer": "مؤسسة النور للتجارة العامة",
	},
	"B": {
		"phone": "+967777667663",
		"contact": "احمد محمد الكحلاني-West View Software Ltd.",
		"name": "احمد محمد الكحلاني",
		"customer": "شركة الوادي للمقاولات والطاقة",
	},
}
ALLOWED = {p["phone"] for p in PEOPLE.values()}
ALLOWED_DIGITS = {p.lstrip("+") for p in ALLOWED}
ALLOWED_CONTACTS = {p["contact"] for p in PEOPLE.values()}
CUSTOMERS = tuple(p["customer"] for p in PEOPLE.values())

# code, Arabic name, UOM, selling rate (YER), cost, opening qty, description
ITEMS = (
	("SOL-PNL-550", "لوح شمسي مونو 550 واط", "حبة", 48000, 39500, 60, "لوح شمسي أحادي البلورة 550 واط، كفاءة 21.3%، ضمان 12 سنة"),
	("SOL-BAT-200", "بطارية جل 200 أمبير 12 فولت", "حبة", 125000, 104000, 40, "بطارية جل عميقة التفريغ 200 أمبير/ساعة 12 فولت، ضمان سنتان"),
	("SOL-INV-5K", "انفرتر هايبرد 5 كيلو واط", "حبة", 420000, 355000, 10, "انفرتر هايبرد 5 كيلو واط 48 فولت مع منظم شحن مدمج"),
	("SOL-MPPT-60", "منظم شحن MPPT 60 أمبير", "حبة", 68000, 54000, 25, "منظم شحن MPPT 60 أمبير 12/24/48 فولت بشاشة رقمية"),
	("SOL-CBL-6", "كابل شمسي 6 مم - لفة 100 متر", "لفة", 55000, 43000, 30, "كابل شمسي نحاس 6 مم² مزدوج العزل، لفة 100 متر"),
	("SOL-LED-50", "كشاف LED 50 واط", "حبة", 9500, 6800, 200, "كشاف LED خارجي 50 واط مقاوم للماء IP65"),
)
RATE = {i[0]: i[3] for i in ITEMS}

_cond_customers = ", ".join(json.dumps(c, ensure_ascii=False) for c in CUSTOMERS)
COND_SELLING = f'doc.company == "{COMPANY}" and doc.customer in ({_cond_customers})'
COND_PAYMENT = f'doc.company == "{COMPANY}" and doc.payment_type == "Receive" and doc.party in ({_cond_customers})'

SIGN = "\n\n*سند الرقمية* — حلول الطاقة الشمسية\nصنعاء، شارع الستين · واتساب 782309999"

TEMPLATES = {
	f"{MARK} إشعار فاتورة مبيعات": (
		"Sales Invoice",
		"السادة / *{{ doc.customer_name }}* المحترمون\n"
		"عناية الأخ {{ recipient.display_name }}، تحية طيبة 🌞\n\n"
		"تم إصدار فاتورة المبيعات رقم *{{ doc.name }}*\n"
		"📅 التاريخ: {{ frappe.utils.formatdate(doc.posting_date, 'dd-MM-yyyy') }}\n"
		"🧾 عدد الأصناف: {{ doc.items | length }}\n"
		"💰 الإجمالي شامل الضريبة: *{{ frappe.utils.fmt_money(doc.grand_total, 0) }} ريال يمني*\n"
		"⏳ تاريخ الاستحقاق: {{ frappe.utils.formatdate(doc.due_date, 'dd-MM-yyyy') }}\n\n"
		"مرفق لكم نسخة الفاتورة (PDF). نشكر لكم ثقتكم." + SIGN,
	),
	f"{MARK} إشعار سند قبض": (
		"Payment Entry",
		"السادة / *{{ doc.party_name }}* المحترمون\n"
		"عناية الأخ {{ recipient.display_name }}\n\n"
		"✅ استلمنا منكم مبلغ *{{ frappe.utils.fmt_money(doc.paid_amount, 0) }} ريال يمني*\n"
		"🧾 سند قبض رقم *{{ doc.name }}* بتاريخ {{ frappe.utils.formatdate(doc.posting_date, 'dd-MM-yyyy') }}\n"
		"💳 طريقة الدفع: {{ _(doc.mode_of_payment) }}"
		"{% if doc.reference_no %} — مرجع {{ doc.reference_no }}{% endif %}\n"
		"{% for r in doc.references %}"
		# on a submitted payment ERPNext stores what is left AFTER it in the row's `outstanding_amount`
		"• فاتورة {{ r.reference_name }}: سُدِّد {{ frappe.utils.fmt_money(r.allocated_amount, 0) }}"
		" والمتبقي {{ frappe.utils.fmt_money(r.outstanding_amount, 0) }} ريال\n"
		"{% endfor %}\n"
		"مرفق لكم سند القبض (PDF)." + SIGN,
	),
	f"{MARK} شكر على السداد": (
		"Sales Invoice",
		"الأخ {{ recipient.display_name }} — *{{ doc.customer_name }}*\n\n"
		"نشكركم على سداد كامل قيمة الفاتورة *{{ doc.name }}* "
		"بمبلغ {{ frappe.utils.fmt_money(doc.grand_total, 0) }} ريال يمني 🙏\n"
		"رصيد الفاتورة الآن: {{ frappe.utils.fmt_money(doc.outstanding_amount, 0) }} ريال.\n"
		"يسعدنا خدمتكم دائماً." + SIGN,
	),
	f"{MARK} تأكيد طلب بيع": (
		"Sales Order",
		"السادة / *{{ doc.customer_name }}* المحترمون\n"
		"عناية الأخ {{ recipient.display_name }}\n\n"
		"تم تأكيد طلبكم رقم *{{ doc.name }}* ✅\n"
		"{% for i in doc.items %}• {{ i.item_name }} × {{ i.qty | int }}\n{% endfor %}"
		"💰 الإجمالي شامل الضريبة: *{{ frappe.utils.fmt_money(doc.grand_total, 0) }} ريال يمني*\n"
		"🚚 موعد التسليم: {{ frappe.utils.formatdate(doc.delivery_date, 'dd-MM-yyyy') }}\n\n"
		"مرفق لكم تأكيد الطلب (PDF)." + SIGN,
	),
	f"{MARK} إشعار تسليم": (
		"Delivery Note",
		"الأخ {{ recipient.display_name }} — *{{ doc.customer_name }}*\n\n"
		"🚚 تم تسليم بضاعتكم بموجب إذن التسليم رقم *{{ doc.name }}* "
		"بتاريخ {{ frappe.utils.formatdate(doc.posting_date, 'dd-MM-yyyy') }}\n"
		"{% for i in doc.items %}• {{ i.item_name }} × {{ i.qty | int }}\n{% endfor %}\n"
		"نرجو مطابقة الكميات عند الاستلام وإبلاغنا بأي ملاحظة خلال 48 ساعة." + SIGN,
	),
	f"{MARK} تذكير فاتورة متأخرة": (
		"Sales Invoice",
		"الأخ {{ recipient.display_name }} — *{{ doc.customer_name }}*\n\n"
		"تذكير ودّي 🔔: الفاتورة رقم *{{ doc.name }}* استحقت بتاريخ "
		"{{ frappe.utils.formatdate(doc.due_date, 'dd-MM-yyyy') }} "
		"(منذ {{ frappe.utils.date_diff(today, doc.due_date) }} أيام).\n"
		"المبلغ المتبقي: *{{ frappe.utils.fmt_money(doc.outstanding_amount, 0) }} ريال يمني*\n\n"
		"نرجو التكرم بالسداد، وإن كنتم قد سددتم فنعتذر عن الإزعاج." + SIGN,
	),
	f"{MARK} تذكير بموعد التركيب": (
		"Sales Order",
		"الأخ {{ recipient.display_name }}، السلام عليكم\n\n"
		"نذكّركم بموعد تركيب المنظومة ضمن طلبكم *{{ doc.name }}* يوم "
		"{{ frappe.utils.formatdate(doc.delivery_date, 'dd-MM-yyyy') }} الساعة 9:00 صباحاً 🛠️\n"
		"سيتواصل معكم الفريق الفني قبل الوصول. نرجو تجهيز موقع التركيب وتوفير مصدر كهرباء للفحص." + SIGN,
	),
	f"{MARK} تذكير بالمبلغ المتبقي": (
		"Sales Invoice",
		"الأخ {{ recipient.display_name }} — *{{ doc.customer_name }}*\n\n"
		"بخصوص الفاتورة *{{ doc.name }}* بإجمالي {{ frappe.utils.fmt_money(doc.grand_total, 0) }} ريال:\n"
		"✅ المسدَّد: {{ frappe.utils.fmt_money(doc.grand_total - doc.outstanding_amount, 0) }} ريال\n"
		"⏳ المتبقي: *{{ frappe.utils.fmt_money(doc.outstanding_amount, 0) }} ريال يمني* "
		"يستحق في {{ frappe.utils.formatdate(doc.due_date, 'dd-MM-yyyy') }}\n\n"
		"يمكنكم السداد نقداً في المعرض أو بحوالة عبر الكريمي." + SIGN,
	),
}

RECEIPT_HTML = """{% if letter_head and not no_letterhead %}<div class="letter-head">{{ letter_head }}</div>{% endif %}
<div dir="rtl" style="font-family: 'DejaVu Sans', sans-serif; font-size: 13px; color: #1f272e;">
<table style="width:100%; border-bottom: 3px solid #173561; margin-bottom: 14px;"><tr>
<td style="font-size: 26px; font-weight: bold; color: #173561; padding: 6px 0;">سند قبض</td>
<td style="text-align: left; font-size: 12px; color: #5b6b7d;">رقم السند<br><b style="font-size: 15px; color: #173561;" dir="ltr">{{ doc.name }}</b></td>
</tr></table>
<table style="width:100%; border-collapse: collapse;" cellpadding="7">
<tr><td style="width: 24%; background: #f1f3f5; border: 1px solid #d1d8dd;">التاريخ</td><td style="border: 1px solid #d1d8dd;">{{ frappe.utils.formatdate(doc.posting_date, "dd-MM-yyyy") }}</td>
<td style="width: 20%; background: #f1f3f5; border: 1px solid #d1d8dd;">طريقة الدفع</td><td style="border: 1px solid #d1d8dd;">{{ _(doc.mode_of_payment or "") }}</td></tr>
<tr><td style="background: #f1f3f5; border: 1px solid #d1d8dd;">استلمنا من السادة</td><td colspan="3" style="border: 1px solid #d1d8dd; font-weight: bold;">{{ doc.party_name }}</td></tr>
<tr><td style="background: #f1f3f5; border: 1px solid #d1d8dd;">مبلغاً وقدره</td><td colspan="3" style="border: 1px solid #d1d8dd;"><b style="font-size: 16px;">{{ frappe.utils.fmt_money(doc.paid_amount, 2) }} ريال يمني</b><br>{{ frappe.utils.money_in_words(doc.paid_amount, doc.paid_to_account_currency) }}</td></tr>
{% if doc.reference_no %}<tr><td style="background: #f1f3f5; border: 1px solid #d1d8dd;">رقم المرجع / الحوالة</td><td style="border: 1px solid #d1d8dd;" dir="ltr">{{ doc.reference_no }}</td>
<td style="background: #f1f3f5; border: 1px solid #d1d8dd;">تاريخ المرجع</td><td style="border: 1px solid #d1d8dd;">{{ frappe.utils.formatdate(doc.reference_date, "dd-MM-yyyy") }}</td></tr>{% endif %}
<tr><td style="background: #f1f3f5; border: 1px solid #d1d8dd;">أُودِع في</td><td colspan="3" style="border: 1px solid #d1d8dd;">{{ doc.paid_to }}</td></tr>
</table>
{% if doc.references %}
<p style="margin: 16px 0 6px; font-weight: bold; color: #173561;">وذلك سداداً للفواتير التالية</p>
<table style="width:100%; border-collapse: collapse;" cellpadding="6">
<tr>{% for h in ["م", "المستند", "إجمالي الفاتورة", "المسدَّد بهذا السند", "المتبقي بعد السداد"] %}<th style="background: #173561; color: #ffffff !important; text-align: {{ "right" if loop.index < 3 else "left" }}; border: 1px solid #173561;">{{ h }}</th>{% endfor %}</tr>
{% for r in doc.references %}<tr>
<td style="border: 1px solid #d1d8dd;">{{ loop.index }}</td><td style="border: 1px solid #d1d8dd;" dir="ltr">{{ r.reference_name }}</td>
<td style="border: 1px solid #d1d8dd; text-align: left;">{{ frappe.utils.fmt_money(r.total_amount, 2) }}</td>
<td style="border: 1px solid #d1d8dd; text-align: left; font-weight: bold;">{{ frappe.utils.fmt_money(r.allocated_amount, 2) }}</td>
<td style="border: 1px solid #d1d8dd; text-align: left;">{{ frappe.utils.fmt_money(r.outstanding_amount, 2) }}</td></tr>{% endfor %}
</table>{% endif %}
{% if doc.remarks %}<p style="margin-top: 14px; color: #5b6b7d;">البيان: {{ doc.remarks }}</p>{% endif %}
<table style="width:100%; margin-top: 60px;"><tr>
<td style="width: 33%; text-align: center;">المستلم (أمين الصندوق)<br><br>....................</td>
<td style="width: 33%; text-align: center;">المحاسب<br><br>....................</td>
<td style="width: 33%; text-align: center;">الختم<br><br>....................</td></tr></table>
</div>"""

LETTER_HEAD_HTML = """<table dir="rtl" style="width:100%; font-family: 'DejaVu Sans', sans-serif; border-bottom: 2px solid #f2b632; margin-bottom: 10px;"><tr>
<td style="padding: 4px 0;"><div style="font-size: 20px; font-weight: bold; color: #173561;">سند الرقمية للتجارة وحلول الطاقة الشمسية</div>
<div style="font-size: 11px; color: #5b6b7d;">ألواح · بطاريات · انفرترات · تركيب وصيانة</div></td>
<td style="text-align: left; font-size: 11px; color: #5b6b7d;">صنعاء — شارع الستين الغربي<br>هاتف / واتساب: <span dir="ltr">+967 782 309 999</span><br>sales@sanad.digital</td>
</tr></table>"""


# --------------------------------------------------------------------------- guard


def guard(obj, where: str = "payload") -> None:
	"""Refuse any recipient but the two allowed numbers / their two Contacts, anywhere in `obj`."""
	if isinstance(obj, dict):
		rtype = obj.get("recipient_type")
		# "Document Field" resolves from a document: `expect_notification` checks it before submit
		if rtype and rtype not in ("Phone", "Fixed Number", "Individual", "Document Field"):
			raise GuardError(f"{where}: recipient_type {rtype!r} could reach other people")
		for k, v in obj.items():
			if k in base.PHONE_KEYS and v not in (None, "", []):
				for one in v if isinstance(v, list) else [v]:
					s = str(one)
					if "@" in s or base._digits(s) not in ALLOWED_DIGITS:
						raise GuardError(f"{where}.{k}: {s!r} is not an allowed recipient")
			if k in ("contacts", "contact") and v:
				for one in v if isinstance(v, list) else [v]:
					if one not in ALLOWED_CONTACTS:
						raise GuardError(f"{where}.{k}: contact {one!r} is not one of the two test contacts")
			if k == "groups" and v:
				for one in v if isinstance(v, list) else [v]:
					if not str(one).startswith(MARK):
						raise GuardError(f"{where}.{k}: group {one!r} is not a test group")
			guard(v, f"{where}.{k}")
	elif isinstance(obj, list):
		for i, v in enumerate(obj):
			guard(v, f"{where}[{i}]")


base.guard = guard  # `Client.write/insert/update` call the module's guard


class Client(base.Client):
	@staticmethod
	def _path(method: str) -> str:
		return method if method.startswith(("frappe.", "whatsapp_next.", "erpnext.")) else f"whatsapp_next.api.v1.{method}"

	def get_doc(self, doctype: str, name: str) -> dict:
		r = self.s.get(f"{self.base}/api/resource/{doctype}/{base.requests.utils.quote(name, safe='')}", timeout=120)
		return self._unwrap(r)

	def submit(self, doc: dict) -> dict:
		"""The Desk's Submit: the saved document as loaded, through `frappe.client.submit`."""
		return self.write("frappe.client.submit", doc=doc)


# --------------------------------------------------------------------------- engine


class Biz(Engine):
	# ---- state
	def _load_state(self) -> dict:
		st = super()._load_state()
		st.setdefault("docs", [])  # [{doctype, name, customer, amount, note}]
		st.setdefault("log", [])  # one row per verified message
		st.setdefault("restore", {})
		return st

	def record_doc(self, doctype: str, name: str, customer: str = "", amount=None, note: str = "") -> None:
		if not any(d["doctype"] == doctype and d["name"] == name for d in self.state["docs"]):
			self.state["docs"].append({"doctype": doctype, "name": name, "customer": customer, "amount": amount, "note": note})
			self.save_state()

	def kept(self, key: str, default=None):
		return self.state.setdefault("kept", {}).get(key, default)

	def keep(self, key: str, value) -> None:
		self.state.setdefault("kept", {})[key] = value
		self.save_state()

	# ---- budget / pacing over both numbers
	def _since(self) -> str:
		return self.state.get("first_run_at") or str(self.run_start)

	def used_budget(self) -> tuple[int, int]:
		f = self.fresh()
		rows = f.get_all(
			"WhatsApp Log",
			filters={"phone_e164": ("in", list(ALLOWED)), "creation": (">=", self._since())},
			fields=["status", "provider_message_id"],
		)
		real = sum(1 for r in rows if r.status in base.REAL or (r.status == "Failed" and r.provider_message_id))
		pending = sum(1 for r in rows if r.status in base.OPEN and r.status != "Sending")
		return real, pending

	def reserve(self, n: int) -> None:
		real, pending = self.used_budget()
		if real + pending + n > MAX_REAL:
			raise BudgetError(f"cap: {real} sent + {pending} pending + {n} new > {MAX_REAL}")
		if not self.state.get("first_run_at") and not self.args.dry_run:
			self.state["first_run_at"] = str(self.run_start)
			self.save_state()

	def pace(self) -> None:
		"""Wait until nothing of this run is still on its way and the last real send is ≥ GAP ago."""
		deadline = time.time() + base.SEND_TIMEOUT
		busy = []
		while time.time() < deadline:
			f = self.fresh()
			busy = f.get_all(
				"WhatsApp Log",
				filters={"phone_e164": ("in", list(ALLOWED)), "creation": (">=", self.run_start), "status": ("in", ["Queued", "Sending", "Unsent"])},
				fields=["name", "scheduled_at"],
			)
			busy = [b for b in busy if not b.scheduled_at or b.scheduled_at <= self.site_now() + dt.timedelta(seconds=90)]
			if not busy:
				break
			time.sleep(5)
		else:
			raise BudgetError(f"pacing: {[b.name for b in busy]} still on their way after {base.SEND_TIMEOUT} s")
		last = self.fresh().db.sql(
			"select max(sent_at) from `tabWhatsApp Log` where phone_e164 in %s and sent_at is not null", (tuple(ALLOWED),)
		)[0][0]
		if last:
			gap = (self.site_now() - last).total_seconds()
			if gap < GAP_SECONDS:
				time.sleep(GAP_SECONDS - gap)

	def scan_foreign(self, sc: Scenario) -> None:
		"""Rows this run caused to anyone but the two numbers: cancel what is still open and stop."""
		f = self.fresh()
		mine = self.state["created"]
		rows = f.get_all(
			"WhatsApp Log",
			filters={"creation": (">=", self.run_start)},
			fields=["name", "phone_e164", "jid", "status", "owner", "campaign", "notification", "notification_alert"],
		)
		bad = [
			r
			for r in rows
			if (r.phone_e164 or r.jid) not in ALLOWED
			and (
				r.owner == USER
				or r.campaign in mine.get("campaigns", []) + mine.get("bulk_campaigns", [])
				or r.notification in mine.get("notifications", [])
				or r.notification_alert in mine.get("alerts", [])
			)
		]
		for r in bad:
			if r.status in base.OPEN and self.client:
				try:
					self.client.write("messages.cancel", name=r.name, reason="E2E-BIZ guard: foreign recipient")
				except Exception as exc:
					sc.notes.append(f"guard cancel of {r.name} failed: {exc}")
		if bad:
			sc.check("no message to any other recipient", False, str([(r.name, r.phone_e164, r.status) for r in bad]))
			raise GuardError(f"rows to other recipients: {[r.name for r in bad]}")

	# ---- verifying one message
	def verify_message(self, sc: Scenario, name: str, label: str, *, phone: str, queue: bool = True, kind: str = "", source: str = "") -> dict:
		"""Wait for Sent then Delivered/Read; timestamps, queue item, recipient. Records the row."""
		t0 = time.time()
		row = self.wait_status(name, ("Sent", "Delivered", "Read"), base.SEND_TIMEOUT)
		if row.get("status") == "Sent":
			row = self.wait_status(name, ("Delivered", "Read"), base.DELIVER_TIMEOUT)
		st = row.get("status")
		c = row.get("creation")
		to_sent = (row["sent_at"] - c).total_seconds() if row.get("sent_at") and c else None
		info = {
			"label": label, "name": name, "phone": row.get("phone_e164"), "kind": kind or row.get("message_type"),
			"source": source or row.get("source_type"), "status": st, "creation": str(c), "sent_at": str(row.get("sent_at")),
			"delivered_at": str(row.get("delivered_at")), "read_at": str(row.get("read_at")),
			"queue_to_sent_s": round(to_sent, 1) if to_sent is not None else None,
			"waited_s": round(time.time() - t0, 1),
			"error": row.get("error_code") and f"{row.get('error_code')}: {row.get('error_message')}",
		}
		sc.messages.append(info)
		self.state["log"] = [m for m in self.state["log"] if m["name"] != name] + [info]
		if name not in self.state["messages"]:
			self.state["messages"].append(name)
		self.save_state()
		sc.check(f"{label}: recipient is {phone}", row.get("phone_e164") == phone, row.get("phone_e164"))
		sc.check(f"{label}: device is {DEVICE}", row.get("device") == DEVICE, row.get("device"))
		sc.check(f"{label}: reached Sent", st in ("Sent", "Delivered", "Read"), f"{st} {info['error'] or ''}")
		sc.check(f"{label}: reached Delivered/Read", st in ("Delivered", "Read"), st)
		for f_ in ("sent_at", "delivered_at", "read_at"):
			v = row.get(f_)
			if v and c:
				sc.check(f"{label}: {f_} not before creation, not in the future", c - dt.timedelta(seconds=1) <= v <= self.site_now() + dt.timedelta(seconds=60), f"{f_}={v} creation={c}")
		if row.get("sent_at") and row.get("delivered_at"):
			sc.check(f"{label}: delivered_at ≥ sent_at", row["delivered_at"] >= row["sent_at"] - dt.timedelta(seconds=2), "")
		if queue:
			qi = row.get("queue_item")
			q = self.fresh().db.get_value("WhatsApp Queue Item", qi, ["status", "attempts", "completed_at", "dead_letter_reason"], as_dict=True) if qi else None
			sc.check(f"{label}: queue item Completed", bool(q) and q.status == "Completed", f"{qi} {q and q.status} {q and q.dead_letter_reason or ''}")
			if q and q.completed_at and c:
				sc.check(f"{label}: queue completed_at not before creation", q.completed_at >= c - dt.timedelta(seconds=1), str(q.completed_at))
		return row

	def log_extra(self, name: str) -> dict:
		return self.fresh().db.get_value(
			"WhatsApp Log", name,
			["attachment", "file_name", "mime_type", "caption", "body", "reference_doctype", "reference_name", "contact", "display_name",
			 "notification", "notification_alert", "campaign", "template", "source_type", "message_type", "phone_e164", "poll_question", "poll_options"],
			as_dict=True,
		) or {}

	def check_text(self, sc: Scenario, label: str, text: str | None, must: list[str]) -> None:
		text = text or ""
		sc.check(f"{label}: no 'None', no raw Jinja, no traceback in the text", "None" not in text and "{{" not in text and "{%" not in text and "Traceback" not in text, text[:300])
		missing = [m for m in must if m not in text]
		sc.check(f"{label}: text carries {must}", not missing, f"missing {missing} in: {text[:400]}")

	def check_pdf(self, sc: Scenario, label: str, row: dict, *, file_name: str, must: list[str]) -> None:
		"""The stored attachment is a real PDF carrying `must` (read from disk, as the provider gets it)."""
		from whatsapp_next.services import attachments

		sc.check(f"{label}: sent as a Document named {file_name}", row.get("message_type") == "Document" and row.get("file_name") == file_name and row.get("mime_type") == "application/pdf", (row.get("message_type"), row.get("file_name"), row.get("mime_type")))
		if not row.get("attachment"):
			sc.check(f"{label}: attachment stored", False, "no attachment on the log")
			return
		self.fresh()
		data = attachments.as_bytes(row["attachment"])
		sc.check(f"{label}: attachment is a PDF ({len(data)} bytes)", data[:5] == b"%PDF-" and len(data) > 5000, data[:8])
		try:
			import pypdf

			reader = pypdf.PdfReader(io.BytesIO(data))
			text = "\n".join((p.extract_text() or "") for p in reader.pages)
			flat = text.replace(" ", "").replace("\n", "")
			missing = [m for m in must if m.replace(" ", "") not in flat]
			sc.check(f"{label}: PDF ({len(reader.pages)} page) carries {must}", not missing, f"missing {missing}")
		except Exception as exc:
			sc.check(f"{label}: PDF readable", False, f"{type(exc).__name__}: {exc}")
		out = os.path.join(self.out, "files")
		os.makedirs(out, exist_ok=True)
		with open(os.path.join(out, f"{label}-{file_name}"), "wb") as fh:
			fh.write(data)

	# ---- setup
	def setup(self) -> None:
		f = self.frappe
		pwd = self.state.get("password") or ("Biz-" + base.uuid.uuid4().hex[:16] + "!9")
		if not f.db.exists("User", USER):
			user = f.get_doc({"doctype": "User", "email": USER, "first_name": "محاسب المبيعات", "last_name": f"({MARK})", "send_welcome_email": 0})
			user.insert(ignore_permissions=True)
		user = f.get_doc("User", USER)
		have = {r.role for r in user.roles}
		if not user.enabled or have != set(USER_ROLES) or user.time_zone != USER_TZ or not self.state.get("password"):
			user.enabled = 1
			user.user_type = "System User"
			user.set("roles", [])
			for role in USER_ROLES:
				user.append("roles", {"role": role})
			user.time_zone = USER_TZ
			user.language = "ar"
			user.new_password = pwd
			user.flags.ignore_password_policy = True
			user.save(ignore_permissions=True)
			f.db.commit()
			self.state["password"] = pwd
			self.save_state()
		self.client = Client(self.args.base, self.args.site, USER, self.state["password"], self.args.dry_run, self.log)

	def ui(self, mode: str, payload: dict, lang: str = "ar") -> dict:
		os.environ["E2E_ALLOWED"] = ",".join(sorted(ALLOWED_DIGITS))
		real_user = base.USER
		base.USER = USER
		try:
			return super().ui(mode, payload, lang)
		finally:
			base.USER = real_user

	# ---- small helpers
	def exists(self, doctype: str, name) -> bool:
		return bool(self.fresh().db.exists(doctype, name))

	def today(self) -> dt.date:
		from frappe.utils import getdate

		return getdate()

	def person_of(self, customer: str) -> dict:
		return next(p for p in PEOPLE.values() if p["customer"] == customer)

	# ====================================================================== scenarios

	def sc_preflight(self, sc: Scenario) -> None:
		f = self.fresh()
		dev = f.db.get_value("WhatsApp Device", DEVICE, ["status", "disabled", "is_default", "phone_e164"], as_dict=True)
		sc.check("device WA-DEV-014 Connected", dev and dev.status == "Connected" and not dev.disabled, dev)
		from frappe.utils.scheduler import is_scheduler_disabled

		sc.check("site scheduler enabled", not is_scheduler_disabled(verbose=False))
		sc.check("queue not paused globally", not f.db.get_single_value("WhatsApp Settings", "queue_paused"))
		for p in PEOPLE.values():
			ctx = self.client.read("quick_send.get_context", phone=p["phone"])
			rec = ctx.get("recipient") or {}
			sc.check(f"{p['phone']} resolves, not blacklisted", rec.get("phone_e164") == p["phone"] and not rec.get("blacklisted"), rec)
		real, pending = self.used_budget()
		sc.notes.append(f"budget: {real} real + {pending} pending of {MAX_REAL} since {self._since()}; site now {self.site_now()}")
		if "baseline_numbers" not in self.state:
			self.state["baseline_numbers"] = {ph: self.number_row(ph) for ph in ALLOWED}
			self.state["baseline_home"] = (self.client.read("home.get_dashboard") or {}).get("today")
			self.save_state()

	def number_row(self, phone: str) -> dict:
		row = self.fresh().db.get_value("WhatsApp Number", phone, ["outbound_count", "inbound_count", "last_seen", "last_direction", "last_device", "display_name"], as_dict=True)
		return {k: str(v) if isinstance(v, dt.datetime) else v for k, v in (row or {}).items()}

	# ---------------------------------------------------------------- master data
	def sc_setup(self, sc: Scenario) -> None:
		"""Catalogue, customers, opening stock, print format, letter head, templates."""
		f = self.frappe
		c = self.client
		media = self.args.media
		# what needs System Manager: a letter head and the receipt print format
		if not f.db.exists("Letter Head", LETTER_HEAD):
			f.get_doc({"doctype": "Letter Head", "letter_head_name": LETTER_HEAD, "source": "HTML", "content": LETTER_HEAD_HTML, "is_default": 0}).insert(ignore_permissions=True)
			self.remember("letter_heads", LETTER_HEAD)
		if not f.db.exists("Print Format", RECEIPT_FORMAT):
			f.get_doc({
				"doctype": "Print Format", "name": RECEIPT_FORMAT, "doc_type": "Payment Entry", "module": "Accounts", "standard": "No",
				"custom_format": 1, "print_format_type": "Jinja", "html": RECEIPT_HTML, "default_print_language": "ar",
			}).insert(ignore_permissions=True)
			self.remember("print_formats", RECEIPT_FORMAT)
		else:
			f.db.set_value("Print Format", RECEIPT_FORMAT, "html", RECEIPT_HTML)
		f.db.commit()
		for uom in ("حبة", "لفة"):
			if not self.exists("UOM", uom):
				c.insert("UOM", {"uom_name": uom, "must_be_whole_number": 1})
				self.remember("uoms", uom)
		if not self.exists("Item Group", ITEM_GROUP):
			c.insert("Item Group", {"item_group_name": ITEM_GROUP, "parent_item_group": "All Item Groups", "is_group": 0})
			self.remember("item_groups", ITEM_GROUP)
		for code, name, uom, rate, cost, _qty, desc in ITEMS:
			if self.exists("Item", code):
				continue
			img = c.upload(os.path.join(media, f"{code}.png"), is_private=0)
			self.remember("files", img["name"])
			c.insert("Item", {
				"item_code": code, "item_name": name, "item_group": ITEM_GROUP, "stock_uom": uom, "is_stock_item": 1,
				"include_item_in_manufacturing": 0, "description": desc, "image": img["file_url"], "standard_rate": rate,
				"valuation_rate": cost, "item_defaults": [{"company": COMPANY, "default_warehouse": WAREHOUSE}],
			})
			self.remember("items", code)
			self.record_doc("Item", code, "", rate, name)
		prices = self.fresh().get_all("Item Price", filters={"item_code": ("in", [i[0] for i in ITEMS]), "selling": 1}, fields=["item_code", "price_list_rate", "price_list"])
		sc.check("six products with a selling price and a picture", len(prices) == 6 and all(RATE[p.item_code] == p.price_list_rate for p in prices) and self.fresh().db.count("Item", {"item_group": ITEM_GROUP, "image": ("is", "set")}) == 6, prices)
		for key, p in PEOPLE.items():
			cust = p["customer"]
			if not self.exists("Customer", cust):
				c.insert("Customer", {
					"customer_name": cust, "customer_type": "Company", "customer_group": "Commercial", "territory": "Yemen",
					"language": "ar", "customer_details": f"{MARK} — عميل اختبار الأعمال الحي ({key})",
				})
				self.remember("customers", cust)
				self.record_doc("Customer", cust, cust, None, f"contact {p['contact']} / {p['phone']}")
			links = self.fresh().get_all("Dynamic Link", filters={"parenttype": "Contact", "parent": p["contact"]}, fields=["link_doctype", "link_name", "idx"], order_by="idx asc")
			if not any(x.link_doctype == "Customer" and x.link_name == cust for x in links):
				# additive: the Contact keeps its links (and its first one, which the commands read); one row is added
				c.update("Contact", p["contact"], {"links": [{"link_doctype": x.link_doctype, "link_name": x.link_name} for x in links] + [{"link_doctype": "Customer", "link_name": cust}]})
				self.state["restore"].setdefault("contact_links_added", []).append({"contact": p["contact"], "customer": cust})
				self.save_state()
			from whatsapp_next.services.permissions import contact_phones

			self.fresh()
			phones = contact_phones(p["contact"])
			links = self.fresh().get_all("Dynamic Link", filters={"parenttype": "Contact", "parent": p["contact"]}, fields=["link_name", "idx"], order_by="idx asc")
			sc.check(f"contact {p['name']} has exactly the one number and is linked to {cust}", phones == [p["phone"]] and any(x.link_name == cust for x in links), (phones, links))
		if not self.kept("opening_stock"):
			# The goods come in on a purchase receipt. (A Stock Entry cannot be submitted on this site:
			# snd_accounting's override reads `Stock Entry Detail.party_type`, a custom field the site lacks.)
			if not self.exists("Supplier", SUPPLIER):
				c.insert("Supplier", {"supplier_name": SUPPLIER, "supplier_group": self.fresh().db.get_value("Supplier Group", {"is_group": 0}, "name"), "supplier_type": "Company", "country": "Yemen", "supplier_details": f"{MARK} — مورد اختبار الأعمال الحي"})
				self.remember("suppliers", SUPPLIER)
				self.record_doc("Supplier", SUPPLIER, "", None, "source of the opening stock")
			doc = c.insert("Purchase Receipt", {
				"supplier": SUPPLIER, "company": COMPANY, "currency": "YER", "buying_price_list": "Standard Buying",
				"set_posting_time": 1, "posting_date": "2026-08-01", "posting_time": "09:00:00", "set_warehouse": WAREHOUSE,
				"remarks": f"{MARK} — استلام شحنة أصناف الطاقة الشمسية",
				"items": [{"item_code": i[0], "qty": i[5], "rate": i[4], "warehouse": WAREHOUSE} for i in ITEMS],
			})
			c.submit(c.get_doc("Purchase Receipt", doc["name"]))
			self.keep("opening_stock", doc["name"])
			self.record_doc("Purchase Receipt", doc["name"], SUPPLIER, doc.get("grand_total"), "opening stock, dated 2026-08-01")
		bins = self.fresh().get_all("Bin", filters={"warehouse": WAREHOUSE, "item_code": ("in", [i[0] for i in ITEMS])}, fields=["item_code", "actual_qty"])
		sc.check("opening stock is in the warehouse", len(bins) == 6 and all(b.actual_qty > 0 for b in bins), bins)
		for name, (ref, body) in TEMPLATES.items():
			if not self.exists("WhatsApp Template", name):
				c.insert("WhatsApp Template", {"template_name": name, "message_type": "Text", "category": "مبيعات", "reference_doctype": ref, "language": "ar", "body": body, "description": f"{MARK}"})
				self.remember("templates", name)
			elif self.fresh().db.get_value("WhatsApp Template", name, "body") != body:
				c.update("WhatsApp Template", name, {"body": body, "disabled": 0})
		sc.check("templates saved", all(self.exists("WhatsApp Template", n) for n in TEMPLATES))

	# ---------------------------------------------------------------- notifications
	def notification(self, sc: Scenario, key: str, payload: dict) -> str:
		"""Create / update one of the test's notifications through the editor's own call."""
		name = payload["notification_name"]
		payload = {"device": DEVICE, "condition_type": "Python", "enabled": 1, **payload}
		if self.exists("WhatsApp Notification", name):
			payload["name"] = name
		res = self.client.write("notifications.save_editor", payload=payload)
		self.remember("notifications", res["name"])
		self.keep(f"notif_{key}", res["name"])
		self.state.setdefault("notif_payload", {})[res["name"]] = {k: v for k, v in payload.items() if k != "name"}
		self.save_state()
		return res["name"]

	def silence_owner_notification(self, sc: Scenario) -> None:
		"""The owner's own notification on Sales Invoice / Submit has no condition: it would send a
		second message for each of our invoices. It is switched off for the test and switched back
		on by `cleanup`."""
		row = self.fresh().db.get_value("WhatsApp Notification", OWNER_SI_NOTIFICATION, ["enabled", "document_type", "event"], as_dict=True)
		if not row:
			return
		if "owner_notification_enabled" not in self.state["restore"]:
			self.state["restore"]["owner_notification_enabled"] = int(row.enabled)
			self.save_state()
		if row.enabled:
			self.client.write("notifications.save_editor", payload={"name": OWNER_SI_NOTIFICATION, "notification_name": OWNER_SI_NOTIFICATION, "enabled": 0})
		others = self.fresh().get_all("WhatsApp Notification", filters={"enabled": 1, "name": ("not like", f"{MARK}%")}, fields=["name", "document_type", "event"])
		sc.check("no other enabled notification can double-send", not others, others)

	def expect_notification(self, sc: Scenario, label: str, notif: str, doc_name: str, phone: str) -> bool:
		"""Before the event: the saved notification, tried on the draft, resolves to exactly `phone`."""
		payload = dict(self.state["notif_payload"][notif], name=notif)
		pv = self.client.write("notifications.preview_draft", payload=payload, reference_name=doc_name)
		recips = pv.get("recipients") or []
		ok = (
			not pv.get("problem") and not pv.get("error") and pv.get("recipients_count") == 1
			and recips and recips[0]["phone_e164"].endswith(phone[-2:]) and recips[0]["phone_e164"].lstrip("+").startswith("967")
		)
		sc.check(f"{label}: preview resolves to one recipient ending {phone[-2:]}", ok, {k: pv.get(k) for k in ("problem", "error", "recipients", "recipients_count", "meets_condition", "warnings")})
		text = pv.get("message") or ""
		clean = bool(text) and "None" not in text and "{{" not in text
		sc.check(f"{label}: the previewed text is clean (no 'None', no raw Jinja)", clean, text[:300])
		ok = ok and clean
		if not ok:
			raise GuardError(f"{label}: notification {notif} does not resolve to {phone} on {doc_name}: {pv}")
		return bool(pv.get("meets_condition"))

	def wait_notification(self, notif: str, doc_name: str, *, timeout: int = 90, settle: int = 25) -> list[str]:
		"""Log rows of `notif` for `doc_name`; after the first appears, wait `settle` s for a duplicate."""
		deadline = time.time() + timeout
		rows: list[str] = []
		while time.time() < deadline:
			rows = self.fresh().get_all("WhatsApp Log", filters={"notification": notif, "reference_name": doc_name}, pluck="name")
			if rows:
				break
			time.sleep(3)
		if rows:
			time.sleep(settle)
			rows = self.fresh().get_all("WhatsApp Log", filters={"notification": notif, "reference_name": doc_name}, pluck="name")
		return rows

	def check_notification_message(self, sc: Scenario, label: str, notif: str, doctype: str, doc_name: str, person: dict, *, must: list[str], pdf_must: list[str] | None, before_count: int) -> dict | None:
		rows = self.wait_notification(notif, doc_name)
		sc.check(f"{label}: exactly ONE message for {doc_name}", len(rows) == 1, rows)
		if not rows:
			nd = self.fresh().db.get_value("WhatsApp Notification", notif, ["last_error", "last_error_at"], as_dict=True)
			sc.notes.append(f"{label}: nothing queued; notification last_error={nd}")
			return None
		row = self.verify_message(sc, rows[0], label, phone=person["phone"], kind="PDF + caption" if pdf_must is not None else "text", source=f"Notification «{notif}» on {doctype} {doc_name}")
		x = self.log_extra(rows[0])
		text = x.get("caption") if pdf_must is not None else x.get("body")
		self.check_text(sc, label, text, must)
		sc.check(f"{label}: log links {doctype} {doc_name}, the notification and the contact", (x.get("reference_doctype"), x.get("reference_name"), x.get("notification"), x.get("contact")) == (doctype, doc_name, notif, person["contact"]), (x.get("reference_doctype"), x.get("reference_name"), x.get("notification"), x.get("contact")))
		sc.check(f"{label}: display name is the contact's", x.get("display_name") == person["name"], x.get("display_name"))
		if pdf_must is not None:
			self.check_pdf(sc, label, x, file_name=f"{doc_name}.pdf", must=pdf_must)
		nd = self.fresh().db.get_value("WhatsApp Notification", notif, ["send_count", "last_sent_at", "last_error"], as_dict=True)
		sc.check(f"{label}: notification send_count +1, last_sent_at set", (nd.send_count or 0) == before_count + 1 and nd.last_sent_at and nd.last_sent_at >= row.get("creation") - dt.timedelta(seconds=5), dict(nd))
		return row

	def send_count(self, notif: str) -> int:
		return self.fresh().db.get_value("WhatsApp Notification", notif, "send_count") or 0

	# ---------------------------------------------------------------- selling documents
	def taxes(self) -> list[dict]:
		rows = self.client.write("erpnext.controllers.accounts_controller.get_taxes_and_charges", master_doctype="Sales Taxes and Charges Template", master_name=TAX_TEMPLATE)
		return [{k: v for k, v in r.items() if k not in ("name", "parent", "parenttype", "parentfield", "creation", "modified", "owner", "modified_by", "idx", "docstatus")} for r in rows]

	def selling_doc(self, doctype: str, person: dict, lines: list[tuple[str, int]], **extra) -> dict:
		doc = {
			"company": COMPANY, "customer": person["customer"], "contact_person": person["contact"], "currency": "YER",
			"selling_price_list": "Standard Selling", "set_warehouse": WAREHOUSE, "taxes_and_charges": TAX_TEMPLATE, "language": "ar",
			"items": [{"item_code": code, "qty": qty, "rate": RATE[code], "warehouse": WAREHOUSE} for code, qty in lines],
			"taxes": self.taxes(),
			# what the form fetches when the contact is picked
			**self.contact_details(person),
			**extra,
		}
		return self.client.insert(doctype, doc)

	def contact_details(self, person: dict) -> dict:
		d = self.client.write("frappe.contacts.doctype.contact.contact.get_contact_details", contact=person["contact"])
		return {k: d.get(k) for k in ("contact_display", "contact_mobile", "contact_email") if d.get(k)}

	def draft(self, key: str, doctype: str, make) -> dict:
		"""The scenario's draft: made once, found again when a run stopped between insert and submit."""
		name = self.kept(f"{key}_draft")
		if name and self.fresh().db.get_value(doctype, name, "docstatus") == 0:
			return self.client.get_doc(doctype, name)
		doc = make()
		self.keep(f"{key}_draft", doc["name"])
		return doc

	def expected_total(self, lines: list[tuple[str, int]]) -> float:
		net = sum(RATE[c] * q for c, q in lines)
		return round(net * 1.05, 2)

	def sc_invoices(self, sc: Scenario) -> None:
		"""Two direct invoices for customer A (one back-dated and already overdue) → one PDF each."""
		self.silence_owner_notification(sc)
		notif = self.notification(sc, "invoice", {
			"notification_name": f"{MARK} فاتورة مبيعات معتمدة", "document_type": "Sales Invoice", "event": "Submit",
			"condition": COND_SELLING + " and not doc.is_return", "template": f"{MARK} إشعار فاتورة مبيعات",
			"message_type": "Document", "attach_print": 1, "letter_head": LETTER_HEAD,
			"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "contact_person"}],
		})
		a = PEOPLE["A"]
		today = self.today()
		plan = [
			("inv1", [("SOL-PNL-550", 4), ("SOL-BAT-200", 2), ("SOL-MPPT-60", 1)], {"due_date": str(today + dt.timedelta(days=30)), "remarks": f"توريد منظومة طاقة شمسية منزلية — {MARK}"}),
			("inv3", [("SOL-LED-50", 10), ("SOL-CBL-6", 1)], {"set_posting_time": 1, "posting_date": "2026-08-25", "posting_time": "11:30:00", "due_date": str(today - dt.timedelta(days=7)), "remarks": f"كشافات وكابلات لإنارة المستودع — {MARK}"}),
		]
		for key, lines, extra in plan:
			if self.kept(key):
				sc.notes.append(f"{key} already done: {self.kept(key)}")
				continue
			self.reserve(1)
			self.pace()
			draft = self.draft(key, "Sales Invoice", lambda lines=lines, extra=extra: self.selling_doc("Sales Invoice", a, lines, update_stock=1, **extra))
			inv = draft["name"]
			total = self.expected_total(lines)
			sc.check(f"{key} {inv}: grand total {total:,.0f} = net + 5% VAT", abs(draft["grand_total"] - total) < 0.01 and draft.get("contact_mobile") == a["phone"], (draft["grand_total"], draft.get("contact_mobile"), draft.get("total_taxes_and_charges")))
			meets = self.expect_notification(sc, key, notif, inv, a["phone"])
			sc.check(f"{key}: condition holds on the draft", meets)
			before = self.send_count(notif)
			t0 = self.site_now()
			self.client.submit(self.client.get_doc("Sales Invoice", inv))
			self.keep(key, inv)
			self.record_doc("Sales Invoice", inv, a["customer"], total, f"{key}; due {extra['due_date']}")
			due = dt.date.fromisoformat(extra["due_date"]).strftime("%d-%m-%Y")
			row = self.check_notification_message(
				sc, key, notif, "Sales Invoice", inv, a,
				must=[inv, a["customer"], a["name"], f"{total:,.0f} ريال يمني", due], pdf_must=[inv, f"{total:,.2f}"], before_count=before,
			)
			if row:
				sc.notes.append(f"{key}: submit → log row {(row['creation'] - t0).total_seconds():.1f}s, row → sent {(row['sent_at'] - row['creation']).total_seconds():.1f}s")
			if key == "inv1" and row and row.get("status") in ("Delivered", "Read"):
				sc.notes.append(f"FIRST INVOICE PDF DELIVERED: log {row['name']} to {a['phone']}")

	def sc_orders(self, sc: Scenario) -> None:
		"""Customer B: sales order (PDF confirmation) → delivery note (text) → invoice from the delivery (PDF)."""
		b = PEOPLE["B"]
		today = self.today()
		lines = [("SOL-INV-5K", 1), ("SOL-PNL-550", 6), ("SOL-BAT-200", 4)]
		total = self.expected_total(lines)
		n_so = self.notification(sc, "order", {
			"notification_name": f"{MARK} تأكيد طلب بيع", "document_type": "Sales Order", "event": "Submit", "condition": COND_SELLING,
			"template": f"{MARK} تأكيد طلب بيع", "message_type": "Document", "attach_print": 1, "letter_head": LETTER_HEAD,
			"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "contact_person"}],
		})
		n_dn = self.notification(sc, "delivery", {
			"notification_name": f"{MARK} إشعار تسليم", "document_type": "Delivery Note", "event": "Submit", "condition": COND_SELLING + " and not doc.is_return",
			"template": f"{MARK} إشعار تسليم", "message_type": "Text",
			# the phone field itself this time: `contact_mobile` is fetched from the contact
			"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "contact_mobile"}],
		})
		n_si = self.kept("notif_invoice")
		if not n_si:
			raise RuntimeError("run `invoices` first: the Sales Invoice notification is not there")
		delivery = today + dt.timedelta(days=3)
		if not self.kept("so"):
			self.reserve(1)
			self.pace()
			draft = self.draft("so", "Sales Order", lambda: self.selling_doc("Sales Order", b, lines, delivery_date=str(delivery), po_no=f"{MARK}-PO-1047", order_type="Sales"))
			so = draft["name"]
			sc.check(f"order {so}: grand total {total:,.0f}", abs(draft["grand_total"] - total) < 0.01, draft["grand_total"])
			self.expect_notification(sc, "order", n_so, so, b["phone"])
			before = self.send_count(n_so)
			self.client.submit(self.client.get_doc("Sales Order", so))
			self.keep("so", so)
			self.record_doc("Sales Order", so, b["customer"], total, f"delivery {delivery}")
			self.check_notification_message(sc, "order", n_so, "Sales Order", so, b, must=[so, b["customer"], b["name"], f"{total:,.0f} ريال يمني", delivery.strftime("%d-%m-%Y"), "انفرتر هايبرد 5 كيلو واط × 1"], pdf_must=[so], before_count=before)
		so = self.kept("so")
		if not self.kept("dn"):
			self.reserve(1)
			self.pace()
			def make_dn():
				mapped = self.client.write("erpnext.selling.doctype.sales_order.sales_order.make_delivery_note", source_name=so)
				mapped["instructions"] = f"التسليم في موقع العميل — {MARK}"
				return self.client.insert("Delivery Note", mapped)

			dn_doc = self.draft("dn", "Delivery Note", make_dn)
			dn = dn_doc["name"]
			sc.check("the delivery note carries the contact's mobile from the order", dn_doc.get("contact_mobile") == b["phone"], dn_doc.get("contact_mobile"))
			self.expect_notification(sc, "delivery", n_dn, dn, b["phone"])
			before = self.send_count(n_dn)
			self.client.submit(self.client.get_doc("Delivery Note", dn))
			self.keep("dn", dn)
			self.record_doc("Delivery Note", dn, b["customer"], total, f"from {so}")
			row = self.wait_notification(n_dn, dn)
			sc.check(f"delivery: exactly ONE message for {dn}", len(row) == 1, row)
			if row:
				self.verify_message(sc, row[0], "delivery", phone=b["phone"], kind="text", source=f"Notification «{n_dn}» on Delivery Note {dn}")
				x = self.log_extra(row[0])
				self.check_text(sc, "delivery", x.get("body"), [dn, b["customer"], "لوح شمسي مونو 550 واط × 6"])
				# `contact_mobile` carries no Contact: the name and the contact come from the Numbers row
				sc.check("delivery: recipient named although the field is a plain phone", bool(x.get("display_name")) and "None" not in (x.get("body") or ""), (x.get("display_name"), x.get("contact")))
				sc.check("delivery: notification send_count +1", self.send_count(n_dn) == before + 1, self.send_count(n_dn))
		dn = self.kept("dn")
		first = self.fresh().get_all("WhatsApp Log", filters={"notification": n_dn, "reference_name": dn}, fields=["name", "body"], order_by="creation asc")
		if first and "None" in (first[0].body or "") and not self.kept("dn_resent"):
			# the first delivery message greeted "None" (fixed since): the same notification, sent again
			# for the same delivery note with the form's "Send now"
			self.reserve(1)
			self.pace()
			self.expect_notification(sc, "delivery-resend", n_dn, dn, b["phone"])
			r = self.client.write("notifications.send_now", name=n_dn, reference_name=dn)
			self.keep("dn_resent", r)
			sc.check("delivery-resend: send_now queued one message", r.get("sent") == 1 and len(r.get("outbounds") or []) == 1 and not r.get("error"), r)
			if r.get("outbounds"):
				self.verify_message(sc, r["outbounds"][0], "delivery-resend", phone=b["phone"], kind="text", source=f"Notification «{n_dn}» Send now on Delivery Note {dn} (after the fix)")
				x = self.log_extra(r["outbounds"][0])
				self.check_text(sc, "delivery-resend", x.get("body"), [dn, b["customer"], f"الأخ {b['name']}"])
		if not self.kept("inv2"):
			self.reserve(1)
			self.pace()
			due2 = str(today + dt.timedelta(days=15))

			def make_inv():
				mapped = self.client.write("erpnext.stock.doctype.delivery_note.delivery_note.make_sales_invoice", source_name=dn)
				mapped["due_date"] = due2
				mapped["remarks"] = f"منظومة هايبرد 5 كيلو واط مع الألواح والبطاريات — {MARK}"
				return self.client.insert("Sales Invoice", mapped)

			mapped = {"due_date": due2}
			inv = self.draft("inv2", "Sales Invoice", make_inv)["name"]
			self.expect_notification(sc, "inv2", n_si, inv, b["phone"])
			before = self.send_count(n_si)
			self.client.submit(self.client.get_doc("Sales Invoice", inv))
			self.keep("inv2", inv)
			self.record_doc("Sales Invoice", inv, b["customer"], total, f"from {dn}; due {mapped['due_date']}")
			self.check_notification_message(sc, "inv2", n_si, "Sales Invoice", inv, b, must=[inv, b["customer"], b["name"], f"{total:,.0f} ريال يمني"], pdf_must=[inv, f"{total:,.2f}"], before_count=before)
		st = self.fresh().db.get_value("Sales Order", so, ["status", "per_delivered", "per_billed"], as_dict=True)
		sc.check("the order is fully delivered and billed", st and st.per_delivered == 100 and st.per_billed == 100, dict(st or {}))

	def sc_payments(self, sc: Scenario) -> None:
		"""Receipts: invoice 1 in full (cash) → receipt PDF + a thank-you when it turns Paid; invoice 2 in
		part (Kuraimi transfer) → receipt PDF and no thank-you."""
		a, b = PEOPLE["A"], PEOPLE["B"]
		inv1, inv2 = self.kept("inv1"), self.kept("inv2")
		if not (inv1 and inv2):
			raise RuntimeError("run `invoices` and `orders` first")
		n_pe = self.notification(sc, "receipt", {
			"notification_name": f"{MARK} سند قبض", "document_type": "Payment Entry", "event": "Submit", "condition": COND_PAYMENT,
			"template": f"{MARK} إشعار سند قبض", "message_type": "Document", "attach_print": 1, "print_format": RECEIPT_FORMAT, "letter_head": LETTER_HEAD,
			"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "contact_person"}],
		})
		n_paid = self.notification(sc, "paid", {
			"notification_name": f"{MARK} شكر على السداد الكامل", "document_type": "Sales Invoice", "event": "Value Change", "value_changed": "status",
			"condition": COND_SELLING + ' and doc.status == "Paid"', "template": f"{MARK} شكر على السداد", "message_type": "Text",
			"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "contact_person"}],
		})
		today = str(self.today())
		plan = [
			("pe1", inv1, a, None, {"mode_of_payment": "Cash"}, f"سداد نقدي كامل للفاتورة {inv1} — {MARK}"),
			("pe2", inv2, b, 600000.0, {"mode_of_payment": "Wire Transfer", "reference_no": "KRM-20261001-48211", "reference_date": today}, f"دفعة أولى بحوالة الكريمي عن الفاتورة {inv2} — {MARK}"),
		]
		for key, inv, person, amount, extra, remarks in plan:
			if self.kept(key):
				sc.notes.append(f"{key} already done: {self.kept(key)}")
				first = self.fresh().get_all("WhatsApp Log", filters={"notification": n_pe, "reference_name": self.kept(key)}, fields=["name", "caption"], order_by="creation asc")
				if first and "والمتبقي -" in (first[0].caption or "") and not self.kept(f"{key}_resent"):
					# this test's own template subtracted the payment twice (ERPNext stores what is left AFTER the
					# payment in the row): the corrected receipt, sent again with the form's "Send now"
					self.reserve(1)
					self.pace()
					r = self.client.write("notifications.send_now", name=n_pe, reference_name=self.kept(key))
					self.keep(f"{key}_resent", r)
					sc.check(f"{key}-resend: send_now queued one message", r.get("sent") == 1 and not r.get("error"), r)
					if r.get("outbounds"):
						self.verify_message(sc, r["outbounds"][0], f"{key}-resend", phone=person["phone"], kind="PDF + caption", source=f"Notification «{n_pe}» Send now on Payment Entry {self.kept(key)} (corrected template)")
						x = self.log_extra(r["outbounds"][0])
						self.check_text(sc, f"{key}-resend", x.get("caption"), [self.kept(key), inv, "والمتبقي 0 ريال"])
						self.check_pdf(sc, f"{key}-resend", x, file_name=f"{self.kept(key)}.pdf", must=[self.kept(key), inv])
				continue
			self.reserve(2 if key == "pe1" else 1)
			self.pace()
			pe = self.client.write("erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry", dt="Sales Invoice", dn=inv)
			outstanding = pe["references"][0]["outstanding_amount"]
			if extra.get("mode_of_payment") == "Cash":
				acc = self.client.write("erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account", mode_of_payment=extra["mode_of_payment"], company=COMPANY)
				pe.update({"paid_to": acc["account"], "paid_to_account_currency": "YER"})
			if amount:
				pe.update({"paid_amount": amount, "received_amount": amount})
				pe["references"][0]["allocated_amount"] = amount
			pe.update({"custom_remarks": 1, "remarks": remarks, "contact_person": person["contact"], **extra})
			paid = amount or outstanding
			name = self.draft(key, "Payment Entry", lambda pe=pe: self.client.insert("Payment Entry", pe))["name"]
			self.expect_notification(sc, key, n_pe, name, person["phone"])
			paid_before = self.fresh().get_all("WhatsApp Log", filters={"notification": n_paid, "reference_name": inv}, pluck="name")
			before, before_paid = self.send_count(n_pe), self.send_count(n_paid)
			self.client.submit(self.client.get_doc("Payment Entry", name))
			self.keep(key, name)
			self.record_doc("Payment Entry", name, person["customer"], paid, f"against {inv}" + (" (partial)" if amount else " (full)"))
			left = outstanding - paid
			self.check_notification_message(
				sc, key, n_pe, "Payment Entry", name, person,
				must=[name, person["customer"], f"{paid:,.0f} ريال يمني", inv, f"والمتبقي {left:,.0f} ريال"] + ([extra["reference_no"]] if extra.get("reference_no") else []),
				pdf_must=[name, inv, f"{paid:,.2f}"], before_count=before,
			)
			st = self.fresh().db.get_value("Sales Invoice", inv, ["status", "outstanding_amount"], as_dict=True)
			if amount:
				sc.check(f"{key}: invoice {inv} is Partly Paid with {left:,.0f} left", st.status == "Partly Paid" and abs(st.outstanding_amount - left) < 0.01, dict(st))
				time.sleep(20)
				rows = [r for r in self.fresh().get_all("WhatsApp Log", filters={"notification": n_paid, "reference_name": inv}, pluck="name") if r not in paid_before]
				sc.check(f"{key}: no thank-you for a partial payment", not rows and self.send_count(n_paid) == before_paid, rows)
			else:
				sc.check(f"{key}: invoice {inv} is Paid, nothing outstanding", st.status == "Paid" and not st.outstanding_amount, dict(st))
				self.check_notification_message(sc, f"{key}-thanks", n_paid, "Sales Invoice", inv, person, must=[inv, person["customer"], person["name"], "رصيد الفاتورة الآن: 0 ريال"], pdf_must=None, before_count=before_paid)

	def sc_reminder(self, sc: Scenario) -> None:
		"""Days After: the overdue invoice gets one reminder when the daily job runs, as the scheduler runs it."""
		a = PEOPLE["A"]
		inv3 = self.kept("inv3")
		if not inv3:
			raise RuntimeError("run `invoices` first")
		f = self.fresh()
		due = f.db.get_value("Sales Invoice", inv3, "due_date")
		days = (self.today() - due).days
		notif = self.notification(sc, "overdue", {
			"notification_name": f"{MARK} تذكير فاتورة متأخرة", "document_type": "Sales Invoice", "event": "Days After", "date_changed": "due_date",
			"days_in_advance": days, "condition": COND_SELLING + " and doc.outstanding_amount > 0 and not doc.is_return",
			"template": f"{MARK} تذكير فاتورة متأخرة", "message_type": "Text",
			"recipients": [{"recipient_type": "Document Field", "receiver_by_document_field": "contact_person"}],
		})
		from whatsapp_next.services import notifications

		self.fresh()
		due_docs = notifications.documents_due(self.frappe.get_doc("WhatsApp Notification", notif))
		sc.check(f"documents_due finds {inv3} ({days} days after its due date {due})", inv3 in due_docs, due_docs)
		self.expect_notification(sc, "reminder", notif, inv3, a["phone"])
		for other in [d for d in due_docs if d != inv3]:
			pv = self.client.write("notifications.preview_draft", payload=dict(self.state["notif_payload"][notif], name=notif), reference_name=other)
			if pv.get("meets_condition"):
				raise GuardError(f"reminder would also fire for {other}: {pv}")
		if self.kept("reminder_sent"):
			sc.notes.append("reminder already sent")
			return
		self.reserve(1)
		self.pace()
		before = self.send_count(notif)
		job = self.frappe.db.get_value("Scheduled Job Type", {"method": "whatsapp_next.services.notifications.trigger_daily"}, "name")
		self.frappe.get_doc("Scheduled Job Type", job).enqueue(force=True)  # what the scheduler's tick does when it is due
		self.frappe.db.commit()
		self.keep("reminder_sent", str(self.site_now()))
		out = self.fresh().db.get_value("Sales Invoice", inv3, "outstanding_amount")
		self.check_notification_message(sc, "reminder", notif, "Sales Invoice", inv3, a, must=[inv3, a["customer"], f"{out:,.0f} ريال يمني", f"منذ {days} أيام", due.strftime("%d-%m-%Y")], pdf_must=None, before_count=before)
		# off at once: the real daily job must not send it again tomorrow
		self.client.write("notifications.save_editor", payload={"name": notif, "notification_name": notif, "enabled": 0})
		sc.check("reminder notification switched off after its run", not self.fresh().db.get_value("WhatsApp Notification", notif, "enabled"))

	# ---------------------------------------------------------------- alerts
	def run_alert(self, sc: Scenario, label: str, payload: dict, *, must: list[str], attach: str | None) -> None:
		aname = payload["alert_name"]
		payload = {"enabled": 1, "periodicity": "Daily", "content_type": "Report", "device": DEVICE, "language": "ar",
		           "recipients": [{"recipient_type": "Phone", "phone": p} for p in sorted(ALLOWED)], **payload}
		if self.exists("WhatsApp Notification Alert", aname):
			payload["name"] = aname
		pv = self.client.write("alerts.preview_draft", payload=payload)
		sc.check(f"{label}: draft preview has rows, two recipients, no problem", not pv.get("problem") and not pv.get("error") and pv.get("recipients_count") == 2 and (pv.get("row_count") or 0) >= 1, {k: pv.get(k) for k in ("problem", "error", "row_count", "recipients_count")})
		sc.notes.append(f"{label} preview message:\n{pv.get('message')}")
		self.check_text(sc, f"{label} preview", pv.get("message"), must)
		if pv.get("problem") or pv.get("error") or pv.get("recipients_count") != 2:
			return
		res = self.client.write("alerts.save_editor", payload=payload)
		self.remember("alerts", res["name"])
		saved = self.fresh().db.get_value("WhatsApp Notification Alert", aname, ["next_run_at", "notification_time", "send_count"], as_dict=True)
		at = dt.datetime.combine(self.today(), dt.time(*[int(x) for x in payload["notification_time"].split(":")]))
		want = at if at > self.site_now() else at + dt.timedelta(days=1)
		sc.check(f"{label}: next_run_at is the next {payload['notification_time']} in site time", saved.next_run_at == want, f"{saved.next_run_at} vs {want}")
		if self.kept(f"alert_{label}"):
			sc.notes.append(f"{label} already run")
			return
		self.reserve(2)
		self.pace()
		before = set(self.fresh().get_all("WhatsApp Log", filters={"notification_alert": aname}, pluck="name"))
		self.client.write("alerts.run_now", name=aname)
		self.keep(f"alert_{label}", str(self.site_now()))
		deadline = time.time() + 180
		new: list[str] = []
		while time.time() < deadline:
			new = [n for n in self.fresh().get_all("WhatsApp Log", filters={"notification_alert": aname}, pluck="name") if n not in before]
			if len(new) >= 2:
				break
			time.sleep(3)
		time.sleep(20)
		new = [n for n in self.fresh().get_all("WhatsApp Log", filters={"notification_alert": aname}, pluck="name") if n not in before]
		phones = sorted(self.log_extra(n).get("phone_e164") for n in new)
		sc.check(f"{label}: run_now → exactly one message per recipient", phones == sorted(ALLOWED), phones)
		for n in new:
			x = self.log_extra(n)
			tag = f"{label}→{x.get('phone_e164', '')[-4:]}"
			self.verify_message(sc, n, tag, phone=x.get("phone_e164"), kind=(attach or "text"), source=f"Alert «{aname}» ({payload.get('report')})")
			text = x.get("caption") if attach else x.get("body")
			self.check_text(sc, tag, text, must)
			if attach == "PDF":
				self.check_pdf(sc, tag, x, file_name=x.get("file_name") or "", must=[])
				sc.check(f"{tag}: file name is sensible", (x.get("file_name") or "").endswith(".pdf") and len(x.get("file_name") or "") > 8, x.get("file_name"))
			elif attach == "PNG":
				from whatsapp_next.services import attachments

				data = attachments.as_bytes(x["attachment"]) if x.get("attachment") else b""
				sc.check(f"{tag}: sent as an Image, a real PNG ({len(data)} bytes)", x.get("message_type") == "Image" and data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 5000, (x.get("message_type"), x.get("file_name"), data[:8]))
				os.makedirs(os.path.join(self.out, "files"), exist_ok=True)
				with open(os.path.join(self.out, "files", f"{label}-{x.get('phone_e164', '')[-4:]}-{x.get('file_name')}"), "wb") as fh:
					fh.write(data)
		ad = self.fresh().db.get_value("WhatsApp Notification Alert", aname, ["send_count", "last_sent_at", "last_error", "next_run_at"], as_dict=True)
		sc.check(f"{label}: send_count +2, last_sent_at set, no error, next run unchanged", (ad.send_count or 0) == (saved.send_count or 0) + 2 and ad.last_sent_at and not ad.last_error and ad.next_run_at == want, dict(ad))
		self.client.write("alerts.set_enabled", name=aname, enabled=0)
		sc.check(f"{label}: alert switched off after the test", not self.fresh().db.get_value("WhatsApp Notification Alert", aname, "enabled"))

	def far_time(self) -> str:
		"""A daily time about 12 h from now: the alert never comes due by itself during the test."""
		return (self.site_now() + dt.timedelta(hours=12)).strftime("%H:00")

	def sc_alerts(self, sc: Scenario) -> None:
		only = self.args.alert
		if only in (None, "receivable"):
			self.run_alert(sc, "receivable", {
				"alert_name": f"{MARK} أرصدة العملاء المدينة", "report": "Accounts Receivable Summary", "notification_time": self.far_time(),
				"filters_json": {"company": COMPANY, "ageing_based_on": "Due Date", "range": "30, 60, 90, 120", "party_type": "Customer"},
				"dynamic_filters_json": {"report_date": "today"}, "attachment_format": "PDF", "letter_head": LETTER_HEAD,
				"message": (
					"📊 *أرصدة العملاء المدينة* حتى {{ frappe.utils.formatdate(today, 'dd-MM-yyyy') }}\n"
					"{% set ns = namespace(n=0) %}"
					"{% for r in rows if r.party and r.outstanding %}{% set ns.n = ns.n + 1 %}"
					"• {{ r.party }}: {{ frappe.utils.fmt_money(r.outstanding, 0) }} ريال\n{% endfor %}"
					"عدد العملاء المدينين: {{ ns.n }}\n"
					"التفاصيل وأعمار الديون في الملف المرفق (PDF)." + SIGN
				),
			}, must=["أرصدة العملاء المدينة", PEOPLE["A"]["customer"], PEOPLE["B"]["customer"], "668,400"], attach="PDF")
		if only in (None, "ledger"):
			b = PEOPLE["B"]["customer"]
			self.run_alert(sc, "ledger", {
				"alert_name": f"{MARK} كشف حساب عميل", "report": "General Ledger", "notification_time": self.far_time(),
				"filters_json": {"company": COMPANY, "party_type": "Customer", "party": [b], "group_by": "Group by Voucher (Consolidated)"},
				"dynamic_filters_json": {"from_date": "fiscal_year_start", "to_date": "today"}, "attachment_format": "PNG", "letter_head": LETTER_HEAD,
				"message": (
					"🧾 *كشف حساب* — " + b + "\n"
					"من {{ frappe.utils.formatdate(filters.from_date, 'dd-MM-yyyy') }} إلى {{ frappe.utils.formatdate(filters.to_date, 'dd-MM-yyyy') }}\n"
					"{% set v = rows | selectattr('voucher_no') | list %}"
					"عدد الحركات: {{ v | length }}\n"
					"{% for r in v %}• {{ _(r.voucher_type) }} {{ r.voucher_no }}: "
					"{% if r.debit %}مدين {{ frappe.utils.fmt_money(r.debit, 0) }}{% else %}دائن {{ frappe.utils.fmt_money(r.credit, 0) }}{% endif %}\n{% endfor %}"
					"الرصيد الختامي: *{{ frappe.utils.fmt_money(rows[-1].balance, 0) }} ريال يمني*\n"
					"الكشف التفصيلي مرفق كصورة." + SIGN
				),
			}, must=["كشف حساب", b, "ACC-SINV-2026-00008", "ACC-PAY-2026-00007", "668,400 ريال يمني"], attach="PNG")
		if only in (None, "trial"):
			# an snd_accounting report, as text only
			self.run_alert(sc, "trial", {
				"alert_name": f"{MARK} ميزان مراجعة العملاء", "report": "Customer Trial Balance", "notification_time": self.far_time(),
				"filters_json": {"company": COMPANY, "timespan": "Select Date Range", "from_fiscal_year": "2026", "to_fiscal_year": "2026", "party_type": "Customer", "short_total": 1},
				"dynamic_filters_json": {"from_date": "fiscal_year_start", "to_date": "today"}, "attachment_format": "None",
				"message": (
					"📒 *ميزان مراجعة العملاء* من {{ frappe.utils.formatdate(filters.from_date, 'dd-MM-yyyy') }} إلى {{ frappe.utils.formatdate(filters.to_date, 'dd-MM-yyyy') }}\n"
					"{% for r in rows if r.party and r.debit %}"
					"• {{ r.party }}: مدين {{ frappe.utils.fmt_money(r.debit, 0) }} · دائن {{ frappe.utils.fmt_money(r.credit, 0) }} · الرصيد {{ frappe.utils.fmt_money(r.closing, 0) }}\n"
					"{% endfor %}"
					"عدد العملاء: {{ row_count }}" + SIGN
				),
			}, must=["ميزان مراجعة العملاء", PEOPLE["A"]["customer"], PEOPLE["B"]["customer"], "الرصيد 668,400", "الرصيد 157,500"], attach=None)

	# ---------------------------------------------------------------- campaigns
	def campaign(self, name: str, messages: list[dict], description: str) -> str:
		existing = self.fresh().get_all("WhatsApp Campaign", filters={"campaign_name": name, "status": "Draft"}, pluck="name")
		if existing:
			return existing[0]
		doc = self.client.insert("WhatsApp Campaign", {"campaign_name": name, "device": DEVICE, "messages_per_minute": 6, "description": description, "messages": messages})
		self.remember("campaigns", doc["name"])
		rows = [{"phone": p["phone"], "phone_e164": p["phone"], "display_name": p["name"], "contact": p["contact"], "source_type": "Contact", "source_doctype": "Contact", "source_name": p["contact"], "valid": True} for p in PEOPLE.values()]
		prev = self.client.write("picker.preview", target_doctype="WhatsApp Campaign", target_name=doc["name"], rows=rows)
		if len(prev.get("available") or []) != 2:
			raise RuntimeError(f"picker preview did not offer both numbers: {prev}")
		self.client.write("picker.commit_add", target_doctype="WhatsApp Campaign", target_name=doc["name"], rows=rows, source_type="Contact")
		recips = sorted(self.fresh().get_all("WhatsApp Campaign Recipient", filters={"parent": doc["name"]}, pluck="phone_e164"))
		if recips != sorted(ALLOWED):
			raise GuardError(f"campaign {doc['name']} recipients {recips}")
		return doc["name"]

	def watch_campaign(self, sc: Scenario, camp: str, total: int, timeout: int = 900) -> dict:
		"""The monitor's own call until the campaign ends; every change of the counters is noted."""
		deadline = time.time() + timeout
		last, prog, seen = None, {}, []
		while time.time() < deadline:
			prog = self.client.read("campaigns.get_progress", name=camp)
			c = prog.get("counters") or {}
			snap = (prog.get("status"), c.get("queued"), c.get("sent"), c.get("delivered"), c.get("read"), c.get("failed"), (prog.get("rates") or {}).get("percent"))
			if snap != last:
				seen.append(f"{self.site_now():%H:%M:%S} {snap[0]} queued={snap[1]} sent={snap[2]} delivered={snap[3]} read={snap[4]} failed={snap[5]} {snap[6]}%")
				last = snap
				# what the monitor shows must add up at every step
				parts = sum(c.get(k) or 0 for k in ("queued", "sent", "delivered", "read", "failed", "cancelled"))
				if c.get("total") != total or parts != total:
					sc.check(f"{camp}: counters add up to {total} at every step", False, c)
			if prog.get("status") in ("Completed", "Partially Failed", "Cancelled"):
				break
			time.sleep(5)
		sc.notes.append(f"{camp} monitor: " + " → ".join(seen))
		c = prog.get("counters") or {}
		sc.check(f"{camp}: ended Completed", prog.get("status") == "Completed", prog.get("status"))
		sc.check(f"{camp}: final counters total={total}, open=0, failed=0, 100%", c.get("total") == total and c.get("open") == 0 and not c.get("failed") and (prog.get("rates") or {}).get("percent") == 100, (c, prog.get("rates")))
		f = self.fresh()
		doc = f.db.get_value("WhatsApp Campaign", camp, ["sent_count", "delivered_count", "read_count", "failed_count", "queued_count", "total_recipients", "started_at", "ended_at", "first_message_at", "last_message_at", "creation"], as_dict=True)
		by = {s: f.db.count("WhatsApp Log", {"campaign": camp, "status": s}) for s in ("Sent", "Delivered", "Read", "Failed", "Queued")}
		sc.check(f"{camp}: stored counters equal its log rows", (doc.sent_count, doc.delivered_count, doc.read_count, doc.failed_count) == (by["Sent"], by["Delivered"], by["Read"], by["Failed"]) or doc.sent_count + doc.delivered_count + doc.read_count == by["Sent"] + by["Delivered"] + by["Read"], f"doc={dict(doc)} rows={by}")
		if doc.started_at and doc.ended_at:
			sc.check(f"{camp}: creation ≤ started ≤ first message ≤ last message ≤ ended", doc.creation - dt.timedelta(seconds=1) <= doc.started_at <= (doc.first_message_at or doc.started_at) <= (doc.last_message_at or doc.ended_at) <= doc.ended_at + dt.timedelta(seconds=2), dict(doc))
		recips = f.get_all("WhatsApp Campaign Recipient", filters={"parent": camp}, fields=["status", "phone_e164"])
		sc.check(f"{camp}: both recipient rows final", len(recips) == 2 and all(r.status in ("Sent", "Delivered", "Read") for r in recips), recips)
		return prog

	def sc_campaign_offer(self, sc: Scenario) -> None:
		"""The October offer: the banner with a per-recipient caption, then a follow-up text. Started from
		the Start confirm, paused and resumed before the first message leaves."""
		banner = self.kept("banner")
		if not banner:
			fdoc = self.client.upload(os.path.join(self.args.media, "offer-october-solar.jpg"))
			self.remember("files", fdoc["name"])
			banner = fdoc["file_url"]
			self.keep("banner", banner)
		caption = (
			"الأخ {{ recipient.display_name }}، مساء الخير 🌞\n\n"
			"*عرض أكتوبر على منظومات الطاقة الشمسية* — خصم 10% حتى 15 أكتوبر 2026:\n"
			"• لوح شمسي مونو 550 واط: *43,200 ريال* بدلاً من 48,000\n"
			"• بطارية جل 200 أمبير: *112,500 ريال* بدلاً من 125,000\n"
			"• انفرتر هايبرد 5 كيلو واط: *378,000 ريال* بدلاً من 420,000\n"
			"• منظم شحن MPPT 60 أمبير: *61,200 ريال* بدلاً من 68,000\n\n"
			"الأسعار شاملة الضمان، والكمية محدودة."
		)
		follow = (
			"للطلب أو الاستفسار عن العرض يكفي الرد على هذه الرسالة 📩\n"
			"التوصيل داخل أمانة العاصمة مجاناً للطلبات فوق 500,000 ريال، ويتوفر التركيب مع فريقنا الفني." + SIGN
		)
		camp = self.kept("camp_offer") or self.campaign(
			f"{MARK} عرض أكتوبر للطاقة الشمسية",
			[
				{"message_type": "Image", "attachment": banner, "caption": caption, "delay_seconds": 150},
				{"message_type": "Text", "body": follow, "delay_seconds": 60},
			],
			f"{MARK} — عرض المنتجات: صورة العرض مع الأسعار ثم رسالة متابعة",
		)
		self.keep("camp_offer", camp)
		a_row = self.fresh().db.get_value("WhatsApp Campaign Recipient", {"parent": camp, "phone_e164": PEOPLE["A"]["phone"]}, "name")
		pv = self.client.read("campaigns.preview_message", name=camp, idx=1, recipient_row=a_row)
		sc.check("the caption previews with the recipient's own name", (pv.get("caption") or "").startswith(f"الأخ {PEOPLE['A']['name']}") and not pv.get("errors"), pv)
		rd = self.client.read("campaigns.get_readiness", name=camp)
		sc.check("readiness ok", rd.get("ok"), rd.get("checks"))
		sc.notes.append(f"readiness: {json.dumps(rd, ensure_ascii=False, default=str)[:600]}")
		if not rd.get("ok"):
			return
		status = self.fresh().db.get_value("WhatsApp Campaign", camp, "status")
		if status == "Draft":
			self.reserve(4)
			self.pace()
			res = self.ui("start", {"campaign": camp, "messages": 2})
			sc.notes.append(f"ui start: {res}")
			sc.check("started from the Start confirm in the browser, no JS errors", res.get("started") and not res.get("errors"), res.get("errors"))
			if not res.get("started"):
				self.client.write("campaigns.start", name=camp)
				sc.notes.append("fell back to campaigns.start over HTTP")
		outs = self.wait_campaign_outbound(camp, 4, timeout=180)
		sc.check("materialized 4 outbound rows (2 recipients × 2 messages)", len(outs) == 4, outs)
		if self.fresh().db.get_value("WhatsApp Campaign", camp, "status") == "Running" and not self.kept("offer_paused"):
			n = self.client.write("campaigns.pause", name=camp, reason="مراجعة السعر قبل الإرسال")
			items = self.fresh().get_all("WhatsApp Queue Item", filters={"campaign": camp}, fields=["status"])
			sc.check("pause → all four queue items Paused, campaign Paused", all(i.status == "Paused" for i in items) and self.fresh().db.get_value("WhatsApp Campaign", camp, "status") == "Paused", (n, items))
			dash = self.client.read("home.get_dashboard")
			sc.check("Home lists the paused campaign", any(x.get("name") == camp and x.get("status") == "Paused" for x in dash.get("campaigns_sending") or []), [(x.get("name"), x.get("status")) for x in dash.get("campaigns_sending") or []])
			prog = self.client.read("campaigns.get_progress", name=camp)
			sc.check("monitor while paused: 4 queued, nothing sent", (prog.get("counters") or {}).get("queued") == 4 and not (prog.get("counters") or {}).get("sent"), prog.get("counters"))
			time.sleep(12)
			sent_while_paused = self.fresh().db.count("WhatsApp Log", {"campaign": camp, "status": ("in", list(base.REAL))})
			sc.check("nothing leaves while paused", sent_while_paused == 0, sent_while_paused)
			self.client.write("campaigns.resume", name=camp)
			items = self.fresh().get_all("WhatsApp Queue Item", filters={"campaign": camp}, fields=["status"])
			sc.check("resume → queue items Queued again, campaign Running", all(i.status == "Queued" for i in items) and self.fresh().db.get_value("WhatsApp Campaign", camp, "status") == "Running", items)
			self.keep("offer_paused", 1)
		self.watch_campaign(sc, camp, 4)
		rows = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, fields=["name", "phone_e164", "campaign_message_idx", "sent_at", "scheduled_at"], order_by="phone_e164 asc, campaign_message_idx asc")
		for r in rows:
			who = next(p for p in PEOPLE.values() if p["phone"] == r.phone_e164)
			tag = f"offer-{'image' if r.campaign_message_idx == 1 else 'text'}→{r.phone_e164[-4:]}"
			self.verify_message(sc, r.name, tag, phone=r.phone_e164, kind="image + caption" if r.campaign_message_idx == 1 else "text", source=f"Campaign {camp}")
			x = self.log_extra(r.name)
			if r.campaign_message_idx == 1:
				self.check_text(sc, tag, x.get("caption"), [f"الأخ {who['name']}", "43,200 ريال", "خصم 10%"])
				from whatsapp_next.services import attachments

				data = attachments.as_bytes(x["attachment"])
				sc.check(f"{tag}: the banner goes as an Image (JPEG, {len(data)} bytes)", x.get("message_type") == "Image" and data[:3] == b"\xff\xd8\xff" and x.get("mime_type") == "image/jpeg", (x.get("message_type"), x.get("mime_type"), x.get("file_name")))
			else:
				self.check_text(sc, tag, x.get("body"), ["للطلب أو الاستفسار", "سند الرقمية"])
		rows = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, fields=["phone_e164", "campaign_message_idx", "sent_at"], order_by="sent_at asc")
		for ph in ALLOWED:
			mine = [r for r in rows if r.phone_e164 == ph and r.sent_at]
			if len(mine) == 2:
				sc.check(f"{ph[-4:]}: the picture arrives before its follow-up text", mine[0].campaign_message_idx == 1 and (mine[1].sent_at - mine[0].sent_at).total_seconds() >= 1, [(m.campaign_message_idx, str(m.sent_at)) for m in mine])
		sc.notes.append("send order: " + ", ".join(f"{r.phone_e164[-4:]}#{r.campaign_message_idx}@{r.sent_at:%H:%M:%S}" for r in rows if r.sent_at))

	def sc_campaign_poll(self, sc: Scenario) -> None:
		"""Scheduled from the dialog by a user in Asia/Aden on a site in Asia/Kolkata: a text, then a poll."""
		camp = self.kept("camp_poll") or self.campaign(
			f"{MARK} استطلاع اهتمامات العملاء",
			[
				{"message_type": "Text", "body": "الأخ {{ recipient.display_name }}، نعمل على تجهيز عروض الشهر القادم ونودّ معرفة ما يهمّكم أكثر 🙏\nسؤال واحد فقط في الرسالة التالية.", "delay_seconds": 0},
				{"message_type": "Poll", "poll_question": "أي المنتجات تهمّك أكثر في العرض القادم؟", "poll_options": json.dumps(["ألواح شمسية", "بطاريات", "انفرترات", "كشافات LED"], ensure_ascii=False), "delay_seconds": 45},
			],
			f"{MARK} — حملة مجدولة: نص ثم استطلاع",
		)
		self.keep("camp_poll", camp)
		rd = self.client.read("campaigns.get_readiness", name=camp)
		sc.check("readiness ok", rd.get("ok"), rd.get("checks"))
		if not rd.get("ok"):
			return
		minutes = 5
		if self.fresh().db.get_value("WhatsApp Campaign", camp, "status") == "Draft":
			self.reserve(4)
			self.pace()
			res = self.ui("schedule", {"campaign": camp, "minutes": minutes})
			sc.notes.append(f"ui schedule: {res}")
			sc.check("scheduled from the dialog in the browser, no JS errors", res.get("scheduled") and not res.get("errors"), res.get("errors"))
			typed = res.get("typed") or {}
			sc.check("the user typed Aden time on a Kolkata site", typed.get("user_tz") == USER_TZ and typed.get("system_tz") == "Asia/Kolkata", typed)
			self.keep("poll_typed", typed)
			self.keep("poll_expected", str(self.site_now() + dt.timedelta(minutes=minutes)))
		doc = self.fresh().db.get_value("WhatsApp Campaign", camp, ["status", "scheduled_at", "started_at"], as_dict=True)
		if not doc.scheduled_at:
			sc.check("campaign has a scheduled time", False, dict(doc))
			return
		sched = doc.scheduled_at
		expected = dt.datetime.fromisoformat(self.kept("poll_expected"))
		drift = abs((sched - expected).total_seconds())
		sc.check("scheduled_at is stored in site time, the same instant the user typed", drift <= 90, f"stored {sched} (site), expected ≈ {expected}; typed {self.kept('poll_typed')}")
		if drift > 90 and doc.status == "Scheduled":
			# a wrong hour must not send at a wrong time: take it off the schedule and stop
			self.client.write("campaigns.unschedule", name=camp)
			raise GuardError(f"campaign {camp} was scheduled for {sched}, not ≈ {expected}; unscheduled")
		sc.check("status Scheduled until its time", doc.status == "Scheduled" or doc.started_at, doc.status)
		home = self.client.read("home.get_dashboard")
		sc.notes.append(f"home while scheduled: {json.dumps({k: home.get(k) for k in ('campaigns_sending', 'campaigns_scheduled') if k in home}, ensure_ascii=False, default=str)[:500]}")
		deadline = time.time() + max((sched - self.site_now()).total_seconds(), 0) + 420
		started = None
		while time.time() < deadline:
			early = self.fresh().db.count("WhatsApp Log", {"campaign": camp})
			started = self.fresh().db.get_value("WhatsApp Campaign", camp, "started_at")
			if started:
				break
			if early:
				sc.check("no message row before the scheduled time", False, early)
			time.sleep(5)
		sc.check("started by the scheduler", bool(started), started)
		if started:
			lag = (started - sched).total_seconds()
			sc.check("not started before its time", lag >= -1, f"scheduled {sched} started {started}")
			sc.check("started within one scheduler tick (240 s) of its time", lag <= 250, f"lag {lag:.0f}s")
			sc.notes.append(f"scheduled {sched}, started {started}: lag {lag:.0f}s (the bench scheduler ticks every 240 s)")
		outs = self.wait_campaign_outbound(camp, 4, timeout=240)
		sc.check("materialized 4 outbound rows", len(outs) == 4, outs)
		self.watch_campaign(sc, camp, 4)
		rows = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, fields=["name", "phone_e164", "campaign_message_idx", "sent_at"], order_by="phone_e164 asc, campaign_message_idx asc")
		for r in rows:
			who = next(p for p in PEOPLE.values() if p["phone"] == r.phone_e164)
			poll = r.campaign_message_idx == 2
			tag = f"poll-{'poll' if poll else 'text'}→{r.phone_e164[-4:]}"
			row = self.verify_message(sc, r.name, tag, phone=r.phone_e164, kind="poll" if poll else "text", source=f"Campaign {camp} (scheduled)")
			x = self.log_extra(r.name)
			if poll:
				opts = x.get("poll_options")
				opts = json.loads(opts) if isinstance(opts, str) else opts
				sc.check(f"{tag}: a Poll with the question and four options", x.get("message_type") == "Poll" and x.get("poll_question") == "أي المنتجات تهمّك أكثر في العرض القادم؟" and len(opts or []) == 4, (x.get("message_type"), x.get("poll_question"), opts))
			else:
				self.check_text(sc, tag, x.get("body"), [f"الأخ {who['name']}"])
			if row.get("sent_at"):
				sc.check(f"{tag}: not sent before the scheduled time", row["sent_at"] >= sched - dt.timedelta(seconds=1), f"sent {row['sent_at']} scheduled {sched}")
		res = self.client.read("campaigns.get_poll_results", name=camp, refresh=1)
		sc.notes.append(f"poll results now: {json.dumps(res, ensure_ascii=False, default=str)[:600]}")
		polls = (res or {}).get("results") or []
		sc.check("poll results: one poll, sent to 2", len(polls) == 1 and polls[0].get("sent") == 2, polls)

	def sc_poll_retry(self, sc: Scenario) -> None:
		"""The two polls of the scheduled campaign failed on the platform ("Value for Poll Options cannot be a
		list"); with the options now sent as JSON text, the campaign's own "Retry failed" sends them again."""
		camp = self.kept("camp_poll")
		failed = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp, "status": "Failed"}, fields=["name", "phone_e164", "error_code", "error_message", "message_type"])
		sc.notes.append(f"failed before the retry: {failed}")
		fx = self.client.read("campaigns.get_failures", name=camp)
		sc.notes.append(f"get_failures: {json.dumps(fx, ensure_ascii=False, default=str)[:500]}")
		if failed and not self.kept("poll_retried"):
			self.reserve(len(failed))
			self.pace()
			r = self.client.write("campaigns.retry_failed", name=camp, error_code=failed[0].error_code)
			self.keep("poll_retried", r)
			sc.check("retry_failed resent both polls", r.get("retried") == 2 and not r.get("refused"), r)
		old = {f.name for f in failed} | set(self.kept("poll_failed") or [])
		self.keep("poll_failed", sorted(old))
		deadline = time.time() + 120
		new = []
		while time.time() < deadline:
			new = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp, "message_type": "Poll", "name": ("not in", list(old) or [""])}, fields=["name", "phone_e164"])
			if len(new) >= 2:
				break
			time.sleep(3)
		sc.check("two new poll rows, one per recipient", sorted(n.phone_e164 for n in new) == sorted(ALLOWED), new)
		for n in new:
			tag = f"poll-retry→{n.phone_e164[-4:]}"
			self.verify_message(sc, n.name, tag, phone=n.phone_e164, kind="poll", source=f"Campaign {camp}: Retry failed (poll options as JSON text)")
			x = self.log_extra(n.name)
			opts = x.get("poll_options")
			opts = json.loads(opts) if isinstance(opts, str) else opts
			sc.check(f"{tag}: a Poll with the question and four options", x.get("message_type") == "Poll" and len(opts or []) == 4, (x.get("poll_question"), opts))
		time.sleep(8)
		prog = self.client.read("campaigns.get_progress", name=camp)
		sc.notes.append(f"campaign after the retry: {prog.get('status')} {prog.get('counters')} {prog.get('rates')}")
		sc.check("campaign counters after the retry: nothing open", (prog.get("counters") or {}).get("open") == 0, prog.get("counters"))
		res = self.client.read("campaigns.get_poll_results", name=camp, refresh=1)
		sc.notes.append(f"poll results: {json.dumps(res, ensure_ascii=False, default=str)[:700]}")
		polls = (res or {}).get("results") or []
		sc.check("poll results: one poll, sent to 2", len(polls) == 1 and polls[0].get("sent") == 2, [(p.get("idx"), p.get("sent")) for p in polls])

	# ---------------------------------------------------------------- templates, bulk
	def sc_templates(self, sc: Scenario) -> None:
		"""Quick send from a template over a real document, as the Send button on the document does."""
		b = PEOPLE["B"]
		so, inv2 = self.kept("so"), self.kept("inv2")
		if not (so and inv2):
			raise RuntimeError("run `orders` first")
		f = self.fresh()
		delivery = f.db.get_value("Sales Order", so, "delivery_date")
		inv = f.db.get_value("Sales Invoice", inv2, ["grand_total", "outstanding_amount", "due_date"], as_dict=True)
		plan = [
			("appointment", f"{MARK} تذكير بموعد التركيب", "Sales Order", so, [so, b["name"], delivery.strftime("%d-%m-%Y")]),
			("balance", f"{MARK} تذكير بالمبلغ المتبقي", "Sales Invoice", inv2, [inv2, b["name"], b["customer"], f"{inv.grand_total:,.0f} ريال", f"{inv.grand_total - inv.outstanding_amount:,.0f} ريال", f"{inv.outstanding_amount:,.0f} ريال يمني", inv.due_date.strftime("%d-%m-%Y")]),
		]
		for key, tpl, dtype, dname, must in plan:
			if self.kept(f"tpl_{key}"):
				continue
			ctx = self.client.read("quick_send.get_context", contact=b["contact"], reference_doctype=dtype, reference_name=dname)
			offered = [t.get("name") for t in ctx.get("templates") or []]
			sc.check(f"{key}: the composer offers the template for a {dtype}", tpl in offered, offered)
			sc.check(f"{key}: the composer resolves the contact to {b['phone']}", (ctx.get("recipient") or {}).get("phone_e164") == b["phone"], ctx.get("recipient"))
			pv = self.client.read("quick_send.preview", template=tpl, reference_doctype=dtype, reference_name=dname)
			sc.check(f"{key}: preview renders without errors", pv.get("body") and not pv.get("errors"), pv)
			self.reserve(1)
			self.pace()
			r = self.client.write("quick_send.send", device=DEVICE, phone=b["phone"], contact=b["contact"], template=tpl, reference_doctype=dtype, reference_name=dname)
			self.keep(f"tpl_{key}", r["outbound"])
			self.verify_message(sc, r["outbound"], f"template-{key}", phone=b["phone"], kind="text", source=f"Quick Send, template «{tpl}» on {dtype} {dname}")
			x = self.log_extra(r["outbound"])
			self.check_text(sc, f"template-{key}", x.get("body"), must)
			sc.check(f"{key}: log keeps the template, the document and the contact", (x.get("template"), x.get("reference_doctype"), x.get("reference_name"), x.get("contact"), x.get("source_type")) == (tpl, dtype, dname, b["contact"], "Quick Send"), (x.get("template"), x.get("reference_doctype"), x.get("reference_name"), x.get("contact"), x.get("source_type")))
			t = self.fresh().db.get_value("WhatsApp Template", tpl, ["use_count", "last_used_at"], as_dict=True)
			sc.check(f"{key}: template use_count moved", (t.use_count or 0) >= 1 and t.last_used_at, dict(t))

	def sc_bulk(self, sc: Scenario) -> None:
		gname = f"{MARK} عملاء الطاقة الشمسية"
		if not self.exists("WhatsApp Contact Group", gname):
			rows = [{"phone": p["phone"], "phone_e164": p["phone"], "display_name": p["name"], "contact": p["contact"], "source_type": "Contact", "source_doctype": "Contact", "source_name": p["contact"]} for p in PEOPLE.values()]
			res = self.client.write("groups.save_editor", payload={"group_name": gname, "kind": "Marketing", "description": f"{MARK} — عملاء منظومات الطاقة الشمسية", "add": rows})
			self.remember("groups", res["name"])
		members = sorted(self.fresh().get_all("WhatsApp Contact Group Member", filters={"parent": gname}, pluck="phone_e164"))
		if not sc.check("the group holds exactly the two numbers", members == sorted(ALLOWED), members):
			return
		est = self.client.read("bulk_send.estimate", groups=json.dumps([gname]))
		sc.check("estimate is exactly two recipients", est.get("total") == 2, est)
		if self.kept("bulk"):
			camp = self.kept("bulk")
		else:
			self.reserve(2)
			self.pace()
			body = (
				"الأخ {{ recipient.display_name }}، تحية طيبة\n\n"
				"📢 *تنويه بمواعيد الدوام*: بمناسبة ذكرى ثورة 14 أكتوبر المجيدة يكون المعرض مغلقاً يوم الأربعاء 14 أكتوبر 2026، "
				"ونستأنف الدوام يوم الخميس 15 أكتوبر من 8:30 صباحاً حتى 8:00 مساءً.\n"
				"طلبات التوصيل المؤكدة قبل الإجازة تُسلَّم في موعدها. كل عام وأنتم بخير 🇾🇪" + SIGN
			)
			r = self.client.write("bulk_send.send", payload={"groups": [gname], "kind": "text", "device": DEVICE, "body": body, "rate": 6})
			sc.notes.append(f"bulk: {r}")
			sc.check("bulk created a campaign with 2 recipients, none excluded", r.get("recipients") == 2 and not r.get("excluded") and not r.get("invalid"), r)
			camp = r["campaign"]
			self.remember("bulk_campaigns", camp)
			self.keep("bulk", camp)
		outs = self.wait_campaign_outbound(camp, 2)
		sc.check("two outbound rows", len(outs) == 2, outs)
		self.watch_campaign(sc, camp, 2)
		for n in outs:
			x = self.log_extra(n)
			who = next(p for p in PEOPLE.values() if p["phone"] == x.get("phone_e164"))
			tag = f"bulk→{who['phone'][-4:]}"
			self.verify_message(sc, n, tag, phone=who["phone"], kind="text", source=f"Bulk send to group «{gname}» ({camp})")
			self.check_text(sc, tag, x.get("body"), [f"الأخ {who['name']}", "14 أكتوبر"])
		rows = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, fields=["sent_at"], order_by="sent_at asc")
		if len(rows) == 2 and rows[0].sent_at and rows[1].sent_at:
			# the rate is a ceiling per minute, not a spacing: one batch hands both to the platform, which paces them itself
			sc.notes.append(f"bulk: the two messages left {(rows[1].sent_at - rows[0].sent_at).total_seconds():.1f}s apart")

	# ---------------------------------------------------------------- commands
	def commands_plan(self) -> list[dict]:
		"""What the owner sends from each phone to the device's number, with the reply the system would
		give now (`commands.test_command` — the router's dry run; nothing is sent)."""
		inv1, inv2 = self.kept("inv1"), self.kept("inv2")
		plan = []
		texts = [
			("B", "فحص تجربة"), ("B", "رصيد"), ("B", "كشف"), ("B", "فاتورة ACC-SINV-2026-00001"), ("B", f"فاتورة {inv2 or 'ACC-SINV-2026-00007'}"),
			("B", "عملاء"), ("B", "موردين"), ("B", "صندوق"), ("B", "بنك"), ("B", "مساعدة"),
			("A", "رصيد"), ("A", "عملاء"),
		]
		for who, text in texts:
			p = PEOPLE[who]
			try:
				r = self.client.write("commands.test_command", text=text, sender_phone=p["phone"], device=DEVICE)
			except ApiError as exc:
				r = {"error": str(exc)}
			replies = r.get("replies") or []
			plan.append({
				"from": p["phone"], "who": p["name"], "send": text, "to": SENDER, "status": r.get("status"), "command": r.get("command"),
				"block_reason": r.get("block_reason"), "args": r.get("args"),
				"reply_kinds": [(x.get("message_type"), x.get("output_key"), bool(x.get("attachment"))) for x in replies if isinstance(x, dict)],
				"expected_reply": (r.get("reply_body") or r.get("error") or "")[:900],
			})
		return plan

	def sc_commands_plan(self, sc: Scenario) -> None:
		plan = self.commands_plan()
		self.keep("commands_plan", plan)
		self.keep("commands_since", str(self.site_now()))  # `verify_inbound` reads what arrives from here on
		for row in plan:
			sc.notes.append(json.dumps(row, ensure_ascii=False))
		sc.check("every planned text has a known outcome", all(p["status"] or p["expected_reply"] for p in plan), [p["send"] for p in plan if not (p["status"] or p["expected_reply"])])

	def sc_verify_inbound(self, sc: Scenario) -> None:
		"""After the owner's phone test: every inbound row from the two numbers since `--since`, what the
		router did with it, its reply and the reply time — matched against the plan."""
		since = self.args.since or self.kept("commands_since") or str(self.site_now() - dt.timedelta(hours=3))
		f = self.fresh()
		rows = f.get_all(
			"WhatsApp Inbound Message",
			filters={"received_at": (">=", since), "is_simulated": 0, "device": DEVICE, "phone_e164": ("in", list(ALLOWED))},
			fields=["name", "phone_e164", "message_type", "body", "caption", "received_at", "creation", "command_status", "command", "command_text", "command_error", "block_reason", "reply_outbound", "replied_at", "is_group"],
			order_by="received_at asc",
		)
		sc.notes.append(f"{len(rows)} inbound rows from the two numbers since {since}")
		if not rows:
			sc.status = "skipped"
			sc.notes.append("no inbound yet — the owner sends the list first")
			return
		plan = {(p["from"], p["send"].split()[0]): p for p in (self.kept("commands_plan") or [])}
		seen = set()
		for r in rows:
			text = (r.body or r.caption or "").strip()
			word = text.split()[0] if text else ""
			exp = plan.get((r.phone_e164, word))
			replies = f.get_all("WhatsApp Log", filters={"trigger_inbound": r.name}, fields=["name", "status", "message_type", "body", "caption", "sent_at", "creation", "file_name", "phone_e164"], order_by="creation asc")
			first = replies[0] if replies else None
			latency = (first.sent_at - r.received_at).total_seconds() if first and first.sent_at and r.received_at else None
			info = {
				"inbound": r.name, "from": r.phone_e164, "text": text[:80], "received_at": str(r.received_at), "command_status": r.command_status,
				"command": r.command, "block_reason": r.block_reason, "error": r.command_error,
				"replies": [{"name": x.name, "status": x.status, "type": x.message_type, "text": (x.body or x.caption or "")[:200], "file": x.file_name} for x in replies],
				"reply_seconds": latency, "planned": bool(exp),
			}
			sc.messages.append(info)
			sc.check(f"{r.name} «{text[:30]}»: received_at ≈ creation, not in the future", r.received_at <= self.site_now() + dt.timedelta(seconds=60) and abs((r.creation - r.received_at).total_seconds()) < 600, f"{r.received_at} / {r.creation}")
			sc.check(f"{r.name}: replies go only to the sender", all(x.phone_e164 == r.phone_e164 for x in replies), [x.phone_e164 for x in replies])
			if exp:
				seen.add((r.phone_e164, word))
				sc.check(f"{r.name} «{text[:30]}» from {r.phone_e164[-4:]}: routed as planned ({exp['status']} / {exp['command']})", (r.command or None) == (exp["command"] or None), f"got {r.command_status}/{r.command} {r.block_reason or ''} {r.command_error or ''}")
			if r.command_status in ("Matched", "Executed"):
				sc.check(f"{r.name}: reply sent", bool(first) and first.status in ("Sent", "Delivered", "Read"), info["replies"])
				if latency is not None:
					sc.check(f"{r.name}: first reply within 60 s", 0 <= latency <= 60, f"{latency:.0f}s")
				for x in replies:
					self.check_text(sc, f"{r.name} reply {x.name}", x.body or x.caption or "-", [])
			elif r.command_status == "Failed":
				sc.check(f"{r.name} «{text[:30]}» → {r.command}: the command failed", False, r.command_error)
		missing = [f"{k[0][-4:]}: {k[1]}" for k in plan if k not in seen]
		if missing:
			sc.notes.append(f"planned but not received yet: {missing}")
		real, pending = self.used_budget()
		sc.notes.append(f"budget after the replies: {real} real + {pending} pending of {MAX_REAL}")

	# ---------------------------------------------------------------- consistency, screens
	def sc_consistency(self, sc: Scenario) -> None:
		f = self.fresh()
		time.sleep(5)
		for ph in sorted(ALLOWED):
			num = self.number_row(ph)
			n_out = f.db.count("WhatsApp Log", {"phone_e164": ph})
			n_in = f.db.count("WhatsApp Inbound Message", {"phone_e164": ph, "is_group": 0})
			sc.check(f"{ph}: Number.outbound_count equals its log rows", num.get("outbound_count") == n_out, f"row {num.get('outbound_count')} vs logs {n_out}")
			sc.check(f"{ph}: Number.inbound_count equals its inbound rows", num.get("inbound_count") == n_in, f"row {num.get('inbound_count')} vs {n_in}")
			last_out = f.db.sql("select max(creation) from `tabWhatsApp Log` where phone_e164=%s", ph)[0][0]
			last_in = f.db.sql("select max(received_at) from `tabWhatsApp Inbound Message` where phone_e164=%s and is_group=0", ph)[0][0]
			want = max(x for x in (last_out, last_in) if x)
			sc.check(f"{ph}: Number.last_seen is its latest message", num.get("last_seen") and abs((dt.datetime.fromisoformat(num["last_seen"]) - want).total_seconds()) < 2, f"{num.get('last_seen')} vs {want}")
			api = self.client.read("numbers.get_number", phone_e164=ph)
			sc.check(f"{ph}: numbers.get_number agrees with the row", api.get("outbound_count") == num.get("outbound_count") and api.get("inbound_count") == num.get("inbound_count"), {k: api.get(k) for k in ("outbound_count", "inbound_count", "last_seen")})
			basel = (self.state.get("baseline_numbers") or {}).get(ph) or {}
			mine = f.db.count("WhatsApp Log", {"phone_e164": ph, "creation": (">=", self._since())})
			sc.check(f"{ph}: outbound_count moved by exactly the rows created since the test began", num.get("outbound_count", 0) - (basel.get("outbound_count") or 0) == mine, f"{basel.get('outbound_count')} → {num.get('outbound_count')}, rows since {mine}")
		dash = self.client.read("home.get_dashboard")
		today = dash.get("today") or {}
		from frappe.utils import get_datetime, getdate

		midnight = dt.datetime.combine(getdate(), dt.time())
		db_sent = f.db.count("WhatsApp Log", {"sent_at": (">=", midnight)})
		db_del = f.db.count("WhatsApp Log", {"delivered_at": (">=", midnight)})
		db_fail = f.db.count("WhatsApp Log", {"failed_at": (">=", midnight)})
		sc.check("Home today.sent / delivered / failed equal the rows since site midnight", (today.get("sent"), today.get("delivered"), today.get("failed")) == (db_sent, db_del, db_fail), f"{today} vs sent={db_sent} delivered={db_del} failed={db_fail}")
		q = dash.get("queue") or {}
		db_q = {s: f.db.count("WhatsApp Queue Item", {"status": s}) for s in ("Queued", "Paused", "Dead Letter")}
		sc.check("Home queue counts equal the queue table", q.get("queued") == db_q["Queued"] and q.get("paused") == db_q["Paused"] and q.get("dead_letter") == db_q["Dead Letter"], f"{q} vs {db_q}")
		dup = f.db.sql(
			"""select phone_e164, coalesce(notification, notification_alert, campaign, template) src, reference_name, campaign_message_idx, count(*) n
			from `tabWhatsApp Log` where creation >= %s and phone_e164 in %s and source_type != 'Command Reply'
			group by 1, 2, 3, 4 having n > 1""",
			(self._since(), tuple(ALLOWED)), as_dict=True,
		)
		sc.check("no message was sent twice (same source, document and recipient)", not dup, dup)
		per = {ph: f.db.count("WhatsApp Log", {"phone_e164": ph, "creation": (">=", self._since()), "status": ("in", list(base.REAL))}) for ph in sorted(ALLOWED)}
		failed = f.get_all("WhatsApp Log", filters={"phone_e164": ("in", list(ALLOWED)), "creation": (">=", self._since()), "status": ("in", ["Failed", "Held", "Cancelled"])}, fields=["name", "status", "error_code", "source_type"])
		sc.check("nothing of this test failed, was held or cancelled", not failed, failed)
		real, pending = self.used_budget()
		self.keep("per_number", per)
		sc.notes.append(f"real messages since {self._since()}: {per} — {real} real + {pending} pending of {MAX_REAL}")
		sc.check(f"within the cap of {MAX_REAL}", real + pending <= MAX_REAL, (real, pending))

	def sc_screens(self, sc: Scenario) -> None:
		logs = self.state["log"]
		pdf = next((m["name"] for m in logs if "PDF" in (m.get("kind") or "")), logs[-1]["name"] if logs else None)
		payload = {
			"outbound": pdf, "campaign": self.kept("camp_offer"), "number": PEOPLE["A"]["phone"],
			"extra": [
				["notifications", "whatsapp-notification"], ["alerts", "whatsapp-notification-alert"], ["templates", "whatsapp-template"],
				["campaign-poll", f"whatsapp-campaign/{self.kept('camp_poll')}"] if self.kept("camp_poll") else None,
				["invoice-form", f"sales-invoice/{self.kept('inv1')}"] if self.kept("inv1") else None,
			],
		}
		payload["extra"] = [e for e in payload["extra"] if e]
		for lang in ("ar", "en"):
			res = self.ui("shots", payload, lang)
			for page in res.get("pages", []):
				sc.check(f"[{lang}] {page['name']}: no JS/HTTP errors", not page.get("errors"), page.get("errors"))
				for k, v in (page.get("facts") or {}).items():
					sc.notes.append(f"[{lang}] {page['name']} {k}: {v}")
			if res.get("errors"):
				sc.check(f"[{lang}] shots run", False, res.get("errors"))
		self.frappe.db.set_value("User", USER, "language", "ar")
		self.frappe.db.commit()
		sc.notes.append(f"screenshots in {os.path.join(self.out, 'shots')}")

	def sc_cleanup(self, sc: Scenario) -> None:
		"""Nothing keeps firing: our notifications and alerts off, the owner's notification back as it was,
		any unsent campaign cancelled. Documents, logs and templates stay as the evidence."""
		c = self.state["created"]
		for n in c.get("notifications", []):
			if self.fresh().db.get_value("WhatsApp Notification", n, "enabled"):
				self.client.write("notifications.save_editor", payload={"name": n, "notification_name": n, "enabled": 0})
			sc.check(f"notification «{n}» disabled", not self.fresh().db.get_value("WhatsApp Notification", n, "enabled"))
		for n in c.get("alerts", []):
			if self.fresh().db.get_value("WhatsApp Notification Alert", n, "enabled"):
				self.client.write("alerts.set_enabled", name=n, enabled=0)
			sc.check(f"alert «{n}» disabled", not self.fresh().db.get_value("WhatsApp Notification Alert", n, "enabled"))
		for n in c.get("campaigns", []) + c.get("bulk_campaigns", []):
			st = self.fresh().db.get_value("WhatsApp Campaign", n, "status")
			if st in ("Draft", "Scheduled", "Queued", "Running", "Paused"):
				try:
					self.client.write("campaigns.cancel", name=n, reason="E2E-BIZ cleanup")
				except ApiError as exc:
					sc.notes.append(f"campaign {n}: {exc}")
			sc.notes.append(f"campaign {n}: {self.fresh().db.get_value('WhatsApp Campaign', n, 'status')}")
		was = self.state["restore"].get("owner_notification_enabled")
		if was and not self.args.keep_owner_off:
			self.client.write("notifications.save_editor", payload={"name": OWNER_SI_NOTIFICATION, "notification_name": OWNER_SI_NOTIFICATION, "enabled": 1})
		if was is not None:
			sc.check(f"the owner's notification «{OWNER_SI_NOTIFICATION}» is back to enabled={was}", int(self.fresh().db.get_value("WhatsApp Notification", OWNER_SI_NOTIFICATION, "enabled")) == int(was) or self.args.keep_owner_off)
		open_rows = self.fresh().get_all("WhatsApp Log", filters={"phone_e164": ("in", list(ALLOWED)), "creation": (">=", self._since()), "status": ("in", list(base.OPEN))}, pluck="name")
		sc.check("nothing of this test is still waiting to be sent", not open_rows, open_rows)
		sc.notes.append("kept as evidence: the submitted documents, the logs, the templates, the contact group, the finished campaigns; the test user stays enabled for verify_inbound")


ALL = ["preflight", "setup", "invoices", "orders", "payments", "reminder", "alerts", "campaign_offer", "campaign_poll", "templates", "bulk", "commands_plan", "consistency", "screens"]


def main() -> int:
	ap = argparse.ArgumentParser(description=__doc__)
	ap.add_argument("--site", default="whatsapp.dev.sanad.digital")
	ap.add_argument("--base", default="http://127.0.0.1:8000")
	ap.add_argument("--out", required=True)
	ap.add_argument("--pw-dir", default=os.environ.get("E2E_PW_DIR"))
	ap.add_argument("--media", default=None, help="folder with the product pictures and the offer banner")
	ap.add_argument("--only", nargs="*", default=None, help=f"scenarios: {' '.join(ALL + ['verify_inbound', 'cleanup'])}")
	ap.add_argument("--alert", default=None, choices=["receivable", "ledger", "trial"])
	ap.add_argument("--since", default=None, help="verify_inbound: site-time start")
	ap.add_argument("--keep-owner-off", action="store_true", help="cleanup: leave the owner's Sales Invoice notification disabled")
	ap.add_argument("--dry-run", action="store_true")
	ap.add_argument("--names", nargs="*", default=None)
	args = ap.parse_args()
	args.media = args.media or os.path.join(os.path.abspath(args.out), "media")
	names = args.only or ALL
	if "preflight" not in names and names != ["cleanup"]:
		names = ["preflight"] + names
	eng = Biz(args)
	try:
		eng.run(names)
	finally:
		eng.frappe.destroy()
	bad = [s for s in eng.results if s.status in ("fail", "error")]
	print("\n" + "\n".join(f"{s.name:<20} {s.status}" for s in eng.results))
	print(f"results: {os.path.join(eng.out, 'run-' + eng.run_id)}.json/.md")
	return 1 if bad else 0


if __name__ == "__main__":
	sys.exit(main())
