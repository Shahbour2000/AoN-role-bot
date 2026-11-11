(() => {
  const { t } = window.AON;
  const $ = (id) => document.getElementById(id);
  document.addEventListener('DOMContentLoaded', async () => {
    if (new URLSearchParams(location.search).get('error') === 'login_failed') $('login-error').hidden = false;
    // Both calls are best-effort and time-boxed: the page is fully usable (login link, dashboard link) if either fails or hangs.
    const get = (path) => fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    try {
      const pub = await (await get('/api/public')).json();
      if (typeof pub.inviteUrl === 'string' && pub.inviteUrl.startsWith('https://discord.com/')) for (const id of ['add-bot', 'add-bot-2']) $(id).href = pub.inviteUrl;
    } catch { /* keep the login fallback */ }
    try {
      const me = await get('/api/session');
      if (me.ok) { const b = $('login-btn'); b.href = '/app'; b.dataset.i18n = 'open_dashboard'; b.textContent = t('open_dashboard'); }
    } catch { /* anonymous */ }
  });
})();
