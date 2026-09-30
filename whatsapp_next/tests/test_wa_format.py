# Tests for services/wa_format.py: markers WhatsApp would not draw are moved onto their text;
# correct formatting, arithmetic, snake_case, bullets and code spans are left as written.

from __future__ import annotations

import unittest

from whatsapp_next.services.wa_format import tidy_markers


class TestWaFormat(unittest.TestCase):
	def test_repairs_a_marker_spaced_on_one_side(self):
		self.assertEqual(tidy_markers("رقم * ACC-SINV-2026-00001*"), "رقم *ACC-SINV-2026-00001*")
		self.assertEqual(tidy_markers("_الاخوة :_  * Grant Plastics Ltd.*"), "_الاخوة :_  *Grant Plastics Ltd.*")
		self.assertEqual(tidy_markers("total *67000.0 *."), "total *67000.0*.")
		self.assertEqual(tidy_markers("~ old~ and _ new_"), "~old~ and _new_")

	def test_keeps_what_is_already_right_or_not_formatting(self):
		for text in (
			"*سند الرقمية*",
			"_مائل_ و *عريض*",
			"2 * 3 * 4",
			"file_name and user_id",
			"* first item\n* second item",
			"price: 5*3",
			"```* not bold*```",
		):
			self.assertEqual(tidy_markers(text), text, text)

	def test_multiline_template(self):
		src = "* {name}*\nرقم * INV-1*\n*سند*"
		self.assertEqual(tidy_markers(src), "*{name}*\nرقم *INV-1*\n*سند*")

	def test_empty(self):
		self.assertIsNone(tidy_markers(None))
		self.assertEqual(tidy_markers(""), "")
