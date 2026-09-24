// WhatsApp Campaign form (09 row 6). The form opens with the same instrument the Campaigns list
// draws — one console that says what the campaign is doing, how far it got, what it will cost and
// when it ends, with the verbs beside the state they change (D-088). The vocabulary (funnel bar,
// counters, ETA sentence, the verbs and their confirmations) is shared with the list through
// `public/js/screens/campaigns.js`, so a campaign reads the same wherever the reader meets it.
//
// Below the console: the recipients child table becomes a PagedChildTable fed by
// `campaigns.get_recipients_page` with ContactPicker add / remove, and every message row can be
// previewed. Terminal campaigns are read-only.

const K = whatsapp_next.campaigns;
const CON = whatsapp_next.console;
const { TERMINAL, EDITABLE, is_manager, handed_of_doc, pct_text, device_title, bar_html, stats_html, eta_text } = K;
const fmt_int = (v) => sanad.ui.format_int(v);
const esc = (v) => sanad.ui.escape(v);

// The one status → colour source for recipient rows; PagedChildTable and the ContactPicker read it
// through `sanad.ui.indicator_for`.
frappe.listview_settings["WhatsApp Campaign Recipient"] = {
	get_indicator(doc) {
		const colour = { Pending: "gray", Queued: "blue", Sent: "green", Delivered: "green", Read: "green", Failed: "red", Cancelled: "red", Removed: "gray" }[doc.status] || "gray";
		return [__(doc.status), colour, `status,=,${doc.status}`];
	},
};

function can_change_recipients(frm) {
	return !frm.is_new() && !frm.is_dirty() && !TERMINAL.includes(frm.doc.status) && frappe.perm.has_perm(frm.doctype, 0, "write", frm.doc);
}

function open_picker(frm, operation, preselect) {
	new sanad.ui.ContactPicker({
		target_doctype: frm.doctype,
		target_name: frm.doc.name,
		operation,
		preselect,
		target_label: frm.doc.campaign_name || frm.doc.name,
		on_commit: () => frm.reload_doc(),
	});
}

function mount_recipients(frm) {
	// Shown as visible text next to the buttons when they are disabled (never only a hover title).
	const hint = frm.is_new() || frm.is_dirty() ? __("Save the campaign to add or remove recipients.") : TERMINAL.includes(frm.doc.status) ? __("The campaign has ended, so recipients can no longer change.") : undefined;
	const toolbar_actions = [
		{ label: __("Add recipients"), primary: true, icon: "es-line-add", condition: () => !TERMINAL.includes(frm.doc.status) && is_manager(), disabled: !can_change_recipients(frm), hint, handler: () => open_picker(frm, "add") },
		{ label: __("Remove recipients"), icon: "es-line-delete", condition: () => !TERMINAL.includes(frm.doc.status) && is_manager() && cint(frm.doc.total_recipients) > 0, disabled: !can_change_recipients(frm), hint, handler: () => open_picker(frm, "remove") },
	];
	if (frm.sanad_recipients && frm.sanad_recipients.frm === frm && frm.$wrapper.find('.sanad-pct[data-fieldname="recipients"]').length) {
		frm.sanad_recipients.update({ toolbar_actions });
		return;
	}
	frm.sanad_recipients = new sanad.ui.PagedChildTable({
		frm,
		fieldname: "recipients",
		page_method: "campaigns.get_recipients_page",
		page_length: 50,
		columns: [{ fieldname: "display_name" }, { fieldname: "phone_e164" }, { fieldname: "source_type" }, { fieldname: "status" }, { fieldname: "contact" }],
		filters: [{ fieldname: "status", type: "select" }, { fieldname: "source_type", type: "select" }],
		status_field: "status",
		row_actions: [
			{ label: __("Sent message"), icon: "es-line-link", condition: (row) => !!row.outbound_message, handler: (row) => frappe.set_route("Form", "WhatsApp Log", row.outbound_message) },
			{ label: __("Open contact"), icon: "es-line-people", condition: (row) => !!row.contact, handler: (row) => frappe.set_route("Form", "Contact", row.contact) },
		],
		toolbar_actions,
		empty_text: __("No recipients yet"),
	});
}

// ---- the campaign console ----------------------------------------------------------------------

const TONE = { gray: "gray", blue: "blue", green: "green", orange: "amber", red: "red" };
const messages_of = (frm) => Math.max(1, (frm.doc.messages || []).length);

