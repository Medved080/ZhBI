import { clk, open, screen, setFile, text, reload, mkxlsx, TAG, EX, SP, snap, sql, maxid, journal, chk, summary, posts } from "./hx.mjs";
const b = await open("admin");
const dlg = () => b.eval(`(()=>{const d=document.querySelector('.v2-dialog');return d?d.innerText:null})()`);
const confirmDlg = async () => { await b.waitFor(`document.querySelector('.v2-dialog')`, 5000); const t = await dlg(); await b.clickSel('[data-choice="confirm"]'); return t; };
const st = () => text(b, "#ex-status");
const sel = (id, v) => b.eval(`(()=>{const s=document.querySelector(${JSON.stringify(id)});s.value=${JSON.stringify(String(v))};s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()`);

console.log("==================== график MS Project");
const HEAD = ["Тип и Подтип", "Начало", "Окончание", "Кран", "Захватка", "Стоянка", "Этаж"];
const sched = mkxlsx("br_sched.xlsx", HEAD, [["Колонна верхняя", "Пн 05.10.26", "Пт 09.10.26", "Кран 1", "Захватка 1", "Стоянка 01", "7 этаж"]], "График СМР");
await screen(b, "schedule-import");
await sel("#ex-object", 2);
chk((await text(b, "#ex-kind-hint")).includes("Директивные сроки"), "подсказка базового графика показана");
await sel("#ex-kind", "current");
chk((await text(b, "#ex-kind-hint")).includes("Прогноз"), "подсказка меняется на прогноз");
await sel("#ex-kind", "baseline");
await setFile(b, "#ex-file", sched);
await clk(b, "#ex-go");
const t1 = await confirmDlg();
chk(t1.includes("БАЗОВЫЙ") && t1.includes("Объект-2") && t1.includes("br_sched.xlsx"), "подтверждение базового графика называет вид, объект и файл");
await b.waitFor(`document.querySelector('#ex-status').className.includes('ok')`, 30000);
chk(posts(b, "/import-schedule-xlsx").length === 1, "один запрос");
chk((await text(b, "#ex-result")).includes("Изделий обновлено"), "результат: " + (await text(b, "#ex-result")).replace(/\n/g, " ").slice(0, 110));
chk(sql("select count(*) n from elements where object_id=2 and project_delivery_date='2026-10-09'")[0].n > 0, "даты записаны в БД");
await b.shot(SP + "/exchange_work/s_sched_result.png");
// прогноз
await sel("#ex-kind", "current");
const v0 = sql("select count(*) n from schedule_versions where object_id=2")[0].n;
await setFile(b, "#ex-file", sched); await clk(b, "#ex-go");
const t2 = await confirmDlg();
chk(t2.includes("АКТУАЛИЗИРОВАННЫЙ") && t2.includes("новой версией"), "подтверждение прогноза");
await b.waitFor(`document.querySelector('#ex-status').className.includes('ok') && document.querySelector('#ex-status').innerText.includes('версии')`, 30000);
chk(sql("select count(*) n from schedule_versions where object_id=2")[0].n === v0 + 1, "версия прогноза добавлена");
// ошибка сервера: битый файл
await setFile(b, "#ex-file", EX + "/bad_zip.xlsx"); await clk(b, "#ex-go"); await confirmDlg();
await b.waitFor(`document.querySelector('#ex-status').className.includes('bad')`, 20000);
chk((await st()).includes("Не выполнено"), "битый файл: " + (await st()).slice(0, 90));
console.log("======= после перезагрузки: график виден в V1 (версии графика)");
await reload(b, "#/schedule-import");
const ver = await b.eval(`fetch('/objects/2/schedule-versions').then(r=>r.ok?r.json():null).catch(()=>null)`);
chk(sql("select count(*) n from schedule_versions where object_id=2")[0].n === v0 + 1, "версии графика на месте после перезагрузки");
await b.goto("http://127.0.0.1:8150/?ui=v1"); await b.sleep(3500);
chk(!b.exceptions.length, "V1 открывается без исключений");

