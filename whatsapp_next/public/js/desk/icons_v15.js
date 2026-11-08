// Frappe 15 only: the icons this app draws with that Frappe 15 does not ship. Frappe 16 loads the
// Lucide set (`/assets/frappe/icons/lucide/icons.svg`); 15 has no such set, so a close button, an add
// or a download button was an empty square (owner, 2026-11-08). The drawings are Frappe 16's own
// (lucide-static, ISC), generated for the 38 names the app uses that 15 lacks; a name 15
// already has is left to 15. Regenerate when the app starts using an icon 15 does not have.

const SYMBOLS = [
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-alarm-clock"> <circle cx="12" cy="13" r="8" /> <path d="M12 9v4l2 2" /> <path d="M5 3 2 6" /> <path d="m22 6-3-3" /> <path d="M6.38 18.7 4 21" /> <path d="M17.64 18.67 20 21" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-badge-check"> <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" /> <path d="m9 12 2 2 4-4" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-bell"> <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /> <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-bolt"> <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /> <circle cx="12" cy="12" r="4" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-circle-dashed"> <path d="M10.1 2.182a10 10 0 0 1 3.8 0" /> <path d="M13.9 21.818a10 10 0 0 1-3.8 0" /> <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /> <path d="M2.182 13.9a10 10 0 0 1 0-3.8" /> <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /> <path d="M21.818 10.1a10 10 0 0 1 0 3.8" /> <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /> <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-clock"> <circle cx="12" cy="12" r="10" /> <polyline points="12 6 12 12 16 14" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-code"> <polyline points="16 18 22 12 16 6" /> <polyline points="8 6 2 12 8 18" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-cog"> <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" /> <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" /> <path d="M12 2v2" /> <path d="M12 22v-2" /> <path d="m17 20.66-1-1.73" /> <path d="M11 10.27 7 3.34" /> <path d="m20.66 17-1.73-1" /> <path d="m3.34 7 1.73 1" /> <path d="M14 12h8" /> <path d="M2 12h2" /> <path d="m20.66 7-1.73 1" /> <path d="m3.34 17 1.73-1" /> <path d="m17 3.34-1 1.73" /> <path d="m11 13.73-4 6.93" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-columns-3"> <rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M9 3v18" /> <path d="M15 3v18" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-contact-round"> <path d="M16 2v2" /> <path d="M17.915 22a6 6 0 0 0-12 0" /> <path d="M8 2v2" /> <circle cx="12" cy="12" r="4" /> <rect x="3" y="4" width="18" height="18" rx="2" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-copy"> <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-download"> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /> <polyline points="7 10 12 15 17 10" /> <line x1="12" x2="12" y1="15" y2="3" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-flask-conical"> <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" /> <path d="M8.5 2h7" /> <path d="M7 16h10" /> </symbol>`,
	`<symbol viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" id="icon-home"> <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-inbox"> <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /> <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-layout-template"> <rect width="18" height="7" x="3" y="3" rx="1" /> <rect width="9" height="7" x="3" y="14" rx="1" /> <rect width="5" height="7" x="16" y="14" rx="1" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-link"> <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /> <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-list-ordered"> <line x1="10" x2="21" y1="6" y2="6" /> <line x1="10" x2="21" y1="12" y2="12" /> <line x1="10" x2="21" y1="18" y2="18" /> <path d="M4 6h1v4" /> <path d="M4 10h2" /> <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-megaphone"> <path d="m3 11 18-5v12L3 14v-3z" /> <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-message-square-text"> <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /> <path d="M13 8H7" /> <path d="M17 12H7" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-messages-square"> <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" /> <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-pause"> <rect x="14" y="4" width="4" height="16" rx="1" /> <rect x="6" y="4" width="4" height="16" rx="1" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-phone-call"> <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /> <path d="M14.05 2a9 9 0 0 1 8 7.94" /> <path d="M14.05 6A5 5 0 0 1 18 10" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-plus"> <path d="M5 12h14" /> <path d="M12 5v14" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-rocket"> <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /> <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /> <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /> <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-send"> <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /> <path d="m21.854 2.147-10.94 10.939" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-settings"> <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /> <circle cx="12" cy="12" r="3" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-shield"> <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-shield-check"> <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /> <path d="m9 12 2 2 4-4" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-sigma"> <path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-smartphone"> <rect width="14" height="20" x="5" y="2" rx="2" ry="2" /> <path d="M12 18h.01" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-square-function"> <rect width="18" height="18" x="3" y="3" rx="2" ry="2" /> <path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3" /> <path d="M9 11.2h5.7" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-terminal"> <polyline points="4 17 10 11 4 5" /> <line x1="12" x2="20" y1="19" y2="19" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-trash"> <path d="M3 6h18" /> <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /> <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-user"> <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /> <circle cx="12" cy="7" r="4" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-wallet"> <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /> <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-webhook"> <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" /> <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /> <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" /> </symbol>`,
	`<symbol xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="icon-x"> <path d="M18 6 6 18" /> <path d="m6 6 12 12" /> </symbol>`,
];

function add_missing_icons() {
	if (document.getElementById("wa-icons-v15")) return;
	const missing = SYMBOLS.filter((symbol) => !document.getElementById(/id="([^"]+)"/.exec(symbol)[1]));
	if (!missing.length) return;
	const holder = document.createElement("div");
	holder.innerHTML = `<svg id="wa-icons-v15" aria-hidden="true" style="display: none;" class="icon" xmlns="http://www.w3.org/2000/svg">${missing.join("")}</svg>`;
	document.body.appendChild(holder.firstChild);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add_missing_icons);
else add_missing_icons();
