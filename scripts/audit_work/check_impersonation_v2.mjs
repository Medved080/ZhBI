// Регрессия режима «от имени» внутри ТОЙ ЖЕ вкладки V2.
// AUDIT_BASE и AUDIT_DB должны указывать на сервер с временной копией БД.
import { session, openScreen, sleep, sql1, check, summary, tap } from "./lib.mjs";

const base = process.env.AUDIT_BASE, db = process.env.AUDIT_DB;
if (!base || !db) throw new Error("Нужны AUDIT_BASE и AUDIT_DB тестового сервера");
const id = sql1(db, "SELECT id FROM users WHERE domain_login='user2'");
let b;
try {
  b = await session(base, "admin", { objectId: 1 });
  await openScreen(b, "users-access", `document.querySelector('#ua-rows')`);
  await tap(b, `.v2-table [data-user="${id}"]`);
  await b.waitFor(`!!document.querySelector('[data-tab=security]')`);
  await tap(b, "[data-tab=security]");
  await b.waitFor(`!!document.querySelector('#sec-impersonate')`);
  const n = b.requests.length;
  await tap(b, "#sec-impersonate");
  await b.waitFor(`!!document.querySelector('.v2-dialog [data-choice=confirm]')`);
  await tap(b, ".v2-dialog [data-choice=confirm]");
  await sleep(4000);
  const st = await b.eval(`({url:location.href,title:document.title,bar:document.querySelector('#v2-impersonation-bar')?.hidden,
    token:!!sessionStorage.getItem('zhbi_impersonate'),body:document.body.innerText.slice(0,500)})`);
  const req = b.requests.slice(n).filter((r) => /impersonate|\/me$|\/login$/.test(r.url))
    .map((r) => `${r.method} ${new URL(r.url).pathname} ${r.status}`);
  check("POST /impersonate выполнен ровно один раз", req.filter((x) => x.startsWith("POST /users/")).length === 1, req.join("; "));
  check("та же вкладка вошла в режим «от имени» и показала красную полосу", st.bar === false && st.token,
    JSON.stringify({ ...st, requests: req, exceptions: b.exceptions.slice(-3) }));
  if (st.bar === false) {
    await tap(b, "#v2-impersonation-exit");
    await b.waitFor(`document.querySelector('#v2-impersonation-bar')?.hidden===true && !sessionStorage.getItem('zhbi_impersonate')`, 15000);
    check("выход возвращает администратора", await b.eval(`fetch('/me').then(r=>r.json()).then(x=>x.domain_login)`) === "admin");
  }
} finally { await b?.close(); }
process.exit(summary("Режим отладки прав") ? 1 : 0);
