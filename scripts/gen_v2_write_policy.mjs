// Генерирует `Docs/v2-write-policy.md` — таблицу изменяющих операций V2 для ограниченного выпуска — ИЗ ТОЙ ЖЕ таблицы
// политики, по которой работает шлюз (`app/static/v2/write-gate.js`): документ и поведение не могут разойтись.
// Запуск: node scripts/gen_v2_write_policy.mjs
import { writeFileSync } from "node:fs";
import { POLICY } from "../app/static/v2/write-gate.js";

const human = (re) => re.source.replace(/^\^|\$$/g, "").replace(/\\d\+/g, "{id}").replace(/\[\^\/\]\+/g, "{ключ}").replace(/\[0-9-\]\+/g, "{дата}")
  .replace(/\\\//g, "/").replace(/\(\/\.\+\)\?/g, "[/…]").replace(/\(\/\{id\}\)\?/g, "[/{id}]").replace(/\(\?!smu\/\|subtype\/\|mark_prefix\/\)/g, "(кроме smu, subtype, mark_prefix)");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");

const allowed = POLICY.filter((r) => r.allowed);
const off = POLICY.filter((r) => !r.allowed);
const rows = (list) => list.map((r) => `| ${cell(r.screen)} | ${cell(r.action)} | \`${r.method} ${cell(human(r.path))}\`${r.onlyKeys ? ` (только поля: ${r.onlyKeys.join(", ")})` : ""} | ${cell(r.risk)} | ${cell(r.allowed ? r.proof : r.why)} |`).join("\n");

const md = `# Изменяющие операции V2 в ограниченном выпуске

*Файл создаётся скриптом \`scripts/gen_v2_write_policy.mjs\` из таблицы политики шлюза \`app/static/v2/write-gate.js\` — руками не править.*

Шлюз стоит в единственной точке отправки запросов V2 (\`api.js\`) и работает по принципу «запрещено всё, что не разрешено явно»:
изменяющий запрос, которого нет в первой таблице, до сервера не доходит. Решает не название метода, а фактический эффект:
POST-чтение отчётов (\`/reports/*\`), выгрузки (\`/export.xlsx\`, \`/export.pdf\`) и чтение (GET) шлюзом не ограничиваются; личные настройки
(гамма, цвет подписей, «Ознакомился») помечены как «личная» — они видны и в V1 у того же пользователя. Серверная авторизация действует
на все операции, разрешённые и нет; шлюз её не заменяет.

## Разрешено (${allowed.length})

| Экран | Действие | Запрос | Риск | Доказательство проверки |
| --- | --- | --- | --- | --- |
${rows(allowed)}

## Временно отключено (${off.length} групп; всё остальное, чего нет в таблице выше, отключено тоже)

| Экран | Действие | Запрос | Риск | Почему отключено |
| --- | --- | --- | --- | --- |
${rows(off)}

Пояснение на экране и переход в текущий интерфейс показывает оболочка (\`main.js\`); поля и кнопки отключённых операций на экранах
«Физлица», «Мои сеансы» и «Учёт по блокам» (прогноз, примечание) не показываются или заблокированы.
`;
writeFileSync(new URL("../Docs/v2-write-policy.md", import.meta.url), md, "utf-8");
console.log(`Docs/v2-write-policy.md: разрешено ${allowed.length}, отключено (групп) ${off.length}`);