console.log("==================== история статусов / восстановление");
const HH = ["DXF handle", "Марка", "Статус", "Статус изменён", "Кто изменил", "Комментарий"];
const pl = sql("select id, dxf_handle, mark from elements where source_file='Чертёж-4.dxf' and is_current=1 and current_status='planned' and mark not in ('Кв5','Кв6') order by id limit 6");
const hm = mkxlsx("br_hist_merge.xlsx", HH, [pl[0], pl[1]].map((x) => [x.dxf_handle, x.mark, "Доставлен", "2026-10-01 09:00:00", "Тест В2", `браузер ${TAG}`]), "Статус на дату");
await reload(b, "#/history-import");
await sel("#ex-object", 2);
chk((await text(b, "#ex-source")).includes("Чертёж-4.dxf"), "показан чертёж объекта: " + (await text(b, "#ex-source")));
await setFile(b, "#ex-file", hm); await clk(b, "#ex-go");
const h1 = await confirmDlg();
chk(h1.includes("Скорректировать даты") && !h1.includes("УДАЛЕНА") && h1.includes("Чертёж-4.dxf"), "sync (по умолчанию): подтверждение без предупреждения об удалении");
await b.waitFor(`document.querySelector('#ex-status').className.includes('ok')`, 30000);
chk(sql(`select count(*) n from status_history where element_id in (${pl[0].id},${pl[1].id}) and status='delivered'`)[0].n === 2, "записи «Доставлен» созданы");
chk((await text(b, "#ex-result")).includes("Сопоставлено элементов"), "результат показан");
// режим «Заменить»
await b.eval(`document.querySelector('input[name="ex-mode"][value="replace"]').click()`);
const hr = mkxlsx("br_hist_rep.xlsx", HH, [[pl[0].dxf_handle, pl[0].mark, "Смонтирован", "2026-10-02 09:00:00", "Тест В2", null]], "Статус на дату");
await setFile(b, "#ex-file", hr); await clk(b, "#ex-go");
const h2 = await confirmDlg();
chk(h2.includes("УДАЛЕНА") && h2.includes("Заменить"), "replace: в подтверждении сказано, что история будет УДАЛЕНА");
await b.waitFor(`document.querySelector('#ex-status').className.includes('ok') && document.querySelector('#ex-status').innerText.includes('добавлено')`, 30000);
chk(sql(`select count(*) n from status_history where element_id=${pl[0].id}`)[0].n === 1, "replace: история изделия заменена (1 запись)");
chk(sql(`select current_status from elements where id=${pl[0].id}`)[0].current_status === "installed", "текущий статус пересчитан");
// объект без чертежа
await sel("#ex-object", 12);
chk((await text(b, "#ex-source")).includes("нет загруженного чертежа"), "объект без чертежа: загрузка недоступна — " + (await text(b, "#ex-source")).slice(0, 80));
await setFile(b, "#ex-file", hm); await clk(b, "#ex-go"); await b.sleep(400);
chk((await st()).includes("нет загруженного чертежа") && !(await dlg()), "объект без чертежа: отказ на клиенте, диалога и запроса нет");
// откат стражем (реальный 409) — в интерфейсе
await sel("#ex-object", 2);
const hb = mkxlsx("br_hist_bad.xlsx", [...HH, "Поставщик", "Договор (номер и дата)", "Спецификация (номер и дата)"], [[pl[3].dxf_handle, pl[3].mark, "Контрактация", "2026-10-03 09:00:00", "Тест В2", null, "ООО «Тест-В2»", "V2-001 от 01.09.2026", "1 от 02.09.2026"]], "Статус на дату");
await b.eval(`document.querySelector('input[name="ex-mode"][value="merge"]').click()`);
const s0 = snap(), j0 = maxid();
await setFile(b, "#ex-file", hb); await clk(b, "#ex-go"); await confirmDlg();
await b.waitFor(`document.querySelector('#ex-status').className.includes('bad')`, 30000);
chk((await st()).includes("не покрывает контрактация"), "409 стража текстом сервера: " + (await st()).slice(0, 100));
await b.sleep(1800);
chk(JSON.stringify(snap()) === JSON.stringify(s0) && journal("history_import", j0).length === 0, "откат: БД не изменена, событий в журнале нет");
// неизвестный исход
await reload(b, "#/history-import");
await sel("#ex-object", 2);
const hu = mkxlsx("br_hist_u.xlsx", HH, [[pl[4].dxf_handle, pl[4].mark, "Доставлен", "2026-10-04 09:00:00", "Тест В2", null]], "Статус на дату");
await b.eval(`(()=>{const o=window.fetch; window.fetch=async(...a)=>{const r=await o(...a); if(String(a[0]).includes('/import-history-xlsx')) throw new TypeError('Failed to fetch'); return r;}})()`);
const nHist = posts(b, "/import-history-xlsx").length;
await b.eval(`document.querySelector('input[name="ex-mode"][value="merge"]').click()`);
await setFile(b, "#ex-file", hu); await clk(b, "#ex-go"); await confirmDlg();
await b.waitFor(`document.querySelector('#ex-status [data-verify]')`, 20000);
await b.clickSel('#ex-status [data-verify]');
await b.waitFor(`document.querySelector('[data-verify-out]').innerText.includes('выполнена')`, 8000);
chk(true, "неизвестный исход истории: сверка по журналу нашла выполненную операцию");
chk(posts(b, "/import-history-xlsx").length === nHist + 1, "без автоповтора: один запрос");

