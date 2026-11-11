(() => {
  const { t, el, icon, paintIcons, getLang, fmtNum, fmtDate } = window.AON;
  const root = document.getElementById('root');
  const state = { csrf: '', user: null, guilds: null };
  let renderToken = 0;
  const API_TIMEOUT_MS = 20000;

  // ---------------------------------------------------------------- plumbing
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET' && method !== 'DELETE') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body ?? {}); }
    if (method !== 'GET') opts.headers['x-csrf-token'] = state.csrf;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS); opts.signal = ctl.signal;   // a request can never stay pending forever
    let res; try { res = await fetch(path, opts); } catch { clearTimeout(timer); return { ok: false, status: 0, data: { error: ctl.signal.aborted ? 'timeout' : 'network' } }; }
    let data = {}; try { data = await res.json(); } catch { if (ctl.signal.aborted) { clearTimeout(timer); return { ok: false, status: 0, data: { error: 'timeout' } }; } /* no body */ }
    clearTimeout(timer);
    if (res.status === 401) { toast(t('session_expired'), true); setTimeout(() => location.assign('/'), 1200); }
    return { ok: res.ok, status: res.status, data };
  }
  // Never leave the skeleton on screen: every failure ends in a localized message with a Retry button.
  const failPanel = (msg, retry) => el('div', { class: 'callout warn', role: 'alert' }, el('p', { text: msg }), el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', id: 'retry', text: t('retry'), onclick: retry })));
  const errText = (r) => { const k = `e_${r.data?.error}`; const s = t(k); return s === k ? t('error_generic') : s; };
  function toast(msg, bad = false) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const n = el('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status', text: msg }); document.body.append(n); setTimeout(() => n.remove(), 4000);
  }
  // Modal helper: keeps Tab inside the dialog, Escape cancels, focus returns to where it was.
  function openModal(ov, onCancel, focusEl) {
    const prev = document.activeElement;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); onCancel(); return; }
      if (e.key !== 'Tab') return;
      const f = [...ov.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && !n.hidden);
      if (!f.length) return; const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true); document.body.append(ov); (focusEl || ov.querySelector('button'))?.focus();
    return close;
  }
  function confirmDialog(title, text, danger = false) {
    return new Promise((resolve) => {
      let close = () => {}; const done = (v) => { close(); resolve(v); };
      const ov = el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'dialog' }, el('h3', { text: title }), el('p', { class: 'muted', text }),
          el('div', { class: 'row' }, el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', text: t('confirm'), onclick: () => done(true) }), el('button', { class: 'btn', type: 'button', text: t('cancel'), onclick: () => done(false) }))));
      close = openModal(ov, () => resolve(false));
    });
  }
  // Lists exactly what a confirmed server-type change will delete; the destructive button stays disabled until the box is ticked.
  function removalDialog(title, intro, items, confirmLabel) {
    return new Promise((resolve) => {
      let close = () => {}; const done = (v) => { close(); resolve(v); };
      const ack = el('input', { type: 'checkbox', id: 'removal-ack' });
      const go = el('button', { class: 'btn danger', type: 'button', disabled: true, text: confirmLabel, onclick: () => done(true) });
      ack.addEventListener('change', () => { go.disabled = !ack.checked; });
      const ov = el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'dialog wide' }, el('h3', { text: title }), el('p', { class: 'muted', text: intro }), el('ul', { class: 'affected' }, items.map((x) => el('li', {}, el('strong', { text: x.kind }), ' · ', el('bdi', { text: x.role })))),
          el('p', { class: 'muted hint', text: t('ty_keep_note') }), el('label', {}, ack, ' ', t('ty_ack')),
          el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: t('cancel'), onclick: () => done(false) }), go)));
      close = openModal(ov, () => resolve(false), ack);
    });
  }
  const loading = () => root.replaceChildren(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);
  const badge = (text, kind = '') => el('span', { class: `badge ${kind}`, text });

  const BLOCKED_REASONS = ['dangerous_permissions', 'everyone_role', 'integration_managed'];
  function roleSelect(roles, value, withNone = true, usedElsewhere = new Set()) {
    const label = (r) => (BLOCKED_REASONS.includes(r.reason) ? `${r.name} — ${t('role_blocked')}` : usedElsewhere.has(r.id) && r.id !== value ? `${r.name} — ${t('role_used_elsewhere')}` : r.manageable ? r.name : `${r.name} ⚠ ${t('role_unmanageable')} (${t(`r_${r.reason}`)})`);
    const sel = el('select', {}, withNone ? el('option', { value: '', text: t('role_none') }) : null,
      roles.map((r) => el('option', { value: r.id, text: label(r), disabled: BLOCKED_REASONS.includes(r.reason) || (usedElsewhere.has(r.id) && r.id !== value) })));
    sel.value = value || ''; return sel;
  }

  // ---------------------------------------------------------------- routing
  function parseRoute() { const m = location.hash.match(/^#\/g\/(\d{5,25})(?:\/(\w+))?$/); return m ? { guild: m[1], tab: m[2] || 'overview' } : { guild: null }; }
  async function route() {
    const token = ++renderToken; const r = parseRoute();
    closeDrawer(); loading();
    if (!r.guild) { renderNav(null); renderSwitcher(null); }
    let view;
    try { view = r.guild ? await guildShell(r.guild, r.tab, token) : await guildList(token); }
    catch (e) { console.error('dashboard render failed', e); view = [failPanel(t('error_generic'), route)]; }
    if (token === renderToken && view) root.replaceChildren(...view);
  }

  // ---------------------------------------------------------------- guild list
  async function guildList() {
    const res = await api('GET', '/api/guilds');
    if (!res.ok) return [failPanel(errText(res), route)];
    if (!Array.isArray(res.data.guilds)) return [failPanel(t('error_generic'), route)];
    const gs = res.data.guilds; state.guilds = gs;
    return [el('div', { class: 'page-head' }, el('h2', { text: t('pick_server') }), el('p', { text: t('pd_pick') })),
      gs.length ? el('div', { class: 'grid' }, gs.map((g) => el('div', { class: 'card' },
        el('h3', {}, icon('server'), ' ', el('bdi', { text: g.name })), g.installed ? badge(t('manage'), 'ok') : badge(t('not_installed'), 'warn'),
        el('div', { class: 'row' }, g.installed ? el('a', { class: 'btn primary', href: `#/g/${g.id}/overview`, text: t('manage') }) : el('a', { class: 'btn', href: g.inviteUrl, text: t('install') }))))) : el('div', { class: 'empty', text: t('no_servers') })];
  }

  // ---------------------------------------------------------------- guild shell (sidebar nav, server switcher, page header)
  const TABS = ['overview', 'setup', 'roles', 'builds', 'ranks', 'players', 'sync', 'audit', 'diag'];
  const PAGES = { overview, setup, roles: rolesPage, builds: buildsPage, ranks: ranksPage, players, sync: syncPage, audit, diag };
  const NAV_GROUPS = [['nav_general', ['overview', 'setup']], ['nav_roles', ['roles', 'builds', 'ranks']], ['nav_community', ['players']], ['nav_ops', ['sync', 'audit', 'diag']]];
  const guildName = (g) => (state.guilds || []).find((x) => x.id === g)?.name || t('sw_unknown');

  function closeDrawer() {
    document.getElementById('sidebar').classList.remove('open'); document.getElementById('scrim').classList.remove('show');
    const mt = document.getElementById('menu-toggle'); mt.setAttribute('aria-expanded', 'false'); mt.setAttribute('aria-label', t('menu_open'));
  }
  function renderNav(g, tab) {
    const nav = document.getElementById('nav');
    if (!g) { nav.replaceChildren(el('div', { class: 'nav-group' }, el('a', { href: '#/', 'aria-current': 'page' }, icon('server'), el('span', { text: t('sw_all') })))); return; }
    nav.replaceChildren(...NAV_GROUPS.map(([gl, keys]) => el('div', { class: 'nav-group' }, el('h4', { text: t(gl) }),
      keys.map((k) => el('a', { href: `#/g/${g}/${k}`, 'aria-current': k === tab ? 'page' : false }, icon(k), el('span', { text: t(`tab_${k}`) }))))));
  }
  async function renderSwitcher(g, tab) {
    const box = document.getElementById('switcher');
    if (!g) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const draw = () => {
      const btn = el('button', { class: 'btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, icon('server'), el('span', { class: 'name' }, el('bdi', { text: guildName(g) })), icon('chevron'));
      const menu = el('div', { class: 'menu', hidden: true }, (state.guilds || []).filter((x) => x.installed && x.id !== g).map((x) => el('a', { href: `#/g/${x.id}/${tab}` }, icon('server'), el('span', { class: 'label' }, el('bdi', { text: x.name })))), el('a', { href: '#/' }, icon('back', 'flip'), el('span', { class: 'label', text: t('sw_all') })));
      const toggle = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
      btn.addEventListener('click', () => toggle(menu.hidden));
      menu.addEventListener('click', () => toggle(false));
      box.replaceChildren(btn, menu);
    };
    draw();
    if (!state.guilds) { const r = await api('GET', '/api/guilds'); if (r.ok) { state.guilds = r.data.guilds; draw(); } }
  }

  // ---- language switching keeps unsaved work: controls are captured by position before the re-render and restored after it.
  function captureState() {
    const c = document.getElementById('tab-content'); if (!c) return null;
    const controls = [...c.querySelectorAll('input, select, textarea')].map((n) => ({ tag: n.tagName, type: n.type, v: n.type === 'checkbox' || n.type === 'radio' ? n.checked : n.value }));
    const f = document.activeElement; const focus = c.contains(f) ? [...c.querySelectorAll('input, select, textarea, button')].indexOf(f) : -1;
    return { hash: location.hash, scroll: window.scrollY, controls, focus, open: [...c.querySelectorAll('details')].map((d) => d.open) };
  }
  function restoreState(c, snap) {
    if (!snap || snap.hash !== location.hash) return;
    // Controls are matched by position. A restored <select> may rebuild the form (e.g. the server type), so after each such change the
    // list is read again and restoring continues from the next control; the first structural mismatch stops it (never writes to the wrong control).
    let i = 0;
    for (let pass = 0; pass < 6 && i < snap.controls.length; pass++) {
      const nodes = [...c.querySelectorAll('input, select, textarea')]; let rebuilt = false;
      for (; i < snap.controls.length && i < nodes.length && !rebuilt; i++) {
        const n = nodes[i], w = snap.controls[i];
        if (n.tagName !== w.tag || n.type !== w.type) { i = snap.controls.length; break; }
        const checkable = n.type === 'checkbox' || n.type === 'radio'; const have = checkable ? n.checked : n.value;
        if (have === w.v) continue;                                  // already equal (e.g. auto-saved): do not re-fire handlers
        if (checkable) n.checked = w.v; else n.value = w.v;
        n.dispatchEvent(new Event(checkable || n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        if (n.tagName === 'SELECT') rebuilt = true;                  // handlers may have replaced the controls after this one
      }
      if (!rebuilt) break;
    }
    [...c.querySelectorAll('details')].forEach((d, k) => { if (snap.open[k] !== undefined) d.open = snap.open[k]; });
    if (snap.focus >= 0) [...c.querySelectorAll('input, select, textarea, button')][snap.focus]?.focus({ preventScroll: true });
    window.scrollTo(0, snap.scroll);
  }
  let pendingSnap = null;

  async function guildShell(g, tab, token) {
    if (!PAGES[tab]) tab = 'overview';
    const snap = pendingSnap; pendingSnap = null;
    renderNav(g, tab); renderSwitcher(g, tab);
    const content = el('div', { id: 'tab-content' });
    const head = el('div', { class: 'page-head' }, el('h2', {}, icon(tab), el('span', { text: t(`tab_${tab}`) })), el('p', { text: t(`pd_${tab}`) }));
    queueMicrotask(async () => { if (token !== renderToken) return; let n; try { n = await PAGES[tab](g, content); } catch (e) { console.error('page render failed', e); n = [failPanel(t('error_generic'), route)]; } if (token === renderToken && n) { content.replaceChildren(...n); paintIcons(content); restoreState(content, snap); } });
    content.replaceChildren(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
    return [head, content];
  }

  // ---------------------------------------------------------------- overview
  const jobStatus = (st) => { const k = `js_${st}`; const v = t(k); return v === k ? String(st) : v; };
  async function overview(g) {
    const r = await api('GET', `/api/guilds/${g}/overview`);
    if (!r.ok) return [el('p', { class: 'err', text: errText(r) })];
    const d = r.data; const job = d.lastJob;
    const stat = (ic, label, value, small = false) => el('div', { class: 'card stat' }, el('h3', {}, icon(ic), ' ', label), el('p', { class: small ? 'small' : '', text: value }));
    return [el('div', { class: 'stats' },
      stat('link', t('ov_active'), fmtNum(d.links.active)),
      stat('players', t('ov_pending'), fmtNum(d.links.pending)),
      stat('sync', t('ov_lastjob'), job ? `${jobStatus(job.status)} · ${fmtDate(job.finishedAt || job.createdAt)}` : t('ov_none'), true),
      stat('clock', t('sy_next'), d.settings && d.settings.autoSyncEnabled ? `${fmtDate(d.settings.nextSyncAt)} · ${t(`sy_every_${d.settings.syncIntervalHours}`)}` : t('sy_next_off'), true)),
      d.warnings.length ? el('div', { class: 'card' }, el('h3', { text: t('ov_warnings') }), el('ul', {}, d.warnings.map((w) => el('li', { text: t(`w_${w}`) })))) : null,
      el('div', { class: 'card' }, el('h3', { text: t('ov_recent') }), d.recentAudit.length ? el('ul', {}, d.recentAudit.map((e) => el('li', { text: `${fmtDate(e.createdAt)} · ${e.action}` }))) : el('p', { class: 'muted', text: t('ov_none') }))];
  }

  // ---------------------------------------------------------------- setup (settings)
  const TYPE_PRESETS = { country: { government: true, party: false, unit: false }, party: { government: false, party: true, unit: false }, military_unit: { government: false, party: false, unit: true }, general: { government: true, party: false, unit: false } };
  async function setup(g) {
    const r = await api('GET', `/api/guilds/${g}/settings`);
    if (!r.ok) return [el('p', { class: 'err', text: errText(r) })];
    const s = r.data.settings; const rules = s.typeRules; const legacy = s.communityType === 'alliance';
    const sel = (opts, v, tk) => { const x = el('select', {}, opts.map((o) => el('option', { value: o, text: t(`${tk}${o}`) }))); x.value = v; return x; };
    const lang = el('select', {}, el('option', { value: 'ar', text: 'العربية' }), el('option', { value: 'en', text: 'English' })); lang.value = s.language;
    // Alliance is NOT a configurable type. A legacy server that stores it sees only a disabled, localized "Closed" option and keeps its data.
    const type = sel(['general', 'country', 'party', 'military_unit'], legacy ? 'general' : s.communityType, 'type_');
    if (legacy) { type.append(el('option', { value: 'alliance', disabled: true, text: `${t('type_alliance')} — ${t('closed')}` })); type.value = 'alliance'; }
    const typeDesc = el('p', { class: 'muted type-desc', id: 'type-desc' });

    // ---- searchable selectors (real game data; see picker.js). A party/unit server only uses a country as a search FILTER, which is not saved.
    const mk = (kind, value, label, extra = {}) => AON.entityPicker({ type: kind, api, guildId: g, value, label, ...extra });
    const held = s.countryReservation === 'held';
    const pCountry = mk('country', s.communityType === 'country' || s.communityType === 'general' ? s.countryId : s.countryId, t('pk_l_country'), { allowClear: !(s.communityType === 'country' && held) });
    const pScope = mk('country', s.countryId, t('pk_scope_country'), { hint: t('pk_scope_hint') });
    const pParty = mk('party', s.partyId, t('pk_l_party'), { getCountryId: () => pScope.value() });
    const pUnit = mk('unit', s.unitId, t('pk_l_unit'), { getCountryId: () => pScope.value() });
    pScope.el.addEventListener('picker:change', () => { pParty.refresh(); pUnit.refresh(); });
    const conflict = el('p', { class: 'err', id: 'country-conflict', role: 'alert', hidden: true });

    const dem = sel(['never', 'immediate', 'grace'], s.demotion.mode, 'dem_');
    const grace = el('input', { type: 'number', min: 1, max: 365, value: s.demotion.graceDays || 7 });
    const mods = Object.fromEntries(['government', 'party', 'unit', 'ranks'].map((m) => [m, el('input', { type: 'checkbox', checked: s.modules[m], id: `mod-${m}` })]));
    const presetNote = el('p', { class: 'muted', id: 'preset-note', hidden: true, text: t('type_preset_note') });
    const linkMode = sel(['direct', 'staff_approval'], s.linkMode, 'lm_');
    const unitLeader = el('input', { type: 'checkbox', checked: s.unitLeaderReplacesMember, id: 'unit-leader-replaces' });

    // ---- the part of the form that depends on the selected type; rebuilt on every type change, controls are reused so nothing typed is lost
    const area = el('div', { id: 'type-area' });
    const reservation = () => {
      if (s.communityType !== 'country' || !s.countryId) return null;
      const out = [];
      if (held) out.push(el('p', {}, badge(t('res_held'), 'ok')), el('button', { class: 'btn danger', type: 'button', id: 'release-country', text: t('res_release'), onclick: async () => {
        if (!(await confirmDialog(t('res_release_title'), t('res_release_text'), true))) return;
        const res = await api('DELETE', `/api/guilds/${g}/country`); if (res.ok) { toast(t('res_released')); route(); } else toast(errText(res), true); } }));
      else if (s.countryReservation === 'held_by_other') out.push(el('div', { class: 'notice', id: 'res-duplicate', text: t('res_duplicate') }));
      return out;
    };
    const renderArea = () => {
      const ty = type.value; const rule = rules[ty] || { modules: [], entity: null };
      typeDesc.textContent = legacy && ty === 'alliance' ? t('ty_legacy') : t(`tyd_${ty}`);
      const nodes = [];
      if (ty === 'country') nodes.push(el('h3', { text: t('ty_entity_country') }), pCountry.el, el('p', { class: 'muted hint', text: t('res_note') }), ...(reservation() || []));
      else if (ty === 'general') nodes.push(el('h3', { text: t('ty_entity_general') }), pCountry.el, el('p', { class: 'muted hint', text: t('ty_general_note') }));
      else if (ty === 'party') nodes.push(el('h3', { text: t('ty_entity_party') }), pScope.el, pParty.el);
      else if (ty === 'military_unit') nodes.push(el('h3', { text: t('ty_entity_unit') }), pScope.el, pUnit.el);
      nodes.push(conflict);
      if (ty !== 'alliance') nodes.push(el('h3', { text: t('set_modules') }), presetNote, el('div', { class: 'row' }, rule.modules.map((m) => el('label', {}, mods[m], ' ', t(`mod_${m}`)))));
      area.replaceChildren(...nodes);
    };
    type.addEventListener('change', () => { const p = TYPE_PRESETS[type.value]; if (p) { for (const [k, v] of Object.entries(p)) mods[k].checked = v; presetNote.hidden = false; } conflict.hidden = true; renderArea(); });
    renderArea();

    async function save(confirmRemoval) {
      const ty = type.value; const body = { language: lang.value, demotionMode: dem.value, demotionGraceDays: Number(grace.value), linkMode: linkMode.value, unitLeaderReplacesMember: unitLeader.checked };
      if (!legacy) {
        body.communityType = ty;
        const allowed = (rules[ty] || { modules: [] }).modules;
        body.modules = { ...Object.fromEntries(['government', 'party', 'unit', 'ranks'].map((m) => [m, allowed.includes(m) ? mods[m].checked : false])), alliance: false };
        if (ty === 'country' || ty === 'general') body.countryId = pCountry.value();
        if (ty === 'party') body.partyId = pParty.value();
        if (ty === 'military_unit') body.unitId = pUnit.value();
      }
      if (confirmRemoval) body.confirmRemoveIncompatible = true;
      const res = await api('PUT', `/api/guilds/${g}/settings`, body);
      if (res.ok) {
        const n = res.data.notices || { coercedModules: [], removedMappings: 0 };
        toast(t('saved')); if (n.removedMappings) toast(t('ty_removed', { n: n.removedMappings }));
        if (n.coercedModules.length) toast(t('ty_modules_off', { names: n.coercedModules.map((m) => t(`mod_${m}`)).join('، ') }));
        return route();
      }
      if (res.data?.error === 'incompatible_mappings') {
        const rl = await api('GET', `/api/guilds/${g}/roles`); const names = new Map(rl.ok ? rl.data.roles.map((x) => [x.id, x.name]) : []);
        const items = res.data.mappings.map((m) => ({ kind: t(`k_${m.kind}`), role: names.get(m.discordRoleId) || t('ty_role_missing') }));
        if (await removalDialog(t('ty_confirm_title', { type: t(`type_${ty}`) }), t('ty_confirm_intro', { n: items.length }), items, t('ty_confirm_btn'))) return save(true);
        return;
      }
      if (res.data?.error === 'country_reserved') { conflict.textContent = t('e_country_reserved'); conflict.hidden = false; conflict.scrollIntoView?.({ block: 'nearest' }); return; }
      toast(errText(res), true);
    }
    const saveBtn = el('button', { class: 'btn primary', type: 'button', id: 'save-settings', text: t('save'), onclick: () => save(false) });
    return [el('div', { class: 'card' },
      el('div', { class: 'row' }, field(t('set_language'), lang), field(t('set_type'), type)), typeDesc, area),
      el('div', { class: 'card' }, el('details', { id: 'advanced' }, el('summary', { text: t('set_advanced') }),
        el('div', { class: 'row' }, field(t('set_demotion'), dem), field(t('set_grace'), grace)),
        el('div', { class: 'row' }, field(t('set_link_mode'), linkMode)), el('p', { class: 'muted', text: t('lm_note') }),
        el('div', { class: 'row' }, el('label', {}, unitLeader, ' ', t('set_unit_leader'))))),
      el('div', { class: 'row' }, saveBtn)];
  }

  // ---------------------------------------------------------------- role mappings
  // Grouped by community type. Alliance kinds are NOT offered: there is no verified game data behind them.
  const KIND_GROUPS = [
    ['grp_country', ['president', 'vice_president', 'minister_defense', 'minister_foreign', 'minister_economy', 'congress', 'citizen', 'government_role']],
    ['grp_party', ['party_leader', 'party_role', 'party_member']],
    ['grp_unit', ['unit_leader', 'unit_member']],
  ];
  const NEEDS_VALUE = ['minister_foreign', 'government_role', 'party_role'];
  async function rolesPage(g) {
    const [m, rl, rk, st, cfg] = await Promise.all([api('GET', `/api/guilds/${g}/mappings`), api('GET', `/api/guilds/${g}/roles`), api('GET', `/api/guilds/${g}/ranks`), api('GET', `/api/guilds/${g}/sync/status`), api('GET', `/api/guilds/${g}/settings`)]);
    const allowed = cfg.ok ? new Set(cfg.data.settings.allowedKinds) : null;      // the server type decides which role kinds exist
    if (!m.ok) return [el('p', { class: 'err', text: errText(m) })];
    if (!rl.ok) return [el('p', { class: 'err', text: errText(rl) })];
    const roles = rl.data.roles; const names = new Map(roles.map((r) => [r.id, r.name]));
    const rankRoles = new Set(rk.ok ? rk.data.ranks.map((r) => r.discordRoleId).filter(Boolean) : []);
    const job = st.ok ? (st.data.lastSuccess || st.data.lastJob) : null; const seen = (job && job.details && job.details.seenRoles) || { party: {}, unit: {}, governmentUnknown: [] };
    const body = el('tbody', {}, m.data.mappings.map((x) => el('tr', {}, el('td', { text: t(`k_${x.kind}`) }), el('td', { text: x.gameRef || '—' }), el('td', { text: names.get(x.discordRoleId) || x.discordRoleId }),
      el('td', {}, el('button', { class: 'btn danger', type: 'button', text: t('remove'), onclick: async () => { const res = await api('DELETE', `/api/guilds/${g}/mappings/${x.id}`); if (res.ok) route(); else toast(errText(res), true); } })))));
    const kind = el('select', { id: 'map-kind' }, KIND_GROUPS.map(([gl, ks]) => [gl, allowed ? ks.filter((k) => allowed.has(k)) : ks]).filter(([, ks]) => ks.length).map(([gl, ks]) => el('optgroup', { label: t(gl) }, ks.map((k) => el('option', { value: k, text: t(`k_${k}`) })))));
    const ref = el('input', { class: 'wide', maxlength: 80, id: 'map-ref' }); const role = roleSelect(roles, '', false, rankRoles);
    const chips = el('div', { id: 'seen-values', class: 'row' });
    const refreshChips = () => {
      const vals = kind.value === 'party_role' ? Object.keys(seen.party || {}) : ['government_role', 'minister_foreign'].includes(kind.value) ? (seen.governmentUnknown || []) : [];
      chips.replaceChildren(...(NEEDS_VALUE.includes(kind.value) ? [el('span', { class: 'muted', text: vals.length ? t('map_seen') : t('map_seen_none') }), ...vals.map((v) => el('button', { class: 'btn', type: 'button', text: v, onclick: () => { ref.value = v; } }))] : []));
    };
    kind.addEventListener('change', refreshChips); refreshChips();
    const add = el('button', { class: 'btn primary', type: 'button', text: t('map_add'), onclick: async () => {
      if (NEEDS_VALUE.includes(kind.value) && !ref.value.trim()) { toast(t('map_value_required'), true); return; }
      const res = await api('POST', `/api/guilds/${g}/mappings`, { kind: kind.value, discordRoleId: role.value, ...(ref.value.trim() ? { gameRef: ref.value.trim() } : {}) });
      if (res.ok) { toast(t('saved')); route(); } else toast(errText(res), true);
    } });
    return [m.data.mappings.length ? el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, [t('map_kind'), t('map_ref'), t('map_role'), ''].map((h) => el('th', { text: h })))), body)) : el('div', { class: 'empty', text: t('map_none') }),
      el('div', { class: 'card' }, el('div', { class: 'row' }, field(t('map_kind'), kind), field(t('map_ref'), ref), field(t('map_role'), role), add), chips,
        el('p', { class: 'muted', text: t('map_country_hint') }), el('p', { class: 'muted', text: t('map_entity_hint') }))];
  }

  // ---------------------------------------------------------------- player build roles (War / Eco / Hybrid)
  const BUILD_KEYS = ['war', 'eco', 'hybrid'];
  async function buildsPage(g) {
    const [b, rl, rk, mp] = await Promise.all([api('GET', `/api/guilds/${g}/builds`), api('GET', `/api/guilds/${g}/roles`), api('GET', `/api/guilds/${g}/ranks`), api('GET', `/api/guilds/${g}/mappings`)]);
    if (!b.ok) return [el('p', { class: 'err', text: errText(b) })];
    const roles = rl.ok ? rl.data.roles : [];
    const used = new Set([...(rk.ok ? rk.data.ranks.map((x) => x.discordRoleId) : []), ...(mp.ok ? mp.data.mappings.map((x) => x.discordRoleId) : [])].filter(Boolean));
    const saved = Object.fromEntries(b.data.builds.map((x) => [x.key, x]));
    const selects = {}; const msgs = {}; const save = el('button', { class: 'btn primary', type: 'button', id: 'builds-save', text: t('save') });
    const refresh = () => {
      const vals = BUILD_KEYS.map((k) => selects[k].value || null); let bad = false;
      BUILD_KEYS.forEach((k) => { const v = selects[k].value || null; const dup = v && vals.filter((x) => x === v).length > 1; bad = bad || !!dup;
        msgs[k].replaceChildren(!v ? el('span', { class: 'muted', text: t('bld_unset') }) : dup ? el('span', { class: 'err', role: 'alert', text: t('bld_dup') }) : ''); });
      save.disabled = bad;
    };
    const cards = BUILD_KEYS.map((k) => {
      const e = saved[k]; selects[k] = roleSelect(roles, e.roleId, true, new Set([...used].filter((x) => x !== e.roleId))); selects[k].id = `build-${k}`; selects[k].setAttribute('aria-label', t(`bld_${k}`));
      msgs[k] = el('div'); selects[k].addEventListener('change', refresh);
      return el('div', { class: 'card', id: `card-${k}` }, el('h3', { text: t(`bld_${k}`) }), el('p', { class: 'muted', text: t(`bld_${k}_d`) }), badge(t(`bs_${e.status}`), e.status === 'ok' ? 'ok' : e.status === 'unset' ? '' : 'warn'), el('div', { class: 'row' }, selects[k]), msgs[k]);
    });
    save.addEventListener('click', async () => { const res = await api('PUT', `/api/guilds/${g}/builds`, Object.fromEntries(BUILD_KEYS.map((k) => [k, selects[k].value || null]))); if (res.ok) { toast(t('saved')); route(); } else toast(errText(res), true); });
    refresh();
    return [el('h2', { text: t('bld_section') }), !b.data.discordAvailable ? el('div', { class: 'notice', text: t('e_discord_unavailable') }) : null, el('div', { class: 'grid' }, cards), el('div', { class: 'row' }, save), el('p', { class: 'muted', text: t('bld_hier') }),
      el('details', {}, el('summary', { text: t('bld_how') }), el('ul', {}, ['bld_rule_war', 'bld_rule_eco', 'bld_rule_hybrid', 'bld_rule_none'].map((k) => el('li', { text: t(k) }))))];
  }

  // ---------------------------------------------------------------- military ranks (the editor)
  function validateRanks(ranks) {
    const errs = new Map(); const add = (k, m) => errs.set(k, [...(errs.get(k) || []), m]);
    const roleCount = new Map(); ranks.forEach((r) => r.discordRoleId && roleCount.set(r.discordRoleId, (roleCount.get(r.discordRoleId) || 0) + 1));
    for (const r of ranks) {
      if (!r.nameAr.trim() || !r.nameEn.trim()) add(r.key, t('rk_err_name'));
      if (!Number.isSafeInteger(r.minDamage) || r.minDamage <= 0) add(r.key, t('rk_err_int'));
      if (r.discordRoleId && roleCount.get(r.discordRoleId) > 1) add(r.key, t('rk_err_role'));
    }
    const on = ranks.filter((r) => r.enabled && Number.isSafeInteger(r.minDamage)).sort((a, b) => a.order - b.order);
    for (let i = 1; i < on.length; i++) if (on[i].minDamage <= on[i - 1].minDamage) add(on[i].key, t('rk_err_order', { lower: getLang() === 'ar' ? on[i - 1].nameAr : on[i - 1].nameEn, v: fmtNum(on[i - 1].minDamage) }));
    return errs;
  }
  async function ranksPage(g, container) {
    const [rk, rl, mp, stg] = await Promise.all([api('GET', `/api/guilds/${g}/ranks`), api('GET', `/api/guilds/${g}/roles`), api('GET', `/api/guilds/${g}/mappings`), api('GET', `/api/guilds/${g}/settings`)]);
    if (!rk.ok) return [el('p', { class: 'err', text: errText(rk) })];
    const roles = rl.ok ? rl.data.roles : [];
    const mappedRoles = new Set(mp.ok ? mp.data.mappings.map((x) => x.discordRoleId) : []);          // a role cannot be both a rank role and a mapped role
    const settings = stg.ok ? stg.data.settings : null; const systemOn = !!(settings && settings.modules.ranks);
    const setSystem = async (on) => { const res = await api('PUT', `/api/guilds/${g}/settings`, { modules: { ...settings.modules, alliance: false, ranks: on } }); if (res.ok) { toast(t('saved')); route(); } else toast(errText(res), true); };
    const banner = settings ? el('div', { class: 'notice', id: 'rank-system-banner' }, systemOn ? t('rk_on_banner') : t('rk_off_banner'), ' ', el('button', { class: 'btn', type: 'button', id: 'rank-system-toggle', text: systemOn ? t('rk_disable') : t('rk_enable'), onclick: () => setSystem(!systemOn) })) : null;
    if (!rk.data.ranks.length) return [banner, el('div', { class: 'empty', text: t('rk_empty') }), systemOn ? el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', id: 'rank-create-defaults', text: t('rk_create_defaults'), onclick: async () => { const res = await api('POST', `/api/guilds/${g}/ranks/reset`, {}); if (res.ok) { toast(t('saved')); route(); } else toast(errText(res), true); } })) : null];
    let ranks = rk.data.ranks.map((r) => ({ ...r })); const original = new Map(rk.data.ranks.map((r) => [r.key, { ...r }]));
    let serverErrs = new Map();
    const lang = getLang();
    const tbody = el('tbody'); const summary = el('div'); const saveBtn = el('button', { class: 'btn primary', type: 'button', text: t('rk_save') });

    const sorted = () => [...ranks].sort((a, b) => a.order - b.order);
    function refresh() {
      const errs = validateRanks(ranks);
      for (const [k, v] of serverErrs) v.forEach((m) => errs.set(k, [...(errs.get(k) || []), m]));
      tbody.querySelectorAll('tr[data-key]').forEach((tr) => {
        const k = tr.dataset.key; const list = errs.get(k) || []; const cell = tr.querySelector('.errs');
        tr.classList.toggle('invalid', list.length > 0); cell.replaceChildren(...list.map((m) => el('div', { class: 'err', role: 'alert', text: m })));
        const r = ranks.find((x) => x.key === k); tr.classList.toggle('disabled-rank', !r.enabled);
        const noRole = r.enabled && !r.discordRoleId; const hint = tr.querySelector('.hint'); hint.textContent = noRole ? t('rk_norole') : '';
      });
      saveBtn.disabled = errs.size > 0 || ranks.length === 0;
      summary.replaceChildren(errs.size ? el('p', { class: 'err', text: t('rk_invalid') }) : null);
    }
    function build() {
      const list = sorted();
      tbody.replaceChildren(...list.map((r, i) => {
        const nameAr = el('input', { value: r.nameAr, maxlength: 60, lang: 'ar', dir: 'rtl', 'aria-label': t('rk_name_ar'), oninput: (e) => { r.nameAr = e.target.value; refresh(); } });
        const nameEn = el('input', { value: r.nameEn, maxlength: 60, lang: 'en', dir: 'ltr', 'aria-label': t('rk_name_en'), oninput: (e) => { r.nameEn = e.target.value; refresh(); } });
        const dmg = el('input', { type: 'number', min: 1, step: 1, value: r.minDamage, 'aria-label': t('rk_min'), oninput: (e) => { r.minDamage = e.target.value === '' ? NaN : Number(e.target.value); refresh(); } });
        const role = roleSelect(roles, r.discordRoleId, true, mappedRoles); role.addEventListener('change', () => { r.discordRoleId = role.value || null; refresh(); });
        const on = el('input', { type: 'checkbox', checked: r.enabled, 'aria-label': t('rk_on'), onchange: (e) => { r.enabled = e.target.checked; refresh(); } });
        // Moving a rank swaps positions but the damage thresholds stay in their slots, so the ladder is always consistent.
        const swap = (j) => { const o = list[j]; [r.order, o.order] = [o.order, r.order]; [r.minDamage, o.minDamage] = [o.minDamage, r.minDamage]; build(); };
        return el('tr', { 'data-key': r.key }, el('td', { text: String(i + 1) }), el('td', {}, nameAr), el('td', {}, nameEn), el('td', {}, dmg, el('div', { class: 'muted', text: fmtNum(r.minDamage) })), el('td', {}, role, el('div', { class: 'muted hint' })), el('td', {}, on),
          el('td', {}, el('button', { class: 'btn', type: 'button', text: '↑', title: t('rk_up'), 'aria-label': t('rk_up'), disabled: i === 0, onclick: () => swap(i - 1) }), el('button', { class: 'btn', type: 'button', text: '↓', title: t('rk_down'), 'aria-label': t('rk_down'), disabled: i === list.length - 1, onclick: () => swap(i + 1) }),
            el('button', { class: 'btn danger', type: 'button', text: '✕', title: t('remove'), 'aria-label': t('remove'), onclick: async () => { if (!(await confirmDialog(t('rk_delete_t'), t('rk_delete_d'), true))) return; ranks = ranks.filter((x) => x.key !== r.key); build(); } })),
          el('td', { class: 'errs' }));
      }));
      refresh();
    }
    function diff() {
      const d = { th: 0, nm: 0, en: 0, ro: 0, ad: 0, rm: 0 };
      for (const r of ranks) { const o = original.get(r.key); if (!o) { d.ad++; continue; } if (o.minDamage !== r.minDamage) d.th++; if (o.nameAr !== r.nameAr || o.nameEn !== r.nameEn) d.nm++; if (o.enabled !== r.enabled) d.en++; if (o.discordRoleId !== r.discordRoleId) d.ro++; }
      d.rm = [...original.keys()].filter((k) => !ranks.some((r) => r.key === k)).length; return d;
    }
    saveBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(t('rk_confirm_t'), t('rk_confirm_d', diff())))) return;
      const res = await api('PUT', `/api/guilds/${g}/ranks`, { ranks: sorted().map((r) => ({ key: r.key, order: r.order, nameAr: r.nameAr.trim(), nameEn: r.nameEn.trim(), minDamage: r.minDamage, discordRoleId: r.discordRoleId, enabled: r.enabled })) });
      if (res.ok) { toast(t('saved')); route(); return; }
      serverErrs = new Map();
      for (const i of res.data.issues || []) if (i.rankKey) serverErrs.set(i.rankKey, [...(serverErrs.get(i.rankKey) || []), i.message || t('e_invalid_ladder')]);
      toast(errText(res), true); refresh();
    });
    const addBtn = el('button', { class: 'btn', type: 'button', text: t('rk_add'), onclick: () => {
      const top = Math.max(0, ...ranks.map((r) => r.order)); const hi = Math.max(0, ...ranks.filter((r) => r.enabled).map((r) => r.minDamage || 0));
      ranks.push({ key: `custom_${Date.now().toString(36)}`, order: top + 1, nameAr: 'رتبة جديدة', nameEn: 'New rank', minDamage: hi + 1000, discordRoleId: null, enabled: true }); build();
    } });
    const resetBtn = el('button', { class: 'btn', type: 'button', text: t('rk_reset'), onclick: async () => { if (!(await confirmDialog(t('rk_reset'), t('rk_reset_confirm'), true))) return; const res = await api('POST', `/api/guilds/${g}/ranks/reset`); if (res.ok) { toast(t('saved')); route(); } else toast(errText(res), true); } });
    void lang; void container;
    build();
    return [banner, el('p', { class: 'muted', text: t('rk_hint') }),
      el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['#', t('rk_name_ar'), t('rk_name_en'), t('rk_min'), t('rk_role'), t('rk_on'), '', ''].map((h) => el('th', { text: h })))), tbody)),
      summary, el('div', { class: 'row' }, saveBtn, addBtn, resetBtn)];
  }

  // ---------------------------------------------------------------- players
  async function players(g) {
    const filter = el('select', {}, el('option', { value: '', text: t('filter_all') }), ['pending', 'verified', 'admin_linked', 'rejected', 'unlinked'].map((s) => el('option', { value: s, text: t(`st_${s}`) })));
    const holder = el('div');
    async function load() {
      const r = await api('GET', `/api/guilds/${g}/links${filter.value ? `?status=${filter.value}` : ''}`);
      if (!r.ok) return holder.replaceChildren(el('p', { class: 'err', text: errText(r) }));
      const act = async (path, label) => { const res = await api('POST', `/api/guilds/${g}/links/${path}`, {}); if (res.ok) { toast(label); load(); } else toast(errText(res), true); };
      holder.replaceChildren(r.data.links.length ? el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, [t('pl_user'), t('pl_player'), t('status'), t('pl_damage'), t('pl_sync'), t('pl_actions')].map((h) => el('th', { text: h })))),
        el('tbody', {}, r.data.links.map((l) => el('tr', {}, el('td', { text: l.discordUserId }), el('td', { text: `${l.username || ''} (${l.playerId})` }),
          el('td', {}, badge(t(`st_${l.status}`), l.status === 'pending' ? 'warn' : l.status === 'rejected' || l.status === 'unlinked' ? 'bad' : 'ok'), ' ', badge(t(`pm_${l.method}`), l.method === 'self_direct' ? 'warn' : ''), l.conflict ? badge(t('conflict'), 'bad') : null),
          el('td', { text: fmtNum(l.lastDamage) }), el('td', { text: fmtDate(l.lastSyncedAt) }),
          el('td', {}, l.status === 'pending' ? [el('button', { class: 'btn primary', type: 'button', text: t('approve'), onclick: () => act(`${l.id}/approve`, t('approve')) }), el('button', { class: 'btn danger', type: 'button', text: t('reject'), onclick: () => act(`${l.id}/reject`, t('reject')) })]
            : ['verified', 'admin_linked'].includes(l.status) ? el('button', { class: 'btn danger', type: 'button', text: t('unlink'), onclick: async () => { if (await confirmDialog(t('unlink'), `${l.username || l.playerId}`, true)) { const res = await api('POST', `/api/guilds/${g}/links/unlink`, { discordUserId: l.discordUserId }); if (res.ok) load(); else toast(errText(res), true); } } }) : null)))))) : el('div', { class: 'empty', text: t('pl_none') }));
    }
    filter.addEventListener('change', load); load();
    const fu = el('input', { class: 'wide', inputmode: 'numeric', maxlength: 25 }), fp = el('input', { class: 'wide', maxlength: 40 }), fr = el('input', { class: 'wide', maxlength: 200 }), fx = el('input', { type: 'checkbox' });
    const fb = el('button', { class: 'btn primary', type: 'button', text: t('force_btn'), onclick: async () => {
      const res = await api('POST', `/api/guilds/${g}/links/force`, { discordUserId: fu.value.trim(), playerName: fp.value.trim(), ...(fr.value.trim() ? { reason: fr.value.trim() } : {}), replace: fx.checked });
      if (res.ok) { toast(t('saved')); load(); } else toast(errText(res), true);
    } });
    return [el('div', { class: 'row' }, field(t('status'), filter)), holder,
      el('div', { class: 'card' }, el('h3', { text: t('force_t') }), el('div', { class: 'row' }, field(t('force_user'), fu), field(t('force_player'), fp), field(t('force_reason'), fr), el('label', {}, fx, ' ', t('force_replace')), fb))];
  }

  // ---------------------------------------------------------------- sync (schedule + status + Sync now)
  const reasonText = (code) => {
    const m = /^(roster|citizens|profile|lookup)_(error|rate_limited|not_found|incomplete|missing)$/.exec(code);
    if (m) return `${t(`src_${m[1]}`)}: ${t(`rs_api_${m[2]}`)}`;
    const k = `rs_${String(code).replace(/^discord_error:.*/, 'x')}`; const v = t(k); return v === k ? String(code) : v;
  };
  const reasonList = (title, map) => {
    const rows = Object.entries(map || {}).sort((x, y) => y[1] - x[1]);
    return el('div', {}, el('h4', { text: title }), rows.length ? el('ul', {}, rows.map(([c, n]) => el('li', { text: `${reasonText(c)} × ${fmtNum(n)}` }))) : el('p', { class: 'muted', text: t('sy_nothing') }));
  };
  async function syncPage(g, container) {
    const holder = el('div'); const jobsHolder = el('div');
    const startBtn = el('button', { class: 'btn primary', type: 'button', text: t('sy_start') }); const cancelBtn = el('button', { class: 'btn danger', type: 'button', text: t('sy_cancel') });
    const auto = el('input', { type: 'checkbox', id: 'auto-sync' }); const interval = el('select', { id: 'sync-interval', 'aria-label': t('sy_interval') }, [3, 6, 12, 24].map((h) => el('option', { value: String(h), text: t(`sy_every_${h}`) })));
    let timer = null; let formReady = false;
    const saveSchedule = el('button', { class: 'btn primary', type: 'button', text: t('save'), onclick: async () => {
      const res = await api('PUT', `/api/guilds/${g}/settings`, { autoSyncEnabled: auto.checked, syncIntervalHours: Number(interval.value) });
      toast(res.ok ? t('sy_schedule_saved') : errText(res), !res.ok); if (res.ok) load();
    } });
    async function load() {
      const [st, jobs] = await Promise.all([api('GET', `/api/guilds/${g}/sync/status`), api('GET', `/api/guilds/${g}/sync/jobs`)]);
      if (!st.ok) { holder.replaceChildren(el('p', { class: 'err', text: errText(st) })); return; }
      const d = st.data; const last = d.lastJob; const ok = d.lastSuccess;
      if (!formReady) { auto.checked = d.enabled; interval.value = String(d.intervalHours); formReady = true; }
      startBtn.disabled = d.running; cancelBtn.disabled = !d.running;
      const c = (last && last.counts) || {}; const det = (last && last.details) || {};
      holder.replaceChildren(el('div', { class: 'card kv', id: 'sync-status' },
        el('span', { text: t('sy_schedule') }), el('span', { text: d.enabled ? t(`sy_every_${d.intervalHours}`) : t('sy_schedule_off') }),
        el('span', { text: t('sy_last_success') }), el('span', { text: ok ? fmtDate(ok.finishedAt || ok.createdAt) : t('sy_never') }),
        el('span', { text: t('sy_next') }), el('span', { text: d.enabled && d.nextSyncAt ? fmtDate(d.nextSyncAt) : t('sy_next_off') }),
        el('span', { text: t('sy_state') }), el('span', {}, badge(d.running ? t('sy_state_running') : t('sy_state_idle'), d.running ? 'warn' : 'ok')),
        el('span', { text: t('sy_last_result') }), el('span', {}, last ? [badge(last.status, last.status === 'succeeded' ? 'ok' : last.status === 'failed' ? 'bad' : 'warn'), ' ', t('sy_roles_summary', { added: fmtNum(c.rolesAdded ?? 0), removed: fmtNum(c.rolesRemoved ?? 0), processed: fmtNum(c.processed ?? 0), total: fmtNum(c.total ?? 0), skipped: fmtNum(c.skipped ?? 0), failed: fmtNum(c.failed ?? 0) })] : t('sy_never')),
        last && last.error ? [el('span', { text: t('sy_errors_t') }), el('span', { class: 'err', text: last.error })] : null),
        last ? el('div', { class: 'card', id: 'sync-details' }, el('p', { class: 'muted', text: t('sy_keep_note') }), reasonList(t('sy_skipped_t'), det.skippedReasons), reasonList(t('sy_blocked_t'), det.blockedReasons), reasonList(t('sy_lookups_t'), det.lookupFailures),
          (det.errors && det.errors.length) ? el('div', {}, el('h4', { text: t('sy_errors_t') }), el('ul', {}, det.errors.map((e) => el('li', { text: `${e.discordUserId}: ${reasonText(e.note)}` })))) : null) : null);
      if (jobs.ok) jobsHolder.replaceChildren(jobs.data.jobs.length ? el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, [t('au_when'), t('status'), '', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, jobs.data.jobs.map((j) => el('tr', {}, el('td', { text: fmtDate(j.createdAt) }), el('td', {}, badge(j.status === 'running' ? t('sy_running') : j.status, j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn'), ' ', badge(j.kind)),
          el('td', { text: j.counts && j.counts.total !== undefined ? t('sy_counts', { processed: j.counts.processed ?? 0, total: j.counts.total, updated: j.counts.updated ?? 0, failed: j.counts.failed ?? 0 }) : '' }), el('td', { class: 'muted', text: j.error || '' })))))) : el('div', { class: 'empty', text: t('sy_none') }));
      clearTimeout(timer); if (d.running && container.isConnected) timer = setTimeout(load, 3000);
    }
    startBtn.addEventListener('click', async () => { const res = await api('POST', `/api/guilds/${g}/sync`, {}); toast(res.ok ? t('sy_started') : res.data.error === 'already_running' ? t('sy_already') : errText(res), !res.ok); setTimeout(load, 500); });
    cancelBtn.addEventListener('click', async () => { const res = await api('POST', `/api/guilds/${g}/sync/cancel`, {}); if (!res.ok) toast(errText(res), true); load(); });
    load();
    return [el('div', { class: 'card' }, el('h3', { text: t('sy_schedule_t') }), el('div', { class: 'row' }, el('label', {}, auto, ' ', t('sy_auto')), field(t('sy_interval'), interval), saveSchedule)),
      el('div', { class: 'row' }, startBtn, cancelBtn), holder, jobsHolder];
  }

  // ---------------------------------------------------------------- audit
  async function audit(g) {
    const tbody = el('tbody'); const more = el('button', { class: 'btn', type: 'button', text: t('au_more'), hidden: true }); let cursor = null;
    async function load() {
      const r = await api('GET', `/api/guilds/${g}/audit?limit=50${cursor ? `&before=${cursor}` : ''}`);
      if (!r.ok) { toast(errText(r), true); return; }
      tbody.append(...r.data.events.map((e) => el('tr', {}, el('td', { text: fmtDate(e.createdAt) }), el('td', { text: e.actor || t('au_system') }), el('td', { text: e.action }), el('td', { text: e.target || '' }))));
      cursor = r.data.nextBefore; more.hidden = r.data.events.length < 50;
    }
    more.addEventListener('click', load); await load();
    return [el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, [t('au_when'), t('au_actor'), t('au_action'), t('au_target')].map((h) => el('th', { text: h })))), tbody)), el('div', { class: 'row' }, more)];
  }

  // ---------------------------------------------------------------- diagnostics
  async function diag(g) {
    const r = await api('GET', `/api/guilds/${g}/diagnostics`);
    if (!r.ok) return [el('p', { class: 'err', text: errText(r) })];
    const st = (v) => (v === null || v === undefined ? badge(t('dg_unknown')) : v ? badge(t('dg_ok'), 'ok') : badge(t('dg_down'), 'bad'));
    return [el('div', { class: 'card kv' }, el('span', { text: t('dg_db') }), st(r.data.database), el('span', { text: t('dg_discord') }), st(r.data.discord), el('span', { text: t('dg_api') }),
      r.data.gameApi ? el('span', { text: Object.entries(r.data.gameApi).map(([k, v]) => `${k}: ${v ?? '—'}`).join(' · ') }) : badge(t('dg_unknown')))];
  }

  // ---------------------------------------------------------------- boot
  document.addEventListener('DOMContentLoaded', async () => {
    let me, j;
    try { me = await fetch('/api/session', { credentials: 'same-origin', signal: AbortSignal.timeout(API_TIMEOUT_MS) }); if (me.ok) j = await me.json(); }
    catch { root.replaceChildren(failPanel(t('e_network'), () => location.reload())); return; }
    if (me.status === 401) { location.assign('/auth/login'); return; }
    if (!me.ok || !j || !j.user) { root.replaceChildren(failPanel(t(me.status >= 500 ? 'e_server' : 'error_generic'), () => location.reload())); return; }
    state.user = j.user; state.csrf = j.csrfToken;
    document.getElementById('who').textContent = j.user.username;
    const lo = document.getElementById('logout'); lo.hidden = false;
    lo.addEventListener('click', async () => { await api('POST', '/auth/logout', {}); location.assign('/'); });
    paintIcons();
    window.addEventListener('hashchange', route);
    document.addEventListener('aon:lang-before', () => { pendingSnap = captureState(); });
    document.addEventListener('aon:lang', () => { const mt = document.getElementById('menu-toggle'); mt.setAttribute('aria-label', t(document.getElementById('sidebar').classList.contains('open') ? 'menu_close' : 'menu_open')); route(); });
    const side = document.getElementById('sidebar'); const scrim = document.getElementById('scrim'); const mt = document.getElementById('menu-toggle');
    mt.addEventListener('click', () => { const open = !side.classList.contains('open'); side.classList.toggle('open', open); scrim.classList.toggle('show', open); mt.setAttribute('aria-expanded', String(open)); mt.setAttribute('aria-label', t(open ? 'menu_close' : 'menu_open')); });
    scrim.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); document.querySelectorAll('.switcher .menu:not([hidden])').forEach((m) => { m.hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false'); }); } });
    document.addEventListener('click', (e) => { if (!e.target.closest?.('.switcher')) document.querySelectorAll('.switcher .menu:not([hidden])').forEach((m) => { m.hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false'); }); });
    route();
  });
})();
