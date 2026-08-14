import fs from "node:fs/promises";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const outputDir = "/Users/max/zhbi-tool/outputs/ai_services_comparison";
const outputPath = `${outputDir}/Сравнение_AI_сервисов.xlsx`;

const wb = Workbook.create();
const summary = wb.worksheets.add("Итог");
const features = wb.worksheets.add("Функции");
const costs = wb.worksheets.add("Стоимость");
const security = wb.worksheets.add("Безопасность");
const sources = wb.worksheets.add("Источники");

const COLORS = {
  navy: "#17324D",
  blue: "#2E6F9E",
  paleBlue: "#EAF2F8",
  green: "#2F855A",
  paleGreen: "#E8F5EE",
  amber: "#B7791F",
  paleAmber: "#FFF4D6",
  red: "#B83232",
  paleRed: "#FDECEC",
  gray: "#667085",
  paleGray: "#F2F4F7",
  border: "#D0D5DD",
  white: "#FFFFFF",
  text: "#1F2937",
};

function styleTitle(sheet, range, title, subtitle) {
  sheet.getRange(range).merge();
  const topLeft = range.split(":")[0];
  sheet.getRange(topLeft).values = [[title]];
  sheet.getRange(range).format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 20 },
    verticalAlignment: "center",
    horizontalAlignment: "left",
  };
  const startRow = Number(topLeft.match(/\d+/)[0]) + 1;
  const cols = range.split(":").map(x => x.match(/[A-Z]+/)[0]);
  const subRange = `${cols[0]}${startRow}:${cols[1]}${startRow}`;
  sheet.getRange(subRange).merge();
  sheet.getRange(`${cols[0]}${startRow}`).values = [[subtitle]];
  sheet.getRange(subRange).format = {
    fill: COLORS.paleBlue,
    font: { color: COLORS.gray, italic: true, size: 10 },
    verticalAlignment: "center",
    wrapText: true,
  };
}

