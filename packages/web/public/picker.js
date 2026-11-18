/*
 * Searchable entity picker (country / party / military unit), an accessible combobox.
 * Data comes ONLY from GET /api/guilds/:id/entities/:type (searched and paginated by the server). Option text is always a real game name.
 * Entities with a verified image (`imageUrl`, https only, set by the server) show it; everything else shows a neutral initials avatar.
 * Raw game IDs are never shown in the list; the only place an ID can be typed is the "enter manually" fallback.
 */
(() => {
  const { t, el, icon } = window.AON;
  const DEBOUNCE_MS = 250, PAGE = 20, ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  let uid = 0;

  const initials = (name) => { const w = Array.from(String(name).trim().split(/\s+/).filter(Boolean)); return ((w[0] ? Array.from(w[0])[0] : '') + (w[1] ? Array.from(w[1])[0] : '')).toUpperCase() || '?'; };
  const avatar = (name, url) => {
    const a = el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(name) });
    if (typeof url === 'string' && /^https:\/\//.test(url)) {          // image is drawn over the initials; if it fails to load the initials simply remain
      const img = el('img', { class: 'avatar-img', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }); img.addEventListener('error', () => img.remove()); a.append(img);
    }
    return a;
  };

  /**
   * opts: { type: 'country'|'party'|'unit', api, guildId, label, value, scoped?: boolean, getCountryId?: () => string|null, allowClear?: boolean, hint?: string }
   * returns { el, value(), refresh(), setValue(id, name?) }
   */
  function entityPicker(opts) {
    const id = `pk${++uid}`;
    const st = { value: opts.value || null, name: null, image: null, items: [], total: 0, offset: 0, loading: false, error: null, verified: true, loaded: false, needsQuery: false, open: false, active: -1, seq: 0, q: '' };
    const allowClear = opts.allowClear !== false;

    const hidden = el('input', { type: 'hidden', class: 'picker-value', value: st.value || '' });
    const input = el('input', { type: 'text', id: `${id}-in`, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, autocomplete: 'off', maxlength: 40, placeholder: t('pk_search'), class: 'picker-input' });
    const list = el('ul', { id: `${id}-list`, role: 'listbox', class: 'picker-list', hidden: true, 'aria-label': opts.label });
    const status = el('p', { class: 'picker-status muted hint', role: 'status', 'aria-live': 'polite' });
    const more = el('button', { class: 'btn sm', type: 'button', hidden: true, text: t('pk_more') });
    const retry = el('button', { class: 'btn sm', type: 'button', hidden: true, text: t('pk_retry') });
    const chip = el('div', { class: 'picker-selected', hidden: true });
    const manualId = el('input', { type: 'text', maxlength: 80, class: 'wide', id: `${id}-manual`, 'aria-label': t('pk_manual_id') });
    const manualBtn = el('button', { class: 'btn sm', type: 'button', text: t('pk_manual_apply') });
    const manualErr = el('p', { class: 'err', hidden: true, role: 'alert', text: t('pk_manual_bad') });
    const manual = el('details', { class: 'picker-manual' }, el('summary', { text: t('pk_manual') }), el('p', { class: 'muted hint', text: t('pk_manual_hint') }), el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', { for: `${id}-manual`, text: t('pk_manual_id') }), manualId), manualBtn), manualErr);
    const root = el('div', { class: 'picker', 'data-type': opts.type }, el('label', { for: `${id}-in`, text: opts.label }), chip, el('div', { class: 'picker-box' }, input, list), status, el('div', { class: 'row picker-actions' }, more, retry), opts.hint ? el('p', { class: 'muted hint', text: opts.hint }) : null, manual, hidden);

    const optId = (i) => `${id}-o${i}`;
    const say = (msg) => { status.textContent = msg || ''; };

    function drawChip() {
      chip.replaceChildren();
      chip.hidden = !st.value;
      if (!st.value) return;
      const nm = st.name || t('pk_selected_unknown');
      chip.append(avatar(st.name || '?', st.image), el('span', { class: 'picker-name' }, el('bdi', { text: nm })), el('span', { class: 'badge ok', text: t('pk_selected') }));
      if (allowClear) chip.append(el('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `${t('pk_clear')}: ${nm}`, onclick: () => { setValue(null, null, true); input.focus(); } }, icon('close')));
    }
    function drawList() {
      list.hidden = !st.open || (!st.items.length);
      input.setAttribute('aria-expanded', String(st.open && st.items.length > 0));
      list.replaceChildren(...st.items.map((o, i) => el('li', { id: optId(i), role: 'option', class: `picker-opt${i === st.active ? ' active' : ''}`, 'aria-selected': String(o.id === st.value), onmousedown: (e) => { e.preventDefault(); choose(i); } }, avatar(o.name, o.imageUrl), el('span', { class: 'picker-name' }, el('bdi', { text: o.name })), o.id === st.value ? icon('check') : null)));
      if (st.active >= 0) input.setAttribute('aria-activedescendant', optId(st.active)); else input.removeAttribute('aria-activedescendant');
      st.active >= 0 && list.children[st.active]?.scrollIntoView?.({ block: 'nearest' });
      more.hidden = !(st.open && !st.loading && st.items.length < st.total);
      retry.hidden = !st.error || st.error === 'country_required';
    }
    function describe() {
      if (st.loading) { root.setAttribute('aria-busy', 'true'); return say(t('pk_loading')); }
      root.removeAttribute('aria-busy');
      if (st.error === 'incomplete') return say(t('pk_unrecognized'));
      if (st.error === 'rate_limited') return say(t('pk_rate'));
      if (st.error === 'country_required') return say(t('pk_need_country'));
      if (st.error) return say(t('pk_error'));
      if (st.needsQuery) return say(t('pk_type_to_search'));
      if (!st.loaded) return say('');                                  // nothing searched yet: do not claim "no results"
      if (!st.items.length) return say(t('pk_empty'));
      say(`${t('pk_results', { n: st.total })}${st.verified ? '' : ` · ${t('pk_unverified')}`}`);
    }

    async function load(reset) {
      const mySeq = ++st.seq; st.loading = true; st.error = null; if (reset) { st.offset = 0; st.items = []; st.active = -1; } describe(); drawList();
      const qs = new URLSearchParams({ q: st.q, limit: String(PAGE), offset: String(reset ? 0 : st.items.length) });
      // `scoped`: the server lists ONLY the parties / units of this server's own country (no country is sent or accepted from the browser).
      const cid = !opts.scoped && opts.getCountryId ? opts.getCountryId() : null; if (cid) qs.set('countryId', cid);
      if (opts.type === 'party' && !cid && !opts.scoped) { st.loading = false; st.error = 'country_required'; describe(); drawList(); return; }
      const res = await opts.api('GET', `/api/guilds/${opts.guildId}/${opts.scoped ? 'country-entities' : 'entities'}/${opts.type}?${qs}`);
      if (mySeq !== st.seq) return;                                   // a newer search superseded this one
      st.loading = false; st.loaded = true;
      if (!res.ok) {
        const code = String(res.data?.error || '');
        st.error = code === 'game_incomplete' ? 'incomplete' : code === 'game_rate_limited' || code === 'rate_limited' ? 'rate_limited' : code === 'country_required' ? 'country_required' : 'error';
        if (st.error === 'incomplete') manual.open = true;           // list unusable: expose the manual fallback
      } else {
        const d = res.data; st.needsQuery = !!d.needsQuery; st.verified = d.verified !== false; st.total = d.total;
        st.items = reset ? d.items : st.items.concat(d.items);
      }
      describe(); drawList();
    }

    function setValue(v, name, notify, image) {
      st.value = v || null; st.name = v ? name || null : null; st.image = v ? image || null : null; hidden.value = st.value || '';
      st.open = false; input.value = ''; st.q = ''; drawChip(); drawList();
      if (notify) { root.dispatchEvent(new CustomEvent('picker:change', { bubbles: true, detail: { id: st.value, name: st.name } })); }
      if (st.value && !st.name) resolveName(st.value);
    }
    async function resolveName(v) {
      if (opts.scoped) return;                                          // the scoped list already carries the name; there is no per-id lookup
      const res = await opts.api('GET', `/api/guilds/${opts.guildId}/entities/${opts.type}/${encodeURIComponent(v)}`);
      if (res.ok && st.value === v && res.data.name) { st.name = res.data.name; drawChip(); }
    }
    function choose(i) { const o = st.items[i]; if (o) { setValue(o.id, o.name, true, o.imageUrl); say(t('pk_chosen', { name: o.name })); } }
    function openList() { if (!st.open) { st.open = true; if (!st.items.length && !st.loading) load(true); else drawList(); } }

    let timer = null;
    input.addEventListener('input', () => { st.open = true; st.q = input.value.trim(); clearTimeout(timer); timer = setTimeout(() => load(true), DEBOUNCE_MS); });
    input.addEventListener('focus', openList);
    input.addEventListener('click', openList);
    input.addEventListener('blur', () => { st.open = false; drawList(); });
    input.addEventListener('keydown', (e) => {
      const n = st.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!st.open) openList(); else if (n) { st.active = (st.active + 1) % n; drawList(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { st.active = st.active <= 0 ? n - 1 : st.active - 1; st.open = true; drawList(); } }
      else if (e.key === 'Home' && st.open && n) { e.preventDefault(); st.active = 0; drawList(); }
      else if (e.key === 'End' && st.open && n) { e.preventDefault(); st.active = n - 1; drawList(); }
      else if (e.key === 'Enter') { if (st.open && st.active >= 0) { e.preventDefault(); choose(st.active); } }
      else if (e.key === 'Escape') { if (st.open) { e.preventDefault(); e.stopPropagation(); st.open = false; drawList(); } else if (input.value) { input.value = ''; st.q = ''; } }
    });
    more.addEventListener('click', () => load(false));
    retry.addEventListener('click', () => load(true));
    manualBtn.addEventListener('click', () => { const v = manualId.value.trim(); if (!ID_RE.test(v)) { manualErr.hidden = false; return; } manualErr.hidden = true; manualId.value = ''; setValue(v, null, true); });
    // The language-switch restore writes the hidden field: follow it.
    hidden.addEventListener('input', () => { if (hidden.value !== (st.value || '')) { st.value = hidden.value || null; st.name = null; drawChip(); if (st.value) resolveName(st.value); } });

    drawChip(); if (st.value) resolveName(st.value); describe();
    return { el: root, value: () => st.value, refresh: () => { st.seq++; clearTimeout(timer); st.loading = false; root.removeAttribute('aria-busy'); st.items = []; st.total = 0; st.error = null; st.needsQuery = false; st.loaded = false; if (st.open) load(true); else { describe(); drawList(); } }, setValue: (v, n) => setValue(v, n, false) };
  }
  window.AON.entityPicker = entityPicker;

  /**
   * Searchable role picker (drop-in for a <select>): shows each role's real name and real Discord colour, filters locally (the list comes from the
   * server's /roles endpoint, which already contains only THIS server's roles). The element exposes `.value` and fires `change`, like a select.
   * opts: { roles: [{id,name,color,manageable,reason}], value, withNone, usedElsewhere:Set, label }
   */
  const BLOCKED = ['dangerous_permissions', 'everyone_role', 'integration_managed'];
  const hexOf = (n) => (n ? `#${Number(n).toString(16).padStart(6, '0')}` : '#99aab5');           // colour 0 = no colour: Discord shows grey
  function rolePicker(opts) {
    const id = `rp${++uid}`; const roles = opts.roles || []; const used = opts.usedElsewhere || new Set(); const withNone = opts.withNone !== false;
    let value = opts.value || ''; let q = ''; let open = false; let active = -1;
    const norm = (x) => String(x).toLowerCase();
    const byId = (v) => roles.find((r) => r.id === v);
    const blockedOf = (r) => BLOCKED.includes(r.reason);
    const takenOf = (r) => used.has(r.id) && r.id !== value;
    const noteOf = (r) => (blockedOf(r) ? t('role_blocked') : takenOf(r) ? t('role_used_elsewhere') : r.manageable === false ? `${t('role_unmanageable')} (${t(`r_${r.reason}`)})` : '');
    const dot = (r) => el('span', { class: 'role-dot', 'aria-hidden': 'true', style: `background:${hexOf(r.color)}` });
    const input = el('input', { type: 'text', class: 'rp-search', id: `${id}-in`, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, autocomplete: 'off', maxlength: 60, placeholder: t('rp_search') });
    const list = el('ul', { id: `${id}-list`, role: 'listbox', class: 'picker-list', hidden: true, 'aria-label': opts.label || t('rp_placeholder') });
    const chip = el('div', { class: 'picker-selected role-chip' });
    const root = el('div', { class: 'picker rolepick' }, chip, el('div', { class: 'picker-box' }, input, list));
    const visible = () => { const n = norm(q).trim(); return roles.filter((r) => !n || norm(r.name).includes(n)); };
    function paintChip() {
      chip.replaceChildren(); const r = byId(value);
      if (!value) { chip.append(el('span', { class: 'muted', text: t('role_none') })); return; }
      chip.append(r ? dot(r) : el('span', { class: 'role-dot', style: 'background:#99aab5' }), el('span', { class: 'picker-name' }, el('bdi', { text: r ? r.name : t('rp_unknown') })));
      if (withNone) chip.append(el('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `${t('pk_clear')}: ${r ? r.name : ''}`, onclick: () => set('', true) }, icon('close')));
    }
    function paintList() {
      const items = visible(); active = Math.min(active, items.length - 1);
      list.hidden = !open; input.setAttribute('aria-expanded', String(open));
      list.replaceChildren(...(items.length ? items.map((r, i) => {
        const dis = blockedOf(r) || takenOf(r); const note = noteOf(r);
        return el('li', { id: `${id}-o${i}`, role: 'option', class: `picker-opt${i === active ? ' active' : ''}${dis ? ' disabled' : ''}`, 'aria-selected': String(r.id === value), 'aria-disabled': String(dis), 'data-role-id': r.id,
          onmousedown: (e) => { e.preventDefault(); if (!dis) { set(r.id, true); open = false; paintList(); } } },
          dot(r), el('span', { class: 'picker-name' }, el('bdi', { text: r.name })), note ? el('span', { class: `badge ${dis ? '' : 'warn'}`, text: note }) : null, r.id === value ? icon('check') : null);
      }) : [el('li', { class: 'picker-opt empty', role: 'presentation', text: t('rp_none') })]));
      if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-o${active}`); else input.removeAttribute('aria-activedescendant');
    }
    function set(v, notify) { value = v || ''; q = ''; input.value = ''; paintChip(); paintList(); if (notify) root.dispatchEvent(new Event('change', { bubbles: true })); }
    input.addEventListener('input', () => { q = input.value; open = true; active = -1; paintList(); });
    input.addEventListener('focus', () => { open = true; paintList(); });
    input.addEventListener('click', () => { open = true; paintList(); });
    input.addEventListener('blur', () => { open = false; paintList(); });
    input.addEventListener('keydown', (e) => {
      const items = visible(); const n = items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); open = true; if (n) active = (active + 1) % n; paintList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); open = true; if (n) active = active <= 0 ? n - 1 : active - 1; paintList(); }
      else if (e.key === 'Enter') { if (open && active >= 0 && items[active] && !blockedOf(items[active]) && !takenOf(items[active])) { e.preventDefault(); set(items[active].id, true); open = false; paintList(); } }
      else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); open = false; paintList(); } }
    });
    Object.defineProperty(root, 'value', { get: () => value, set: (v) => set(v, false) });
    paintChip(); paintList();
    return root;
  }
  window.AON.rolePicker = rolePicker;
})();
