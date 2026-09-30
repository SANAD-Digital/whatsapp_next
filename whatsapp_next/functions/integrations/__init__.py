# Module role: functions this app ships for other apps' data. Each sub-package is a catalog
# (`vN/catalog.json`, listed in `whatsapp_function_catalogs`) whose `requires_apps` hides it on a
# site without those apps, plus handlers (`whatsapp_function_handlers`) that import the other
# app only when called — so nothing here fails to load where that app is absent.
