(function(){
// طبقة بيانات وهمية في الذاكرة — كل الأرقام في التطبيق تُحسب من هنا.
// بذرة ثابتة => نفس البيانات في كل تحميل.
function makeRng(s) {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = makeRng(20260907);
const pick = (a) => a[Math.floor(r() * a.length)];
const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const wpick = (pairs) => {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let x = r() * total;
  for (const [v, w] of pairs) { x -= w; if (x <= 0) return v; }
  return pairs[pairs.length - 1][0];
};

// ساعة واحدة للتطبيق كله: البذور تُثبَّت على لحظة التحميل حتى تبقى
// «قبل ١٢ دقيقة» صحيحة مهما طال بقاء الصفحة مفتوحة.
const NOW = Date.now();
const DAY = 86400000;

const STATUS = {
  unsent:    { ar: 'غير مرسل',    en: 'Unsent',    tone: 'muted' },
  queued:    { ar: 'قيد الإرسال', en: 'Queued',    tone: 'warn' },
  sent:      { ar: 'مرسل',        en: 'Sent',      tone: 'sent' },
  delivered: { ar: 'مستلم',       en: 'Delivered', tone: 'delivered' },
  read:      { ar: 'مقروء',       en: 'Read',      tone: 'read' },
  cancelled: { ar: 'ملغي',        en: 'Cancelled', tone: 'muted' },
  failed:    { ar: 'فشل',         en: 'Failed',    tone: 'danger' },
};

const ERRORS = {
  recipient_not_registered: { ar: 'رقم غير مسجّل بواتساب', raw: 'recipient_not_registered: {n} is not a WhatsApp user', fix: 'تصحيح الرقم' },
  device_disconnected:      { ar: 'الجهاز مفصول',          raw: 'device_disconnected: session closed by phone', fix: 'إعادة الاقتران' },
  timeout:                  { ar: 'انتهاء المهلة',          raw: 'gateway_timeout: no ack within 30s', fix: 'إعادة المحاولة' },
  platform_rejected:        { ar: 'رفض من المنصة',          raw: 'platform_rejected: rate limit exceeded', fix: 'تهدئة المعدل' },
  invalid_template:         { ar: 'قالب غير صالح',          raw: 'invalid_template: variable {invoice_total} not resolved', fix: 'تحرير النموذج' },
  insufficient_balance:     { ar: 'نفاد الرصيد',            raw: 'insufficient_balance: wallet below message price', fix: 'شحن المحفظة' },
};

const contactGroups = [
  { id: 'g1', name: 'عملاء محتملين من حملة إعلانية في الانستجرام', kind: 'تسويقي', note: 'أرقام وصلت من حملة سبتمبر — لم تُربط بحسابات بعد.', size: 412, source: 'استيراد CSV', updated: NOW - 3 * 86400000 },
  { id: 'g2', name: 'قائمة بريدية مدراء القطاع غير الربحي', kind: 'قائمة بريدية', note: 'جهات اتصال للنشرة الشهرية والدعوات.', size: 168, source: 'إدخال يدوي', updated: NOW - 11 * 86400000 },
  { id: 'g3', name: 'قائمة المحاسبين القانونيين المعتمدين', kind: 'مهني', note: 'تُستخدم لإشعارات التقارير والمراجعة السنوية.', size: 74, source: 'مزامنة من الأستاذ المساعد', updated: NOW - 26 * 86400000 },
  { id: 'g4', name: 'قائمة سوداء — سبام', kind: 'قائمة سوداء', note: 'أرقام محجوبة من كل الأوامر والحملات.', size: 39, source: 'حجب يدوي', updated: NOW - 86400000 },
];

const msgTemplates = [
  { id: 'mt1', name: 'تذكير مستحقات أسبوعي', category: 'مستحقات', updated: NOW - 3 * DAY, uses: 128,
    body: 'السلام عليكم {{ customer_name }}،\nنودّ تذكيركم بأن رصيد حسابكم لدينا {{ balance }} حتى تاريخ {{ to_date }}.\n{% if overdue_days > 0 %}تجاوز موعد الاستحقاق بـ {{ overdue_days }} يوم.{% else %}لا توجد مستحقات متأخرة.{% endif %}\nشاكرين لكم تعاونكم — {{ company }}' },
  { id: 'mt2', name: 'تأكيد استلام دفعة', category: 'مالية', updated: NOW - 9 * DAY, uses: 74,
    body: 'شكراً {{ customer_name }}.\nاستلمنا دفعتكم بمبلغ *{{ amount }}* بتاريخ {{ date }} على الفاتورة {{ doc_no }}.\nرصيدكم الحالي: {{ balance }}.' },
  { id: 'mt3', name: 'إشعار شحن طلب', category: 'مبيعات', updated: NOW - 1 * DAY, uses: 212,
    body: 'مرحباً {{ customer_name }}،\nتم شحن طلبكم رقم {{ doc_no }}.\n{% if tracking %}رقم التتبع: {{ tracking }}{% endif %}\nالتسليم المتوقع: {{ eta }}.' },
  { id: 'mt4', name: 'ترحيب بعميل جديد', category: 'عام', updated: NOW - 20 * DAY, uses: 41,
    body: 'أهلاً بك {{ customer_name }} في {{ company }}!\nللاستفسار عن رصيدك أرسل *كشف*، وعن فواتيرك أرسل *فواتير*.' },
];

const CONTACT_GROUPS = contactGroups.map((g) => g.name);

const PARTY_TYPES = {
  customer: { ar: 'عميل',       color: '#1F5A97' },
  supplier: { ar: 'مورد',       color: '#8A6116' },
  employee: { ar: 'موظف',       color: '#4A5A56' },
  agent:    { ar: 'مندوب',      color: '#6F4E10' },
  partner:  { ar: 'شريك',       color: '#0B6250' },
  payment:  { ar: 'طريقة دفع',  color: '#3E4C57' },
};

const DOC_TYPES = ['فاتورة بيع', 'أمر بيع', 'عرض سعر', 'سند قبض', 'طلب شراء', 'فاتورة مشتريات', 'سند صرف'];

const devices = [
  { id: 'd1', name: 'جهاز المبيعات', phone: '+966 50 123 4567', status: 'connected',   initials: 'مب', color: '#55645F', lastSeen: NOW - 22000,   battery: 78 },
  { id: 'd2', name: 'فرع جدة',       phone: '+966 55 902 8814', status: 'disconnected', initials: 'جد', color: '#55645F', lastSeen: NOW - 42 * 60000, battery: 12 },
  { id: 'd3', name: 'المحاسبة',      phone: '+966 53 447 1120', status: 'pending',      initials: 'مح', color: '#55645F', lastSeen: null,          battery: null },
  { id: 'd4', name: 'الدعم الفني',   phone: '+966 56 771 3390', status: 'connected',    initials: 'دع', color: '#55645F', lastSeen: NOW - 9000,    battery: 54 },
];

const companyNames = ['مؤسسة المطلق للتجارة', 'شركة الرياض للمقاولات', 'مجموعة الخليج الغذائية', 'مصنع النخبة للبلاستيك', 'شركة سدير للنقل', 'مؤسسة البيان للتوريدات', 'شركة الواحة الطبية', 'مؤسسة أضواء الشرق', 'شركة تبوك الزراعية', 'مؤسسة الفهد للأدوات الصحية', 'شركة نجد للحلول التقنية', 'مصنع الأمانة للأثاث', 'مؤسسة درة القصيم', 'شركة البحر الأحمر اللوجستية', 'مؤسسة الصفوة للمعادن', 'شركة الجوف للتمور', 'مؤسسة ركن الإنشاء', 'شركة المدار للتجزئة', 'مؤسسة زهرة الشمال', 'شركة الساحل للتبريد'];
const personNames = ['عبدالله الفهد', 'سارة القحطاني', 'محمد العتيبي', 'نورة الدوسري', 'خالد الشمري', 'ريم الغامدي', 'فهد الحربي', 'لمى العنزي', 'سلطان المطيري', 'هند البقمي', 'ماجد الزهراني', 'أسماء السبيعي'];

const contacts = [];
for (let i = 0; i < 68; i++) {
  const type = wpick([['customer', 52], ['supplier', 20], ['employee', 14], ['agent', 10], ['partner', 8], ['payment', 6]]);
  const isCompany = type === 'customer' || type === 'supplier' || type === 'partner';
  const person = personNames[i % personNames.length];
  const org = companyNames[i % companyNames.length] + (i >= companyNames.length ? ' — فرع ' + int(2, 9) : '');
  const name = isCompany ? person + ' (' + org + ')' : person;
  const accountCount = isCompany ? int(1, 3) : 1;
  const accounts = [];
  const accountTypes = [];
  for (let a = 0; a < accountCount; a++) {
    const base = isCompany ? companyNames[(i + a * 3) % companyNames.length] : person;
    const nm = base + (r() > 0.82 ? ' — حساب مجمد' : '');
    if (accounts.indexOf(nm) > -1) continue;
    accounts.push(nm);
    accountTypes.push(a === 0 ? type : wpick([['customer', 40], ['supplier', 30], ['partner', 14], ['agent', 10]]));
  }
  contacts.push({
    id: 'c' + (i + 1),
    name,
    phone: '+9665' + int(0, 6) + ' ' + int(100, 999) + ' ' + int(1000, 9999),
    type,
    linked: r() > 0.18,
    active: r() > 0.12,
    isSystemUser: type === 'employee' && r() > 0.45,
    accounts,
    accountTypes,
    starred: r() > 0.9,
    inDevice: r() > 0.35,
    balance: Math.round((r() * 180000 - 30000) / 10) * 10,
    lastMessageAt: NOW - int(0, 60) * DAY,
  });
}
/* ١٨ جهة بلا وارد مسجّل، ٥ منها محادثتها مؤكدة يدوياً (جرت قبل ربط النظام) */
contacts.forEach((x, ix) => { if (ix % 4 === 1 && ix < 72) { x.noInbound = true; x.chatManual = ix % 12 === 1; } });

// حالات طرفية مقصودة
contacts.push({ id: 'c-long', name: 'عبدالعزيز بن ناصر الدوسري (شركة المجموعة الوطنية المتحدة للتجارة والتوزيع والخدمات اللوجستية المحدودة — الفرع الرئيسي بالرياض)', accounts: ['شركة المجموعة الوطنية المتحدة للتجارة والتوزيع', 'شركة المجموعة الوطنية — فرع جدة'], accountTypes: ['customer', 'supplier'], phone: '+966 11 200 4477', type: 'customer', linked: true, starred: true, inDevice: true, balance: 0, lastMessageAt: NOW - 2 * DAY });
contacts.push({ id: 'c-noname', name: '', phone: '+966 55 000 1188', type: 'customer', linked: false, starred: false, inDevice: true, balance: 0, lastMessageAt: NOW - 5 * DAY });
contacts.push({ id: 'c-group', name: 'صندوق الفرع الرئيسي', accounts: ['صندوق الفرع الرئيسي'], accountTypes: ['employee'], phone: '120363048822917@g.us', type: 'employee', linked: true, starred: false, inDevice: false, balance: 0, lastMessageAt: NOW - 1 * DAY });


/* ————— خصائص الفلترة لكل نوع جهة ————— */
const CUST_GROUPS = ['تجزئة', 'جملة', 'مشاريع', 'جهات حكومية'];
const CITIES = ['الرياض', 'جدة', 'الدمام', 'مكة المكرمة', 'المدينة المنورة', 'أبها', 'بريدة'];
const REPS = ['سلطان المطيري', 'ريم الغامدي', 'فهد الحربي', 'لمى العنزي'];
const DEPTS = ['المبيعات', 'المحاسبة', 'المستودع', 'الموارد البشرية', 'التقنية'];
const BRANCHES = ['الفرع الرئيسي', 'فرع جدة', 'فرع الدمام', 'فرع القصيم'];
const SUP_CATS = ['مواد خام', 'خدمات', 'نقل وشحن', 'تقنية', 'تشغيل وصيانة'];
const ACCT_STATES = ['نشط', 'متوقف', 'مجمد'];
contacts.forEach((c, i) => {
  c.city = CITIES[i % CITIES.length];
  if (c.type === 'customer') { c.custGroup = CUST_GROUPS[i % CUST_GROUPS.length]; c.rep = REPS[i % REPS.length]; c.acctState = ACCT_STATES[i % 9 === 4 ? 1 : i % 13 === 7 ? 2 : 0]; }
  if (c.type === 'supplier') { c.supCat = SUP_CATS[i % SUP_CATS.length]; }
  if (c.type === 'employee') { c.dept = DEPTS[i % DEPTS.length]; c.branch = BRANCHES[i % BRANCHES.length]; }
});
const PARTY_FILTERS = {
  customer: [
    { key: 'custGroup', label: 'مجموعة العملاء', options: CUST_GROUPS },
    { key: 'rep', label: 'المندوب', options: REPS },
    { key: 'city', label: 'المدينة', options: CITIES },
    { key: 'acctState', label: 'حالة الحساب', options: ACCT_STATES },
  ],
  supplier: [
    { key: 'supCat', label: 'تصنيف المورد', options: SUP_CATS },
    { key: 'city', label: 'المدينة', options: CITIES },
  ],
  employee: [
    { key: 'dept', label: 'القسم', options: DEPTS },
    { key: 'branch', label: 'الفرع', options: BRANCHES },
  ],
  agent: [{ key: 'city', label: 'المدينة', options: CITIES }],
  partner: [{ key: 'city', label: 'المدينة', options: CITIES }],
  payment: [{ key: 'city', label: 'المدينة', options: CITIES }],
};

const bodies = [
  'عميلنا العزيز، صدرت فاتورة بيع رقم {no} بمبلغ {amt} ر.س. شكراً لتعاملكم معنا.',
  'تم اعتماد أمر البيع رقم {no}. المبلغ الإجمالي {amt} ر.س وسيتم التجهيز خلال يومين عمل.',
  'عرض السعر رقم {no} صالح حتى نهاية الأسبوع. الإجمالي {amt} ر.س.',
  'استلمنا مبلغ {amt} ر.س بموجب سند القبض رقم {no}. جزيل الشكر.',
  'تذكير: مستحقات بمبلغ {amt} ر.س على حسابكم رقم {no}. يسعدنا تسويتها في أقرب فرصة.',
  'صدر طلب الشراء رقم {no} لصالحكم بمبلغ {amt} ر.س، يرجى تأكيد التوريد.',
];

const campaigns = [];
const campaignNames = ['تذكير مستحقات سبتمبر', 'عرض نهاية الموسم', 'تحديث بيانات العملاء', 'إعلان جدول الإجازة', 'استبيان رضا العملاء', 'تنبيه انتهاء العروض', 'دعوة معرض الرياض', 'تذكير مواعيد التسليم', 'إشعار تغيير أرقام التحويل', 'عرض الجمعة على المعدات', 'حملة تحصيل الشيكات', 'تذكير عقود الصيانة', 'إشعار توقف النظام للتحديث', 'ترحيب بالعملاء الجدد'];
campaignNames.forEach((name, i) => {
  const status = wpick([['completed', 40], ['running', 12], ['scheduled', 14], ['paused', 10], ['draft', 16], ['cancelled', 6]]);
  const recipients = int(45, 780);
  const progress = status === 'completed' ? 1 : status === 'running' ? r() * 0.8 + 0.1 : status === 'paused' ? r() * 0.5 : 0;
  const sent = Math.round(recipients * progress);
  const failed = Math.round(sent * (r() * 0.05));
  const rate = int(14, 40);
  const startAt = status === 'scheduled' ? NOW + int(1, 21) * DAY : NOW - int(0, 70) * DAY;
  /* المدة التقديرية = المستلمون ÷ المعدّل؛ الفعلية تنتهي بـ endAt للحملات المنتهية فقط */
  const estMs = (recipients / rate) * 60000;
  campaigns.push({
    id: 'k' + (i + 1), name, status, recipients, sent, failed, rate,
    delivered: Math.max(0, sent - failed - Math.round(sent * 0.02)),
    read: Math.round(sent * 0.72),
    deviceId: pick(devices).id,
    createdAt: NOW - int(1, 80) * DAY,
    startAt,
    wasScheduled: status === 'scheduled' ? true : r() > 0.55,
    endAt: (status === 'completed' || status === 'cancelled') ? Math.min(NOW, startAt + Math.round(estMs * (0.82 + r() * 1.05))) : null,
    owner: pick(personNames),
    body: pick(msgTemplates).body,
    initialRecipients: null, pauseCount: 0, log: [], roster: null, prevStatus: null,
  });
});

/* ضمان تغطية كل الحالات في العرض: حملتان مجدولتان وحملة ملغية على الأقل */
const forcedScheduled = [];
(() => {
  const need = (st, n, from) => {
    let have = campaigns.filter((c) => c.status === st).length;
    for (let i = 0; i < campaigns.length && have < n; i++) {
      const c = campaigns[i];
      if (from.indexOf(c.status) < 0) continue;
      c.status = st;
      if (st === 'scheduled') { c.sent = 0; c.delivered = 0; c.read = 0; c.failed = 0; c.endAt = null; c.wasScheduled = true; c.startAt = NOW + int(1, 18) * DAY; forcedScheduled.push(c.id); }
      if (st === 'cancelled') { c.endAt = NOW - int(1, 9) * DAY; }
      have++;
    }
  };
  need('scheduled', 2, ['draft', 'completed']);
  need('cancelled', 1, ['completed']);
})();

/* بعض الحملات عُدّلت بعد اعتمادها: إيقاف ← إزالة/إضافة مستلمين أو تعديل الرسالة ← استئناف (وقد يتكرر) */
campaigns.forEach((c) => {
  if (!['paused', 'running', 'completed', 'cancelled'].includes(c.status) || r() > 0.42) return;
  const rounds = int(1, 2), plan = [];
  let remTotal = 0, addTotal = 0;
  for (let k = 0; k < rounds; k++) { const rem = int(3, 26), add = r() > 0.4 ? int(2, 19) : 0; plan.push({ rem, add }); remTotal += rem; addTotal += add; }
  const init = c.recipients + remTotal - addTotal;
  let cur = init;
  const p2 = (x) => String(x).padStart(2, '0');
  const dtTxt = (ts) => { const dd = new Date(ts); return dd.toISOString().slice(0, 10) + ' ' + p2(dd.getHours()) + ':' + p2(dd.getMinutes()); };
  plan.forEach((pl, k) => {
    const t = c.startAt + (k + 1) * 2700000, by = pick(personNames);
    const wasStatus = c.wasScheduled && k === 0 ? 'مجدولة' : 'قيد الإرسال';
    c.log.push({ ts: t, kind: 'pause', text: 'أُوقفت الحملة', by, from: wasStatus, to: 'موقوفة' });
    const next = cur - pl.rem + pl.add;
    c.log.push({ ts: t + 120000, kind: 'recipients', text: 'أُزيل ' + pl.rem + ' مستلماً لم تُرسل لهم' + (pl.add ? ' وأُضيف ' + pl.add + ' مستلماً جديداً' : ''), by, from: cur + ' مستلم', to: next + ' مستلم' });
    cur = next;
    if (r() > 0.55) { const a = int(120, 320), b = int(120, 320); c.log.push({ ts: t + 180000, kind: 'body', text: 'عُدّل نص الرسالة', by, from: a + ' حرف', to: b + ' حرف' }); }
    if (r() > 0.75) { const d1 = pick(devices), d2 = devices.find((x) => x.id !== d1.id); c.log.push({ ts: t + 210000, kind: 'device', text: 'غُيّر جهاز الإرسال', by, from: d1.name, to: d2.name }); }
    if (c.wasScheduled && r() > 0.6) c.log.push({ ts: t + 240000, kind: 'reschedule', text: 'أُعيدت الجدولة', by, from: dtTxt(c.startAt - int(1, 4) * DAY), to: dtTxt(c.startAt) });
    if (c.status !== 'paused' || k < rounds - 1) c.log.push({ ts: t + 300000, kind: 'resume', text: 'استُئنفت الحملة', by, from: 'موقوفة', to: c.wasScheduled && k === 0 ? 'مجدولة' : 'قيد الإرسال' });
  });
  c.pauseCount = rounds;
  c.initialRecipients = init;
  c.removedCount = remTotal;
  c.addedCount = addTotal;
});

const templates = [];
[['فاتورة بيع عند الاعتماد', 'فاتورة بيع'], ['أمر بيع عند الإنشاء', 'أمر بيع'], ['عرض سعر عند الإرسال', 'عرض سعر'], ['سند قبض عند التحصيل', 'سند قبض'], ['طلب شراء للمورد', 'طلب شراء'], ['تذكير مستحقات أسبوعي', 'فاتورة بيع'], ['شكر بعد السداد', 'سند قبض'], ['إشعار تأخر التوريد', 'فاتورة مشتريات'], ['ترحيب بعميل جديد', 'أمر بيع'], ['إشعار صرف راتب', 'سند صرف'], ['تأكيد موعد التسليم', 'أمر بيع']].forEach(([name, doc], i) => {
  templates.push({ id: 't' + (i + 1), name, docType: doc, status: r() > 0.25 ? 'active' : 'inactive', deviceId: pick(devices).id, vars: int(2, 6), usage30d: int(0, 3200), updatedAt: NOW - int(0, 60) * DAY, body: pick(bodies) });
});

const functions = [];
const FN_META = {
  'كشف حساب عميل': {
    partyType: 'العميل، المندوب، مستخدم',
    description: 'ترسل كشف حساب العميل خلال فترة محددة مع صافي الرصيد بالأرقام والأحرف.',
    whenToUse: 'اربطها بأمر يطلبه العميل مباشرة (مثل «كشف») لإرسال كشف حسابه دون تدخّل يدوي.',
    inputs: [
      { token: '#العميل', label: 'العميل', example: '#CU101', requiredFor: '*مستخدم أو مندوب', details: 'في حال كان نوع المرسل «مستخدم» مع اشتراط أن يكون لديه صلاحية على تقرير كشف حساب العميل ولديه صلاحية أيضاً لنفس العميل المرسل.' },
      { token: '#السنة', label: 'السنة', example: '#2026', details: 'في حال لم يتم تمرير سنة سيتم إرسال كشف الحساب للفترة من بداية سنة تاريخ الإرسال إلى تاريخ الإرسال نفسه.' },
      { token: '#العملة', label: 'العملة', example: '#SAR', details: 'في حال لم يتم تمرير عملة سيتم إرسال كشوفات الحساب لجميع العملات.' },
    ],
    outputs: [
      { token: '{{data.balance}}', label: 'الرصيد بالأرقام' },
      { token: '{{data.balance_in_words}}', label: 'الرصيد بالأحرف' },
    ],
    settings: [
      { key: 'allow_prev_years', label: 'السماح بكشف حساب لسنوات سابقة', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'لا', notes: 'عند التفعيل يُقبل تمرير #السنة لسنة مالية مغلقة؛ وإلا يُرد بالسنة الحالية فقط.' },
      { key: 'attach_pdf', label: 'إرفاق مستند الكشف (PDF)', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'يرفق ملف الكشف المُولّد من قالب الطباعة مع الرسالة.' },
      { key: 'rows_limit', label: 'عدد الحركات المعروضة في الرسالة', fieldType: 'number', typeLabel: 'رقم', defaultValue: '10', notes: 'الحركات الأحدث أولاً. القيمة 0 يعني عرض الكل.' },
      { key: 'words_balance', label: 'إظهار الرصيد بالأحرف', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'يضيف قيمة {{balance_in_words}} إلى نص الرسالة.' },
      { key: 'currency', label: 'العملة الافتراضية', fieldType: 'select', typeLabel: 'قائمة', defaultValue: 'كل العملات', choices: ['كل العملات', 'SAR', 'USD', 'AED'], notes: 'تُستخدم عند عدم تمرير #العملة في نص الأمر.' },
      { key: 'block_frozen', label: 'حجب الكشف عند تجميد حساب العميل', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'عند التفعيل تُرسل «رسالة الحساب مجمد» بدلاً من الكشف.' },
    ],
    options: [
      { name: 'رسالة الرصيد', type: 'نص', typeKey: 'text', defaultValue: 'كشف حساب العميل {{customer_name}} للفترة {{from_date}} الى الفترة {{to_date}} هو {{balance}} {{balance_in_words}}', notes: 'تُرسل عند وجود حركة على الحساب خلال الفترة.', fields: ['{{customer_name}}', '{{from_date}}', '{{to_date}}', '{{balance}}', '{{balance_in_words}}'] },
      { name: 'مستند كشف الحساب', type: 'مستند', typeKey: 'document', fileName: 'كشف حساب {{customer_name}} من {{from_date}} الى {{to_date}}', defaultValue: 'Customer Ledger Print Format', notes: 'قالب الطباعة المستخدم لتوليد ملف PDF المرفق.', fields: [] },
      { name: 'رسالة الحساب مجمد', type: 'نص', typeKey: 'text', defaultValue: 'لا يمكن .. حسابكم مجمد لدينا يرجى التواصل مع ادارة العملاء', notes: 'تُرسل بدلاً من الكشف عند تجميد الحساب.', fields: [] },
    ],
    example: { command: 'كشف', rendered: 'مرفق لكم كشف حسابكم (العميل: عميل تجريبي) للفترة من 01/01/2026 الى 07/09/2026 عدد صفحات () وبرصيد: بالارقام: مدين 10,000 ر.س، بالاحرف: عليكم عشرة الف ريال سعودي' },
    suggestedCommands: ['كشف', 'كشف حسابي', 'رصيدي'],
  },
  'كشف حساب مورد': {
    partyType: 'المورد، مستخدم',
    description: 'ترسل كشف حساب المورد مع صافي المستحقات خلال الفترة المطلوبة.',
    whenToUse: 'استخدمها للرد على استفسارات الموردين عن مستحقاتهم دون الرجوع لقسم الحسابات.',
    inputs: [
      { token: '#المورد', label: 'المورد', example: '#SU204', requiredFor: '*مستخدم أو مندوب', details: 'في حال كان نوع المرسل «مستخدم» مع اشتراط أن يكون لديه صلاحية على تقرير كشف حساب المورد ولديه صلاحية أيضاً لنفس المورد المرسل.' },
      { token: '#السنة', label: 'السنة', example: '#2026', details: 'في حال لم يتم تمرير سنة سيتم إرسال كشف الحساب للفترة من بداية سنة تاريخ الإرسال إلى تاريخ الإرسال نفسه.' },
      { token: '#العملة', label: 'العملة', example: '#SAR', details: 'في حال لم يتم تمرير عملة سيتم إرسال كشوفات الحساب لجميع العملات.' },
    ],
    outputs: [
      { token: '{{data.balance}}', label: 'المستحق بالأرقام' },
      { token: '{{data.balance_in_words}}', label: 'المستحق بالأحرف' },
    ],
    settings: [
      { key: 'allow_prev_years', label: 'السماح بكشف حساب لسنوات سابقة', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'لا', notes: 'عند التفعيل يُقبل تمرير #السنة لسنة مالية مغلقة؛ وإلا يُرد بالسنة الحالية فقط.' },
      { key: 'attach_pdf', label: 'إرفاق مستند الكشف (PDF)', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'يرفق ملف الكشف المُولّد من قالب الطباعة مع الرسالة.' },
      { key: 'rows_limit', label: 'عدد الحركات المعروضة في الرسالة', fieldType: 'number', typeLabel: 'رقم', defaultValue: '10', notes: 'الحركات الأحدث أولاً. القيمة 0 يعني عرض الكل.' },
      { key: 'words_balance', label: 'إظهار الرصيد بالأحرف', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'يضيف قيمة {{balance_in_words}} إلى نص الرسالة.' },
      { key: 'currency', label: 'العملة الافتراضية', fieldType: 'select', typeLabel: 'قائمة', defaultValue: 'كل العملات', choices: ['كل العملات', 'SAR', 'USD', 'AED'], notes: 'تُستخدم عند عدم تمرير #العملة في نص الأمر.' },
      { key: 'block_frozen', label: 'حجب الكشف عند تجميد حساب المورد', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'عند التفعيل تُرسل «رسالة الحساب مجمد» بدلاً من الكشف.' },
    ],
    options: [
      { name: 'رسالة الرصيد', type: 'نص', typeKey: 'text', defaultValue: 'كشف حساب المورد {{supplier_name}} للفترة {{from_date}} الى الفترة {{to_date}} هو {{balance}} {{balance_in_words}}', notes: 'تُرسل عند وجود حركة على الحساب خلال الفترة.', fields: ['{{supplier_name}}', '{{from_date}}', '{{to_date}}', '{{balance}}', '{{balance_in_words}}'] },
      { name: 'مستند كشف الحساب', type: 'مستند', typeKey: 'document', fileName: 'كشف حساب {{supplier_name}} من {{from_date}} الى {{to_date}}', defaultValue: 'Customer Ledger Print Format', notes: 'قالب الطباعة المستخدم لتوليد ملف PDF المرفق.', fields: [] },
      { name: 'رسالة الحساب مجمد', type: 'نص', typeKey: 'text', defaultValue: 'لا يمكن .. حسابكم مجمد لدينا يرجى التواصل مع ادارة العملاء', notes: 'تُرسل بدلاً من الكشف عند تجميد الحساب.', fields: [] },
    ],
    example: { command: 'كشف مورد', rendered: 'مرفق كشف حساب المورد شركة الأفق للتوريدات للفترة من 01/08/2026 الى 07/09/2026، المستحق: 24,500.00 ر.س.' },
    suggestedCommands: ['كشف مورد', 'مستحقاتي'],
  },
  'كشف حساب موظف': {
    partyType: 'الموظف، مستخدم',
    description: 'كشف يعرض للموظف رصيد سلفياته ومستحقاته خلال فترة محددة.',
    whenToUse: 'عند طلب الموظف الاستفسار عن سلفياته أو مستحقاته عبر واتساب.',
    inputs: [
      { token: '#الموظف', label: 'الموظف', example: '#EM312', requiredFor: '*مستخدم أو مندوب', details: 'في حال كان نوع المرسل «مستخدم» مع اشتراط أن يكون لديه صلاحية على تقرير كشف حساب الموظف ولديه صلاحية أيضاً لنفس الموظف المرسل.' },
      { token: '#السنة', label: 'السنة', example: '#2026', details: 'في حال لم يتم تمرير سنة سيتم إرسال كشف الحساب للفترة من بداية سنة تاريخ الإرسال إلى تاريخ الإرسال نفسه.' },
      { token: '#العملة', label: 'العملة', example: '#SAR', details: 'في حال لم يتم تمرير عملة سيتم إرسال كشوفات الحساب لجميع العملات.' },
    ],
    outputs: [
      { token: '{{data.balance}}', label: 'الرصيد بالأرقام' },
      { token: '{{data.balance_in_words}}', label: 'الرصيد بالأحرف' },
    ],
    settings: [
      { key: 'allow_prev_years', label: 'السماح بكشف حساب لسنوات سابقة', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'لا', notes: 'عند التفعيل يُقبل تمرير #السنة لسنة مالية مغلقة؛ وإلا يُرد بالسنة الحالية فقط.' },
      { key: 'attach_pdf', label: 'إرفاق مستند الكشف (PDF)', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'يرفق ملف الكشف المُولّد من قالب الطباعة مع الرسالة.' },
      { key: 'rows_limit', label: 'عدد الحركات المعروضة في الرسالة', fieldType: 'number', typeLabel: 'رقم', defaultValue: '10', notes: 'الحركات الأحدث أولاً. القيمة 0 يعني عرض الكل.' },
      { key: 'words_balance', label: 'إظهار الرصيد بالأحرف', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'يضيف قيمة {{balance_in_words}} إلى نص الرسالة.' },
      { key: 'currency', label: 'العملة الافتراضية', fieldType: 'select', typeLabel: 'قائمة', defaultValue: 'كل العملات', choices: ['كل العملات', 'SAR', 'USD', 'AED'], notes: 'تُستخدم عند عدم تمرير #العملة في نص الأمر.' },
      { key: 'block_frozen', label: 'حجب الكشف عند تجميد حساب الموظف', fieldType: 'check', typeLabel: 'خيار', defaultValue: 'نعم', notes: 'عند التفعيل تُرسل «رسالة الحساب مجمد» بدلاً من الكشف.' },
    ],
    options: [
      { name: 'رسالة الرصيد', type: 'نص', typeKey: 'text', defaultValue: 'كشف حساب الموظف {{employee_name}} للفترة {{from_date}} الى الفترة {{to_date}} هو {{balance}} {{balance_in_words}}', notes: 'تُرسل عند وجود حركة على الحساب خلال الفترة.', fields: ['{{employee_name}}', '{{from_date}}', '{{to_date}}', '{{balance}}', '{{balance_in_words}}'] },
      { name: 'مستند كشف الحساب', type: 'مستند', typeKey: 'document', fileName: 'كشف حساب {{employee_name}} من {{from_date}} الى {{to_date}}', defaultValue: 'Customer Ledger Print Format', notes: 'قالب الطباعة المستخدم لتوليد ملف PDF المرفق.', fields: [] },
      { name: 'رسالة الحساب مجمد', type: 'نص', typeKey: 'text', defaultValue: 'لا يمكن .. حسابكم مجمد لدينا يرجى التواصل مع ادارة العملاء', notes: 'تُرسل بدلاً من الكشف عند تجميد الحساب.', fields: [] },
    ],
    example: { command: 'كشف راتب', rendered: 'كشف حساب الموظف محمد العتيبي للفترة من 01/08/2026 الى 07/09/2026، الرصيد: له 1,200.00 ر.س.' },
    suggestedCommands: ['كشف راتب', 'سلفياتي'],
  },
  'أعمار الديون': {
    partyType: 'العميل، مستخدم أو مندوب',
    description: 'تقرير يوزّع أرصدة العملاء المدينة على شرائح عمرية (30/60/90 يوماً فأكثر).',
    whenToUse: 'لمتابعة المتأخرات وتحديد العملاء الذين يحتاجون تذكيراً.',
    inputs: [
      { token: '#اسم_العميل', label: 'اسم العميل (اختياري)', example: '#عميل_تجريبي' },
      { token: '#تاريخ_المطابقة', label: 'تاريخ المطابقة', example: '#07/09/2026' },
    ],
    outputs: [
      { token: '{{data.total_due}}', label: 'إجمالي المديونية' },
      { token: '{{data.buckets}}', label: 'الشرائح العمرية' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'إجمالي المديونية حتى {{filters.as_of_date}}: {{data.total_due}}.' },
      { key: 'all_current', label: 'كل الأرصدة ضمن المدة الحالية', template: 'لا توجد أرصدة متأخرة، كل الأرصدة ضمن المدة الحالية.' },
    ],
    example: { command: 'ديون', rendered: 'إجمالي المديونية حتى 07/09/2026: 182,400.00 ر.س — 30 يوم: 90,000، 60 يوم: 52,400، 90+ يوم: 40,000.' },
    suggestedCommands: ['ديون', 'متأخرات'],
  },
  'رصيد الصناديق': {
    description: 'يعرض أرصدة الصناديق النقدية لحظياً حسب الفرع.',
    whenToUse: 'لمتابعة السيولة النقدية دون فتح النظام المحاسبي.',
    inputs: [{ token: '#الفرع', label: 'الفرع (اختياري)', example: '#الفرع_الرئيسي' }],
    outputs: [{ token: '{{data.cashboxes}}', label: 'أرصدة الصناديق' }],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'رصيد الصناديق اليوم\nالصندوق الرئيسي: {{data.cashboxes.main}}\nصندوق الفرع: {{data.cashboxes.branch}}' },
      { key: 'no_access', label: 'لا صلاحية للعرض', template: 'لا تملكون صلاحية لعرض أرصدة الصناديق، يرجى مراجعة المحاسب.' },
    ],
    example: { command: 'رصيد', rendered: 'رصيد الصناديق اليوم\nالصندوق الرئيسي: 184,320.00 ر.س\nصندوق الفرع: 41,870.00 ر.س' },
    suggestedCommands: ['رصيد', 'رصيد الصندوق'],
  },
  'رصيد البنوك': {
    description: 'يعرض أرصدة الحسابات البنكية المرتبطة بالمنشأة.',
    whenToUse: 'لمتابعة أرصدة البنوك يومياً دون الدخول للنظام.',
    inputs: [{ token: '#اسم_البنك', label: 'اسم البنك (اختياري)', example: '#الأهلي' }],
    outputs: [{ token: '{{data.banks}}', label: 'أرصدة البنوك' }],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'أرصدة البنوك اليوم\nالأهلي: {{data.banks.ahli}}\nالراجحي: {{data.banks.rajhi}}' },
      { key: 'stale', label: 'بيانات غير محدثة', template: 'آخر تحديث لأرصدة البنوك لم يتم اليوم، البيانات قد تكون قديمة.' },
    ],
    example: { command: 'رصيد بنك', rendered: 'أرصدة البنوك اليوم\nالأهلي: 512,900.00 ر.س\nالراجحي: 96,410.00 ر.س' },
    suggestedCommands: ['رصيد بنك', 'ارصدة البنوك'],
  },
  'رصيد المخزون': {
    description: 'يعرض كمية ورصيد منتج أو مستودع محدد.',
    whenToUse: 'للرد على استفسارات المخزون بدون الرجوع لأمين المستودع.',
    inputs: [
      { token: '#اسم_المنتج', label: 'اسم المنتج', example: '#شاشة_24_بوصة' },
      { token: '#المستودع', label: 'المستودع (اختياري)', example: '#المستودع_الرئيسي' },
    ],
    outputs: [{ token: '{{data.qty}}', label: 'الكمية المتوفرة' }],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'رصيد «{{filters.item_name}}» في المستودع: {{data.qty}} قطعة.' },
      { key: 'out_of_stock', label: 'نفاد الكمية', template: 'المنتج «{{filters.item_name}}» غير متوفر حالياً.' },
    ],
    example: { command: 'مخزون', rendered: 'رصيد «شاشة 24 بوصة» في المستودع الرئيسي: 46 قطعة.' },
    suggestedCommands: ['مخزون', 'كمية المتوفر'],
  },
  'أرصدة العملاء': {
    partyType: 'العميل، مستخدم أو مندوب',
    description: 'ملخص إجمالي أرصدة جميع العملاء المدينين والدائنين.',
    whenToUse: 'للإدارة، لمراقبة إجمالي المديونية دون فتح كشف فردي لكل عميل.',
    inputs: [{ token: '#تاريخ_المطابقة', label: 'تاريخ المطابقة', example: '#07/09/2026' }],
    outputs: [
      { token: '{{data.total_debit}}', label: 'إجمالي المدين' },
      { token: '{{data.total_credit}}', label: 'إجمالي الدائن' },
    ],
    options: [{ key: 'success', label: 'رسالة النجاح', template: 'إجمالي أرصدة العملاء حتى {{filters.as_of_date}}: مدين {{data.total_debit}}، دائن {{data.total_credit}}.' }],
    example: { command: 'ارصدة العملاء', rendered: 'إجمالي أرصدة العملاء حتى 07/09/2026: مدين 612,000.00 ر.س، دائن 34,200.00 ر.س.' },
    suggestedCommands: ['ارصدة العملاء'],
  },
  'آخر فاتورة بيع': {
    partyType: 'العميل، مستخدم أو مندوب',
    description: 'يرسل نسخة من آخر فاتورة بيع للعميل.',
    whenToUse: 'عند طلب العميل نسخة من فاتورته الأخيرة.',
    inputs: [{ token: '#اسم_العميل', label: 'اسم العميل', example: '#عميل_تجريبي' }],
    outputs: [
      { token: '{{data.invoice_no}}', label: 'رقم الفاتورة' },
      { token: '{{data.amount}}', label: 'قيمة الفاتورة' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'آخر فاتورة بيع لكم: رقم {{data.invoice_no}} بتاريخ {{data.date}} بقيمة {{data.amount}}.' },
      { key: 'no_invoices', label: 'لا توجد فواتير', template: 'لا توجد فواتير مسجّلة على حسابكم بعد.' },
    ],
    example: { command: 'فاتورة', rendered: 'آخر فاتورة بيع لكم: رقم 10482 بتاريخ 05/09/2026 بقيمة 3,450.00 ر.س.' },
    suggestedCommands: ['فاتورة', 'فاتورتي الاخيرة'],
  },
  'حالة أمر بيع': {
    partyType: 'العميل، مستخدم أو مندوب',
    description: 'يعرض حالة تنفيذ أمر بيع محدد بالرقم.',
    whenToUse: 'للرد على استفسار العميل عن مرحلة تجهيز طلبه.',
    inputs: [{ token: '#رقم_الأمر', label: 'رقم الأمر', example: '#2291' }],
    outputs: [
      { token: '{{data.status}}', label: 'حالة الأمر' },
      { token: '{{data.expected_date}}', label: 'تاريخ التسليم المتوقع' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'أمر البيع رقم {{filters.order_no}} حالياً: {{data.status}}، التسليم المتوقع {{data.expected_date}}.' },
      { key: 'not_found', label: 'الرقم غير موجود', template: 'لم يتم العثور على أمر بيع بالرقم {{filters.order_no}}.' },
    ],
    example: { command: 'حالة', rendered: 'أمر البيع رقم 2291 حالياً: قيد التجهيز، التسليم المتوقع 10/09/2026.' },
    suggestedCommands: ['حالة الطلب', 'حالة أمر'],
  },
  'نسخة عرض سعر': {
    partyType: 'العميل، مستخدم أو مندوب',
    description: 'يعيد إرسال نسخة من عرض سعر سابق للعميل.',
    whenToUse: 'عند طلب العميل نسخة من عرض السعر المرسل له مسبقاً.',
    inputs: [
      { token: '#اسم_العميل', label: 'اسم العميل', example: '#عميل_تجريبي' },
      { token: '#رقم_العرض', label: 'رقم العرض (اختياري)', example: '#771' },
    ],
    outputs: [
      { token: '{{data.quote_no}}', label: 'رقم العرض' },
      { token: '{{data.amount}}', label: 'قيمة العرض' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'عرض السعر رقم {{data.quote_no}} بقيمة {{data.amount}}، صالح حتى {{data.valid_until}}.' },
      { key: 'expired', label: 'العرض منتهي الصلاحية', template: 'عرض السعر المطلوب منتهي الصلاحية، يرجى طلب عرض جديد.' },
    ],
    example: { command: 'عرض سعر', rendered: 'عرض السعر رقم 771 بقيمة 8,900.00 ر.س، صالح حتى 20/09/2026.' },
    suggestedCommands: ['عرض سعر', 'نسخة العرض'],
  },
  'سندات القبض اليومية': {
    description: 'ملخص سندات القبض المسجّلة خلال اليوم.',
    whenToUse: 'لمراجعة المحصّل يومياً من قبل المحاسب أو المدير.',
    inputs: [{ token: '#التاريخ', label: 'التاريخ (اختياري، اليوم افتراضياً)', example: '#07/09/2026' }],
    outputs: [
      { token: '{{data.count}}', label: 'عدد السندات' },
      { token: '{{data.total}}', label: 'إجمالي المحصّل' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'سندات القبض اليوم: {{data.count}} سنداً بإجمالي {{data.total}}.' },
      { key: 'no_receipts', label: 'لا توجد سندات اليوم', template: 'لم يتم تسجيل أي سندات قبض اليوم حتى الآن.' },
    ],
    example: { command: 'سندات اليوم', rendered: 'سندات القبض اليوم: 14 سنداً بإجمالي 96,300.00 ر.س.' },
    suggestedCommands: ['سندات اليوم', 'قبض اليوم'],
  },
  'مبيعات اليوم': {
    description: 'إجمالي مبيعات اليوم الحالي مقارنة بالمتوسط.',
    whenToUse: 'تقرير صباحي أو مسائي سريع لمتابعة الأداء اليومي.',
    inputs: [{ token: '#الفرع', label: 'الفرع (اختياري)', example: '#الفرع_الرئيسي' }],
    outputs: [
      { token: '{{data.total}}', label: 'إجمالي المبيعات' },
      { token: '{{data.invoices_count}}', label: 'عدد الفواتير' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'مبيعات اليوم: {{data.total}} عبر {{data.invoices_count}} فاتورة.' },
      { key: 'no_sales', label: 'لا مبيعات مسجلة اليوم', template: 'لم تُسجَّل أي مبيعات اليوم حتى الآن.' },
    ],
    example: { command: 'مبيعات', rendered: 'مبيعات اليوم: 42,150.00 ر.س عبر 27 فاتورة.' },
    suggestedCommands: ['مبيعات', 'مبيعات اليوم'],
  },
  'أعلى المنتجات': {
    description: 'أعلى المنتجات مبيعاً خلال فترة محددة.',
    whenToUse: 'لمتابعة أداء المنتجات دون فتح تقارير النظام.',
    inputs: [
      { token: '#بداية_الفترة', label: 'بداية الفترة', example: '#01/08/2026' },
      { token: '#نهاية_الفترة', label: 'نهاية الفترة', example: '#07/09/2026' },
      { token: '#عدد_المنتجات', label: 'عدد المنتجات (اختياري)', example: '#3' },
    ],
    outputs: [{ token: '{{data.items}}', label: 'المنتجات والكميات' }],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'أعلى المنتجات من {{filters.from_date}} إلى {{filters.to_date}}: {{data.items}}.' },
      { key: 'no_data', label: 'لا بيانات للفترة', template: 'لا توجد بيانات مبيعات للفترة المطلوبة.' },
    ],
    example: { command: 'اعلى المنتجات', rendered: 'أعلى 3 منتجات هذا الشهر: شاشة 24 (120)، لوحة مفاتيح (98)، ماوس لاسلكي (85).' },
    suggestedCommands: ['اعلى المنتجات', 'الاكثر مبيعا'],
  },
  'مصروفات الشهر': {
    description: 'إجمالي مصروفات الشهر الحالي موزّعة على البنود الرئيسية.',
    whenToUse: 'تقرير شهري للإدارة لمتابعة المصروفات.',
    inputs: [{ token: '#الشهر', label: 'الشهر (اختياري)', example: '#سبتمبر' }],
    outputs: [
      { token: '{{data.total}}', label: 'إجمالي المصروفات' },
      { token: '{{data.by_category}}', label: 'التوزيع حسب البند' },
    ],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'مصروفات {{filters.month}} حتى الآن: {{data.total}} — {{data.by_category}}.' },
      { key: 'no_data', label: 'لا بيانات', template: 'لا توجد مصروفات مسجّلة لهذا الشهر حتى الآن.' },
    ],
    example: { command: 'مصروفات', rendered: 'مصروفات سبتمبر حتى الآن: 58,200.00 ر.س — رواتب 34,000، إيجار 12,000، أخرى 12,200.' },
    suggestedCommands: ['مصروفات', 'مصروفات الشهر'],
  },
  'مقارنة الفروع': {
    description: 'يقارن أداء المبيعات بين الفروع خلال فترة محددة.',
    whenToUse: 'للإدارة عند تقييم أداء الفروع مقابل بعضها.',
    inputs: [
      { token: '#بداية_الفترة', label: 'بداية الفترة', example: '#01/08/2026' },
      { token: '#نهاية_الفترة', label: 'نهاية الفترة', example: '#07/09/2026' },
    ],
    outputs: [{ token: '{{data.branches}}', label: 'مبيعات كل فرع' }],
    options: [
      { key: 'success', label: 'رسالة النجاح', template: 'مبيعات الفروع من {{filters.from_date}} إلى {{filters.to_date}}: {{data.branches}}.' },
      { key: 'single_branch', label: 'فرع واحد فقط مفعّل', template: 'يوجد فرع واحد نشط فقط، لا مقارنة متاحة.' },
    ],
    example: { command: 'مقارنة الفروع', rendered: 'مبيعات الفرع الرئيسي: 210,000.00 ر.س، فرع جدة: 96,400.00 ر.س.' },
    suggestedCommands: ['مقارنة الفروع', 'اداء الفروع'],
  },
};


