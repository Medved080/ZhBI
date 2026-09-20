// Проверка app/static/v2/api.js без браузера и без БД: счётчик незавершённых
// записей (hasPendingWrites) должен учитывать И JSON-запросы, И загрузку
// файла (api.upload), не считать GET, и обязательно опускаться после отказа.
// Запуск: node scripts/verify_v2_api.mjs
import { api, ApiError } from "../app/static/v2/api.js";

let failures = 0;
function check(cond, label) {
  if (cond) console.log("  ok   " + label);
  else { failures++; console.log("  FAIL " + label); }
}

// Управляемый fetch: каждый вызов возвращает промис, который тест завершает сам.
const calls = [];
globalThis.fetch = (path, opts) => new Promise((resolve, reject) => {
  calls.push({ path, opts, resolve, reject });
});
const jsonResponse = (status, obj) => ({
  ok: status >= 200 && status < 300, status, statusText: "",
  text: async () => (obj === undefined ? "" : JSON.stringify(obj)),
});

console.log("GET не считается записью");
{
  const p = api.get("/x");
  check(!api.hasPendingWrites(), "во время GET hasPendingWrites=false");
  calls.pop().resolve(jsonResponse(200, { a: 1 }));
  check((await p).a === 1, "ответ GET разобран");
}

console.log("POST JSON: счётчик поднят до ответа и опущен после");
{
  const p = api.post("/x", { k: 1 });
  check(api.hasPendingWrites(), "во время POST hasPendingWrites=true");
  const c = calls.pop();
  check(c.opts.headers && c.opts.headers["Content-Type"] === "application/json", "у JSON выставлен Content-Type");
  check(c.opts.body === JSON.stringify({ k: 1 }), "тело JSON сериализовано");
  c.resolve(jsonResponse(200, { ok: true }));
  await p;
  check(!api.hasPendingWrites(), "после ответа hasPendingWrites=false");
}

console.log("upload (FormData): считается записью, Content-Type не трогается");
{
  const fd = new FormData();
  fd.append("entity_type", "object");
  fd.append("file", new Blob(["abc"]), "a.txt");
  const p = api.upload("/attachments", fd);
  check(api.hasPendingWrites(), "во время закачки hasPendingWrites=true (иначе смена раздела не блокируется)");
  const c = calls.pop();
  check(c.opts.method === "POST", "метод POST");
  check(c.opts.body === fd, "FormData передан как есть, не в JSON");
  check(c.opts.headers === undefined, "заголовки не заданы — boundary выставит браузер");
  c.resolve(jsonResponse(200, { attachments: [{ id: 1 }] }));
  check((await p).attachments.length === 1, "ответ загрузки разобран");
  check(!api.hasPendingWrites(), "после закачки hasPendingWrites=false");
}

console.log("upload: отказ сервера опускает счётчик и даёт ApiError с detail");
{
  const p = api.upload("/attachments", new FormData());
  check(api.hasPendingWrites(), "во время закачки счётчик поднят");
  calls.pop().resolve(jsonResponse(413, { detail: "Файл слишком большой" }));
  let err = null;
  try { await p; } catch (e) { err = e; }
  check(err instanceof ApiError && err.status === 413 && err.detail === "Файл слишком большой", "ApiError(413, detail)");
  check(!api.hasPendingWrites(), "после отказа счётчик опущен");
}

console.log("upload: сетевой сбой опускает счётчик");
{
  const p = api.upload("/attachments", new FormData());
  calls.pop().reject(new TypeError("Failed to fetch"));
  let err = null;
  try { await p; } catch (e) { err = e; }
  check(err instanceof TypeError, "сетевая ошибка проброшена");
  check(!api.hasPendingWrites(), "после сетевого сбоя счётчик опущен");
}

console.log("две параллельные записи: счётчик не падает раньше времени");
{
  const p1 = api.patch("/a", {}), p2 = api.upload("/b", new FormData());
  const c2 = calls.pop(), c1 = calls.pop();
  c1.resolve(jsonResponse(200, {}));
  await p1;
  check(api.hasPendingWrites(), "после первой записи вторая ещё в пути — true");
  c2.resolve(jsonResponse(200, {}));
  await p2;
  check(!api.hasPendingWrites(), "обе завершены — false");
}

console.log(failures ? `\nПРОВАЛЕНО проверок: ${failures}` : "\nВсе проверки пройдены");
process.exit(failures ? 1 : 0);
