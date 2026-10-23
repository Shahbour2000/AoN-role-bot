/* Shared helpers: language (ar default, en), RTL/LTR switch, theme, tiny DOM builder. Data is only ever inserted via textContent. */
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
  const applyLang = () => {
    const root = document.documentElement;
    root.lang = lang; root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    const lt = document.getElementById('lang-toggle'); if (lt) lt.textContent = t('lang_toggle');
    document.title = t('app_name');
  };
  const setLang = (l) => { lang = l === 'en' ? 'en' : 'ar'; store.set('aon_lang', lang); applyLang(); };
  const theme = store.get('aon_theme'); if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  const toggleTheme = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; store.set('aon_theme', next);
  };
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US'));
  const fmtDate = (d) => (d ? new Date(d).toLocaleString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US') : '—');
  window.AON = { t, el, applyLang, setLang, getLang: () => lang, toggleTheme, fmtNum, fmtDate };
  document.addEventListener('DOMContentLoaded', () => {
    applyLang();
    document.getElementById('lang-toggle')?.addEventListener('click', () => { setLang(lang === 'ar' ? 'en' : 'ar'); document.dispatchEvent(new CustomEvent('aon:lang')); });
    document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  });
})();