const LINK_MAP = [
  ['العميل', 'Customer'], ['المورد', 'Supplier'], ['الموظف', 'Employee'],
  ['السنة', 'Fiscal Year'], ['العملة', 'Currency'], ['الفرع', 'Branch'],
  ['البنك', 'Bank'], ['المنتج', 'Item'], ['الصنف', 'Item'], ['المستودع', 'Warehouse'],
];
function fieldMetaOf(inp) {
  const tok = inp.token || '';
  for (let i = 0; i < LINK_MAP.length; i++) {
    if (tok.indexOf(LINK_MAP[i][0]) !== -1) {
      const link = LINK_MAP[i][1];
      const partyAr = { Customer: 'العميل', Supplier: 'المورد', Employee: 'الموظف' }[link];
      return {
        fieldType: 'Link', linkTo: link, isStandard: !!partyAr,
        condition: partyAr
          ? 'يظهر فقط عندما نوع الجهة «مستخدم» أو «مندوب»، ويكون إلزامياً. أما إذا كان نوع الجهة «' + partyAr.replace('ال', '') + '» فلا يُمرَّر لأن ' + partyAr + ' يُعرَف من جهة الاتصال نفسها.'
          : '',
      };
    }
  }
  if (tok.indexOf('تاريخ') !== -1) return { fieldType: 'Date', linkTo: '' };
  if (tok.indexOf('الشهر') !== -1) return { fieldType: 'Data', linkTo: '' };
  return { fieldType: 'Data', linkTo: '' };
}


