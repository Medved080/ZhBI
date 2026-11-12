// A failed business request is not proof of expiry: confirm against the shared session.
(() => {
  if (window.ZhBISessionNotice) return;
  const originalFetch = window.fetch.bind(window);
  const origin = new URL(document.baseURI).origin;
  let authenticated = false, checking = null, expired = false;
  async function show() {
    if (expired) return;
    expired = true;
    if (window.parent !== window) {
      try {
        const parentNotice = window.parent.ZhBISessionNotice;
        if (parentNotice) {await parentNotice.check(); if (parentNotice.expired) return;}
      } catch { /* A standalone frame can still show its own notice. */ }
    }
    const dialog = document.createElement('dialog');
    dialog.id = 'zhbi-session-expired';
    dialog.setAttribute('aria-labelledby', 'zhbi-session-title');
    dialog.setAttribute('aria-describedby', 'zhbi-session-description');
    dialog.setAttribute('role', 'alertdialog');
    dialog.style.cssText = 'max-width:min(520px,calc(100vw - 32px));padding:24px;border:1px solid var(--line,#ccd5df);border-radius:12px;background:var(--bg,#fff);color:var(--ink,#172b4d);font:16px/1.5 system-ui;box-shadow:0 12px 60px #0005';
    const title = document.createElement('h2');
    title.id = 'zhbi-session-title'; title.textContent = 'Сессия истекла';
    title.style.cssText = 'font-size:20px;margin:0 0 12px';
    const description = document.createElement('p');
    description.id = 'zhbi-session-description';
    description.textContent = 'Войдите снова, чтобы продолжить работу. Данные на экране больше не обновляются. Несохранённый ввод остаётся на странице до перехода ко входу.';
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Войти снова';
    button.style.cssText = 'font:inherit;min-height:40px;padding:8px 16px;border:0;border-radius:6px;background:var(--accent,#1851df);color:var(--accent-ink,#fff);cursor:pointer';
    button.addEventListener('click', () => window.top.location.reload());
    dialog.append(title, description, button);
    dialog.addEventListener('cancel', event => event.preventDefault());
    document.body.append(dialog); dialog.showModal();
    if (window.parent !== window) window.parent.postMessage({type:'zhbi-session-expired'}, origin);
  }
  async function check() {
    if (!authenticated || expired) return;
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await originalFetch('/me', {credentials:'same-origin',cache:'no-store'});
        if (response.status === 401) await show();
      } catch { /* Offline/5xx is not expiry. */ }
      finally { checking = null; }
    })();
    return checking;
  }
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, document.baseURI);
    if (url.origin !== origin) return response;
    if (response.ok && ['/me','/calc/api/auth/me','/login'].includes(url.pathname)) authenticated = true;
    if (response.status === 401 && url.pathname !== '/login') await check();
    return response;
  };
  window.addEventListener('message', event => {
    if (event.origin !== origin || event.data?.type !== 'zhbi-session-expired') return;
    if ([...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source)) void check();
  });
  window.ZhBISessionNotice = {check, get expired() {return expired;}};
})();