/** What the state cell says under the status word: the fact that explains it. */
function state_sub(frm) {
	const doc = frm.doc;
	if (doc.status === "Scheduled" && doc.scheduled_at) {
		const days = frappe.datetime.get_day_diff(doc.scheduled_at, frappe.datetime.now_datetime());
		const when = `${frappe.datetime.str_to_user(doc.scheduled_at).slice(0, 10)} ${String(doc.scheduled_at).slice(11, 16)}`;
		const relative = days < 0 ? __("the time has passed") : days === 0 ? __("today") : days === 1 ? __("tomorrow") : __("in {0} days", [fmt_int(days)]);
		return __("starts {0} · {1}", [when, relative]);
	}
	if (doc.status === "Paused") return doc.pause_reason ? __("paused: {0}", [doc.pause_reason]) : __("paused — nothing is going out");
	if (doc.status === "Cancelled") return doc.cancel_reason ? __("cancelled: {0}", [doc.cancel_reason]) : __("cancelled");
	if (TERMINAL.includes(doc.status)) return doc.ended_at ? __("ended {0}", [whatsapp_next.fmt.dt(doc.ended_at)]) : __("ended");
	if (doc.status === "Draft") return __("not started yet");
	return __("handing messages to the queue");
}

/** Before the first message: what pressing Start would cost, in one line. */
function plan_text(frm) {
	const doc = frm.doc;
	const per = messages_of(frm);
	const total = cint(doc.total_recipients) * per;
	if (!cint(doc.total_recipients)) return __("No recipients yet — add recipients before starting.");
	const rate = cint(doc.messages_per_minute) || 20;
	const minutes = Math.max(1, Math.round(total / rate));
	return __("{0} × {1} = {2} · {3} at {4}/min ≈ {5}", [
		sanad.ui.plural(cint(doc.total_recipients), { one: __("{0} recipient"), other: __("{0} recipients") }),
		sanad.ui.plural(per, { one: __("{0} message"), other: __("{0} messages") }),
		sanad.ui.plural(total, { one: __("{0} message in total"), other: __("{0} messages in total") }),
		device_title(doc.device) || __("no device"),
		fmt_int(rate),
		minutes < 60 ? __("{0} min", [fmt_int(minutes)]) : __("{0} h", [fmt_int(Math.round(minutes / 60))]),
	]);
}

function metrics_html(frm, progress) {
	const doc = frm.doc;
	const handed = handed_of_doc(doc);
	const delivered = cint(doc.delivered_count) + cint(doc.read_count);
	const failed = cint(doc.failed_count);
	const changed = cint(doc.added_count) + cint(doc.removed_count);
	const running = ["Running", "Queued"].includes(doc.status);

	const recipients_sub =
		changed && doc.started_at
			? __("{0} added · {1} removed since it started", [fmt_int(doc.added_count), fmt_int(doc.removed_count)])
			: doc.exclude_unknown_numbers
				? __("numbers with no conversation are skipped")
				: __("everyone in the list below");

	return `
		<div class="wa-ops__metrics">
			${CON.state_metric({
				label: __("Campaign"),
				state: __(doc.status),
				tone: TONE[K.INDICATOR[doc.status]] || "gray",
				pulse: running,
				sub: esc(state_sub(frm)),
				verbs: '<span class="wa-ops__verbs"></span>',
			})}
			${CON.metric(__("Recipients"), esc(fmt_int(doc.total_recipients)), esc(recipients_sub))}
			${CON.metric(__("Handed over"), esc(pct_text(handed, doc.total_recipients)), esc(__("{0} of {1} recipients", [fmt_int(handed), fmt_int(doc.total_recipients)])))}
			${CON.metric(__("Delivered"), esc(pct_text(delivered, handed)), esc(__("of {0} handed over", [fmt_int(handed)])))}
			${CON.metric(__("Read"), esc(pct_text(doc.read_count, delivered)), esc(__("of {0} delivered", [fmt_int(delivered)])))}
			${CON.metric(
				__("Failed"),
				esc(fmt_int(failed)),
				failed ? `<button type="button" class="wa-ops__link" data-go="failed">${esc(__("See the messages"))}</button>` : esc(__("no failures")),
				{ tone: failed ? "red" : "" }
			)}
		</div>`;
}