const OUT_COND = {
  'رسالة الرصيد': 'عند وجود حركة على الحساب خلال الفترة المطلوبة',
  'مستند كشف الحساب': 'عند تفعيل خيار «إرفاق مستند الكشف (PDF)»',
  'رسالة الحساب مجمد': 'عندما يكون الحساب مجمداً في الأستاذ المساعد',
};
function outMetaOf(o) {
  if (o.name && OUT_COND[o.name]) return { condition: OUT_COND[o.name], conditional: true };
  if (o.key === 'success') return { condition: 'الحالة الافتراضية عند نجاح التنفيذ', conditional: false };
  if (o.label) return { condition: 'عند حالة: ' + o.label, conditional: true };
  return { condition: '', conditional: false };
}


function changelogOf(major, minor, currentVersionDate, latestVersion, latestVersionDate, needsUpdate) {
  const CH = ["تحسين أداء تنفيذ الدالة وتقليل زمن الاستجابة.","إضافة دعم تمرير العملة في نص الأمر.","إصلاح احتساب الرصيد عند وجود حركات في سنوات سابقة.","إضافة خيار إرفاق مستند الكشف بصيغة PDF.","تحسين صياغة الرسالة وترتيب الحقول.","دعم الحسابات المجمدة برسالة مخصصة.","إصلاح تنسيق التواريخ في الرسالة المرسلة.","إضافة تحقق من صلاحية المستخدم قبل التنفيذ."];
  const log = [];
  if (needsUpdate) {
    log.push({ version: latestVersion, date: latestVersionDate, current: false, latest: true, changes: [CH[int(0, CH.length - 1)], CH[int(0, CH.length - 1)]].filter((x, i, a) => a.indexOf(x) === i) });
  }
  let mn = minor;
  let d = currentVersionDate;
  for (let k = 0; k < 3 && mn >= 0; k++) {
    log.push({
      version: 'v' + major + '.' + mn + '.0', date: d, current: k === 0, latest: !needsUpdate && k === 0,
      changes: [CH[int(0, CH.length - 1)], CH[int(0, CH.length - 1)]].filter((x, i, a) => a.indexOf(x) === i),
    });
    mn -= 1;
    d -= int(25, 120) * DAY;
  }
  return log;
}

