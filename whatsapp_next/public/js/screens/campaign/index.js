// The campaign builder — the WhatsApp Campaign screen, in the pieces it is made of. Imported as
// one line from the app bundle; the form script (`public/js/form/whatsapp_campaign.js`) only
// mounts `whatsapp_next.campaign.Builder` over the document and hands it Desk's events.
//
// Order matters: `parts.js` defines the vocabulary the rest draw with, and every file here reads
// `whatsapp_next.campaigns` (the shared campaign verbs and funnel) at load time.

import "./parts.js";
import "./header.js";
import "./stepper.js";
import "./readiness.js";
import "./setup.js";
import "./messages.js";
import "./audience.js";
import "./review.js";
import "./monitor.js";
import "./builder.js";
