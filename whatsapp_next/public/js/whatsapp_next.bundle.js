// whatsapp_next Desk bundle — loads the portable kit (sanad.ui) then the app-specific setup that
// maps kit API keys to this app's whitelisted methods. Nothing under `ui/` knows this app.

import "./ui/index.js";
import "./whatsapp_next_setup.js";
import "./screens/console.js";
import "./screens/messages.js";
import "./screens/campaigns.js";
import "./screens/campaign/index.js";
