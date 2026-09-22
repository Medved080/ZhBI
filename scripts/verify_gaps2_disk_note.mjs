// Проверка пункта 6 задания gaps2: предупреждение о нехватке места (main.js: warnAboutDiskSpace, перенос V1
// warnAboutDiskSpace()) — фоновый GET /admin/disk-space один раз при входе, баннер только при disk.message,
// закрывается крестиком, доступен только тем, кому виден раздел копий (system_admin или features.backups
// read/write).
//
// Реальное свободное место на тестовой машине заведомо больше порога (3 ГБ) — баннер в обычных условиях НЕ
// появится, это не проверка. Подменяем ТОЛЬКО ответ ЭТОГО ОДНОГО эндпоинта через window.fetch (инъекция
// СВОИМ скриптом через Page.addScriptToEvaluateOnNewDocument — существующим, ни для кого не общим, приёмом
// `b.send()` из cdp.mjs; сам cdp.mjs не трогаем), все остальные запросы (вход, /me, /me/permissions, экран)
// идут к НАСТОЯЩЕМУ backend как обычно — подменяется только то, что физически нельзя воспроизвести на тестовой
// машине (реальный дефицит места на диске).
import { launch } from "./cdp.mjs";

const base = process.argv[2] || "http://127.0.0.1:8250";
const PASSWORD = "Test-Pass-1234!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_DISK_CRITICAL = {
  known: true, level: "critical", reason: "том",
  message: "Критически мало места на диске: свободно 512.0 МБ из 100.0 ГБ — под копию базы (1.2 ГБ) его почти не осталось. Копия базы снимается перед КАЖДЫМ обновлением, до миграций: не хватит места — сервис не запустится.",
  total_bytes: 107374182400, used_bytes: 106900000000, free_bytes: 536870912, db_bytes: 1288490188,
};

async function injectFakeDiskSpace(b, payload) {
  // Подмена целиком в JS ДО загрузки страницы: реальный fetch() к этому конкретному пути не уходит в сеть вовсе
  // (b.requests его поэтому не увидит) — счётчик вызовов подмены читаем отдельно, через window.__diskSpaceCalls.
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      window.__diskSpaceCalls = 0;
      const orig = window.fetch;
      window.fetch = function(input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/admin/disk-space")) {
          window.__diskSpaceCalls++;
          return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(payload))}, { status: 200, headers: { "Content-Type": "application/json" } }));
        }
        return orig.apply(this, arguments);
      };
    })();
  ` });
}

async function loginAs(b, user) {
  await b.goto(`${base}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type(user);
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object')`, 20000);
  await sleep(700);
}

(async () => {
  let allOk = true;

  // 1) admin, диск «критично» (подменено) — баннер должен появиться, текст совпасть, крестик — скрыть
  {
    const b = await launch({ width: 1400, height: 900 });
    await injectFakeDiskSpace(b, FAKE_DISK_CRITICAL);
    await loginAs(b, "admin");
    await sleep(600);
    const hidden1 = await b.eval(`document.getElementById('v2-disk-note').hidden`);
    const text1 = await b.eval(`document.getElementById('v2-disk-note-text').textContent`);
    const critClass = await b.eval(`document.getElementById('v2-disk-note').classList.contains('v2-disk-note-critical')`);
    console.log("[admin] баннер скрыт сразу после входа:", hidden1, "(ожидание: false)");
    console.log("[admin] текст баннера совпал:", text1 === FAKE_DISK_CRITICAL.message);
    console.log("[admin] класс «критично» применён:", critClass);
    await b.clickSel("#v2-disk-note-x");
    await sleep(200);
    const hidden2 = await b.eval(`document.getElementById('v2-disk-note').hidden`);
    console.log("[admin] баннер скрыт после клика по крестику:", hidden2, "(ожидание: true)");
    // переход на другой экран НЕ должен вернуть баннер (V1: одна строка состояния, без повторного показа)
    await b.eval(`location.hash='#/projects-objects'`);
    await sleep(600);
    const hidden3 = await b.eval(`document.getElementById('v2-disk-note').hidden`);
    console.log("[admin] баннер остаётся скрытым после перехода на другой экран:", hidden3, "(ожидание: true)");
    const calls = await b.eval(`window.__diskSpaceCalls`);
    console.log("[admin] запросов к /admin/disk-space за весь сеанс:", calls, "(ожидание: 1 — только при входе)");
    allOk = allOk && !hidden1 && text1 === FAKE_DISK_CRITICAL.message && critClass && hidden2 && hidden3 && calls === 1;
    await b.close();
  }

  // 2) user4 (роль view, нет доступа к разделу копий) — запрос вообще не должен уйти
  {
    const b = await launch({ width: 1400, height: 900 });
    await injectFakeDiskSpace(b, FAKE_DISK_CRITICAL);
    await loginAs(b, "user4");
    await sleep(800);
    const calls = await b.eval(`window.__diskSpaceCalls`);
    console.log("[user4/view] запросов к /admin/disk-space:", calls, "(ожидание: 0 — нет доступа к разделу копий)");
    const hidden = await b.eval(`document.getElementById('v2-disk-note')?.hidden`);
    console.log("[user4/view] баннер скрыт:", hidden, "(ожидание: true)");
    allOk = allOk && calls === 0 && hidden !== false;
    await b.close();
  }

  console.log(allOk ? "ИТОГ: РАБОТАЕТ" : "ИТОГ: ЕСТЬ РАСХОЖДЕНИЯ");
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });
