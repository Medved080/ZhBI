(() => {
  let started = false;
  window.CalcZhBIUpdates = {start({request, beforeReload}) {
    if (started) return; started = true;
    const root = document.getElementById('precast-concept');
    const notice = document.getElementById('pc-update-notice');
    const button = document.getElementById('pc-update-reload');
    let known = null, checking = false, timer;
    async function check() {
      if (checking || !notice.hidden || document.hidden) return;
      checking = true;
      try {
        const data = await request('/app-build', {cache:'no-store'});
        if (!data || typeof data.build !== 'string' || !data.build) return;
        if (known === null) {known = data.build; return;}
        if (data.build === known) return;
        document.getElementById('pc-update-version').textContent = data.version ? `v${data.version}` : '';
        notice.hidden = false; root.dataset.updateAvailable = 'true'; clearInterval(timer);
      } catch { /* The session notice handles 401; transient outages retry. */ }
      finally {checking = false;}
    }
    button.addEventListener('click', async () => {
      if (button.disabled) return; button.disabled = true;
      const message = document.getElementById('pc-update-status'); message.textContent = '';
      try {await beforeReload(); window.top.location.reload();}
      catch (error) {message.textContent = error.message || 'Не удалось сохранить изменения. Повторите сохранение перед обновлением.';}
      finally {button.disabled = false;}
    });
    timer = setInterval(check, 15000);
    document.addEventListener('visibilitychange', () => {if (!document.hidden) void check();});
    window.addEventListener('focus', () => void check());
    void check();
  }};
})();
