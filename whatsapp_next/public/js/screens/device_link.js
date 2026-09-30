// How a WhatsApp Device reads wherever it is linked — every list, table and drawer: a dot in the
// device's state colour and its name, nothing else (`sanad.ui.link_renderers`). The state is not on
// the row that links to it, so the devices are read once (a handful of rows) and kept; a dot drawn
// before they arrive is grey and takes its colour as soon as they do, and `wa:device:status`
// recolours every dot on the page when a device connects or drops.

frappe.provide("whatsapp_next.device_link");

(function () {
	const DOCTYPE = "WhatsApp Device";
	const STATES = {
		Connected: { tone: "green", label: () => __("Connected") },
		"Pending QR": { tone: "blue", label: () => __("Not paired") },
		Disconnected: { tone: "amber", label: () => __("Disconnected") },
		"Logged Out": { tone: "red", label: () => __("Signed out") },
	};
	const state = { rows: null, loading: null };

	const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
	const look = (status) => STATES[status] || { tone: "gray", label: () => __(status || "Unknown") };

	function load() {
		if (state.rows || state.loading) return state.loading;
		state.loading = frappe.db
			.get_list(DOCTYPE, { fields: ["name", "device_name", "status", "disabled"], limit: 500 })
			.then((rows) => {
				state.rows = {};
				(rows || []).forEach((r) => (state.rows[r.name] = r));
				paint();
			})
			.catch(() => {
				state.rows = {};
			})
			.finally(() => (state.loading = null));
		return state.loading;
	}

	/** Recolour every device dot on the page from what is known now. */
	function paint(only) {
		document.querySelectorAll(only ? `.wa-devlink[data-device="${CSS.escape(only)}"]` : ".wa-devlink[data-device]").forEach((el) => {
			const row = state.rows && state.rows[el.dataset.device];
			if (!row) return;
			const l = look(row.status);
			el.dataset.tone = l.tone;
			const dot = el.querySelector(".wa-devlink__dot");
			if (dot) dot.title = l.label();
			const sr = el.querySelector(".wa-devlink__state");
			if (sr) sr.textContent = l.label();
		});
	}

	/** The link itself: the dot, the name, and the state in words for a screen reader. */
	function html(name, display) {
		if (!state.rows) load();
		const row = state.rows && state.rows[name];
		const l = look(row && row.status);
		// Desk hands the device's title when it fetched it; otherwise the known name, else the ID
		const label = display && display !== name ? display : (row && row.device_name) || name;
		return `<a class="wa-devlink" href="${esc(frappe.utils.get_form_link(DOCTYPE, name))}" data-device="${esc(name)}" data-tone="${row ? l.tone : "gray"}" title="${esc(label)}"><span class="wa-devlink__dot" aria-hidden="true" title="${esc(row ? l.label() : "")}"></span><span class="wa-devlink__name" dir="auto">${esc(label)}</span><span class="sr-only wa-devlink__state">${esc(row ? l.label() : "")}</span></a>`;
	}

	whatsapp_next.device_link.html = html;
	whatsapp_next.device_link.reload = () => {
		state.rows = null;
		return load();
	};

	const register = () => {
		if (!window.sanad || !sanad.ui) return;
		sanad.ui.link_renderers = sanad.ui.link_renderers || {};
		sanad.ui.link_renderers[DOCTYPE] = html;
	};
	register();
	$(document).on("app_ready", register);

	// a device that connects or drops recolours its dots wherever they are
	$(document).on("app_ready", () => {
		frappe.realtime.on("wa:device:status", (data) => {
			if (!data || !data.device || !state.rows) return;
			if (state.rows[data.device]) state.rows[data.device].status = data.status;
			else return whatsapp_next.device_link.reload();
			paint(data.device);
		});
	});
})();