function styleHeader(range) {
  range.format = {
    fill: COLORS.blue,
    font: { bold: true, color: COLORS.white, size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
}

function styleBody(range) {
  range.format = {
    font: { color: COLORS.text, size: 10 },
    verticalAlignment: "top",
    wrapText: true,
    borders: {
      insideHorizontal: { style: "thin", color: COLORS.border },
      bottom: { style: "thin", color: COLORS.border },
    },
  };
}

function addOverlapFormatting(range) {
  range.conditionalFormats.add("containsText", { text: "Высокое", format: { fill: COLORS.paleRed, font: { color: COLORS.red, bold: true } } });
  range.conditionalFormats.add("containsText", { text: "Среднее", format: { fill: COLORS.paleAmber, font: { color: COLORS.amber, bold: true } } });
  range.conditionalFormats.add("containsText", { text: "Низкое", format: { fill: COLORS.paleGreen, font: { color: COLORS.green, bold: true } } });
  range.conditionalFormats.add("containsText", { text: "Нет", format: { fill: COLORS.paleBlue, font: { color: COLORS.blue, bold: true } } });
}

// ---------- Функции ----------
styleTitle(features, "A1:H1", "Сравнение функциональности", "Степень пересечения оценивается относительно уже внедрённого Битрикс24. Высокое = почти полное дублирование; низкое/нет = новая ценность.");
const featureRows = [
  ["AI-инструменты", "Универсальный AI-чат", "Да", "Да", "Да", "Высокое", "Высокое", "Все три решения дают диалог с AI; в Битрикс24 он встроен в рабочий портал."],
  ["AI-инструменты", "Генерация и редактирование текстов", "Да", "Да", "Да", "Высокое", "Высокое", "Письма, резюме, перевод, изменение тона и подготовка черновиков."],
  ["AI-инструменты", "Выбор нескольких LLM", "Частично", "Да", "Да, ключевая функция", "Среднее", "Низкое", "Daisy выделяется доступом к ChatGPT, Claude, Gemini, Grok и мультимедийным моделям."],
  ["Документы", "Анализ документов и файлов", "Частично", "Да", "Да", "Среднее", "Среднее", "В Битрикс24 AI работает прежде всего с объектами портала; внешние файлы сильнее раскрыты у Искры и Daisy."],
  ["Документы", "Сравнение версий документов", "Не основной сценарий", "Да", "Да", "Низкое", "Низкое", "Дополнительная ценность обоих внешних сервисов."],
  ["Знания", "Корпоративная база знаний с AI-поиском", "Да", "Да, центральная функция", "RAG заявлен", "Высокое", "Среднее", "Для Daisy готовность разграниченной базы знаний требует подтверждения."],
  ["Знания", "Ответы со ссылками на корпоративный источник", "Да", "Да", "Не подтверждено", "Высокое", "Низкое", "У Искры это основной сценарий; у Daisy в deck описан RAG-движок, но не пользовательский сценарий."],
  ["Исследования", "Веб-поиск с источниками", "Ограниченно", "Да", "Да", "Среднее", "Среднее", "Искра и Daisy ориентированы на внешние исследования сильнее BitrixGPT."],
  ["Исследования", "Deep Research", "Не основной сценарий", "Да", "Да", "Низкое", "Низкое", "Отдельная новая ценность при подготовке исследований и обзоров."],
  ["Данные", "Анализ Excel/CSV", "BI и данные портала", "Да", "Да", "Среднее", "Среднее", "Искра заявляет аномалии, воронки и когорты; Daisy — анализ файлов и код."],
  ["Данные", "Запуск кода в изолированной среде", "Нет", "Да", "Не подтверждено", "Нет", "Нет", "У Daisy подтверждено написание кода, но не выполнение в sandbox."],
  ["Контент", "Генерация изображений", "Да", "Да", "Да", "Высокое", "Высокое", "Daisy предлагает больше специализированных моделей и операций с изображениями."],
  ["Контент", "Генерация видео и музыки", "Нет", "Частично", "Да", "Низкое", "Нет", "Сильная отличительная функция Daisy: Runway, Veo, Suno."],
  ["CRM", "CRM, лиды и сделки", "Да", "Нет, интеграция", "Нет", "Нет", "Нет", "Битрикс24 остаётся системой учёта; внешние сервисы её не заменяют."],
  ["CRM", "Расшифровка и анализ клиентских звонков", "Да", "Через загрузку/интеграцию", "Не заявлено", "Среднее", "Нет", "BitrixGPT нативно заполняет CRM и анализирует скрипты продаж."],
  ["Коммуникации", "Резюме видеовстреч и договорённостей", "Да", "Да", "Не заявлено", "Высокое", "Нет", "BitrixGPT Follow-up встроен непосредственно в звонки и чаты."],
  ["Работа", "Задачи и проекты", "Полноценная система", "AI-проекты", "Контекстные AI-проекты", "Среднее", "Среднее", "AI-проекты не заменяют управление сроками, ролями и загрузкой в Битрикс24."],
  ["Работа", "Автономные задачи по расписанию", "Бизнес-процессы", "Да", "Не заявлено", "Среднее", "Нет", "Искра выделяется агентами, которые выполняют регулярные задания."],
  ["Интеграции", "1С, CRM, почта, календарь, Confluence", "Маркетплейс/API", "Заявлены через MCP", "Не заявлены", "Среднее", "Нет", "Готовность каждого коннектора Искры нужно проверять пилотом."],
  ["Интеграции", "Нативные действия внутри Битрикс24", "Да", "Требует интеграции", "Не заявлено", "Высокое", "Нет", "Сильная сторона BitrixGPT — результат AI сразу превращается в объект портала."],
  ["Администрирование", "Роли, группы и лимиты", "Да", "Да", "Да", "Высокое", "Высокое", "Базовые корпоративные функции присутствуют во всех решениях."],
  ["Безопасность", "On-premise", "Да, коробка", "Да", "Локальные модели/изолированные серверы по запросу", "Среднее", "Низкое", "У Daisy полная локальность всей платформы требует договорного подтверждения."],
  ["Безопасность", "Маскирование ПДн перед LLM", "Не заявлено универсально", "Да, заявлено", "Да, заявлено", "Низкое", "Низкое", "Коммерческая тайна шире персональных данных и может не распознаваться PII-фильтром."],
  ["Безопасность", "Защита от prompt injection", "Публично не раскрыта", "Да, заявлена", "Не подтверждено", "Низкое", "Нет", "Для агентов и RAG это отдельный важный механизм."],
  ["Безопасность", "AI-аудит и экспорт в SIEM", "Журналирование портала", "Да, заявлено", "Отчёты об использовании", "Низкое", "Низкое", "Нужны демонстрация и описание состава логов, сроков хранения и ролей доступа."],
];
features.getRange("A4:H4").values = [["Категория", "Функция", "Битрикс24 + BitrixGPT", "Искра", "Daisy Teams", "Пересечение Искры с Битрикс24", "Пересечение Daisy с Битрикс24", "Комментарий"]];
styleHeader(features.getRange("A4:H4"));
features.getRange(`A5:H${4 + featureRows.length}`).values = featureRows;
styleBody(features.getRange(`A5:H${4 + featureRows.length}`));
addOverlapFormatting(features.getRange(`F5:G${4 + featureRows.length}`));
features.getRange("A5:A29").format.font = { bold: true, color: COLORS.navy, size: 10 };
features.freezePanes.freezeRows(4);
features.freezePanes.freezeColumns(2);
features.showGridLines = false;
features.getRange("A:A").format.columnWidth = 16;
features.getRange("B:B").format.columnWidth = 34;
features.getRange("C:E").format.columnWidth = 23;
features.getRange("F:G").format.columnWidth = 19;
features.getRange("H:H").format.columnWidth = 52;
features.getRange("1:1").format.rowHeight = 34;
features.getRange("2:2").format.rowHeight = 36;
features.getRange("4:4").format.rowHeight = 44;
features.getRange("5:29").format.rowHeight = 42;

// ---------- Стоимость ----------
styleTitle(costs, "A1:H1", "Стоимость лицензий и сценарии", "Цены актуальны на 13.08.2026. Тарифы различаются по лимитам и не являются полностью эквивалентными. Жёлтые ячейки — редактируемые допущения.");
costs.getRange("A4:B8").values = [
  ["Параметр сценария", "Значение"],
  ["Количество сотрудников", 50],
  ["Daisy, ₽/польз./мес.", 3000],
  ["Искра, выбранный пакет ₽/мес.", 14000],
  ["BitrixGPT, подписка ₽/год", 60000],
];
styleHeader(costs.getRange("A4:B4"));
styleBody(costs.getRange("A5:B8"));
costs.getRange("B5:B8").format.fill = COLORS.paleAmber;
costs.getRange("B6:B8").format.numberFormat = "#,##0 [$₽-ru-RU]";
costs.getRange("B5").format.numberFormat = "#,##0";
costs.getRange("D4:F4").values = [["Сервис", "Стоимость в год", "Комментарий"]];
styleHeader(costs.getRange("D4:F4"));
costs.getRange("D5:D7").values = [["Битрикс24 + BitrixGPT"], ["Искра"], ["Daisy Teams"]];
costs.getRange("E5:E7").formulas = [["=$B$8"], ["=$B$7*12"], ["=$B$5*$B$6*12"]];
costs.getRange("F5:F7").values = [
  ["Инкрементальная стоимость для уже купленного портала; выбран стандартный тариф КП-250."],
  ["В сценарии выбран облачный пакет M; число участников не ограничено, расходуется общий пул токенов."],
  ["Оплата за каждое рабочее место; превышение лимитов оплачивается дополнительно."],
];
styleBody(costs.getRange("D5:F7"));
costs.getRange("E5:E7").format.numberFormat = "#,##0 [$₽-ru-RU]";

costs.getRange("A11:D11").values = [["Искра — облачные пакеты", "Токены, MT/мес.", "Цена, ₽/мес.", "Цена, ₽/год"]];
styleHeader(costs.getRange("A11:D11"));
const iskraCloud = [["XS", 1, 0], ["S", 40, 5000], ["M", 140, 14000], ["L", 700, 49000], ["XL", 3000, 190000], ["XXL", 20000, 990000]];
costs.getRange("A12:C17").values = iskraCloud;
costs.getRange("D12").formulas = [["=C12*12"]];
costs.getRange("D12:D17").fillDown();
styleBody(costs.getRange("A12:D17"));
costs.getRange("B12:B17").format.numberFormat = "#,##0";
costs.getRange("C12:D17").format.numberFormat = "#,##0 [$₽-ru-RU]";

costs.getRange("A27:C27").values = [["Искра — on-premise", "Цена от, ₽/год", "Ограничение"]];
styleHeader(costs.getRange("A27:C27"));
costs.getRange("A28:C30").values = [
  ["Простая", 2400000, "До 1 000 пользователей; сервер, GPU, LLM, внедрение и SLA отдельно"],
  ["Расширенная", 12000000, "Без ограничения пользователей; AD/SSO и поддержка развёртывания"],
  ["Максимальная", 36000000, "Изолированный режим, аудит исходного кода и формальная работа с ИБ"],
];
styleBody(costs.getRange("A28:C30"));
costs.getRange("B28:B30").format.numberFormat = "#,##0 [$₽-ru-RU]";

costs.getRange("A20:D20").values = [["Daisy Teams", "Цена, ₽/польз./мес.", "Цена, ₽/польз./год", "Примечание"]];
styleHeader(costs.getRange("A20:D20"));
costs.getRange("A21:B21").values = [["Business", 3000]];
costs.getRange("C21").formulas = [["=B21*12"]];
costs.getRange("D21").values = [["Лимиты по моделям включены; токены сверх лимитов, изолированные серверы и выделенная поддержка — отдельно."]];
styleBody(costs.getRange("A21:D21"));
costs.getRange("B21:C21").format.numberFormat = "#,##0 [$₽-ru-RU]";

costs.getRange("F20:H20").values = [["BitrixGPT + Маркетплейс для коробки", "Стандарт, ₽/год без НДС", "Акция -50%, ₽/год без НДС"]];
styleHeader(costs.getRange("F20:H20"));
costs.getRange("F21:H25").values = [
  ["Корпоративный портал 50", 60000, 30000],
  ["Корпоративный портал 100", 80000, 40000],
  ["Корпоративный портал 250", 120000, 60000],
  ["Корпоративный портал 500", 210000, 105000],
  ["Энтерпрайз 1000", 450000, 225000],
];
styleBody(costs.getRange("F21:H25"));
costs.getRange("G21:H25").format.numberFormat = "#,##0 [$₽-ru-RU]";
costs.getRange("F27:H28").merge(true);
costs.getRange("F27").values = [["Акция указана на сайте Битрикс24 для зоны .RU и действует при выполнении условий до 15.04.2027. Для расчёта TCO используйте стандартную цену, пока поставщик не подтвердит скидку."]];
costs.getRange("F27:H28").format = { fill: COLORS.paleAmber, font: { color: COLORS.amber, size: 9 }, wrapText: true, verticalAlignment: "center" };

const costChart = costs.charts.add("bar", costs.getRange("D4:E7"));
costChart.title = "Годовая стоимость выбранного сценария, ₽";
costChart.hasLegend = false;
costChart.setPosition("E9", "H18");
costChart.yAxis = { numberFormatCode: "#,##0", title: { text: "₽ в год" } };
costChart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } };

