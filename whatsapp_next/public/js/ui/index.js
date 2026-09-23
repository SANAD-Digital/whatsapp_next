// sanad.ui kit barrel — imports every component so a single bundle line loads the whole kit.
// Copy `public/js/ui/` into any Frappe app and import this file from that app's bundle.

import "./_core/index.js";
// foundations
import "./StatusBadge/index.js";
import "./EmptyState/index.js";
import "./Toast/index.js";
import "./ConfirmDialog/index.js";
// list helpers
import "./FilterBar/index.js";
import "./TreeGroupBy/index.js";
import "./RowActions/index.js";
import "./BulkActions/index.js";
// inputs and flows
import "./Stepper/index.js";
import "./PhoneField/index.js";
import "./DateFilter/index.js";
import "./ListStatsCard/index.js";
import "./MetaDialog/index.js";
// list renderers
import "./DataList/index.js";
import "./PageHeader/index.js";
// panels
import "./Drawer/index.js";
import "./ChatThread/index.js";
import "./ConversationDrawer/index.js";
import "./QuickSend/index.js";
import "./TemplateEditor/index.js";
import "./PagedChildTable/index.js";
import "./DashboardBlock/index.js";
// sub-system
import "./ContactPicker/index.js";