const fnCats = [['كشوف الحسابات', ['كشف حساب عميل', 'كشف حساب مورد', 'كشف حساب موظف', 'أعمار الديون']], ['الأرصدة', ['رصيد الصناديق', 'رصيد البنوك', 'رصيد المخزون', 'أرصدة العملاء']], ['المستندات', ['آخر فاتورة بيع', 'حالة أمر بيع', 'نسخة عرض سعر', 'سندات القبض اليومية']], ['التقارير', ['مبيعات اليوم', 'أعلى المنتجات', 'مصروفات الشهر', 'مقارنة الفروع']]];
fnCats.forEach(([cat, list], ci) => list.forEach((name, i) => {
  const meta = FN_META[name] || {};
  const major = int(1, 3), minor = int(0, 6);
  const currentVersion = 'v' + major + '.' + minor + '.0';
  const needsUpdate = r() > 0.55;
  const latestVersion = needsUpdate ? 'v' + major + '.' + (minor + int(1, 4)) + '.0' : currentVersion;
  const currentVersionDate = NOW - int(20, 260) * DAY;
  const latestVersionDate = needsUpdate ? NOW - int(0, 18) * DAY : currentVersionDate;
  functions.push({
    id: 'f' + ci + i, name, category: cat,
    version: currentVersion, currentVersion, latestVersion,
    currentVersionDate, latestVersionDate, needsUpdate,
    installed: r() > 0.35,
    calls30d: int(0, 1800), status: r() > 0.12 ? 'active' : 'inactive', avgMs: int(120, 2400),
    partyType: meta.partyType || 'عام (لا يخص جهة محددة)', description: meta.description || '', whenToUse: meta.whenToUse || '',
    inputs: (meta.inputs || []).map((inp) => ({ ...inp, ...fieldMetaOf(inp) })), outputs: meta.outputs || [], options: (meta.options || []).map((o) => ({ ...o, ...outMetaOf(o) })), settings: meta.settings || [],
    example: meta.example || null, suggestedCommands: meta.suggestedCommands || [],
    changelog: changelogOf(major, minor, currentVersionDate, latestVersion, latestVersionDate, needsUpdate),
  });
}));


