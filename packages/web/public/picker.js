/*
 * Searchable entity picker (country / party / military unit), an accessible combobox.
 * Data comes ONLY from GET /api/guilds/:id/entities/:type (searched and paginated by the server). Option text is always a real game name.
 * There is no image/flag: no sample has ever shown a verified image field, so a neutral initials avatar is drawn instead.
 * Raw game IDs are never shown in the list; the only place an ID can be typed is the "enter manually" fallback.
 */
(() => {
  const { t, el, icon } = window.AON;
  const DEBOUNCE_MS = 250, PAGE = 20, ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  let uid = 0;

  const initials = (name) => { const w = Array.from(String(name).trim().split(/\s+/).filter(Boolean)); return ((w[0] ? Array.from(w[0])[0] : '') + (w[1] ? Array.from(w[1])[0] : '')).toUpperCase() || '?'; };
  const avatar = (name) => el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(name) });

  /**
   * opts: { type: 'country'|'party'|'unit', api, guildId, label, value, getCountryId?: () => string|null, allowClear?: boolean, hint?: string }
   * returns { el, value(), refresh(), setValue(id, name?) }
   */
  function entityPicker(opts) {
    const id = `pk${++uid}`;
    const st = { value: opts.value || null, name: null, items: [], total: 0, offset: 0, loading: false, error: null, verified: true, loaded: false, needsQuery: false, open: false, active: -1, seq: 0, q: '' };
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
      chip.append(avatar(st.name || '?'), el('span', { class: 'picker-name' }, el('bdi', { text: nm })), el('span', { class: 'badge ok', text: t('pk_selected') }));
      if (allowClear) chip.append(el('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `${t('pk_clear')}: ${nm}`, onclick: () => { setValue(null, null, true); input.focus(); } }, icon('close')));
    }
    function drawList() {
      list.hidden = !st.open || (!st.items.length);
      input.setAttribute('aria-expanded', String(st.open && st.items.length > 0));
      list.replaceChildren(...st.items.map((o, i) => el('li', { id: optId(i), role: 'option', class: `picker-opt${i === st.active ? ' active' : ''}`, 'aria-selected': String(o.id === st.value), onmousedown: (e) => { e.preventDefault(); choose(i); } }, avatar(o.name), el('span', { class: 'picker-name' }, el('bdi', { text: o.name })), o.id === st.value ? icon('check') : null)));
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
      const cid = opts.getCountryId ? opts.getCountryId() : null; if (cid) qs.set('countryId', cid);
      if (opts.type === 'party' && !cid) { st.loading = false; st.error = 'country_required'; describe(); drawList(); return; }
      const res = await opts.api('GET', `/api/guilds/${opts.guildId}/entities/${opts.type}?${qs}`);
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

    function setValue(v, name, notify) {
      st.value = v || null; st.name = v ? name || null : null; hidden.value = st.value || '';
      st.open = false; input.value = ''; st.q = ''; drawChip(); drawList();
      if (notify) { root.dispatchEvent(new CustomEvent('picker:change', { bubbles: true, detail: { id: st.value, name: st.name } })); }
      if (st.value && !st.name) resolveName(st.value);
    }
    async function resolveName(v) {
      const res = await opts.api('GET', `/api/guilds/${opts.guildId}/entities/${opts.type}/${encodeURIComponent(v)}`);
      if (res.ok && st.value === v && res.data.name) { st.name = res.data.name; drawChip(); }
    }
    function choose(i) { const o = st.items[i]; if (o) { setValue(o.id, o.name, true); say(t('pk_chosen', { name: o.name })); } }
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
    return { el: root, value: () => st.value, refresh: () => { st.items = []; st.total = 0; st.error = null; st.needsQuery = false; st.loaded = false; if (st.open) load(true); else { describe(); drawList(); } }, setValue: (v, n) => setValue(v, n, false) };
  }
  window.AON.entityPicker = entityPicker;
})();