/** The lower half: the funnel while it runs, the plan before it starts. */
function run_html(frm, progress) {
	const doc = frm.doc;
	const started = handed_of_doc(doc) || cint(doc.failed_count) || !["Draft", "Scheduled"].includes(doc.status);
	if (!started) {
		return `<div class="wa-camp__plan">
			<p class="wa-camp__plan-text" dir="auto">${esc(plan_text(frm))}</p>
			<span class="wa-camp__actions"></span>
		</div>`;
	}
	const paused = doc.status === "Paused";
	return `<div class="wa-camp__run">
		<div class="wa-camp__funnel">
			${bar_html(doc, { paused })}
			<span class="wa-strip__progress-text sanad-tabular">${esc(fmt_int(handed_of_doc(doc)))} / ${esc(fmt_int(doc.total_recipients))} · ${esc(pct_text(handed_of_doc(doc), doc.total_recipients))}</span>
		</div>
		<div class="wa-camp__stats">${stats_html(doc)}</div>
		<p class="wa-camp__foot" aria-live="polite" dir="auto">${esc(eta_text(doc, progress))}</p>
		<span class="wa-camp__actions"></span>
	</div>`;
}

function render_console(frm, progress) {
	const $el = frm.sanad_console;
	if (!$el || !$el.closest("body").length) return;
	$el.html(`<section class="wa-ops wa-camp${frm.doc.status === "Paused" ? " wa-ops--paused" : ""}" aria-label="${esc(__("Campaign status"))}">
		${metrics_html(frm, progress)}
		${run_html(frm, progress)}
	</section>`);

	$el.find("[data-go=failed]").on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: frm.doc.name, status: "Failed" }));

	// The verbs sit beside the state they change; each one refreshes the form it acted on.
	const after = () => frm.reload_doc();
	const $verbs = $el.find(".wa-ops__verbs");
	const $actions = $el.find(".wa-camp__actions");
	const verbs = K.verbs(frm.doc, { after, messages: messages_of(frm) });
	const button = (verb, $host, primary) => {
		const cls = primary ? "btn-primary" : verb.tone === "danger" ? "btn-default wa-camp__verb--danger" : "btn-default";
		return $(`<button type="button" class="btn ${cls} btn-sm wa-ops__verb"></button>`)
			.text(verb.label)
			.prop("disabled", frm.is_dirty())
			.on("click", () => verb.run())
			.appendTo($host);
	};
	// the verb that changes the state stands beside it (D-088); the rest join the other actions,
	// because a metric cell holding three stacked buttons is no longer a metric cell
	const lead = verbs.find((v) => ["start", "resume", "pause"].includes(v.key));
	if (lead) button(lead, $verbs, true);
	if (frm.is_dirty() && verbs.length) $verbs.append(`<span class="wa-ops__hint">${esc(__("Save first."))}</span>`);
	verbs.filter((v) => v !== lead).forEach((v) => button(v, $actions, false));
	if (cint(frm.doc.total_recipients)) {
		$(`<button type="button" class="btn btn-default btn-sm wa-camp__log"></button>`)
			.text(__("Outbound log"))
			.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: frm.doc.name }))
			.appendTo($actions);
	}
}

/** The live counters; the form's own fields paint first so the console never starts empty. */
function load_console(frm) {
	if (frm.is_new()) return;
	render_console(frm, null);
	sanad.ui
		.call("campaigns.get_progress", { name: frm.doc.name }, { silent: true })
		.then((p) => render_console(frm, p))
		.catch(() => {});
}

function mount_console(frm) {
	if (frm.is_new()) {
		frm.sanad_console = null;
		return;
	}
	const attached = frm.sanad_console && frm.sanad_console.closest("body").length;
	if (!attached) {
		// css_class "custom": the dashboard drops it on every reset, so it is re-added per refresh.
		frm.sanad_console = frm.dashboard.add_section(sanad.ui.skeleton(1, { lines: 3 }), null, "custom wa-camp__section");
	}
	load_console(frm);
}

function subscribe(frm) {
	unsubscribe(frm);
	frm.sanad_realtime = (data) => {
		if (!data || data.campaign !== frm.doc.name) return;
		if (data.status && data.status !== frm.doc.status) return frm.reload_doc();
		load_console(frm);
		if (frm.sanad_recipients) frm.sanad_recipients.refresh();
	};
	frappe.realtime.on("wa:campaign:status", frm.sanad_realtime);
}