costs.showGridLines = false;
costs.freezePanes.freezeRows(3);
costs.getRange("A:A").format.columnWidth = 30;
costs.getRange("B:B").format.columnWidth = 20;
costs.getRange("C:C").format.columnWidth = 21;
costs.getRange("D:D").format.columnWidth = 24;
costs.getRange("E:E").format.columnWidth = 18;
costs.getRange("F:F").format.columnWidth = 34;
costs.getRange("G:H").format.columnWidth = 23;
costs.getRange("1:1").format.rowHeight = 34;
costs.getRange("2:2").format.rowHeight = 34;
costs.getRange("4:4").format.rowHeight = 36;
costs.getRange("5:8").format.rowHeight = 36;
costs.getRange("11:11").format.rowHeight = 36;
costs.getRange("20:20").format.rowHeight = 36;
costs.getRange("21:25").format.rowHeight = 36;
costs.getRange("27:27").format.rowHeight = 36;
costs.getRange("28:30").format.rowHeight = 44;

// ---------- Безопасность ----------
styleTitle(security, "A1:F1", "Защита корпоративной информации", "Подтверждённые публичные сведения и ключевые ограничения. Маркетинговое заявление не приравнивается к независимому аудиту или сертификату.");
security.getRange("A4:F4").values = [["Критерий", "Битрикс24 / BitrixGPT", "Искра", "Daisy Teams", "Риск / что проверить", "Оценка доказательности"]];
styleHeader(security.getRange("A4:F4"));
const securityRows = [
  ["Хранение данных", "Облако и BitrixGPT — серверы в РФ; коробка — инфраструктура заказчика", "Облако — РФ; on-premise — контур заказчика", "ПДн российских пользователей хранятся в РФ; изолированные серверы по запросу", "Хранение в РФ не исключает передачу запроса внешней LLM", "Битрикс: высокая; Искра/Daisy: заявление поставщика"],
  ["Передача внешней модели", "Зависит от выбранной модели и приложения Маркетплейса", "Чувствительные данные обещают блокировать или маскировать", "Ключевой сценарий — ChatGPT, Claude, Gemini и другие внешние модели", "Нужна схема data flow, список субобработчиков и страны обработки", "Средняя"],
  ["Использование для обучения", "BitrixGPT может использовать данные для улучшения локальных моделей; внешние — по правилам провайдера", "На сайте заявлено: данные не используются для обучения", "Публичного прямого запрета обучения всеми поставщиками моделей не найдено", "Зафиксировать contractual no-training и zero-retention", "Средняя/низкая"],
  ["ПДн третьих лиц", "Допустимость зависит от договора и выбранного AI-провайдера", "Публичная оферта запрещает загрузку ПДн третьих лиц", "Публичное соглашение запрещает ПДн третьих лиц и конфиденциальные данные", "Нужен отдельный B2B-договор поручения обработки по 152-ФЗ", "Высокая: ограничения есть в документах"],
  ["Шифрование", "TLS/HTTPS подтверждены; для Enterprise заявлен TLS 1.3", "Заявлены современные методы шифрования", "Конкретные алгоритмы и шифрование на диске публично не раскрыты", "Запросить at-rest encryption, KMS и управление ключами", "Битрикс: высокая; остальные: низкая"],
  ["Доступ и идентификация", "RBAC, 2FA, SSO SAML/LDAP/AD", "Роли; AD/SSO в расширенной лицензии", "Роли и лимиты; SSO/MFA в deck не подтверждены", "Проверить MFA, SSO, SCIM и отзыв доступа", "Средняя/высокая"],
  ["AI-защита", "Специализированная защита prompt injection публично не раскрыта", "Заявлены PII masking, prompt-injection и jailbreak detection", "Заявлены PII/NSFW Guardrails", "Провести тест на утечки через RAG, агента и вредоносные документы", "Низкая без независимого теста"],
  ["Аудит", "Журнал событий и аудит коробки", "Полный лог запросов/ответов и экспорт в SIEM заявлены", "Отчёты использования; security-аудит не описан", "Уточнить, кто может читать чаты и сколько хранятся логи", "Средняя"],
  ["Сертификация", "ФСТЭК №4750 для соответствующей редакции Enterprise", "Публичные сертификаты не найдены", "Публичные сертификаты не найдены", "Сертификат относится к конкретной версии и конфигурации", "Битрикс: высокая"],
  ["Безопасный режим", "Коробка локальна, но AI-запрос может уйти провайдеру", "Полностью локальная модель и режим без интернета заявлены", "Локальные Qwen/GPT-OSS заявлены, полная изоляция требует подтверждения", "Для коммерческой тайны нужен запрет исходящего трафика", "Средняя"],
];
security.getRange("A5:F14").values = securityRows;
styleBody(security.getRange("A5:F14"));
security.getRange("E5:E14").format.fill = COLORS.paleAmber;
security.getRange("A5:A14").format.font = { bold: true, color: COLORS.navy, size: 10 };
security.freezePanes.freezeRows(4);
security.showGridLines = false;
security.getRange("A:A").format.columnWidth = 24;
security.getRange("B:D").format.columnWidth = 34;
security.getRange("E:E").format.columnWidth = 42;
security.getRange("F:F").format.columnWidth = 26;
security.getRange("1:1").format.rowHeight = 34;
security.getRange("2:2").format.rowHeight = 36;
security.getRange("4:4").format.rowHeight = 42;
security.getRange("5:14").format.rowHeight = 62;