const commands = [];
[['كشف', 'كشف حساب عميل'], ['رصيد', 'رصيد الصناديق'], ['فاتورة', 'آخر فاتورة بيع'], ['مبيعات', 'مبيعات اليوم'], ['حالة', 'حالة أمر بيع'], ['ديون', 'أعمار الديون'], ['مخزون', 'رصيد المخزون'], ['مساعدة', 'مبيعات اليوم']].forEach(([code, fn], i) => {
  commands.push({ id: 'cm' + (i + 1), code, synonyms: [code + ' حسابي', 'ال' + code], fn, status: r() > 0.15 ? 'active' : 'inactive', runs30d: int(0, 940), allowedTypes: ['customer', 'supplier'], requiresLink: true });
});

const messages = [];
let mid = 1;
for (let i = 0; i < 22000; i++) {
  // توزيع شبه منتظم على ٩٢ يوماً مع نموّ خفيف (~٩٪ شهرياً) وهدوء في نهاية الأسبوع
  const ageDays = int(0, 91);
  if (r() < (ageDays / 92) * 0.18) continue;
  const ts = NOW - ageDays * DAY - int(0, 20) * 3600000 - int(0, 59) * 60000;
  const dow = new Date(ts).getDay();
  if ((dow === 5 || dow === 6) && r() < 0.45) continue;
  const contact = pick(contacts);
  /* جهات بلا وارد مسجّل: تُستخدم لسياسة «لا ترسل إلا لمن لدينا منه وارد» */
  const direction = contact.noInbound ? 'out' : (r() > 0.26 ? 'out' : 'in');
  const device = wpick([[devices[0], 46], [devices[1], 18], [devices[2], 6], [devices[3], 30]]);
  let status;
  if (direction === 'in') status = 'read';
  else if (ageDays === 0) status = wpick([['read', 30], ['delivered', 22], ['sent', 14], ['queued', 20], ['failed', 8], ['unsent', 4], ['cancelled', 2]]);
  else status = wpick([['read', 52], ['delivered', 22], ['sent', 12], ['failed', 8], ['cancelled', 3], ['queued', 3]]);
  const docType = pick(DOC_TYPES);
  const err = status === 'failed'
    ? wpick([['recipient_not_registered', 214], ['device_disconnected', 148], ['timeout', 74], ['platform_rejected', 51], ['invalid_template', 28], ['insufficient_balance', 12]])
    : null;
  messages.push({
    id: 'm' + (mid++), ts, direction, status, docType, error: err,
    contactId: contact.id, deviceId: device.id,
    campaignId: r() > 0.72 ? pick(campaigns).id : null,
    templateId: r() > 0.4 ? pick(templates).id : null,
    docNo: docType.slice(0, 2) + '-' + int(1000, 9999),
    amount: Math.round(r() * 48000 + 200),
    body: pick(bodies),
    attempts: status === 'failed' ? int(1, 3) : 1,
    kind: wpick([['text', 58], ['document', 30], ['image', 12]]),
  });
}
/* حملة مجدولة لم تبدأ: كل صادرها مجدول بموعدها، بلا سجل إرسال سابق */
forcedScheduled.forEach((cid) => {
  const c = campaigns.find((x) => x.id === cid);
  if (!c) return;
  messages.forEach((m) => { if (m.campaignId === cid) { m.status = 'unsent'; m.error = null; m.attempts = 0; m.ts = c.startAt; m.scheduledAt = c.startAt; m.deviceId = c.deviceId; } });
});

