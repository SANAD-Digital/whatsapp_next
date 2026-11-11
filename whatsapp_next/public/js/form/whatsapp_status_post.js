// WhatsApp Status Post form: a preview drawn as the status will look, the actions its state allows
// (post now, schedule, cancel the schedule, read views, delete from WhatsApp) and who viewed it.
// Status posts are a plan feature; without it the form says so and offers no action.

const FONT_CSS = {
	Standard: "system-ui, sans-serif",
	Script: "'Brush Script MT', cursive",
	Bold: "system-ui, sans-serif; font-weight: 800",
	Rounded: "'Comic Sans MS', 'Chalkboard SE', sans-serif",
	Display: "Georgia, serif; font-weight: 700",
	Typewriter: "'Courier New', monospace; font-weight: 700",
};

const status_plan = () => !!(((frappe.boot.whatsapp_next || {}).features || {}).status);
const can_manage = () => frappe.user.has_role(["WhatsApp Manager", "System Manager"]);

frappe.ui.form.on("WhatsApp Status Post", {
	onload(frm) {
		if (frm.is_new() && !frm.doc.device) {
			frappe.db.get_single_value("WhatsApp Settings", "default_device").then((d) => d && frm.set_value("device", d));
		}
		frm.set_query("device", () => ({ filters: { status: "Connected", disabled: 0 } }));
	},
	refresh(frm) {
		draw_preview(frm);
		draw_viewers(frm);
		if (!status_plan()) {
			frm.set_intro(__("Your plan does not include status posts."), "orange");
			return;
		}
		if (frm.is_new() || !can_manage()) return;
		const call_status_post_api = (key, args, done) =>
			whatsapp.ui.call(`status_posts.${key}`, Object.assign({ name: frm.doc.name }, args || {}), { freeze: true })
				.then((r) => { if (done) done(r); frm.reload_doc(); })
				.catch((err) => { whatsapp.ui.Toast.error(err); frm.reload_doc(); });
		const state = frm.doc.state;
		if (["Draft", "Failed", "Scheduled"].includes(state)) {
			frm.add_custom_button(__("Post now"), () =>
				frappe.confirm(__("Post this status on WhatsApp now?"), () =>
					call_status_post_api("post_now", null, () => whatsapp.ui.Toast.success(__("The status is posted")))
				)
			).addClass("btn-primary");
		}
		if (["Draft", "Failed"].includes(state)) {
			frm.add_custom_button(__("Schedule"), () => {
				const d = new frappe.ui.Dialog({
					title: __("Schedule the status"),
					fields: [{ fieldtype: "Datetime", fieldname: "at", label: __("Post at"), reqd: 1, default: frm.doc.scheduled_at }],
					primary_action_label: __("Schedule"),
					primary_action: (v) => { d.hide(); call_status_post_api("schedule", { scheduled_at: v.at }, () => whatsapp.ui.Toast.success(__("Scheduled"))); },
				});
				d.show();
			});
		}
		if (state === "Scheduled") frm.add_custom_button(__("Cancel the schedule"), () => call_status_post_api("unschedule"));
		if (state === "Posted" || state === "Deleted") frm.add_custom_button(__("Read views"), () => call_status_post_api("refresh_views"));
		if (state === "Posted") {
			frm.add_custom_button(__("Delete from WhatsApp"), () =>
				frappe.confirm(__("Take this status down from WhatsApp? Its views stay here."), () => call_status_post_api("delete_post"))
			);
		}
	},
	kind: draw_preview,
	text: draw_preview,
	background_color: draw_preview,
	font: draw_preview,
	media: draw_preview,
	caption: draw_preview,
});

function draw_preview(frm) {
	const field = frm.get_field("preview_html");
	if (!field) return;
	const escape_html = frappe.utils.escape_html;
	const doc = frm.doc;
	let body;
	if (doc.kind === "Text") {
		const font = (FONT_CSS[doc.font] || FONT_CSS.Standard).split(";");
		body = `<div class="whatsapp-status__card" style="background:${escape_html(/^#[0-9a-f]{3,8}$/i.test(doc.background_color || "") ? doc.background_color : "var(--whatsapp-pri)")};font-family:${font[0]};${font[1] || ""}">
			<span>${escape_html(doc.text || __("Your text appears here"))}</span></div>`;
	} else if (doc.media) {
		const url = escape_html(doc.media);
		const media = doc.kind === "Video" ? `<video src="${url}" controls preload="metadata"></video>` : `<img src="${url}" alt="">`;
		body = `<div class="whatsapp-status__card whatsapp-status__card--media">${media}${doc.caption ? `<span class="whatsapp-status__caption">${escape_html(doc.caption)}</span>` : ""}</div>`;
	} else {
		body = `<div class="whatsapp-status__card whatsapp-status__card--empty"><span>${escape_html(__("Attach an image or a video"))}</span></div>`;
	}
	field.$wrapper.html(`<div class="whatsapp-status">${body}</div>`);
}

function draw_viewers(frm) {
	const field = frm.get_field("viewers_html");
	if (!field) return;
	const escape_html = frappe.utils.escape_html;
	let viewers = [];
	try {
		viewers = typeof frm.doc.viewers === "string" ? JSON.parse(frm.doc.viewers || "[]") : frm.doc.viewers || [];
	} catch (e) {
		viewers = [];
	}
	if (!viewers.length) {
		field.$wrapper.html(frm.doc.status_id ? `<p class="text-muted">${escape_html(__("No one has viewed it yet."))}</p>` : "");
		return;
	}
	field.$wrapper.html(`<ul class="whatsapp-status__viewers">${viewers
		.map((v) => `<li><bdi dir="ltr">${escape_html(v.number ? "+" + v.number : v.jid)}</bdi><span>${escape_html(v.viewed_at ? moment.unix(v.viewed_at).fromNow() : "")}</span></li>`)
		.join("")}</ul>`);
}