// ---------- Источники ----------
styleTitle(sources, "A1:D1", "Источники и допущения", "URL сохранены обычным текстом для проверки цен, функций и условий безопасности.");
sources.getRange("A4:D4").values = [["Сервис", "Тема", "Источник", "Примечание"]];
styleHeader(sources.getRange("A4:D4"));
const sourceRows = [
  ["Битрикс24", "Функциональность", "https://helpdesk.bitrix24.ru/open/20963834/", "Основные возможности портала"],
  ["Битрикс24", "BitrixGPT", "https://helpdesk.bitrix24.ru/open/28790658/", "AI в CRM, задачах, почте, звонках и других инструментах"],
  ["Битрикс24", "AI-агенты", "https://helpdesk.bitrix24.ru/open/27455370/", "Готовые и собственные агенты"],
  ["Битрикс24", "Цена BitrixGPT для коробки", "https://www.bitrix24.ru/prices/self-hosted.php", "Стандартные и акционные цены; без НДС"],
  ["Битрикс24", "Обработка данных AI", "https://helpdesk.bitrix24.ru/open/19076234/", "Хранение до 14 дней и возможность улучшения локальных моделей"],
  ["Битрикс24", "Безопасность Enterprise", "https://www.bitrix24.ru/enterprise/on-premise/", "TLS, RBAC, 2FA, SSO и сертификат ФСТЭК"],
  ["Искра", "Для бизнеса и цены", "https://iskrabot.ru/dlya-biznesa/", "Облачные пакеты и функции"],
  ["Искра", "Enterprise и on-premise", "https://iskrabot.ru/enterprise/", "AI-инспектор, SIEM, интеграции, цены on-premise"],
  ["Искра", "Политика конфиденциальности", "https://cloud.iskrabot.ru/iskra/legal/iskra_privacy_policy.pdf", "Хранение, меры защиты и передача третьим лицам"],
  ["Искра", "Пользовательское соглашение", "https://cloud.iskrabot.ru/iskra/legal/iskra_terms_of_service.pdf", "Ограничение на загрузку ПДн третьих лиц"],
  ["Daisy Teams", "Функции и цена", "/Users/max/Downloads/daisy teams — deck (1).pdf", "Предоставленная презентация red_mad_robot, 2026"],
  ["Daisy", "Политика конфиденциальности", "https://gptdaisy.com/policy", "Хранение в РФ и возможная передача третьим лицам/за рубеж"],
  ["Daisy", "Пользовательское соглашение", "https://gptdaisy.com/terms-of-service", "Запрет конфиденциальной информации и ПДн третьих лиц в публичной версии"],
];
sources.getRange("A5:D17").values = sourceRows;
styleBody(sources.getRange("A5:D17"));
sources.freezePanes.freezeRows(4);
sources.showGridLines = false;
sources.getRange("A:A").format.columnWidth = 20;
sources.getRange("B:B").format.columnWidth = 30;
sources.getRange("C:C").format.columnWidth = 68;
sources.getRange("D:D").format.columnWidth = 48;
sources.getRange("1:1").format.rowHeight = 34;
sources.getRange("2:2").format.rowHeight = 28;
sources.getRange("4:4").format.rowHeight = 34;
sources.getRange("5:17").format.rowHeight = 40;

