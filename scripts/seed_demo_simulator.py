"""Demo data for the Simulator and the Functions Center.

The two screens read well only when something is there to read: a command the site actually answers
(so "Message on behalf" offers a word to send and the Functions Center shows a linked command with
a run count), one contact with a linked account, and a short conversation with it.

Dev sites only — it writes real documents. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_simulator.py apps/whatsapp_next/whatsapp_next/_seed_s.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_s.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_s.clear   # to undo
    rm apps/whatsapp_next/whatsapp_next/_seed_s.py

Everything it creates carries `DEMOSIM-` in `client_ref` (messages) or the `DEMOSIM` prefix in its
name (command, contact), so `clear()` can take it all back out.
"""

import frappe
from frappe.utils import add_to_date, now_datetime

TAG = "DEMOSIM-"
COMMAND_CODE = "ping"
CONTACT_NAME = "Rana Al Otaibi"
PHONE = "+966500330077"
CONVERSATION = [
    ("in", "Hello, are you there?", 46),
    ("out", "Yes — write #ping to check the connection.", 44),
    ("in", "#ping hello", 40),
    ("out", "pong: hello (now)", 39),
]


def _device() -> str:
    row = frappe.get_all("WhatsApp Device", filters={"disabled": 0}, fields=["name"], limit=1)
    if not row:
        frappe.throw("Pair a WhatsApp Device first.")
    return row[0].name


def _function() -> str:
    """An installed function the demo command can run — `ping` when it is there."""
    if frappe.db.exists("WhatsApp Function", COMMAND_CODE):
        return COMMAND_CODE
    row = frappe.get_all("WhatsApp Function", fields=["name"], limit=1)
    if not row:
        frappe.throw("Install a function from the Functions Center first.")
    return row[0].name


def _command(function: str) -> str:
    if frappe.db.exists("WhatsApp Command", COMMAND_CODE):
        doc = frappe.get_doc("WhatsApp Command", COMMAND_CODE)
        doc.status = "Active"
        doc.save(ignore_permissions=True)
        return doc.name
    doc = frappe.get_doc(
        {
            "doctype": "WhatsApp Command",
            "code": COMMAND_CODE,
            "title": "Connection check",
            "function": function,
            "status": "Active",
            "synonyms": "بنق",
            "description": f"{TAG}replies with an echo so an agent can verify the round trip.",
        }
    )
    doc.insert(ignore_permissions=True)
    return doc.name


def _contact() -> str:
    existing = frappe.get_all("Contact", filters={"first_name": CONTACT_NAME}, fields=["name"], limit=1)
    if existing:
        return existing[0].name
    doc = frappe.get_doc(
        {
            "doctype": "Contact",
            "first_name": CONTACT_NAME,
            "phone_nos": [{"phone": PHONE, "is_primary_mobile_no": 1}],
        }
    )
    doc.insert(ignore_permissions=True)
    return doc.name


def _message(direction: str, body: str, minutes: int, device: str, contact: str) -> None:
    when = add_to_date(now_datetime(), minutes=-minutes)
    if direction == "out":
        doc = frappe.get_doc(
            {
                "doctype": "WhatsApp Log",
                "device": device,
                "recipient_type": "Individual",
                "display_name": CONTACT_NAME,
                "phone": PHONE,
                "phone_e164": PHONE,
                "contact": contact,
                "message_type": "Text",
                "body": body,
                "status": "Read",
                "source_type": "Simulator",
                "client_ref": TAG + frappe.generate_hash(length=8),
                "queued_at": when,
                "sent_at": when,
            }
        )
    else:
        doc = frappe.get_doc(
            {
                "doctype": "WhatsApp Inbound Message",
                "device": device,
                "phone": PHONE,
                "phone_e164": PHONE,
                "contact": contact,
                "display_name": CONTACT_NAME,
                "message_type": "Text",
                "body": body,
                "provider_message_id": TAG + frappe.generate_hash(length=10),
                "received_at": when,
                "command_status": "None",
            }
        )
    doc.flags.ignore_permissions = True
    doc.insert(ignore_permissions=True)


def plan() -> dict:
    """What `run()` would create, without writing anything."""
    return {
        "command": COMMAND_CODE,
        "contact": CONTACT_NAME,
        "phone": PHONE,
        "messages": len(CONVERSATION),
    }


def _enable_commands() -> None:
    """The command router is what "Message on behalf" demonstrates; a demo site keeps it on."""
    settings = frappe.get_doc("WhatsApp Settings")
    if not settings.enable_commands:
        settings.enable_commands = 1
        settings.save(ignore_permissions=True)


def run() -> dict:
    _enable_commands()
    device = _device()
    function = _function()
    command = _command(function)
    contact = _contact()
    for direction, body, minutes in CONVERSATION:
        _message(direction, body, minutes, device, contact)
    frappe.db.commit()
    return {"command": command, "contact": contact, "messages": len(CONVERSATION)}


def clear() -> dict:
    removed = {"messages": 0, "command": 0, "contact": 0}
    for doctype, field in (("WhatsApp Log", "client_ref"), ("WhatsApp Inbound Message", "provider_message_id")):
        for row in frappe.get_all(doctype, filters={field: ("like", f"{TAG}%")}, pluck="name"):
            frappe.delete_doc(doctype, row, force=True, ignore_permissions=True)
            removed["messages"] += 1
    if frappe.db.exists("WhatsApp Command", COMMAND_CODE):
        frappe.delete_doc("WhatsApp Command", COMMAND_CODE, force=True, ignore_permissions=True)
        removed["command"] = 1
    for row in frappe.get_all("Contact", filters={"first_name": CONTACT_NAME}, pluck="name"):
        frappe.delete_doc("Contact", row, force=True, ignore_permissions=True)
        removed["contact"] += 1
    frappe.db.commit()
    return removed
