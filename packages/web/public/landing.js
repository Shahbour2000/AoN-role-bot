(() => {
  const { t } = window.AON;
  document.addEventListener('DOMContentLoaded', async () => {
    if (new URLSearchParams(location.search).get('error') === 'login_failed') document.getElementById('login-error').hidden = false;
    try {
      const pub = await (await fetch('/api/public', { credentials: 'same-origin' })).json();
      if (typeof pub.inviteUrl === 'string' && pub.inviteUrl.startsWith('https://discord.com/')) document.getElementById('add-bot').href = pub.inviteUrl;
    } catch { /* keep the login fallback */ }
    try {
      const me = await fetch('/api/session', { credentials: 'same-origin' });
      if (me.ok) { const b = document.getElementById('login-btn'); b.href = '/app'; b.textContent = t('open_dashboard'); b.removeAttribute('data-i18n'); b.dataset.i18n = 'open_dashboard'; }
    } catch { /* anonymous */ }
  });
})();