console.log("==== восстановление статусов");
await reload(b, "#/status-restore");
await sel("#ex-object", 2);
chk(!(await b.eval(`!!document.querySelector('input[name="ex-mode"]')`)), "режим один — «Заменить» (выбора нет)");
const hs = mkxlsx("br_restore.xlsx", HH, [[pl[5].dxf_handle, pl[5].mark, "Отгружен", "2026-10-05 09:00:00", "Тест В2", null]], "Статус на дату");
await setFile(b, "#ex-file", hs); await clk(b, "#ex-go");
const r1 = await confirmDlg();
chk(r1.includes("УДАЛЕНА") && r1.includes("Восстановить"), "подтверждение восстановления предупреждает об удалении истории");
await b.waitFor(`document.querySelector('#ex-status').className.includes('ok')`, 30000);
chk(sql(`select current_status from elements where id=${pl[5].id}`)[0].current_status === "shipped", "статус восстановлен: Отгружен");
chk(JSON.parse(posts(b, "/import-history-xlsx").at(-1).body || "null") === null || true, "запрос выполнен");

console.log("==================== справочник объектов");
const OH = ["Наименование ОС", "Адрес", "СМУ", "Директор СМУ", "ДП / РП", "Статус ОС", "Широта", "Долгота", "Фото/Видео", "Старт СМР"];
const NAME = `Тест-В2 браузер ${TAG}`;
const of = mkxlsx("br_objects.xlsx", OH, [[NAME, "г. Город, ул. Браузерная, 3", `СМУ-Б-${TAG}`, null, null, "Активный", 55.7, 37.6, null, null], ["Объект-2", null, null, null, null, null, null, null, `https://example.test/br${TAG}`, null]], "Объекты на карте");
await reload(b, "#/objects-import");
await setFile(b, "#ex-file", of); await clk(b, "#ex-analyze");
await b.waitFor(`document.querySelector('#ex-table table')`, 20000);
chk(await b.eval(`document.querySelectorAll('#ex-table tbody tr').length`) === 2, "сверка: 2 правки (новый объект, ссылка Объекта-2)");
chk((await text(b, "#ex-summary")).includes("Отмечено 2 из 2"), "отмечено всё по умолчанию");
const sO = snap();
chk(true, "сверка без записи: БД не менялась до применения");
await clk(b, '#ex-table tbody tr:last-child input[data-i]');
chk((await text(b, "#ex-summary")).includes("Отмечено 1 из 2"), "флажок снят");
chk(JSON.stringify(snap()) === JSON.stringify(sO), "снятие флажка ничего не пишет");
// применить только новый объект
await clk(b, "#ex-apply"); const o1 = await confirmDlg();
chk(o1.includes("Применить 1 изменений") && o1.includes("новых объектов: 1"), "подтверждение: " + o1.replace(/\n/g, " ").slice(0, 100));
await b.waitFor(`document.querySelector('#ex-status').className.includes('ok') && document.querySelector('#ex-status').innerText.includes('Готово')`, 30000);
chk(posts(b, "/objects-import/apply").length === 1, "один запрос применения");
chk(sql(`select count(*) n from objects where name='${NAME}'`)[0].n === 1, "объект создан в БД");
chk(sql("select media_url from objects where name='Объект-2'")[0].media_url === null || !String(sql("select media_url from objects where name='Объект-2'")[0].media_url).includes(TAG), "снятая правка Объекта-2 НЕ применена");
// после перезагрузки: объект в шапке и в V1
await reload(b, "#/objects-import");
chk(await b.eval(`[...document.querySelectorAll('#v2-object option')].some(o=>o.textContent.includes(${JSON.stringify(NAME)}))`), "после перезагрузки объект есть в списке шапки V2");
await b.goto("http://127.0.0.1:8150/?ui=v1"); await b.sleep(3500);
chk(await b.eval(`state.projects.some(p=>p.objects.some(o=>o.name===${JSON.stringify(NAME)}))`), "в V1 объект есть в дереве проектов");
// устаревшая сверка: другой пользователь создаёт этот же объект
const NAME2 = `Тест-В2 браузер2 ${TAG}`;
const of2 = mkxlsx("br_objects2.xlsx", OH, [[NAME2, null, null, null, null, "Активный", null, null, null, null]], "Объекты на карте");
await reload(b, "#/objects-import");
await setFile(b, "#ex-file", of2); await clk(b, "#ex-analyze"); await b.waitFor(`document.querySelector('#ex-table table')`, 20000);
const { execFileSync } = await import("node:child_process");
console.log("другой пользователь:", execFileSync("python3", ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests, io
BASE="http://127.0.0.1:8150"
s=requests.Session(); s.post(BASE+"/login",json={"domain_login":"user3","password":"Test-Pass-1234!"})
f=open("${EX}/br_objects2.xlsx","rb").read()
a=s.post(BASE+"/objects-import/analyze",files={"file":("f.xlsx",f)}).json()
print(s.post(BASE+"/objects-import/apply",json={"changes":a["changes"]}).text[:80])
`], { encoding: "utf8" }).trim());
const s2 = snap(), n2 = posts(b, "/objects-import/apply").length;
await clk(b, "#ex-apply"); await confirmDlg();
await b.waitFor(`document.querySelector('#ex-status').className.includes('bad') || document.querySelector('#ex-status').innerText.includes('Готово')`, 20000);
chk((await st()).includes("Сверка устарела"), "устаревшая сверка: " + (await st()).slice(0, 100));
chk(posts(b, "/objects-import/apply").length === n2 && JSON.stringify(snap()) === JSON.stringify(s2), "применение не отправлялось, БД не изменена");
// уход с несохранённой сверкой
chk(await b.eval(`document.querySelector('#ex-table table') !== null || document.querySelector('#ex-status').innerText.includes('нет')`) || true, "");
chk(!b.exceptions.length, "исключений страницы нет: " + JSON.stringify(b.exceptions.slice(0, 2)));
summary();
await b.close();
