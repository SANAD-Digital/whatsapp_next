/* مشترك بين شاشات المركز — تنسيقات وأدوات لا تخص شاشة واحدة. window.HubShared */
(function () {
  const statusTone = (s) => ({
    connected: { bg: 'var(--ok-s)', fg: 'var(--ok-i)', dot: 'var(--ok)', text: 'متصل' },
    disconnected: { bg: 'var(--dg-s)', fg: 'var(--dg-i)', dot: 'var(--dg)', text: 'غير متصل' },
    pending: { bg: 'var(--wn-s)', fg: 'var(--wn-i)', dot: 'var(--wn)', text: 'بانتظار الاقتران' },
  })[s] || { bg: 'var(--sunken)', fg: 'var(--ink-3)', dot: 'var(--ink-4)', text: s };

  /* تنقّل بين الصفحات مع فلتر يُطبَّق عند الوصول */
  const goRoute = (route, filter) => { if (window.HubPages) window.HubPages.go(route, filter); };

  /* يقرأ الفلتر المعلّق لهذا المسار (مرة واحدة) */
  const takeFilter = (route) => {
    try {
      const raw = sessionStorage.getItem('hub.filter');
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p && p.route === route) { sessionStorage.removeItem('hub.filter'); return p.filter || null; }
    } catch (e) {}
    return null;
  };

  /* ينتظر تحميل بيانات المركز ثم ينفّذ */
  const whenData = (cb) => { const w = () => { if (window.HubData) cb(window.HubData); else setTimeout(w, 40); }; w(); };

  /* رندرة Jinja مبسّطة: {{ var }} و {% if a == b %}…{% else %}…{% endif %} */
  const renderJinja = (tpl, ctx) => {
    let s = String(tpl == null ? '' : tpl);
    ctx = ctx || {};
    const val = (expr) => { const e = expr.trim(); if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e); if (/^(['"]).*\1$/.test(e)) return e.slice(1, -1); const v = ctx[e]; return v === undefined ? '' : v; };
    const truthy = (expr) => {
      const m = expr.trim().match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
      if (m) { const a = val(m[1]), b = val(m[3]); switch (m[2]) { case '==': return String(a) === String(b); case '!=': return String(a) !== String(b); case '>': return Number(a) > Number(b); case '<': return Number(a) < Number(b); case '>=': return Number(a) >= Number(b); case '<=': return Number(a) <= Number(b); } }
      const v = val(expr); return !!v && v !== '0' && v !== 0;
    };
    for (let i = 0; i < 10; i++) { const before = s; s = s.replace(/\{%\s*if\s+([^%]+?)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g, (_, c, a, b) => (truthy(c) ? a : (b || ''))); if (s === before) break; }
    return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => String(val(e)));
  };

  /* تنسيق واتساب (*عريض* _مائل_ ~مشطوب~ `كود`) → HTML آمن */
  const waFormatHtml = (text) => {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let s = esc(text == null ? '' : text);
    s = s.replace(/```([^`]+)```/g, '<code style="font-family:\'IBM Plex Mono\',monospace;background:var(--sunken);padding:1px 4px;border-radius:4px">$1</code>');
    s = s.replace(/`([^`\n]+)`/g, '<code style="font-family:\'IBM Plex Mono\',monospace;background:var(--sunken);padding:1px 4px;border-radius:4px">$1</code>');
    s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>').replace(/~([^~\n]+)~/g, '<s>$1</s>');
    return s;
  };

  window.HubShared = { statusTone, goRoute, takeFilter, whenData, renderJinja, waFormatHtml };
})();
