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
		const call = (key, args, done) =>
			sanad.ui.call(`status_posts.${key}`, Object.assign({ name: frm.doc.name }, args || {}), { freeze: true })
				.then((r) => { if (done) done(r); frm.reload_doc(); })
				.catch((err) => { sanad.ui.Toast.error(err); frm.reload_doc(); });
		const state = frm.doc.state;
		if (["Draft", "Failed", "Scheduled"].includes(state)) {
			frm.add_custom_button(__("Post now"), () =>
				frappe.confirm(__("Post this status on WhatsApp now?"), () =>
					call("post_now", null, () => sanad.ui.Toast.success(__("The status is posted")))
				)
			).addClass("btn-primary");
		}
		if (["Draft", "Failed"].includes(state)) {
			frm.add_custom_button(__("Schedule"), () => {
				const d = new frappe.ui.Dialog({
					title: __("Schedule the status"),
					fields: [{ fieldtype: "Datetime", fieldname: "at", label: __("Post at"), reqd: 1, default: frm.doc.scheduled_at }],
					primary_action_label: __("Schedule"),
					primary_action: (v) => { d.hide(); call("schedule", { scheduled_at: v.at }, () => sanad.ui.Toast.success(__("Scheduled"))); },
				});
				d.show();
			});
		}
		if (state === "Scheduled") frm.add_custom_button(__("Cancel the schedule"), () => call("unschedule"));
		if (state === "Posted" || state === "Deleted") frm.add_custom_button(__("Read views"), () => call("refresh_views"));
		if (state === "Posted") {
			frm.add_custom_button(__("Delete from WhatsApp"), () =>
				frappe.confirm(__("Take this status down from WhatsApp? Its views stay here."), () => call("delete_post"))
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
	const esc = frappe.utils.escape_html;
	const d = frm.doc;
	let body;
	if (d.kind === "Text") {
		const font = (FONT_CSS[d.font] || FONT_CSS.Standard).split(";");
		body = `<div class="wa-status__card" style="background:${esc(/^#[0-9a-f]{3,8}$/i.test(d.background_color || "") ? d.background_color : "var(--wa-pri)")};font-family:${font[0]};${font[1] || ""}">
			<span>${esc(d.text || __("Your text appears here"))}</span></div>`;
	} else if (d.media) {
		const url = esc(d.media);
		const media = d.kind === "Video" ? `<video src="${url}" controls preload="metadata"></video>` : `<img src="${url}" alt="">`;
		body = `<div class="wa-status__card wa-status__card--media">${media}${d.caption ? `<span class="wa-status__caption">${esc(d.caption)}</span>` : ""}</div>`;
	} else {
		body = `<div class="wa-status__card wa-status__card--empty"><span>${esc(__("Attach an image or a video"))}</span></div>`;
	}
	field.$wrapper.html(`<div class="wa-status">${body}</div>`);
}

function draw_viewers(frm) {
	const field = frm.get_field("viewers_html");
	if (!field) return;
	const esc = frappe.utils.escape_html;
	let viewers = [];
	try {
		viewers = typeof frm.doc.viewers === "string" ? JSON.parse(frm.doc.viewers || "[]") : frm.doc.viewers || [];
	} catch (e) {
		viewers = [];
	}
	if (!viewers.length) {
		field.$wrapper.html(frm.doc.status_id ? `<p class="text-muted">${esc(__("No one has viewed it yet."))}</p>` : "");
		return;
	}
	field.$wrapper.html(`<ul class="wa-status__viewers">${viewers
		.map((v) => `<li><bdi dir="ltr">${esc(v.number ? "+" + v.number : v.jid)}</bdi><span>${esc(v.viewed_at ? moment.unix(v.viewed_at).fromNow() : "")}</span></li>`)
		.join("")}</ul>`);
}