/* رسائل مجدولة لم تُرسل بعد: موعد إرسال مستقبلي */
messages.forEach((m) => {
  if (m.direction !== 'out' || m.campaignId || m.status !== 'queued' || r() > 0.22) return;
  m.status = 'unsent';
  m.scheduledAt = NOW + int(1, 96) * 3600000;
  m.attempts = 0;
  m.error = null;
});

/* رسائل اختبار أُرسلت من صندوق الاختبار */
messages.forEach((m) => {
  if (m.direction !== 'out' || m.campaignId || r() > 0.06) return;
  m.sandbox = true;
});

const PRINT_TPLS = ['Customer Ledger A4', 'Invoice A4 — عربي', 'Quotation A4', 'Receipt Voucher 80mm', 'Statement A4 — مختصر'];
messages.forEach((m) => { if (m.kind === 'document') m.printTpl = pick(PRINT_TPLS); });

/* بعض الرسائل الصادرة ردّ آلي على واردة: أمر + دالة */
const FREE_INBOUND = ['ابغى كشف حساب لو سمحت', 'كم رصيدي الحالي؟', 'وصلتني الفاتورة لكن المبلغ غير مطابق', 'متى يوصل الطلب؟', 'ممكن نسخة من العرض؟', 'السلام عليكم، عندي استفسار'];
messages.forEach((m) => {
  if (m.direction !== 'out' || m.campaignId || r() > 0.45) return;
  m.triggerTs = m.ts - int(4, 95) * 1000;
  m.triggerId = 'i' + String(m.id).slice(1);
  if (r() > 0.35) {
    const cm = pick(commands);
    m.triggerKind = 'command';
    m.commandId = cm.id;
    m.triggerText = r() > 0.5 ? cm.code : pick(cm.synonyms);
  } else {
    m.triggerKind = 'reply';
    m.commandId = null;
    m.triggerText = pick(FREE_INBOUND);
    m.triggerTs = m.ts - int(2, 40) * 60000;
  }
});
messages.sort((a, b) => b.ts - a.ts);

