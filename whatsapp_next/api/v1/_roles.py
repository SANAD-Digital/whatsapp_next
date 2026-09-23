# Module role: role tuples shared by the v1 API modules (backend-plan §4.0 shorthand).
SYSTEM_MANAGER = ("System Manager",)
MANAGER = ("WhatsApp Manager", "System Manager")
AGENT_UP = ("WhatsApp Agent", *MANAGER)
VIEWER_UP = ("WhatsApp Viewer", *AGENT_UP)
CONTACT_USER = ("WhatsApp Contact User",)
