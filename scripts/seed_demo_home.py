"""Demo data for the Home board.

Home reads the subscription through `usage_sync.snapshot()`, which is a *cache* of what the
platform last told us (`WhatsApp Settings`, fields listed in `usage_sync.FIELDS`). On a dev site
with no real platform link nothing ever writes it, so the "Plan usage" card and the "Plan and
wallet" panel can only show their empty state. This puts a plausible reading in that cache so the
populated state can be seen and compared with the prototype.

It writes nothing but the cache fields, it creates no documents, and `clear()` puts every field
back to empty. A real `settings.sync_subscription` overwrites it with the truth.

Dev sites only. Run it from the bench:

    cd /home/snd/frappe-bench
    cp apps/whatsapp_next/scripts/seed_demo_home.py apps/whatsapp_next/whatsapp_next/_seed_h.py
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_h.run
    bench --site whatsapp.dev.sanad.digital execute whatsapp_next._seed_h.clear   # to undo
    rm apps/whatsapp_next/whatsapp_next/_seed_h.py
"""

import frappe
from frappe.utils import add_days, now_datetime, nowdate

from whatsapp_next.services import usage_sync

# What a mid-size account looks like: a plan with room left, a wallet with a little in it, and a
# renewal close enough that "days to renewal" is worth printing.
READING = {
    "plan_code": "business-6k",
    "plan_name": "Business 6K",
    "subscription_status": "Active",
    "message_limit": 6000,
    "messages_used": 3540,
    "messages_remaining": 2460,
    "plan_messages_per_minute": 60,
    "device_limit": 10,
    "wallet_balance": 742.5,
    "wallet_currency": "SAR",
}


def _settings():
    return frappe.get_doc("WhatsApp Settings")


def run(used: int = 3540, limit: int = 6000, days_to_renewal: int = 7):
    """Arm the subscription cache so the plan card and the plan panel have something to draw."""
    doc = _settings()
    values = dict(READING)
    values["message_limit"] = limit
    values["messages_used"] = used
    values["messages_remaining"] = max(0, limit - used)
    values["subscription_start"] = add_days(nowdate(), days_to_renewal - 30)
    values["subscription_end"] = add_days(nowdate(), days_to_renewal)
    values["plan_features"] = frappe.as_json({"campaigns": True, "templates": True, "webhooks": True})
    values["subscription_synced_at"] = now_datetime()
    for field, value in values.items():
        doc.set(field, value)
    doc.flags.ignore_permissions = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    print("subscription cache armed:", values["messages_remaining"], "of", limit, "messages left")


def clear():
    """Empty every field this script wrote, back to 'the plan has not been read yet'."""
    doc = _settings()
    for field in usage_sync.FIELDS:
        doc.set(field, None)
    doc.flags.ignore_permissions = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    print("subscription cache cleared")
