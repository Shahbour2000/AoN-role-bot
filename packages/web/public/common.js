/* Shared helpers: language (ar default, en), RTL/LTR switch, inline icons, tiny DOM builder.
   Data is only ever inserted via textContent / createElementNS: no markup strings. Single dark theme (no toggle). */
(() => {
  const dict = window.I18N;
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  let lang = store.get('aon_lang') === 'en' ? 'en' : 'ar';
  const t = (key, params = {}) => String((dict[lang][key] ?? dict.en[key] ?? key)).replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? `{${k}}` : String(params[k])));
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v; else if (k === 'checked') n.checked = !!v; else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  // ---- icons: 24x24 stroke paths (each entry = list of path "d" strings). Unknown names fall back to a dot, never to an error.
  const ICONS = {
    overview: ['M3 13h8V3H3z', 'M13 21h8V11h-8z', 'M13 3h8v6h-8z', 'M3 17h8v4H3z'],
    setup: ['M4 6h10', 'M18 6h2', 'M4 12h2', 'M10 12h10', 'M4 18h12', 'M20 18h0', 'M16 4v4', 'M6 10v4', 'M18 16v4'],
    roles: ['M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z', 'M9 12l2 2 4-4'],
    builds: ['M14.5 4.5l5 5', 'M3 21l6-2 10.5-10.5-4-4L5 15z', 'M13 7l4 4'],
    ranks: ['M12 3l2.6 5.4 5.9.9-4.3 4.1 1 5.9L12 16.6 6.8 19.3l1-5.9L3.5 9.3l5.9-.9z'],
    players: ['M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20', 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M21 20v-1.5a4 4 0 0 0-3-3.9', 'M16 4.2a3.5 3.5 0 0 1 0 6.6'],
    sync: ['M20 11a8 8 0 0 0-14.5-3.5L4 9', 'M4 4v5h5', 'M4 13a8 8 0 0 0 14.5 3.5L20 15', 'M20 20v-5h-5'],
    audit: ['M8 3h8l4 4v14H4V3z', 'M16 3v4h4', 'M8 12h8', 'M8 16h8', 'M8 8h4'],
    diag: ['M3 12h4l3-8 4 16 3-8h4'],
    server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
    link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1'],
    verify: ['M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
    shield: ['M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z'],
    flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
    users: ['M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20', 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
    card: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4'],
    bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
    menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    logout: ['M9 21H5V3h4', 'M16 17l5-5-5-5', 'M21 12H9'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    chevron: ['M6 9l6 6 6-6'],
    back: ['M15 6l-6 6 6 6'],
    dot: ['M12 12h.01'],
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const icon = (name, cls = '') => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    for (const d of ICONS[name] ?? ICONS.dot) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.append(p); }
    return s;
  };
  /** Paints every [data-icon] element once (idempotent: an already painted element is left alone). */
  const paintIcons = (root = document) => {
    root.querySelectorAll('[data-icon]').forEach((n) => { if (!n.querySelector(':scope > svg.icon')) n.prepend(icon(n.getAttribute('data-icon'))); });
  };

  const applyLang = () => {
    const root = document.documentElement;
    root.lang = lang; root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.getAttribute('data-i18n-aria'))); });
    const lt = document.getElementById('lang-toggle'); if (lt) lt.textContent = t('lang_toggle');
    document.title = t('app_name');
  };
  const setLang = (l) => { lang = l === 'en' ? 'en' : 'ar'; store.set('aon_lang', lang); applyLang(); };
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US'));
  const fmtDate = (d) => (d ? new Date(d).toLocaleString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US') : '—');
  window.AON = { t, el, icon, paintIcons, applyLang, setLang, getLang: () => lang, fmtNum, fmtDate };
  document.addEventListener('DOMContentLoaded', () => {
    applyLang(); paintIcons();
    // 'aon:lang-before' lets a page capture unsaved input first; a switch itself never saves anything.
    document.getElementById('lang-toggle')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('aon:lang-before'));
      setLang(lang === 'ar' ? 'en' : 'ar');
      paintIcons();
      document.dispatchEvent(new CustomEvent('aon:lang'));
    });
  });
})();
