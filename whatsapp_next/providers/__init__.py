# Package role: the provider abstraction — outbound I/O only. Nothing outside this package imports
# a concrete provider module; resolution goes through `registry.get_provider` and the
# `whatsapp_providers` hook (architecture.md).
