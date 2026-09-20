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
  check(err instanceof ApiError && err.status === 0, "сетевой сбой → ApiError(status 0), не английский TypeError");
  check(/связи с сервером/.test(err.detail), "текст сетевой ошибки читаем по-русски");
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


console.log("ApiError: читаемый текст для любых форм detail (не [object Object])");
{
  const text = (status, detail) => new ApiError(status, detail).detail;
  check(text(409, "Логин занят") === "Логин занят", "строка detail — как есть");
  const t422 = text(422, [{ loc: ["body", "name"], msg: "Field required", type: "missing" },
                          { loc: ["body", "lat"], msg: "Input should be a valid number", type: "float_parsing" }]);
  check(!t422.includes("[object") && t422.includes("name: обязательное поле") && t422.includes("lat: нужно число"), "422 со списком → «поле: причина» по-русски");
  check(text(422, [{ msg: "Что-то не так" }]).includes("Что-то не так"), "элемент списка без loc/type — msg сервера");
  check(text(400, { message: "Нельзя удалить" }) === "Нельзя удалить", "объект с message");
  check(text(400, { detail: "Вложенный текст" }) === "Вложенный текст", "объект с detail");
  check(text(400, { code: 7 }) === "Ошибка запроса", "объект без текста → общий текст, не [object Object]");
  check(text(500, "<html><body>Bad gateway</body></html>") === "Ошибка сервера (500). Повторите позже.", "HTML прокси не показывается пользователю");
  check(text(409, "Страж покрытия: " + "объяснение ".repeat(40)).includes("Страж покрытия: объяснение"), "длинный обычный текст сервера (409 стража) показывается, а не подменяется");
  check(text(500, "x".repeat(2000)).length === 1001 && text(500, "x".repeat(2000)).endsWith("…"), "заведомо огромный текст обрезается с многоточием");
  check(text(403, "") === "Недостаточно прав для этого действия.", "пустой detail при 403 — понятная причина");
  check(text(404, null).includes("Запись не найдена"), "пустой detail при 404");
  check(text(0, undefined).includes("Нет связи"), "status 0 — нет связи");
  check(new ApiError(422, [{ msg: "m" }]).message === new ApiError(422, [{ msg: "m" }]).detail, "message совпадает с detail");
  check(Array.isArray(new ApiError(422, [{ msg: "m" }]).rawDetail), "исходный detail сохранён в rawDetail");
}

console.log("HTTP-ответы через fetch: 422 и HTML 500");
{
  const p = api.post("/x", {});
  calls.pop().resolve({ ok: false, status: 422, statusText: "", text: async () => JSON.stringify({ detail: [{ loc: ["body", "name"], msg: "Field required", type: "missing" }] }) });
  let err = null; try { await p; } catch (e) { err = e; }
  check(err instanceof ApiError && err.status === 422 && err.detail.includes("name: обязательное поле"), "422 разобран в читаемый текст");
  const p2 = api.patch("/x", {});
  calls.pop().resolve({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "<html>oops</html>" });
  err = null; try { await p2; } catch (e) { err = e; }
  check(err instanceof ApiError && err.status === 500 && !err.detail.includes("<html>"), "HTML 500 не попадает в сообщение");
  check(!api.hasPendingWrites(), "после отказов счётчик опущен");
}

console.log(failures ? `\nПРОВАЛЕНО проверок: ${failures}` : "\nВсе проверки пройдены");
process.exit(failures ? 1 : 0);
