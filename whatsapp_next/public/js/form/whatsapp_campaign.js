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
const RECIPIENT_STATUSES = ["Pending", "Queued", "Sent", "Delivered", "Read", "Failed", "Cancelled", "Removed"];
const SOURCE_TYPES = ["Contact Group", "Contact", "DocType", "Excel", "vCard", "Manual"];
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

/**
 * The recipients, as the product's own list: the shared toolbar (search · status · source ·
 * grouping) over `sanad.ui.DataList` in page mode, paged and ordered by the server. The native
 * grid stays hidden behind it, and the picker's two verbs sit in the panel's head.
 */
function mount_recipients(frm) {
	const state = { page: 0, page_length: 50, search: "", filters: {}, order_by: "idx asc", group_by: [] };
	const field = frm.get_field("recipients");
	const $host = field && field.grid && field.grid.wrapper ? field.grid.wrapper : field && field.$wrapper;
	if (!$host || !$host.length) return;
	if (frm.sanad_recipients && frm.$wrapper.find(".wa-recipients").length) {
		frm.sanad_recipients.update_actions();
		return;
	}
	$host.addClass("sanad-mc-host"); // the native grid parts are hidden by the same rule
	const $panel = $(`
		<div class="sanad-kit wa-recipients">
			<div class="wa-recipients__head">
				<h4 class="wa-recipients__title">${esc(__("Recipients"))}</h4>
				<span class="wa-recipients__count sanad-tabular" aria-live="polite"></span>
				<div class="wa-recipients__actions"></div>
			</div>
			<div class="wa-recipients__toolbar"></div>
			<div class="wa-recipients__table"></div>
		</div>`);
	$host.find(".wa-recipients").remove();
	$host.append($panel);

	const $count = $panel.find(".wa-recipients__count");
	const $actions = $panel.find(".wa-recipients__actions");

	const load = (table) =>
		sanad.ui
			.call(
				"campaigns.get_recipients_page",
				{
					name: frm.doc.name,
					page: state.page + 1,
					page_length: state.page_length,
					search: state.search || undefined,
					status: state.filters.status || undefined,
					source_type: state.filters.source_type || undefined,
					order_by: state.order_by,
				},
				{ silent: true }
			)
			.then((r) => {
				table.set_rows(r.rows || [], r.total);
				const counts = (r.counts || {}).status || {};
				$count.text(sanad.ui.plural(cint(counts.All || r.total), { one: __("{0} recipient"), other: __("{0} recipients") }));
				render_filters(counts, (r.counts || {}).source_type || {});
				return r;
			})
			.catch((err) => sanad.ui.Toast.error(err));

	const table = new sanad.ui.DataList({
		wrapper: $panel.find(".wa-recipients__table"),
		doctype: "WhatsApp Campaign Recipient",
		page_length: state.page_length,
		selectable: true,
		pinnable: false,
		columns: [
			{ fieldname: "display_name", label: __("Name"), sortable: true, sub: (row) => `<span class="sanad-tabular" dir="ltr">${esc(row.phone_e164 || row.phone || "")}</span>` },
			{ fieldname: "status", label: __("Status"), type: "status", sortable: true, width: 130 },
			{ fieldname: "source_type", label: __("Source"), sortable: true, width: 140 },
			{ fieldname: "contact", label: __("Contact"), width: 170 },
			{ fieldname: "error_code", label: __("Error"), width: 140, format: (v) => (v ? `<span class="sanad-tone--red">${esc(v)}</span>` : "—") },
		],
		on_page: (page, t) => {
			state.page = page;
			load(t);
		},
		on_sort: (fieldname, order, t) => {
			state.order_by = `${fieldname} ${order}`;
			state.page = 0;
			load(t);
		},
		on_row_click: (row) => {
			if (row.outbound_message) frappe.set_route("Form", "WhatsApp Log", row.outbound_message);
			else if (row.contact) frappe.set_route("Form", "Contact", row.contact);
		},
		on_select: () => render_actions(),
		empty: { title: __("No recipient matches"), description: __("Change the filters, or add recipients from a group, a file or a list you paste.") },
	});

	// ---- the toolbar: search, the two filters the server answers, and grouping ----------------
	const $toolbar = $panel.find(".wa-recipients__toolbar");
	function render_filters(status_counts, source_counts) {
		if ($toolbar.data("built")) return update_filter_counts(status_counts, source_counts);
		$toolbar.data("built", true);
		const $search = $(`<input type="search" class="form-control input-xs wa-recipients__search" placeholder="${esc(__("Search a name or a number"))}" aria-label="${esc(__("Search a name or a number"))}">`);
		$search.on(
			"input",
			sanad.ui.debounce(() => {
				state.search = $search.val().trim();
				state.page = 0;
				load(table);
			}, 300)
		);
		$toolbar.append($search);
		$toolbar.append(filter_select("status", __("Status"), RECIPIENT_STATUSES, status_counts));
		$toolbar.append(filter_select("source_type", __("Source"), SOURCE_TYPES, source_counts));
		$toolbar.append(group_select());
	}

	function filter_select(fieldname, label, options, counts) {
		const $select = $(`<select class="form-control input-xs wa-recipients__select" data-field="${esc(fieldname)}" aria-label="${esc(label)}"></select>`);
		$select.on("change", () => {
			state.filters[fieldname] = $select.val();
			state.page = 0;
			load(table);
		});
		fill_select($select, label, options, counts, fieldname);
		return $select;
	}

	function fill_select($select, label, options, counts, fieldname) {
		const current = state.filters[fieldname] || "";
		$select.empty().append(`<option value="">${esc(__("{0}: All", [label]))}${counts.All ? ` (${fmt_int(counts.All)})` : ""}</option>`);
		options.forEach((o) => {
			const n = cint(counts[o]);
			if (!n && current !== o) return; // a filter that would empty the table is not offered
			$select.append(`<option value="${esc(o)}"${current === o ? " selected" : ""}>${esc(__(o))}${n ? ` (${fmt_int(n)})` : ""}</option>`);
		});
		$select.val(current);
	}

	function update_filter_counts(status_counts, source_counts) {
		fill_select($toolbar.find('[data-field="status"]'), __("Status"), RECIPIENT_STATUSES, status_counts, "status");
		fill_select($toolbar.find('[data-field="source_type"]'), __("Source"), SOURCE_TYPES, source_counts, "source_type");
	}

	function group_select() {
		const $select = $(`<select class="form-control input-xs wa-recipients__select" aria-label="${esc(__("Group by"))}">
				<option value="">${esc(__("No grouping"))}</option>
				<option value="status">${esc(__("Group by {0}", [__("Status")]))}</option>
				<option value="source_type">${esc(__("Group by {0}", [__("Source")]))}</option>
			</select>`);
		$select.on("change", () => {
			state.group_by = $select.val() ? [$select.val()] : [];
			table.set_group_by(state.group_by);
		});
		return $select;
	}

	// ---- the two verbs, and what the selection allows -----------------------------------------
	function render_actions() {
		$actions.empty();
		const selected = table.get_selected();
		const hint = frm.is_dirty() ? __("Save the campaign to add or remove recipients.") : TERMINAL.includes(frm.doc.status) ? __("The campaign has ended, so recipients can no longer change.") : "";
		if (selected.length && can_change_recipients(frm) && is_manager()) {
			$(`<button type="button" class="btn btn-sm btn-default">${esc(__("Remove {0}", [fmt_int(selected.length)]))}</button>`)
				.on("click", () => remove_selected(selected))
				.appendTo($actions);
		}
		if (!TERMINAL.includes(frm.doc.status) && is_manager()) {
			$(`<button type="button" class="btn btn-sm btn-primary">${sanad.ui.icon("es-line-add", "xs")} ${esc(__("Add recipients"))}</button>`)
				.prop("disabled", !can_change_recipients(frm))
				.on("click", () => open_picker(frm, "add"))
				.appendTo($actions);
			$(`<button type="button" class="btn btn-sm btn-default">${esc(__("Remove recipients"))}</button>`)
				.prop("disabled", !can_change_recipients(frm) || !cint(frm.doc.total_recipients))
				.on("click", () => open_picker(frm, "remove"))
				.appendTo($actions);
		}
		if (hint) $actions.append(`<span class="wa-recipients__hint">${esc(hint)}</span>`);
	}

	function remove_selected(rows) {
		const keys = rows.map((r) => r.phone_e164).filter(Boolean);
		sanad.ui.ConfirmDialog.ask({
			title: __("Remove {0} recipients?", [fmt_int(keys.length)]),
			message: __("They stop receiving this campaign. Nothing else changes."),
			impact: [{ label: __("Recipients to remove"), value: fmt_int(keys.length), tone: "red" }],
			danger: true,
			confirm_label: __("Remove {0}", [fmt_int(keys.length)]),
			on_confirm: () => sanad.ui.call("picker.commit_remove", { target_doctype: frm.doctype, target_name: frm.doc.name, phone_e164s: keys }),
		})
			.then(() => {
				sanad.ui.Toast.success(__("Removed {0}", [fmt_int(keys.length)]));
				frm.reload_doc();
			})
			.catch(() => {});
	}

	render_actions();
	frm.sanad_recipients = { table, refresh: () => load(table), update_actions: render_actions };
	load(table);
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

// ---- the Progress tab ---------------------------------------------------------------------------
//
// Fourteen read-only integers in two Desk columns told nobody anything: `queued_count 40` and
// `read_count 420` are the same shape on the page, and the one number that matters — how far down
// the funnel the campaign actually got — was left for the reader to work out. The fields are hidden
// and the tab draws what they mean instead: one bar for every message the campaign produced, the
// funnel under it stage by stage with each stage's share of the one above, what the audience did
// after the campaign started, and how long the sending itself took.

/** "1 h 28 min" — how long two datetimes are apart, said the way a person says it. */
function span_text(from, to) {
	if (!from || !to) return "";
	const minutes = Math.max(0, Math.round((frappe.datetime.str_to_obj(to) - frappe.datetime.str_to_obj(from)) / 60000));
	if (minutes < 1) return __("under a minute");
	if (minutes < 60) return __("{0} min", [fmt_int(minutes)]);
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? __("{0} h {1} min", [fmt_int(hours), fmt_int(rest)]) : __("{0} h", [fmt_int(hours)]);
}

/**
 * The campaign's own counters are mutually exclusive by final state — a message that was read is
 * counted in `read_count` and nowhere else — so a stage is the sum of everything at or past it.
 * `get_progress` returns the same fields, fresher, so it simply overlays the document.
 */
function tallies(frm, progress) {
	const d = Object.assign({}, frm.doc, progress || {});
	const read = cint(d.read_count);
	const delivered_only = cint(d.delivered_count);
	const sent_only = cint(d.sent_count);
	const queued = cint(d.queued_count);
	const failed = cint(d.failed_count);
	const cancelled = cint(d.cancelled_count);
	const left = sent_only + delivered_only + read; // everything that got past the device
	return {
		doc: d,
		read,
		delivered_only,
		sent_only,
		queued,
		failed,
		cancelled,
		left,
		arrived: delivered_only + read,
		produced: left + queued + failed + cancelled,
	};
}

/**
 * The stages, in the order a message passes through them. Each one's share is of the stage above
 * it, not of the whole — that is what makes a funnel a funnel: it says where the drop-off is.
 */
function funnel_stages(t) {
	return [
		{ key: "produced", label: __("Messages produced"), value: t.produced, of: t.produced, tone: "gray", note: __("one per recipient, per message of the campaign") },
		{ key: "queued", label: __("Still in the queue"), value: t.queued, of: t.produced, tone: "blue", note: __("waiting for their turn to leave") },
		{ key: "left", label: __("Left the device"), value: t.left, of: t.produced, tone: "green", note: __("accepted by WhatsApp") },
		{ key: "arrived", label: __("Arrived"), value: t.arrived, of: t.left, tone: "green", note: __("of what left the device") },
		{ key: "read", label: __("Read"), value: t.read, of: t.arrived, tone: "accent", note: __("of what arrived") },
		{ key: "failed", label: __("Failed"), value: t.failed, of: t.produced, tone: "red", note: __("never left"), go: "failed" },
		{ key: "cancelled", label: __("Cancelled"), value: t.cancelled, of: t.produced, tone: "gray", note: __("stopped before they were sent") },
	];
}

/**
 * The Progress tab, composed out of the prototype's card vocabulary rather than invented.
 *
 * The prototype has no per-campaign progress screen — it draws a campaign's progress as one bar in
 * the campaigns list and edits the campaign in an overlay panel. So there was nothing to port, and
 * the first attempt at this tab invented a layout, which is exactly why it did not look like the
 * rest of the product. What *is* in the design system is the set of card kinds every screen that
 * shows numbers is built from, and the way the home console arranges them: a row of readings, then
 * a panel whose rows carry the detail. This tab is that, and nothing else.
 */

const STAGE_ICON = {
	produced: "cards",
	queued: "clock",
	left: "send",
	arrived: "check",
	read: "read",
	failed: "fail",
	cancelled: "x",
};

/** The readings across the top: where the campaign stands, in the words the console uses. */
function progress_sections(frm, t, progress) {
	const doc = t.doc;
	const tone = { gray: "muted", blue: "info", green: "ok", orange: "warn", red: "danger" }[K.INDICATOR[doc.status]] || "muted";
	const delivered_pct = t.left ? Math.round((t.arrived / t.left) * 100) : 0;
	const read_pct = t.arrived ? Math.round((t.read / t.arrived) * 100) : 0;
	const failed_pct = t.produced ? (t.failed / t.produced) * 100 : 0;

	const readings = {
		title: __("How it is going"),
		min: 210,
		cards: [
			{ kind: "stat", key: "state", label: __("Campaign"), value: __(doc.status), note: state_sub(frm), tone, icon: "chart" },
			{ kind: "stat", key: "recipients", label: __("Recipients"), value: fmt_int(doc.total_recipients), note: __("in the list below"), icon: "users", dot: false },
			{ kind: "stat", key: "left", label: __("Left the device"), value: fmt_int(t.left), note: __("of {0} produced", [fmt_int(t.produced)]), tone: "ok", icon: "send" },
			{ kind: "stat", key: "arrived", label: __("Arrived"), value: `${delivered_pct}%`, note: __("of what left the device"), tone: "ok", icon: "check" },
			{ kind: "stat", key: "read", label: __("Read"), value: `${read_pct}%`, note: __("of what arrived"), tone: "pri", icon: "read" },
			{
				kind: "stat",
				key: "failed",
				label: __("Failed"),
				value: fmt_int(t.failed),
				note: t.failed ? __("see the messages") : __("no failures"),
				tone: t.failed ? "danger" : "muted",
				icon: t.failed ? "fail" : "check",
				action: t.failed ? "open_failed" : undefined,
			},
		],
	};

	// nothing has gone out yet: one strip saying what pressing the verb would cost, and no funnel
	if (!t.produced) {
		return [
			readings,
			{
				min: 420,
				cards: [{ kind: "alert", tone: "info", icon: "info", label: __("Nothing has been sent yet"), note: plan_text(frm) }],
			},
		];
	}

	const stages = funnel_stages(t).map((st) => {
		const share = st.of ? (st.value / st.of) * 100 : 0;
		return {
			key: st.key,
			label: st.label,
			sub: st.note,
			value: `${fmt_int(st.value)}  ·  ${share.toFixed(share >= 10 || !share ? 0 : 1)}%`,
			bar: share,
			tone: { gray: "muted", blue: "info", green: "ok", accent: "pri", red: "danger" }[st.tone] || "muted",
			action: st.go && st.value ? "open_failed" : undefined,
		};
	});

	const audience = [
		{ label: __("At the start"), value: fmt_int(doc.initial_recipients || doc.total_recipients) },
		{ label: __("Added since"), value: fmt_int(doc.added_count) },
		{ label: __("Removed since"), value: fmt_int(doc.removed_count) },
		{ label: __("Times paused"), value: fmt_int(doc.pause_count) },
	];
	const first = doc.first_message_at;
	const span = span_text(first, doc.last_message_at);
	if (first) {
		audience.push({ label: __("First message"), value: whatsapp_next.fmt.dt(first) });
		audience.push({ label: __("Last message"), value: doc.last_message_at ? whatsapp_next.fmt.dt(doc.last_message_at) : __("still going") });
		if (span) audience.push({ label: __("Sending took"), value: span });
	}

	return [
		readings,
		{
			title: __("Where the messages got to"),
			sub: __("each stage as a share of the one above it, which is where the drop-off shows"),
			min: 420,
			cards: [
				{ kind: "panel", key: "funnel", label: __("The funnel"), note: __("{0} messages produced", [fmt_int(t.produced)]), span: 2, rows: stages, foot: eta_text(doc, progress) },
				{ kind: "panel", key: "audience", label: __("The audience"), note: __("{0} recipients now", [fmt_int(doc.total_recipients)]), rows: audience },
			],
		},
		failed_pct > 8
			? { min: 420, cards: [{ kind: "alert", tone: "danger", icon: "error", label: __("{0}% of the messages failed.", [failed_pct.toFixed(1)]), note: __("Open the failed messages to see the reason each one gives."), cta: __("See the messages"), action: "open_failed" }] }
			: null,
	].filter(Boolean);
}

function render_progress(frm, progress) {
	const $el = frm.sanad_progress;
	if (!$el || !$el.closest("body").length) return;
	const t = tallies(frm, progress);
	$el.empty();

	// the verbs first: this tab replaced the strip above the tabs, so it is the only place the
	// campaign is started, paused or stopped, and a verb stands beside the state it changes (D-088)
	const $bar = $('<div class="wa-btnbar wa-progress__verbs"></div>').appendTo($el);
	const after = () => frm.reload_doc();
	const verbs = K.verbs(frm.doc, { after, messages: messages_of(frm) });
	const lead = verbs.find((v) => ["start", "resume", "pause"].includes(v.key));
	const add = (verb, primary) =>
		$(sanad.ui.btn({ label: verb.label, variant: primary ? "primary" : verb.tone === "danger" ? "danger" : "secondary", disabled: frm.is_dirty() }))
			.on("click", () => verb.run())
			.appendTo($bar);
	if (lead) add(lead, true);
	verbs.filter((v) => v !== lead).forEach((v) => add(v, false));
	if (cint(frm.doc.total_recipients)) {
		$(sanad.ui.btn({ label: __("Outbound log"), icon: "table", variant: "secondary" }))
			.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: frm.doc.name }))
			.appendTo($bar);
	}
	if (frm.is_dirty() && verbs.length) $bar.append(`<span class="wa-progress__hint">${esc(__("Save first."))}</span>`);

	const $cards = $('<div class="wa-progress__cards"></div>').appendTo($el);
	frm.sanad_progress_cards = new sanad.ui.Cards({
		wrapper: $cards,
		sections: progress_sections(frm, t, progress),
		handlers: {
			open_failed: () => frappe.set_route("List", "WhatsApp Log", { campaign: frm.doc.name, status: "Failed" }),
		},
	});
}

