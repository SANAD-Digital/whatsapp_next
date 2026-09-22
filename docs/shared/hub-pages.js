/* سجلّ صفحات المركز: المسار ← الملف المستقل. تُحمَّل عالمياً باسم window.HubPages */
(function () {
  const list = [
    { key: 'home', route: '/', label: 'الرئيسية', file: 'Hub Page - Home.dc.html', desc: 'لوحة المراقبة: صحة الأجهزة، مؤشرات الإرسال، وآخر النشاط.' },
    { key: 'devices', route: '/devices', label: 'الأجهزة', file: 'Hub Page - Devices.dc.html', desc: 'الأجهزة المربوطة وحالتها وربط جهاز جديد.' },
    { key: 'outbound', route: '/messages/outbound', label: 'الرسائل الصادرة', file: 'Hub Page - Outbound.dc.html', desc: 'سجل الرسائل الصادرة مع الفلاتر والتفاصيل.' },
    { key: 'inbound', route: '/messages/inbound', label: 'الرسائل الواردة', file: 'Hub Page - Inbound.dc.html', desc: 'الرسائل الواردة ومطابقتها مع الأوامر.' },
    { key: 'all', route: '/messages/all', label: 'كل الرسائل', file: 'Hub Page - All Messages.dc.html', desc: 'عرض موحّد للصادر والوارد.' },
    { key: 'queue', route: '/messages/queue', label: 'الطابور', file: 'Hub Page - Queue.dc.html', desc: 'الرسائل المعلّقة ومعدّل الإرسال.' },
    { key: 'templates', route: '/templates', label: 'نماذج الإشعارات', file: 'Hub Page - Notification Templates.dc.html', desc: 'نماذج الإشعارات المرتبطة بالمستندات.' },
    { key: 'msgTemplates', route: '/msg-templates', label: 'نماذج الرسائل', file: 'Hub Page - Message Templates.dc.html', desc: 'نماذج الرسائل الجاهزة للإرسال.' },
    { key: 'commands', route: '/commands', label: 'الأوامر', file: 'Hub Page - Commands.dc.html', desc: 'الأوامر النصية ومرادفاتها وربطها بالدوال.' },
    { key: 'functions', route: '/functions', label: 'مركز الدوال', file: 'Hub Page - Functions.dc.html', desc: 'الدوال المتاحة ومعاينتها.' },
    { key: 'send', route: '/send', label: 'محاكي الواتساب', file: 'Hub Page - WhatsApp Simulator.dc.html', desc: 'إرسال رسالة لمجموعة أو جهات محددة أو أرقام يدوية.' },
    { key: 'campaigns', route: '/campaigns', label: 'الحملات', file: 'Hub Page - Campaigns.dc.html', desc: 'حملات الإرسال الجماعي ومتابعتها.' },
    { key: 'contacts', route: '/contacts', label: 'جهات الاتصال', file: 'Hub Page - Contacts.dc.html', desc: 'جهات الاتصال وربطها بالحسابات.' },
    { key: 'waContacts', route: '/wa-contacts', label: 'جهات اتصال الواتس', file: 'Hub Page - WhatsApp Contacts.dc.html', desc: 'جهات اتصال الواتساب كما تظهر في دليل الجهاز.' },
    { key: 'groups', route: '/groups', label: 'مجموعات جهات الاتصال', file: 'Hub Page - Contact Groups.dc.html', desc: 'مجموعات جهات الاتصال للاستهداف.' },
    { key: 'billing', route: '/billing', label: 'الاشتراك والباقة', file: 'Hub Page - Billing.dc.html', desc: 'الباقة والاستهلاك والفواتير.' },
    { key: 'settings', route: '/settings', label: 'الإعدادات', file: 'Hub Page - Settings.dc.html', desc: 'إعدادات المنصة والمفاتيح والصلاحيات.' },
    { key: 'demo', route: '/demo', label: 'وضع العرض التجريبي', file: 'Hub Page - Demo.dc.html', desc: 'تبديل حالات العرض (تحميل، فارغ، خطأ، عدم اتصال).' },
  ];
  const byKey = {}, byRoute = {};
  list.forEach((p) => { byKey[p.key] = p; byRoute[p.route] = p; });
  byKey.msgs = byKey.outbound;
  window.HubPages = {
    list, byKey, byRoute,
    href: (keyOrRoute) => { const p = byKey[keyOrRoute] || byRoute[keyOrRoute]; return p ? encodeURI(p.file) : null; },
    go: (keyOrRoute, filter) => {
      const p = byKey[keyOrRoute] || byRoute[keyOrRoute];
      if (!p) return false;
      try { if (filter) sessionStorage.setItem('hub.filter', JSON.stringify({ route: p.route, filter })); } catch (e) {}
      location.href = encodeURI(p.file);
      return true;
    },
  };
})();