const incoming = messages.filter((m) => m.direction === 'in').map((m, i) => ({
  ...m,
  matchedCommand: r() > 0.35 ? pick(commands).id : null,
  text: r() > 0.35 ? pick(commands).code : pick(['السلام عليكم', 'وش الجديد؟', 'ابغى كشف حساب', 'شكراً لكم', 'كم رصيدي؟']),
}));

const activity = [];
[['فُصل جهاز «فرع جدة» — Disconnected', 'danger', 42 * 60000], ['أوقف عبدالله الفهد الطابور', 'warn', 12 * 60000], ['اكتملت حملة «تذكير مستحقات سبتمبر»', 'primary', 3600000], ['نُفّذ أمر «كشف حساب عميل» لمؤسسة المطلق للتجارة', 'info', 2 * 3600000], ['حُدّثت دالة «كشف حساب مورد» إلى v2.4.0', 'purple', 26 * 3600000], ['أُضيف جهاز «الدعم الفني» واقترن بنجاح', 'primary', 3 * DAY], ['تم شحن المحفظة بمبلغ 500.00 ر.س', 'info', 4 * DAY], ['أُلغيت 41 رسالة يدوياً من الطابور', 'muted', 5 * DAY], ['تجاوز استهلاك الباقة 70% من الحد الشهري', 'warn', 6 * DAY]].forEach(([text, tone, ago], i) => activity.push({ id: 'a' + i, text, tone, ts: NOW - ago }));

const queue = { paused: true, pausedSince: NOW - 12 * 60000, pausedBy: 'عبدالله الفهد', reason: 'تجنّب الحظر أثناء اختبار الحملة', rate: 24 };

const cycleStart = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), 1).getTime();

/* ————— أرقام واتساب جرت معها محادثة ولا سجل لها كجهة اتصال في النظام ————— */
const WA_NAMES = ['أبو ريان', 'محمد — مقاول', 'Ahmed Store', 'ورشة الشرق', 'سعود', 'عبير — مشتريات', 'Delivery Fast', 'أم عبدالله', 'خالد الدوسري', 'مؤسسة الندى', 'Ali Mobile', 'صيدلية الحياة', 'بدر', 'مطبعة الرواد', 'فهد — سباك', 'نايف العمري', 'Sara', 'مكتب العقار', 'محمد نور', 'توصيل الرياض', 'أبو يوسف', 'ليان', 'مستودع التمور', 'حسن — كهربائي'];
const waUnregistered = [];
for (let i = 0; i < WA_NAMES.length; i++) {
  const inCount = int(1, 34);
  const isGroup = i % 11 === 3;
  waUnregistered.push({
    id: 'wa' + (i + 1),
    phone: isGroup ? '12036304' + int(10000000, 99999999) + '@g.us' : '+9665' + int(0, 6) + ' ' + int(100, 999) + ' ' + int(1000, 9999),
    waName: i % 7 === 2 ? '' : WA_NAMES[i],
    inCount,
    outCount: int(0, inCount),
    lastTs: NOW - int(0, 40) * DAY - int(0, 20) * 3600000,
    deviceId: pick(devices).id,
    contactId: null,
  });
}

const subscription = {
  plan: 'الأعمال 6K', quota: 6000,
  used: messages.filter((m) => m.direction === 'out' && m.ts >= cycleStart && ['sent', 'delivered', 'read', 'failed'].includes(m.status)).length,
  wallet: 742.5, pricePerMessage: 0.11,
  renewAt: new Date('2026-10-01T00:00:00+03:00').getTime(), autoRenew: true, renewAmount: 660, cycleStart,
};

/* المنشأة صاحبة الحساب */
const company = {
  name: 'شركة مسار للتجارة والتوزيع',
  short: 'مسار',
  crn: '1010447392',
  branch: 'الفرع الرئيسي — الرياض',
  activatedAt: NOW - 94 * DAY,
  user: { name: 'عبدالله الفهد', role: 'مدير الحسابات', initials: 'ع ف' },
};

const setup = [
  { id: 's1', label: 'بيانات اعتماد المنصة', note: 'مفتاح العميل ومفتاح API والسر — مكتملة', done: true },
  { id: 's2', label: 'إنشاء جهاز', note: '4 أجهزة مُنشأة', done: true },
  { id: 's3', label: 'مسح الباركود', note: '3 أجهزة مقترنة', done: true },
  { id: 's4', label: 'تفعيل الويب هوك', note: 'بدون هذه الخطوة لا تصل الرسائل الواردة ولا تحديثات الحالة.', done: false },
];

/* ————— محدّدات (كل رقم في الواجهة يخرج من هنا) ————— */
const RANGES = { today: 'اليوم', week: 'الأسبوع', month: 'الشهر', year: 'السنة' };
function rangeStart(range, now = NOW) {
  if (range === 'today') return now - DAY;
  if (range === 'week') return now - 7 * DAY;
  if (range === 'month') return now - 30 * DAY;
  return now - 365 * DAY;
}
const inRange = (m, range) => m.ts >= rangeStart(range);
const onDev = (m, deviceId) => !deviceId || m.deviceId === deviceId;

function kpis(range, deviceId = null) {
  const cur = messages.filter((m) => m.direction === 'out' && inRange(m, range) && onDev(m, deviceId));
  const prevFrom = rangeStart(range) - (NOW - rangeStart(range));
  const prev = messages.filter((m) => m.direction === 'out' && m.ts >= prevFrom && m.ts < rangeStart(range) && onDev(m, deviceId));
  const count = (arr, s) => arr.filter((m) => m.status === s).length;
  const sentLike = (arr) => arr.filter((m) => ['sent', 'delivered', 'read', 'failed'].includes(m.status)).length;
  const total = sentLike(cur), totalPrev = sentLike(prev);
  const delivered = count(cur, 'delivered') + count(cur, 'read');
  const read = count(cur, 'read');
  const failed = count(cur, 'failed');
  const failedPrev = count(prev, 'failed');
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);
  return {
    total, delivered, read, failed,
    queued: count(cur, 'queued'), cancelled: count(cur, 'cancelled'), unsent: count(cur, 'unsent'),
    deltaTotal: pct(total, totalPrev),
    deliveredRate: total ? (delivered / total) * 100 : 0,
    readRate: total ? (read / total) * 100 : 0,
    failRate: total ? (failed / total) * 100 : 0,
    failRatePrev: totalPrev ? (failedPrev / totalPrev) * 100 : 0,
  };
}