// ---------- Итог ----------
styleTitle(summary, "A1:H1", "Битрикс24, Искра и Daisy Teams", "Управленческое сравнение пересечения функциональности, стоимости и защиты корпоративной информации. Актуально на 13.08.2026.");
summary.getRange("A4:B4").merge();
summary.getRange("A4").values = [["Ключевой вывод"]];
summary.getRange("A4:B4").format = { fill: COLORS.blue, font: { bold: true, color: COLORS.white, size: 12 }, verticalAlignment: "center" };
summary.getRange("A5:B8").merge();
summary.getRange("A5").values = [["Битрикс24 уже закрывает CRM, задачи, коммуникации, встречи и базовые AI-функции. Искру стоит рассматривать для межсистемных агентов, общей базы знаний и локального AI-контура. Daisy — для контролируемого доступа к ChatGPT, Claude, Gemini, видео и музыке. Одновременная лицензия Искры и Daisy для всех сотрудников избыточна."]];
summary.getRange("A5:B8").format = { fill: COLORS.paleBlue, font: { color: COLORS.navy, size: 11 }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: COLORS.border } };

summary.getRange("D4:E4").merge();
summary.getRange("D4").values = [["Расчётное пересечение с Битрикс24"]];
summary.getRange("D4:E4").format = { fill: COLORS.blue, font: { bold: true, color: COLORS.white, size: 12 }, horizontalAlignment: "center" };
summary.getRange("D5:D6").values = [["Искра"], ["Daisy Teams"]];
summary.getRange("E5").formulas = [["=(COUNTIF('Функции'!$F$5:$F$29,\"Высокое\")+0.5*COUNTIF('Функции'!$F$5:$F$29,\"Среднее\"))/COUNTA('Функции'!$B$5:$B$29)"]];
summary.getRange("E6").formulas = [["=(COUNTIF('Функции'!$G$5:$G$29,\"Высокое\")+0.5*COUNTIF('Функции'!$G$5:$G$29,\"Среднее\"))/COUNTA('Функции'!$B$5:$B$29)"]];
styleBody(summary.getRange("D5:E6"));
summary.getRange("E5:E6").format.numberFormat = "0%";
summary.getRange("E5:E6").conditionalFormats.add("dataBar", { color: COLORS.blue, gradient: true });
summary.getRange("D8:E8").merge();
summary.getRange("D8").values = [["Метод: высокое пересечение = 1, среднее = 0,5, низкое/нет = 0. Показатель ориентировочный и основан на матрице функций."]];
summary.getRange("D8:E8").format = { fill: COLORS.paleGray, font: { color: COLORS.gray, italic: true, size: 9 }, wrapText: true };

