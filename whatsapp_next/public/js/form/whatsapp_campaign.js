// WhatsApp Campaign form (09 row 6).
//
// The form does not look like a form. A campaign is not a record someone fills in field by field:
// it is a decision with four parts and a cost, and then a thing that runs. So Desk's layout is
// kept in the DOM — it is what validates and saves — and hidden behind the product's own screen:
// `whatsapp_next.campaign.Builder`, a wizard while the campaign is a draft and a monitor once it
// has started (`public/js/screens/campaign/`).
//
// This file is the wiring and nothing else. It hands the builder Desk's events (refresh, child
// rows added and removed, realtime status), keeps the lifecycle rules Desk owns (read-only on a
// terminal campaign) and lets the builder own everything the reader sees. Every value the builder
// writes goes through `frm.set_value` / `frappe.model.set_value`, so dirty state, validation,
// permissions and save are Frappe's throughout.

const K = whatsapp_next.campaigns;
const B = whatsapp_next.campaign;

// The one status → colour source for recipient rows; DataList and the ContactPicker read it
// through `sanad.ui.indicator_for`.
frappe.listview_settings["WhatsApp Campaign Recipient"] = {
	get_indicator(doc) {
		const colour = { Pending: "gray", Queued: "blue", Sent: "green", Delivered: "green", Read: "green", Failed: "red", Cancelled: "red", Removed: "gray" }[doc.status] || "gray";
		return [__(doc.status), colour, `status,=,${doc.status}`];
	},
};

/** Our screen's own container, in front of the layout that saves. */
function mount(frm) {
	const $layout = frm.$wrapper.find(".form-layout").first();
	$layout.addClass("wa-cb-native");
	if (!frm.wa_root || !frm.wa_root.closest("body").length) {
		frm.$wrapper.find("> .wa-cb").remove();
		frm.wa_root = $('<div class="sanad-kit wa-cb"></div>').insertBefore($layout);
	}
	// Desk keeps one form per DocType and hands it the next document: a builder left over from the
	// campaign opened before this one would carry that campaign's step and tab.
	if (frm.wa_builder && frm.wa_builder.docname !== frm.doc.name) {
		frm.wa_builder.destroy();
		frm.wa_builder = null;
	}
	if (!frm.wa_builder) {
		frm.wa_builder = new B.Builder({ frm, wrapper: frm.wa_root });
		frm.wa_builder.docname = frm.doc.name;
	} else {
		frm.wa_builder.refresh();
	}
	return frm.wa_builder;
}

const sync = (frm) => frm.wa_builder && frm.wa_builder.sync();

function subscribe(frm) {
	unsubscribe(frm);
	frm.sanad_realtime = (data) => {
		if (!data || data.campaign !== frm.doc.name) return;
		if (data.status && data.status !== frm.doc.status) return frm.reload_doc();
		if (!frm.wa_builder) return;
		frm.wa_builder.sync();
		if (frm.wa_builder.pane && frm.wa_builder.pane.load_progress) frm.wa_builder.pane.load_progress();
	};
	frappe.realtime.on("wa:campaign:status", frm.sanad_realtime);
}

function unsubscribe(frm) {
	if (frm.sanad_realtime) frappe.realtime.off("wa:campaign:status", frm.sanad_realtime);
	frm.sanad_realtime = null;
}

frappe.ui.form.on("WhatsApp Campaign", {
	setup(frm) {
		frm.set_query("device", () => ({ filters: { disabled: 0 } }));
	},

	onload(frm) {
		// a document the reader has not been through yet opens on its first step
		frm.wa_step = 0;
		frm.wa_monitor_tab = "overview";
		// "Campaign for this group" (Contact Group list / form) — new_doc drops unknown route_options,
		// so the group travels in frappe.flags and the picker opens on it after the first save.
		if (frappe.flags.wa_picker_group) {
			frm.sanad_picker_group = frappe.flags.wa_picker_group;
			frappe.flags.wa_picker_group = null;
		}
	},

	refresh(frm) {
		// the screen takes the height it has and scrolls inside itself, so the page it sits on
		// must not add a second scroll under it
		frm.$wrapper.addClass("wa-campaign");
		if (K.TERMINAL.includes(frm.doc.status)) {
			frm.set_read_only();
			frm.disable_save();
		}
		const builder = mount(frm);
		if (!frm.is_new()) subscribe(frm);

		if (frm.sanad_picker_group && !frm.is_new() && !frm.is_dirty()) {
			const group = frm.sanad_picker_group;
			frm.sanad_picker_group = null;
			builder.go(2);
			if (builder.pane && builder.pane.open_picker) builder.pane.open_picker("add", { source: "groups", ref: group });
		}
	},

	// the header, the summary aside and the sticky bar all count the messages; a row added or
	// taken away changes what the campaign costs, so they are told
	messages_add: sync,
	messages_remove: sync,
	messages_move: sync,

	on_hide(frm) {
		unsubscribe(frm);
	},
});

// the delay between two messages is part of how long the campaign takes
frappe.ui.form.on("WhatsApp Campaign Message", {
	delay_seconds(frm) {
		sync(frm);
	},
	message_type(frm) {
		sync(frm);
	},
});
