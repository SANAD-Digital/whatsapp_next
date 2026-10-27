// The function's header (WA-FUNCTION) in the shape the command editor and the function window draw.
// The server reads a function from its Server Script header: values the sender writes (`inputs`), the
// site's options (`settings`), the message texts (`templates`, per language) and the replies it sends.
// `sanad.ui.CommandEditor` and `sanad.ui.FunctionDetail` are portable kit components that draw a
// function as variables · options · outputs; these helpers turn the header into that shape and turn
// the edited outputs back into the command's `templates` rows — the components stay unchanged.

frappe.provide("whatsapp_next.functions");

(() => {
	const LANG = () => frappe.boot.lang || "en";
	const SETTING_TYPE = { Check: "Check", Int: "Int", Select: "Select", Date: "Data", Link: "Data", Dynamic: "Data", Data: "Data" };

	/** A template's text in a language: `{lang: text}` (with `""` for every language) or one text. */
	const text_in = (value, lang) => {
		if (value && typeof value === "object") return value[lang] || value[(lang || "").split("-")[0]] || value[""] || "";
		return value || "";
	};

	/** The header's default text of a message in `lang`. */
	const default_text = (t, lang) => text_in(t.defaults_by_lang || {}, lang) || t.default || "";

	/** One message template as an editor output row: its text here, else the site's, else the header's. */
	function output_of(t, own) {
		const lang = LANG();
		const fallback = text_in(t.site, lang) || default_text(t, lang);
		return {
			output_key: t.key,
			label: t.label,
			output_type: "Text",
			default_template: fallback,
			template: own != null && own !== "" ? own : fallback,
			variables: (t.vars || []).map((v) => v.name).join("\n"),
			notes: "",
		};
	}

	/** The editor's function spec: `templates` drawn as text outputs; `settings` keep their choices. */
	function editor_spec(spec, command_templates) {
		if (!spec) return spec;
		// the command's own text: the row in the reader's language, else the one for every language
		const own = {};
		(command_templates || []).filter((r) => !r.language).forEach((r) => (own[r.param] = r.text));
		(command_templates || []).filter((r) => r.language === LANG()).forEach((r) => (own[r.param] = r.text));
		return Object.assign({}, spec, {
			settings: (spec.settings || []).map((s) =>
				Object.assign({}, s, {
					fieldtype: SETTING_TYPE[s.fieldtype] || "Data",
					// a list, as the editor draws it (CommandEditor README: `choices[]`)
					choices: s.choices || [],
					notes: s.depends_on ? __("Only when {0} is {1}", [s.depends_on.param, s.depends_on.value]) : "",
				})
			),
			outputs: (spec.templates || []).map((t) => output_of(t, own[t.key])),
			party_types: (spec.party_types && spec.party_types.mode === "only" ? spec.party_types.types : []) || [],
			when_to_use: spec.party_types_text ? __("Serves: {0}", [spec.party_types_text]) : "",
		});
	}

	/**
	 * The edited outputs back as the command's rows. The editor shows one text per message (the
	 * reader's language, else every language's): that row is written back where it came from, a text
	 * equal to the function's is not kept, and the rows of other languages stay as they were.
	 */
	function templates_of(outputs, spec_outputs, original) {
		const lang = LANG();
		const base = {};
		(spec_outputs || []).forEach((o) => (base[o.output_key] = o.default_template || ""));
		const rows = (original || []).filter((r) => r.language && r.language !== lang).map((r) => ({ param: r.param, language: r.language, text: r.text }));
		const had_own_lang = new Set((original || []).filter((r) => r.language === lang).map((r) => r.param));
		(outputs || []).forEach((o) => {
			const text = (o.template || "").trim();
			if (o.output_type !== "Text" || !text || text === (base[o.output_key] || "").trim()) return;
			rows.push({ param: o.output_key, language: had_own_lang.has(o.output_key) ? lang : null, text: o.template });
		});
		return rows;
	}

	/** An editor payload (with `outputs`) as the server's (with `templates`). */
	function payload_of(payload, spec_outputs, original) {
		const out = Object.assign({}, payload);
		if ("outputs" in out) {
			out.templates = templates_of(out.outputs, spec_outputs, original);
			delete out.outputs;
		}
		return out;
	}

	Object.assign(whatsapp_next.functions, { editor_spec, templates_of, payload_of, text_in, default_text, output_of });
})();