summary.getRange("A11:H11").values = [["Решение", "Главная ценность", "Что дублирует", "Что добавляет", "Модель цены", "Ориентир", "Безопасность", "Рекомендация"]];
styleHeader(summary.getRange("A11:H11"));
summary.getRange("A12:H14").values = [
  ["Битрикс24 + BitrixGPT", "AI внутри CRM, задач, чатов и встреч", "Базовый AI-чат, тексты, база знаний", "Нативные действия в портале", "Годовая подписка к коробке", "60–450 тыс. ₽/год стандартно, без НДС", "Зрелая защита портала; AI-данные требуют отдельной политики", "Использовать первым, так как портал уже внедрён"],
  ["Искра", "База знаний, агенты, интеграции, on-premise", "AI-чат, документы, поиск, встречи", "1С/CRM/MCP, расписание, локальный AI-контур", "Общий пул токенов; on-premise отдельно", "0–990 тыс. ₽/мес.; on-premise от 2,4 млн ₽/год", "Сильные заявленные AI-контроли; нужен B2B-договор и проверка", "Пилотировать только под межсистемные сценарии"],
  ["Daisy Teams", "Единый доступ к мировым LLM и мультимедиа", "AI-чат, тексты, документы, исследования", "Claude/ChatGPT/Gemini, видео и музыка", "За каждого сотрудника", "3 000 ₽/польз./мес.", "Базовое соглашение запрещает конфиденциальные данные; нужен отдельный Teams-договор", "Пилот 5–10 пользователей с неконфиденциальными данными"],
];
styleBody(summary.getRange("A12:H14"));
summary.getRange("H12:H14").format.fill = COLORS.paleGreen;