function unsubscribe(frm) {
	if (frm.sanad_realtime) frappe.realtime.off("wa:campaign:status", frm.sanad_realtime);
	frm.sanad_realtime = null;
}

/**
 * The messages the campaign sends, drawn as the conversation they will produce: one card per
 * message, its own editor beside a live bubble, and the delay between two messages drawn as the
 * gap between their cards. The native grid stays hidden behind it.
 */
function mount_messages(frm) {
	const editable = !TERMINAL.includes(frm.doc.status) && EDITABLE.includes(frm.doc.status) && frappe.perm.has_perm(frm.doctype, 0, "write", frm.doc);
	if (frm.sanad_messages && frm.$wrapper.find('.sanad-mc[data-fieldname="messages"]').length) {
		frm.sanad_messages.refresh();
		return;
	}
	frm.sanad_messages = new sanad.ui.MessageComposer({
		frm,
		fieldname: "messages",
		type_field: "message_type",
		body_field: "body",
		delay_field: "delay_seconds",
		max: 5,
		can_edit: () => editable,
		preview: { method: "campaigns.preview_message", args: (row) => ({ name: frm.doc.name, idx: row.idx }) },
		// the campaign renders per recipient: these are the names that exist in that context
		// (`services/campaign_runner._render_message_body`), said in the reader's words
		variables: [
			{ name: "recipient.display_name", label: __("Recipient name") },
			{ name: "recipient.phone_e164", label: __("Recipient number") },
			{ name: "recipient.contact", label: __("Linked contact") },
			{ name: "campaign.campaign_name", label: __("Campaign name") },
			{ name: "doc.name", label: __("Source document") },
			{ name: "today", label: __("Today's date") },
			{ name: "now", label: __("Now") },
		],
		empty_text: __("No message yet"),
	});
}

function preview_message(frm, row) {
	sanad.ui
		.call("campaigns.preview_message", { name: frm.doc.name, idx: row.idx }, { silent: true })
		.then((p) => {
			const d = new frappe.ui.Dialog({ title: __("Preview of message {0}", [row.idx]), fields: [{ fieldtype: "HTML", fieldname: "body" }] });
			const errors = (p.errors || []).map((e) => `<li>${esc(e)}</li>`).join("");
			d.get_field("body").$wrapper.html(`
				<div>
					<pre style="white-space:pre-wrap; font-family:inherit;">${esc(p.body || "")}</pre>
					${p.attachment_name ? `<div class="text-muted">${esc(__("Attachment: {0}", [p.attachment_name]))}</div>` : ""}
					${errors ? `<ul class="text-danger" role="alert">${errors}</ul>` : ""}
				</div>`);
			d.show();
		})
		.catch((err) => sanad.ui.Toast.error(err));
}

frappe.ui.form.on("WhatsApp Campaign", {
	setup(frm) {
		frm.set_query("device", () => ({ filters: { disabled: 0 } }));
	},

	onload(frm) {
		// "Campaign for this group" (Contact Group list / form) — new_doc drops unknown route_options,
		// so the group travels in frappe.flags and the picker opens on it after the first save.
		if (frappe.flags.wa_picker_group) {
			frm.sanad_picker_group = frappe.flags.wa_picker_group;
			frappe.flags.wa_picker_group = null;
		}
	},

	refresh(frm) {
		// the console states the status in words, with the verb that changes it; the field itself
		// would be the same fact twice, read-only, in the middle of the fields the reader may edit
		frm.set_df_property("status", "hidden", 1);
		if (TERMINAL.includes(frm.doc.status)) {
			frm.set_read_only();
			frm.disable_save();
		} else if (!EDITABLE.includes(frm.doc.status) && !frm.is_new()) {
			["messages", "device", "scheduled_at", "messages_per_minute", "exclude_unknown_numbers"].forEach((f) => frm.set_df_property(f, "read_only", 1));
		}
		mount_console(frm);
		mount_recipients(frm);
		if (!frm.is_new()) subscribe(frm);
		if (frm.sanad_picker_group && !frm.is_new() && can_change_recipients(frm)) {
			const group = frm.sanad_picker_group;
			frm.sanad_picker_group = null;
			open_picker(frm, "add", { source: "groups", ref: group });
		}
		mount_messages(frm);
	},

	on_hide(frm) {
		unsubscribe(frm);
	},
});