function volumeSeries(range, deviceId = null) {
  const buckets = [];
  const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  let n, size, label;
  if (range === 'today') { n = 8; size = 3600000 * 3; label = (d) => String(d.getHours()).padStart(2, '0') + ':00'; }
  else if (range === 'week') { n = 7; size = DAY; label = (d) => dayNames[d.getDay()]; }
  else if (range === 'month') { n = 10; size = 3 * DAY; label = (d) => d.getDate() + '/' + (d.getMonth() + 1); }
  else { n = 12; size = 30 * DAY; label = (d) => monthNames[d.getMonth()]; }
  const end = NOW;
  for (let i = n - 1; i >= 0; i--) {
    const from = end - (i + 1) * size, to = end - i * size;
    const slice = messages.filter((m) => m.direction === 'out' && m.ts >= from && m.ts < to && onDev(m, deviceId));
    const parts = { read: 0, delivered: 0, sent: 0, queued: 0, failed: 0 };
    slice.forEach((m) => { if (parts[m.status] !== undefined) parts[m.status]++; });
    buckets.push({ label: label(new Date(to - size / 2)), parts, total: slice.length, from, to });
  }
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return { buckets, max };
}

function failureBreakdown(range, deviceId = null) {
  const out = {};
  messages.filter((m) => m.direction === 'out' && m.status === 'failed' && inRange(m, range) && onDev(m, deviceId)).forEach((m) => { out[m.error] = (out[m.error] || 0) + 1; });
  return Object.keys(out).map((k) => ({ code: k, label: ERRORS[k].ar, count: out[k] })).sort((a, b) => b.count - a.count);
}

function docTypeBreakdown(range, deviceId = null) {
  const out = {};
  messages.filter((m) => m.direction === 'out' && inRange(m, range) && onDev(m, deviceId)).forEach((m) => { out[m.docType] = (out[m.docType] || 0) + 1; });
  const rows = Object.keys(out).map((k) => ({ type: k, count: out[k] })).sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((x) => x.count));
  return rows.map((x) => ({ ...x, pct: (x.count / max) * 100 }));
}

function deviceHealth() {
  const connected = devices.filter((d) => d.status === 'connected').length;
  return { connected, total: devices.length, disconnected: devices.filter((d) => d.status === 'disconnected').length, pending: devices.filter((d) => d.status === 'pending').length };
}

function pendingQueueCount() {
  return messages.filter((m) => m.direction === 'out' && (m.status === 'queued' || m.status === 'unsent')).length;
}

function costOf(range, deviceId = null) {
  const n = messages.filter((m) => m.direction === 'out' && inRange(m, range) && onDev(m, deviceId)
    && ['sent', 'delivered', 'read', 'failed'].includes(m.status)).length;
  return n * subscription.pricePerMessage;
}

/* سلاسل مصغّرة (sparkline) لكل مؤشر — ١٢ نقطة على نفس الفترة */
function sparkSeries(range, deviceId = null, n = 12) {
  const span = NOW - rangeStart(range);
  const size = span / n;
  const out = { total: [], delivered: [], read: [], failed: [], queued: [], inbound: [], cost: [] };
  for (let i = n - 1; i >= 0; i--) {
    const from = NOW - (i + 1) * size, to = NOW - i * size;
    const slice = messages.filter((m) => m.ts >= from && m.ts < to && onDev(m, deviceId));
    const o = slice.filter((m) => m.direction === 'out');
    const sent = o.filter((m) => ['sent', 'delivered', 'read', 'failed'].includes(m.status)).length;
    out.total.push(sent);
    out.delivered.push(o.filter((m) => m.status === 'delivered' || m.status === 'read').length);
    out.read.push(o.filter((m) => m.status === 'read').length);
    out.failed.push(o.filter((m) => m.status === 'failed').length);
    out.queued.push(o.filter((m) => m.status === 'queued' || m.status === 'unsent').length);
    out.inbound.push(slice.filter((m) => m.direction === 'in').length);
    out.cost.push(+(sent * subscription.pricePerMessage).toFixed(2));
  }
  return out;
}

/* الوارد الذي لم يطابقه أمر ولم يُردّ عليه آلياً */
function inboxPending() {
  const rows = incoming.filter((m) => !m.matchedCommand && m.ts >= NOW - 3 * DAY).sort((a, b) => a.ts - b.ts);
  return { count: rows.length, oldest: rows.length ? rows[0].ts : null, rows: rows.slice(-12).reverse() };
}

/* التدفق المباشر: أحدث الحركات صادرة وواردة */
function liveFeed(n = 8) {
  return messages.slice(0, 400).sort((a, b) => b.ts - a.ts).slice(0, n);
}

function contactById(id) { return contacts.find((c) => c.id === id); }
function deviceById(id) { return devices.find((d) => d.id === id); }

function queryMessages({ direction = 'out', status = null, error = null, deviceId = null, contactId = null, docType = null, search = '', range = 'month', sort = 'ts_desc', page = 1, perPage = 12, from = null, to = null, source = null, commandId = null, campaignId = null, linked = null } = {}) {
  let rows = messages.filter((m) => (direction === 'all' ? true : m.direction === direction));
  if (from && to) rows = rows.filter((m) => m.ts >= from && m.ts < to);
  else rows = rows.filter((m) => inRange(m, range));
  if (status) rows = rows.filter((m) => m.status === status);
  if (error) rows = rows.filter((m) => m.error === error);
  if (deviceId) rows = rows.filter((m) => m.deviceId === deviceId);
  if (contactId) rows = rows.filter((m) => m.contactId === contactId);
  if (docType) rows = rows.filter((m) => m.docType === docType);
  if (commandId === 'none') rows = rows.filter((m) => !m.commandId);
  else if (commandId) rows = rows.filter((m) => m.commandId === commandId);
  if (campaignId === 'none') rows = rows.filter((m) => !m.campaignId);
  else if (campaignId) rows = rows.filter((m) => m.campaignId === campaignId);
  if (linked === 'yes') rows = rows.filter((m) => !!m.triggerText);
  else if (linked === 'no') rows = rows.filter((m) => !m.triggerText);
  if (source === 'sandbox') rows = rows.filter((m) => !!m.sandbox);
  else if (source === 'live') rows = rows.filter((m) => !m.sandbox);
  if (search) {
    const q = search.trim();
    rows = rows.filter((m) => {
      const c = contactById(m.contactId);
      return (c && ((c.name || '').includes(q) || c.phone.includes(q))) || m.docNo.includes(q) || m.body.includes(q);
    });
  }
  const [key, dir] = sort.split('_');
  rows = rows.slice().sort((a, b) => {
    const av = key === 'amount' ? a.amount : a.ts, bv = key === 'amount' ? b.amount : b.ts;
    return dir === 'asc' ? av - bv : bv - av;
  });
  const totalRows = rows.length, pages = Math.max(1, Math.ceil(totalRows / perPage));
  const p = Math.min(page, pages);
  return { rows: rows.slice((p - 1) * perPage, p * perPage), totalRows, pages, page: p };
}

/* ————— كتابة: كل إنشاء يظهر فوراً في بقية الشاشات ————— */
function addMessage(m) {
  const rec = { id: 'm' + (mid++), ts: Date.now(), direction: 'out', status: 'queued', attempts: 1, ...m };
  messages.unshift(rec);
  return rec;
}
function retryMessage(id) {
  const m = messages.find((x) => x.id === id);
  if (!m) return null;
  m.status = 'queued'; m.error = null; m.attempts++; m.ts = Date.now();
  return m;
}
function setQueuePaused(v, by) {
  queue.paused = v;
  queue.pausedSince = v ? Date.now() : null;
  if (v) queue.pausedBy = by || queue.pausedBy;
}
// تقدّم تلقائي للحالات: queued → sent → delivered → read
function advanceQueue(n = 3) {
  if (queue.paused) return 0;
  let moved = 0;
  for (const m of messages) {
    if (moved >= n) break;
    if (m.direction !== 'out') continue;
    if (m.status === 'queued') { m.status = 'sent'; moved++; }
    else if (m.status === 'sent' && Math.random() > 0.5) { m.status = 'delivered'; moved++; }
    else if (m.status === 'delivered' && Math.random() > 0.75) { m.status = 'read'; moved++; }
  }
  return moved;
}

function logActivity(text, tone = 'info') {
  activity.unshift({ id: 'a' + Date.now(), text, tone, ts: Date.now() });
}

const fmt = {
  n: (v) => (v == null ? '—' : Number(Math.round(v)).toLocaleString('en-US')),
  money: (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%',
  date: (ts) => new Date(ts).toISOString().slice(0, 10),
  hour12: false,
  setHour12: (v) => { fmt.hour12 = !!v; },
  time: (ts) => {
    const d = new Date(ts);
    const p2 = (x) => String(x).padStart(2, '0');
    if (!fmt.hour12) return p2(d.getHours()) + ':' + p2(d.getMinutes());
    const h = d.getHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return p2(h12) + ':' + p2(d.getMinutes()) + (h < 12 ? ' ص' : ' م');
  },
  ago: (ts) => {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'قبل ' + s + ' ثانية';
    const m = Math.round(s / 60);
    if (m < 60) return 'قبل ' + m + ' دقيقة';
    const h = Math.round(m / 60);
    if (h < 24) return 'قبل ' + h + ' ساعة';
    const d = Math.round(h / 24);
    return d === 1 ? 'أمس' : 'قبل ' + d + ' يوماً';
  },
};

window.HubData = {NOW, STATUS, ERRORS, PARTY_TYPES, PARTY_FILTERS, CONTACT_GROUPS, contactGroups, msgTemplates, DOC_TYPES, devices, contacts, waUnregistered, campaigns, templates, functions, commands, messages, incoming, activity, queue, subscription, setup, RANGES, rangeStart, kpis, volumeSeries, failureBreakdown, docTypeBreakdown, deviceHealth, pendingQueueCount, company, costOf, sparkSeries, inboxPending, liveFeed, contactById, deviceById, queryMessages, addMessage, retryMessage, setQueuePaused, advanceQueue, logActivity, fmt};
})();