function mount_progress(frm) {
	// The fields themselves are hidden in CSS, not with `set_df_property`: Desk hides a tab whose
	// every field is hidden, and this tab has nothing else in it — the panel below would have gone
	// down with them. `_campaigns.scss` hides the sections of whatever tab this panel is mounted in.
	if (frm.is_new()) {
		frm.sanad_progress = null;
		return;
	}
	const tab = (frm.layout.tabs || []).find((t) => t.df && t.df.fieldname === "progress_tab");
	if (!tab || !tab.wrapper || !tab.wrapper.length) return;
	if (!frm.sanad_progress || !frm.sanad_progress.closest("body").length) {
		tab.wrapper.find(".wa-progress").remove();
		frm.sanad_progress = $(`<section class="sanad-kit wa-progress" aria-label="${esc(__("Progress"))}"></section>`).prependTo(tab.wrapper);
	}
	render_progress(frm, null);
	sanad.ui
		.call("campaigns.get_progress", { name: frm.doc.name }, { silent: true })
		.then((p) => render_progress(frm, p))
		.catch(() => {});
}

function subscribe(frm) {
	unsubscribe(frm);
	frm.sanad_realtime = (data) => {
		if (!data || data.campaign !== frm.doc.name) return;
		if (data.status && data.status !== frm.doc.status) return frm.reload_doc();
		mount_progress(frm);
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
function can_write_messages(frm) {
	return !TERMINAL.includes(frm.doc.status) && EDITABLE.includes(frm.doc.status) && frappe.perm.has_perm(frm.doctype, 0, "write", frm.doc);
}

function mount_messages(frm) {
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
		// what leads the editor for each type; everything else the type allows waits under
		// "More options", so a text message is a text box and not a form of eleven fields
		primary_fields: {
			Text: ["body"],
			Image: ["attachment", "caption"],
			Video: ["attachment", "caption"],
			Audio: ["attachment"],
			Sticker: ["attachment"],
			// printing the recipient's own document to PDF is a real capability, but it is not what a
			// campaign's document message usually is: it leads the editor no longer, and waits with
			// `file_name_template` under "More options" for the campaign that wants it
			Document: ["attachment", "caption"],
			Location: [],
			Poll: ["poll_question", "poll_options", "poll_allow_multiple"],
		},
		// asked every time it is drawn, never captured: Desk keeps one `frm` per DocType and hands
		// it the next document, so a composer built while a Running campaign was open would have
		// stayed read-only over a Draft one for the rest of the session
		can_edit: () => can_write_messages(frm),
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
		frm.$wrapper.addClass("wa-campaign"); // the screen's own styling hook
		// the console states the status in words, with the verb that changes it; the field itself
		// would be the same fact twice, read-only, in the middle of the fields the reader may edit
		frm.set_df_property("status", "hidden", 1);
		if (TERMINAL.includes(frm.doc.status)) {
			frm.set_read_only();
			frm.disable_save();
		} else if (!EDITABLE.includes(frm.doc.status) && !frm.is_new()) {
			["messages", "device", "scheduled_at", "messages_per_minute", "exclude_unknown_numbers"].forEach((f) => frm.set_df_property(f, "read_only", 1));
		}
		mount_recipients(frm);
		mount_progress(frm);
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
