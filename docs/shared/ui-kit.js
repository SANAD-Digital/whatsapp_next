// مصدر واحد لتصميم الحقول والأزرار — يُستخدم من Overlay Panel والجداول وأي شاشة أخرى
// كل نص واجهة ثنائي اللغة { ar, en } ويُقرأ عبر L(lang, v) أو t(lang, key)
(function () {
  const MONO = "'IBM Plex Mono',monospace";
  const FONT = { ar: "'IBM Plex Sans Arabic',system-ui,sans-serif", en: "'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif" };
  const DENSITY = {
    comfortable: { h: '38px', hSm: '32px', fs: '14px', fsSm: '13px', px: '12px', gap: '12px 16px', rowPad: '14px 0' },
    compact: { h: '32px', hSm: '28px', fs: '13px', fsSm: '12px', px: '10px', gap: '8px 12px', rowPad: '8px 0' },
  };
  const FIELD_BASE = 'width:100%;border-radius:8px;border:1px solid var(--border-2);background:var(--surface);color:var(--ink);outline:none;font-family:inherit;';
  const FIELD_TYPES = [
    { type: 'text', label: { ar: 'نص', en: 'Text' }, desc: { ar: 'إدخال قصير. mono:true للأرقام والمعرّفات (LTR).', en: 'Short input. mono:true for numbers and IDs (always LTR).' } },
    { type: 'number', label: { ar: 'رقم', en: 'Number' }, desc: { ar: 'LTR دائماً، محاذاة يسار.', en: 'Always LTR, left-aligned.' } },
    { type: 'date', label: { ar: 'تاريخ', en: 'Date' }, desc: { ar: 'حقل تاريخ أصلي.', en: 'Native date input.' } },
    { type: 'textarea', label: { ar: 'نص طويل', en: 'Textarea' }, desc: { ar: 'rows للارتفاع. يُعرض مكدّساً (stacked) في layout=rows.', en: 'rows sets height. Rendered stacked in layout=rows.' } },
    { type: 'select', label: { ar: 'قائمة أصلية', en: 'Native select' }, desc: { ar: 'select الأصلي للمتصفح. options:[{v,l}]. القيمة "" تعرض كنص باهت بلا إطار.', en: 'Browser select. options:[{v,l}]. Empty value renders as muted text without border.' } },
    { type: 'dropdown', label: { ar: 'قائمة منسدلة', en: 'Dropdown' }, desc: { ar: 'اختيار واحد مع بحث. تُفتح بالنقر، تُغلق بـ Esc أو النقر خارجها.', en: 'Single pick with search. Opens on click, closes on Esc or outside click.' } },
    { type: 'multiselect-dropdown', label: { ar: 'اختيار متعدد منسدل', en: 'Multiselect dropdown' }, desc: { ar: 'شرائح (chips) للقيم المختارة داخل الزر + قائمة بصناديق اختيار وبحث.', en: 'Chips for selected values in the trigger + a checklist with search.' } },
    { type: 'multiselect', label: { ar: 'اختيار متعدد ظاهر', en: 'Multiselect list' }, desc: { ar: 'قائمة صناديق اختيار مباشرة بلا انسدال. للخيارات القليلة (≤ 6).', en: 'Inline checklist, no dropdown. For few options (≤ 6).' } },
    { type: 'addons', label: { ar: 'حقل مع أزرار', en: 'Field with add-ons' }, desc: { ar: 'addons:[{ icon, label, mode:"inside"|"attached", side:"start"|"end", tone, onClick }]. inside = أيقونة فقط داخل الحقل. attached = جزء ملتصق بالحقل يظهر نصاً أو أيقونة أو كليهما.', en: 'addons:[{ icon, label, mode:"inside"|"attached", side:"start"|"end", tone, onClick }]. inside = icon-only inside the field. attached = joined segment with text and/or icon.' } },
    { type: 'autocomplete', label: { ar: 'إكمال تلقائي', en: 'Autocomplete' }, desc: { ar: 'items مصفوفة أو dict. itemFormat عند التهيئة: { primary:"{name}", secondary:"{tag} · {city}", meta:"{phone}", avatar:fn, value }. footerActions أزرار في آخر القائمة. ↑↓ وEnter.', en: 'items as array or dict. itemFormat at init: { primary:"{name}", secondary:"{tag} · {city}", meta:"{phone}", avatar:fn, value }. footerActions render buttons at the end of the list. ↑↓ and Enter.' } },
    { type: 'segment', label: { ar: 'مقسّم', en: 'Segmented' }, desc: { ar: '2–4 خيارات قصيرة متجاورة. البديل للـ select عند قلة الخيارات.', en: '2–4 short adjacent options. Replaces select when options are few.' } },
    { type: 'toggle', label: { ar: 'مفتاح', en: 'Toggle' }, desc: { ar: 'قيمة منطقية. في rows يظهر بلا نص مساعد.', en: 'Boolean. In rows layout it renders without helper text.' } },
    { type: 'checkbox', label: { ar: 'صندوق اختيار', en: 'Checkbox' }, desc: { ar: 'للقوائم والجداول. accent-color: var(--pri).', en: 'For lists and tables. accent-color: var(--pri).' } },
    { type: 'radio', label: { ar: 'اختيار واحد', en: 'Radio' }, desc: { ar: 'options:[{v,l}] عمودية.', en: 'options:[{v,l}], stacked vertically.' } },
    { type: 'readonly', label: { ar: 'للقراءة', en: 'Read-only' }, desc: { ar: 'قيمة لا تُعدّل. mono للأرقام.', en: 'Non-editable value. mono for numbers.' } },
    { type: 'avatar', label: { ar: 'صورة', en: 'Avatar' }, desc: { ar: 'دائرة 48px بالأحرف الأولى.', en: '48px circle with initials.' } },
    { type: 'badge', label: { ar: 'شارة حالة', en: 'Status badge' }, desc: { ar: 'tone: ok | warn | danger | info | muted. نقطة + نص.', en: 'tone: ok | warn | danger | info | muted. Dot + text.' } },
  ];
  const TONE = {
    ok: { bg: 'var(--ok-s)', fg: 'var(--ok-i)', dot: 'var(--ok)', bd: 'var(--ok-sb)', label: { ar: 'ناجح', en: 'Success' } },
    warn: { bg: 'var(--wn-s)', fg: 'var(--wn-i)', dot: 'var(--wn)', bd: 'var(--wn-sb)', label: { ar: 'تحذير', en: 'Warning' } },
    danger: { bg: 'var(--dg-s)', fg: 'var(--dg-i)', dot: 'var(--dg)', bd: 'var(--dg-sb)', label: { ar: 'خطأ', en: 'Error' } },
    info: { bg: 'var(--nf-s)', fg: 'var(--nf-i)', dot: 'var(--nf)', bd: 'var(--nf-sb)', label: { ar: 'معلومة', en: 'Info' } },
    muted: { bg: 'var(--sunken)', fg: 'var(--ink-2)', dot: 'var(--ink-4)', bd: 'var(--border)', label: { ar: 'محايد', en: 'Neutral' } },
  };
  const BUTTON = {
    primary: { bg: 'var(--pri)', fg: 'var(--on-pri)', bd: 'none', hover: 'var(--pri-d)', label: { ar: 'أساسي', en: 'Primary' }, use: { ar: 'الإجراء الرئيسي الوحيد في الشاشة: حفظ، إنشاء، إرسال.', en: 'The single main action on a screen: save, create, send.' } },
    secondary: { bg: 'var(--surface)', fg: 'var(--ink)', bd: '1px solid var(--border-2)', hover: 'var(--sunken)', label: { ar: 'ثانوي', en: 'Secondary' }, use: { ar: 'إلغاء، تصدير، إجراءات مساعدة.', en: 'Cancel, export, supporting actions.' } },
    danger: { bg: 'var(--dg-s)', fg: 'var(--dg-i)', bd: '1px solid var(--dg-sb)', hover: 'var(--dg-sb)', label: { ar: 'خطِر', en: 'Danger' }, use: { ar: 'حذف وإجراءات لا تُعكس. يُسند لبداية الشريط.', en: 'Delete and irreversible actions. Anchored to the start of the bar.' } },
    ghost: { bg: 'transparent', fg: 'var(--ink-2)', bd: 'none', hover: 'var(--sunken)', label: { ar: 'شفاف', en: 'Ghost' }, use: { ar: 'إجراءات خفيفة داخل الجداول والقوائم.', en: 'Light actions inside tables and lists.' } },
    tonal: { bg: 'var(--pri-s)', fg: 'var(--pri-d)', bd: '1px solid var(--pri-sb)', hover: 'var(--pri-sb)', label: { ar: 'مُلوَّن', en: 'Tonal' }, use: { ar: 'حالة نشطة لزر ثانوي (فلتر مفعّل، عمود مثبّت).', en: 'Active state of a secondary button (filter on, pinned column).' } },
  };
  const ADDON_ICONS = {
    search: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.6"/><path d="M13 13l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M4 13V5.5A1.5 1.5 0 015.5 4H13" stroke-linecap="round"/></svg>',
    clear: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
    calendar: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="14" height="12" rx="1.5"/><path d="M3 9h14M7 3v4M13 3v4" stroke-linecap="round"/></svg>',
    plus: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>',
    eye: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.5"/></svg>',
    scan: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 7V4.5A1.5 1.5 0 014.5 3H7M13 3h2.5A1.5 1.5 0 0117 4.5V7M17 13v2.5a1.5 1.5 0 01-1.5 1.5H13M7 17H4.5A1.5 1.5 0 013 15.5V13M5 10h10"/></svg>',
    whatsapp: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 16.5l1-3.4A7 7 0 1110 17a7 7 0 01-3.2-.8z" stroke-linejoin="round"/><path d="M7.5 7.5c0 3 2 5 5 5l.8-1.2-1.6-.8-.7.6c-1-.4-1.8-1.2-2.2-2.2l.6-.7-.8-1.6z" fill="currentColor" stroke="none"/></svg>',
    send: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 10l14-6-4 14-3-6z"/><path d="M10 12l7-8"/></svg>',
    user: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="7" r="3"/><path d="M4.5 16.5c.8-2.7 2.9-4 5.5-4s4.7 1.3 5.5 4" stroke-linecap="round"/></svg>',
    users: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7.5" cy="7" r="2.6"/><circle cx="13.5" cy="8.5" r="2"/><path d="M3 16c.7-2.4 2.5-3.6 4.5-3.6S11.3 13.6 12 16" stroke-linecap="round"/></svg>',
    link: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 11.5l3-3"/><path d="M7.5 13.5l-1 1a2.5 2.5 0 01-3.5-3.5l2.5-2.5a2.5 2.5 0 013.5 0"/><path d="M12.5 6.5l1-1a2.5 2.5 0 013.5 3.5l-2.5 2.5a2.5 2.5 0 01-3.5 0"/></svg>',
    gear: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.6"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4" stroke-linecap="round"/></svg>',
    doc: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke-linecap="round"/></svg>',
    attach: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.2 5.2a2.3 2.3 0 103.3 3.3L16 10.6a4 4 0 10-5.7-5.7L5 10.3"/></svg>',
    shield: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 3l6 2v5c0 3.4-2.4 6-6 7-3.6-1-6-3.6-6-7V5l6-2z"/></svg>',
    hook: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 5.5a2.5 2.5 0 115 0v6a2.5 2.5 0 105 0"/></svg>',
  };
  const BUTTON_SIZES = { md: { h: '36px', px: '14px', fs: '13px' }, sm: { h: '28px', px: '10px', fs: '12px' }, lg: { h: '42px', px: '18px', fs: '14px' } };
  // نصوص الواجهة الثابتة
  const I18N = {
    ar: { search: 'بحث…', pick: 'اختر…', none: 'لا نتائج', noneFree: 'لا اقتراحات — سيُحفظ النص كما هو', clearAll: 'مسح الكل', clear: 'مسح', done: 'تم', on: 'مفعّل', off: 'غير مفعّل', selected: 'المحدد', of: 'من', copy: 'نسخ', cancel: 'إلغاء', save: 'حفظ', delete: 'حذف', close: 'إغلاق', unsaved: 'تغييرات غير محفوظة', helper: 'نص مساعد اختياري تحت الحقل.', states: 'الحالات', invalid: 'قيمة غير صالحة', errorMsg: 'رسالة الخطأ تحت الحقل مباشرة.', disabled: 'معطّل', typeHere: 'اكتب هنا…', enable: 'تفعيل الخيار', acPh: 'ابحث باسم جهة الاتصال أو رقمها…', sm: 'صغير', md: 'متوسط', lg: 'كبير', withIcon: 'مع أيقونة', iconOnly: 'أيقونة فقط', comfortable: 'مريح', compact: 'مضغوط', dash: '—' },
    en: { search: 'Search…', pick: 'Select…', none: 'No results', noneFree: 'No suggestions — text will be kept as typed', clearAll: 'Clear all', clear: 'Clear', done: 'Done', on: 'On', off: 'Off', selected: 'Selected', of: 'of', copy: 'Copy', cancel: 'Cancel', save: 'Save', delete: 'Delete', close: 'Close', unsaved: 'Unsaved changes', helper: 'Optional helper text under the field.', states: 'States', invalid: 'Invalid value', errorMsg: 'Error message directly under the field.', disabled: 'Disabled', typeHere: 'Type here…', enable: 'Enable option', acPh: 'Search by contact name or number…', sm: 'Small', md: 'Medium', lg: 'Large', withIcon: 'With icon', iconOnly: 'Icon only', comfortable: 'Comfortable', compact: 'Compact', dash: '—' },
  };
  const t = (lang, key) => (I18N[lang] || I18N.ar)[key] || key;
  // L: يقرأ نصاً ثنائي اللغة أو نصاً عادياً
  const L = (lang, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? (v[lang] ?? v.ar ?? v.en ?? '') : (v ?? '');
  window.UIKit = { MONO, FONT, DENSITY, FIELD_BASE, FIELD_TYPES, TONE, BUTTON, BUTTON_SIZES, ADDON_ICONS, I18N, t, L };
})();
