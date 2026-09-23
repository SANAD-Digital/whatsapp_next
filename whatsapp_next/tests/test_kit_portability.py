# Tests for the portable component kit (phase 5, `.claude/rules/ui.md`): nothing under
# `public/js/ui/` references this app, every component ships `index.js` + `style.scss` +
# `README.md` with a usage snippet, the kit barrel and style sheet import every component, the
# kit uses only Espresso colour tokens and logical CSS properties, and every hooked list/form
# script exists.

from __future__ import annotations

import re
from pathlib import Path

import frappe
from frappe.tests import IntegrationTestCase

APP_DIR = Path(frappe.get_app_path("whatsapp_next"))
PUBLIC = APP_DIR / "public"
UI = PUBLIC / "js" / "ui"

EXPECTED_COMPONENTS = {
	"StatusBadge",
	"EmptyState",
	"Toast",
	"ConfirmDialog",
	"FilterBar",
	"TreeGroupBy",
	"RowActions",
	"BulkActions",
	"Stepper",
	"PhoneField",
	"ListStatsCard",
	"MetaDialog",
	"Drawer",
	"ChatThread",
	"ConversationDrawer",
	"QuickSend",
	"TemplateEditor",
	"PagedChildTable",
	"DashboardBlock",
	"ContactPicker",
	"DataList",
	"PageHeader",
}

HEX_OR_RGB = re.compile(r"(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()")
PHYSICAL_PROPS = re.compile(
	r"(^|[;{\s])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align\s*:\s*(left|right))\s*:",
	re.M,
)


def _component_dirs() -> list[Path]:
	return sorted(p for p in UI.iterdir() if p.is_dir() and not p.name.startswith("_"))


class TestKitPortability(IntegrationTestCase):
	def test_no_app_reference_inside_the_kit(self):
		offenders = []
		for path in UI.rglob("*"):
			if path.is_file() and "whatsapp_next" in path.read_text(encoding="utf-8"):
				offenders.append(str(path.relative_to(APP_DIR)))
		self.assertEqual(offenders, [], "kit files must not reference the host app")

	def test_every_component_is_complete(self):
		found = {p.name for p in _component_dirs()}
		self.assertEqual(EXPECTED_COMPONENTS - found, set(), "missing component folders")
		for comp in _component_dirs():
			for fname in ("index.js", "style.scss", "README.md"):
				self.assertTrue((comp / fname).exists(), f"{comp.name}/{fname} missing")
			index = (comp / "index.js").read_text(encoding="utf-8")
			self.assertIn(
				f"sanad.ui.{comp.name} = class", index, f"{comp.name} must export sanad.ui.{comp.name}"
			)
			self.assertNotIn("stub, replaced", index, f"{comp.name}/index.js is still a stub")
			readme = (comp / "README.md").read_text(encoding="utf-8")
			self.assertIn("## Usage", readme, f"{comp.name}/README.md has no usage section")
			self.assertIn("```", readme, f"{comp.name}/README.md has no snippet")
			self.assertIn("## Live use", readme, f"{comp.name}/README.md names no live use")
			self.assertIn("## Design gate", readme, f"{comp.name}/README.md records no design-gate findings")

	def test_barrel_and_styles_import_every_component(self):
		barrel = (UI / "index.js").read_text(encoding="utf-8")
		styles = (UI / "style.scss").read_text(encoding="utf-8")
		for comp in _component_dirs():
			self.assertIn(f'"./{comp.name}/index.js"', barrel, f"{comp.name} not in ui/index.js")
			self.assertIn(f'"./{comp.name}/style"', styles, f"{comp.name} not in ui/style.scss")

	def test_kit_uses_only_espresso_tokens_and_logical_properties(self):
		offenders = []
		for path in UI.rglob("*.scss"):
			text = path.read_text(encoding="utf-8")
			# strip comments before matching
			text = re.sub(r"//.*", "", text)
			text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
			if HEX_OR_RGB.search(text):
				offenders.append(f"{path.relative_to(APP_DIR)}: hard-coded colour")
			if PHYSICAL_PROPS.search(text):
				offenders.append(f"{path.relative_to(APP_DIR)}: physical left/right property")
		self.assertEqual(offenders, [])

	def test_kit_labels_go_through_translation(self):
		"""Every quoted sentence handed to the UI is wrapped in `__()` — a heuristic on `label:`."""
		offenders = []
		pattern = re.compile(r"""(label|title|description|placeholder)\s*:\s*["'][A-Z][^"']*["']""")
		for path in UI.rglob("*.js"):
			for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
				if pattern.search(line) and "__(" not in line:
					offenders.append(f"{path.relative_to(APP_DIR)}:{i}")
		self.assertEqual(offenders, [], "untranslated UI strings")

	def test_hooks_reference_existing_assets(self):
		hooks = frappe.get_hooks(app_name="whatsapp_next")
		self.assertIn("whatsapp_next.bundle.js", hooks.get("app_include_js", []))
		self.assertIn("whatsapp_next.bundle.css", hooks.get("app_include_css", []))
		self.assertTrue((PUBLIC / "js" / "whatsapp_next.bundle.js").exists())
		self.assertTrue((PUBLIC / "scss" / "whatsapp_next.bundle.scss").exists())
		for hook in ("doctype_js", "doctype_list_js"):
			for doctype, paths in (hooks.get(hook) or {}).items():
				for rel in paths if isinstance(paths, list) else [paths]:
					self.assertTrue((APP_DIR / rel).exists(), f"{hook}[{doctype}] → {rel} missing")
					self.assertTrue(
						frappe.db.exists("DocType", doctype), f"{hook}: unknown DocType {doctype}"
					)

	def test_kit_readme_explains_copying(self):
		readme = (UI / "README.md").read_text(encoding="utf-8")
		self.assertIn("another", readme.lower())
		self.assertIn("sanad.ui.configure", readme)