summary.getRange("A17:H17").merge();
summary.getRange("A17").values = [["Рекомендуемая схема"]];
summary.getRange("A17:H17").format = { fill: COLORS.navy, font: { bold: true, color: COLORS.white, size: 12 }, horizontalAlignment: "center" };
summary.getRange("A18:H20").merge();
summary.getRange("A18").values = [["1) Оставить BitrixGPT для CRM, задач, встреч и внутренней коммуникации.  2) Если нужен единый AI над Битрикс24 + 1С + файлами — пилот Искры.  3) Если сотрудникам критично нужны Claude, ChatGPT, Gemini, видео и музыка — ограниченный пилот Daisy.  4) Не выдавать двум внешним сервисам массовые лицензии одновременно до измерения реального использования и ROI."]];
summary.getRange("A18:H20").format = { fill: COLORS.paleGreen, font: { color: COLORS.green, bold: true, size: 11 }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: COLORS.green } };
summary.showGridLines = false;
summary.getRange("A:A").format.columnWidth = 25;
summary.getRange("B:B").format.columnWidth = 31;
summary.getRange("C:D").format.columnWidth = 30;
summary.getRange("E:E").format.columnWidth = 24;
summary.getRange("F:F").format.columnWidth = 27;
summary.getRange("G:G").format.columnWidth = 34;
summary.getRange("H:H").format.columnWidth = 35;
summary.getRange("1:1").format.rowHeight = 34;
summary.getRange("2:2").format.rowHeight = 32;
summary.getRange("4:4").format.rowHeight = 28;
summary.getRange("5:8").format.rowHeight = 27;
summary.getRange("11:11").format.rowHeight = 44;
summary.getRange("12:14").format.rowHeight = 74;
summary.getRange("17:17").format.rowHeight = 28;
summary.getRange("18:20").format.rowHeight = 30;

await fs.mkdir(outputDir, { recursive: true });
const out = await SpreadsheetFile.exportXlsx(wb);
await out.save(outputPath);

const checks = {};
checks.summary = (await wb.inspect({ kind: "table", range: "Итог!A1:H20", include: "values,formulas", tableMaxRows: 20, tableMaxCols: 8, maxChars: 9000 })).ndjson;
checks.costs = (await wb.inspect({ kind: "table", range: "Стоимость!A4:H25", include: "values,formulas", tableMaxRows: 25, tableMaxCols: 8, maxChars: 9000 })).ndjson;
checks.errors = (await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "final formula error scan", maxChars: 3000 })).ndjson;
for (const name of ["Итог", "Функции", "Стоимость", "Безопасность", "Источники"]) {
  const preview = await wb.render({ sheetName: name, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(`${outputDir}/preview_${name}.png`, new Uint8Array(await preview.arrayBuffer()));
}
console.log(JSON.stringify({ outputPath, checks }, null, 2));
