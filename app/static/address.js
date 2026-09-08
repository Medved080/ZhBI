// Виджет адреса по классификатору КЛАДР (2026-09-07).
//
// Отдельным файлом, а не в app.js: тот уже тридцать тысяч строк, и класть
// туда всё подряд — верный способ сделать его нечитаемым окончательно. Файл
// подключается по первому открытию формы (динамический import), как это уже
// сделано для сцены Three.js; CSP `script-src 'self'` такое разрешает.
//
// Зависимости из app.js передаются ЯВНО при монтировании, а не берутся из
// глобальной области: константы верхнего уровня обычного скрипта на window
// не попадают, и молчаливое `undefined` здесь было бы худшим исходом.
//
// Что делает виджет. Три связанных поля — населённый пункт, улица, дом — и
// поле уточнения. Классификатор не загружен или адрес заведён руками:
// работает как обычное поле ввода, потому что у стройплощадки почтового
// адреса часто нет вовсе.
//
// По мере того как адрес складывается, виджет САМ просит координаты у
// внешнего геокодера (`deps.geocode`, реализован в app/static/map.js через
// Nominatim) и отдаёт их вызывающей стороне колбэком `onGeocode` —
// применять их или нет, решает форма: у уже сохранённой или тронутой
// вручную точки автоматика ничего не перезаписывает.

let deps = null;   // {api, escapeHtml, geocode}

export function init(зависимости) {
  deps = зависимости;
}

// Загружен ли классификатор — спрашивается один раз на страницу: ответ не
// меняется, пока администратор не догрузит регион, а спрашивать на каждое
// открытие формы значит слать лишний запрос на каждый щелчок по дереву.
let классификаторГотов = null;

export async function classifierReady() {
  if (классификаторГотов === null) {
    try {
      const st = await deps.api("/address/status");
      классификаторГотов = (st.loaded || []).length > 0;
    } catch (e) {
      классификаторГотов = false;
    }
  }
  return классификаторГотов;
}

export function resetClassifierCache() {
  классификаторГотов = null;
}

function эл(тег, класс, текст) {
  const e = document.createElement(тег);
  if (класс) e.className = класс;
  if (текст !== undefined) e.textContent = текст;
  return e;
}

// Подсказки под полем ввода — общая механика для населённого пункта,
// улицы И дома. Список — обычный div, а не <datalist>: последний не даёт
// показать вторую строку с полным путём, а без неё одноимённые записи
// (одноимённые населённые пункты, номера домов с разными индексами)
// неразличимы.
//
// `наВвод` — необязательный колбэк на КАЖДОЕ нажатие клавиши, синхронно, до
// запроса подсказок: полю «Дом» кроме списка нужна ещё живая проверка по
// классификатору и пересборка адреса на лету, а не только выбор мышью.
function attachSuggestions(поле_ввода, обёртка, { искать, выбрать, наВвод }) {
  const список = эл("div", "address-suggest");
  список.hidden = true;
  обёртка.appendChild(список);

  let таймер = null;
  let выделен = -1;

  function закрыть() { список.hidden = true; выделен = -1; }

  function показать(варианты) {
    список.innerHTML = "";
    if (!варианты.length) { закрыть(); return; }
    варианты.forEach((в) => {
      const кнопка = эл("button", "address-suggest-item");
      кнопка.type = "button";
      кнопка.appendChild(эл("span", "address-suggest-label", в.label));
      if (в.full_path && в.full_path !== в.label) {
        кнопка.appendChild(эл("span", "address-suggest-path", в.full_path));
      }
      кнопка.addEventListener("mousedown", (e) => {
        // mousedown, а не click: click приходит после blur, а blur успевает
        // закрыть список — и выбор мышью не срабатывал бы вовсе.
        e.preventDefault();
        поле_ввода.value = в.label;
        закрыть();
        выбрать(в);
      });
      список.appendChild(кнопка);
    });
    список.hidden = false;
  }

  poleВвод(поле_ввода, () => {
    if (наВвод) наВвод(поле_ввода.value);
    clearTimeout(таймер);
    таймер = setTimeout(async () => {
      const варианты = await искать(поле_ввода.value.trim());
      показать(варианты || []);
    }, 250);
  });

  поле_ввода.addEventListener("keydown", (e) => {
    const пункты = Array.from(список.querySelectorAll(".address-suggest-item"));
    if (!пункты.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      пункты.forEach((p) => p.classList.remove("kb-focus"));
      выделен = (выделен + (e.key === "ArrowDown" ? 1 : -1) + пункты.length) % пункты.length;
      пункты[выделен].classList.add("kb-focus");
      пункты[выделен].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && выделен >= 0) {
      e.preventDefault();
      пункты[выделен].dispatchEvent(new MouseEvent("mousedown"));
    } else if (e.key === "Escape") {
      закрыть();
    }
  });
  поле_ввода.addEventListener("blur", () => setTimeout(закрыть, 150));

  return { закрыть };
}

// Поле населённого пункта/улицы: подпись, ввод и подсказки одним куском.
function поле({ подпись, placeholder, значение, disabled, искать, выбрать }) {
  const обёртка = эл("label", "object-field address-field");
  обёртка.appendChild(эл("span", null, подпись));
  const поле_ввода = document.createElement("input");
  поле_ввода.type = "text";
  поле_ввода.placeholder = placeholder || "";
  поле_ввода.value = значение || "";
  poleDisabled(поле_ввода, disabled);
  обёртка.appendChild(поле_ввода);

  const { закрыть } = attachSuggestions(поле_ввода, обёртка, { искать, выбрать });

  return { обёртка, поле_ввода, закрыть };
}

function poleDisabled(el, disabled) { if (disabled) el.disabled = true; }
function poleВвод(el, fn) { el.addEventListener("input", fn); }

/**
 * Смонтировать виджет адреса.
 *
 * value — то, что лежит в записи: {address, address_code, address_parts,
 * address_note, postal_code, address_region}. onChange получает те же поля
 * целиком: собирать адрес из кусков — дело сервера, здесь только выбор.
 */
export async function mountAddressWidget(контейнер, { value, canEdit, onChange, onGeocode, manual }) {
  const состояние = Object.assign({
    address: "", address_code: null, address_source: null, address_region: null,
    address_parts: null, postal_code: null, address_note: "",
  }, value || {});

  // Автоматическое определение координат по адресу (2026-09-08): человек
  // выбирает или вводит адрес, а координаты подставляются сами через
  // геокодер OpenStreetMap — без этого пришлось бы ставить пин руками на
  // каждую из сотен площадок. `onGeocode` решает, применять ли найденное
  // (в форме это заблокировано, если координаты уже стоят или тронуты
  // вручную) — здесь только запрос.
  // Строку показа («г Москва», «ул Советская») геокодеру не отдаём — Nominatim
  // ОДНАЖДЫ прочитал «г Москва» как «гора Москва» и вернул точку в четырёх
  // тысячах километров от настоящей (см. app/static/map.js). Вместо этого
  // собираем структурированный запрос из ЧИСТЫХ имён частей — они у
  // классификатора уже без сокращений (`address_parts[...].name`), и поиск
  // «город ищем в поле города» такой ошибки не допускает. Свободный ввод
  // (классификатор не выбран) остаётся строкой — точность здесь уже на
  // совести того, что написал человек.
  function собратьЗапросГеокодера() {
    const части = состояние.address_parts;
    if (!части) return состояние.address || null;
    const пункт = части.settlement || части.city || части.area || части.region || null;
    if (!пункт || !пункт.name) return null;
    const запрос = { city: пункт.name, country: "Россия" };
    if (части.region && части.region.name && части.region !== пункт) {
      запрос.state = части.region.name;
    }
    if (части.street && части.street.name) {
      const дом = части.house && части.house.name;
      запрос.street = дом ? `${части.street.name} ${дом}` : части.street.name;
    }
    return запрос;
  }

  let геокодТаймер = null;
  function запуститьГеокодирование() {
    if (!deps.geocode || !onGeocode) return;
    clearTimeout(геокодТаймер);
    геокодТаймер = setTimeout(async () => {
      const запрос = собратьЗапросГеокодера();
      if (!запрос) return;
      const место = await deps.geocode(запрос);
      if (место) onGeocode(место.lat, место.lon);
    }, 500);
  }

  const готов = await classifierReady();
  // Ручной режим — когда классификатора нет вовсе или адрес заведён без
  // него. Это законное состояние: у площадки часто нет почтового адреса, она
  // адресуется кадастровым номером участка.
  //
  // ЯВНО заданный режим (manual) сильнее вычисленного: у пустой записи кода
  // ещё нет, и без этого параметра нажатие «Выбрать по классификатору»
  // перерисовывало виджет обратно в ручной режим — то есть не работало.
  let вручную = (manual !== undefined && manual !== null)
    ? manual
    : (!готов || !состояние.address_code);
  if (!готов) вручную = true;

  контейнер.innerHTML = "";
  const сетка = эл("div", "object-fields");
  контейнер.appendChild(сетка);

  function сообщить() {
    onChange(Object.assign({}, состояние));
  }

  function перерисовать(режим) {
    mountAddressWidget(контейнер, {
      value: состояние, canEdit, onChange, onGeocode, manual: режим,
    });
  }

  if (вручную) {
    const строка = эл("label", "object-field object-field-wide");
    строка.appendChild(эл("span", null, "Адрес"));
    const ввод = document.createElement("input");
    ввод.type = "text";
    ввод.placeholder = "Населённый пункт, улица, дом";
    ввод.value = состояние.address || "";
    if (!canEdit) ввод.disabled = true;
    ввод.addEventListener("input", () => {
      состояние.address = ввод.value;
      // Ручная правка снимает привязку к классификатору: иначе строка и
      // разбор разъехались бы, и какой из них правда — было бы неизвестно.
      состояние.address_code = null;
      состояние.address_source = null;
      состояние.address_parts = null;
      сообщить();
      запуститьГеокодирование();
    });
    строка.appendChild(ввод);
    сетка.appendChild(строка);

    const подсказка = эл("div", "hint-text address-mode-hint");
    if (!готов) {
      подсказка.textContent = "Адресный классификатор не загружен — адрес вводится вручную. "
        + "Загрузить его может администратор сервиса: «Действия → Администрирование → Адресный классификатор».";
    } else if (canEdit) {
      const кнопка = эл("button", "link-like", "Выбрать по классификатору");
      кнопка.type = "button";
      кнопка.addEventListener("click", () => перерисовать(false));
      подсказка.append("Адрес введён вручную. ", кнопка);
    }
    контейнер.appendChild(подсказка);
  } else {
    const части = состояние.address_parts || {};
    const пункт = части.settlement || части.city || части.area || части.region || null;
    const кодПункта = пункт ? пункт.code : null;

    const поляВиджета = поле({
      подпись: "Населённый пункт",
      placeholder: "Город, посёлок, деревня",
      значение: пункт ? [пункт.type, пункт.name].filter(Boolean).join(" ") : "",
      disabled: !canEdit,
      искать: async (q) => {
        if (q.length < 2) return [];
        const r = await deps.api("/address/settlements?q=" + encodeURIComponent(q));
        return r.items || [];
      },
      выбрать: async (в) => {
        const r = await deps.api("/address/resolve?code=" + encodeURIComponent(в.code));
        Object.assign(состояние, {
          address: r.address, address_code: r.code, address_source: r.source,
          address_region: r.region, address_parts: r.parts, postal_code: r.postal_code,
        });
        сообщить();
        запуститьГеокодирование();
        перерисовать(false);
      },
    });
    сетка.appendChild(поляВиджета.обёртка);

    const улица = части.street || null;
    const полеУлицы = поле({
      подпись: "Улица",
      placeholder: кодПункта ? "Необязательно" : "Сначала выберите населённый пункт",
      значение: улица ? [улица.type, улица.name].filter(Boolean).join(" ") : "",
      disabled: !canEdit || !кодПункта,
      искать: async (q) => {
        if (!кодПункта) return [];
        const r = await deps.api("/address/streets?parent=" + encodeURIComponent(кодПункта)
          + "&q=" + encodeURIComponent(q));
        return r.items || [];
      },
      выбрать: async (в) => {
        const r = await deps.api("/address/resolve?code=" + encodeURIComponent(в.code));
        Object.assign(состояние, {
          address: r.address, address_code: r.code, address_source: r.source,
          address_region: r.region, address_parts: r.parts, postal_code: r.postal_code,
        });
        сообщить();
        запуститьГеокодирование();
        перерисовать(false);
      },
    });
    сетка.appendChild(полеУлицы.обёртка);

    // Дом — поле со свободным вводом И подсказками разом. Раньше подсказок
    // не было: считалось, что КЛАДР хранит дома диапазонами («1,3,5-9») и
    // разложить их в список — значит выдумать номера, которых нет. Проверка
    // на 290 тысячах домов Москвы и области ни одного такого диапазона не
    // нашла: КЛАДР перечисляет номера по одному, включая корпуса и
    // строения («10к1», «12стр2»), и список стало можно строить честно —
    // из тех же данных, по которым идёт последующая проверка. Свободный
    // ввод остаётся: у площадки номер бывает нестандартным («участок 4/1»),
    // и заставлять выбирать из списка нельзя.
    const домОбёртка = эл("label", "object-field address-field");
    домОбёртка.appendChild(эл("span", null, "Дом"));
    const домВвод = document.createElement("input");
    домВвод.type = "text";
    домВвод.placeholder = "Номер или участок";
    домВвод.value = (части.house && части.house.name) || "";
    if (!canEdit) домВвод.disabled = true;
    домОбёртка.appendChild(домВвод);
    сетка.appendChild(домОбёртка);

    const отметка = эл("div", "hint-text address-house-check");
    контейнер.appendChild(отметка);

    // Родитель для поиска домов — улица, если выбрана, иначе сам населённый
    // пункт: у промплощадки без улицы номер иногда привязан прямо к нему.
    const родительДома = () => (улица ? улица.code : кодПункта);

    function применитьНомерДома(номер, известныйИндекс) {
      const основа = состояние.address_parts || {};
      состояние.address_parts = Object.assign({}, основа,
        номер ? { house: { name: номер, type: "д", code: null } } : { house: null });
      const базовый = (состояние.address || "").split(", д ")[0];
      состояние.address = номер ? базовый + ", д " + номер : базовый;
      if (известныйИндекс) состояние.postal_code = известныйИндекс;
      сообщить();
      запуститьГеокодирование();
    }

    let таймерДома = null;
    const { закрыть: закрытьПодсказкиДома } = attachSuggestions(домВвод, домОбёртка, {
      искать: async (q) => {
        const родитель = родительДома();
        if (!родитель) return [];
        const r = await deps.api("/address/houses?parent=" + encodeURIComponent(родитель)
          + "&q=" + encodeURIComponent(q));
        return (r.items || []).map((x) => ({
          label: x.label, full_path: x.postal_code ? "индекс " + x.postal_code : "",
        }));
      },
      выбрать: (в) => {
        // Выбрано из списка — дом заведомо есть в классификаторе, отдельно
        // спрашивать проверкой незачем: сам список из неё и построен.
        применитьНомерДома(в.label);
        const индекс = (в.full_path || "").replace("индекс ", "") || null;
        отметка.textContent = "Дом есть в классификаторе" + (индекс ? ", индекс " + индекс + "." : ".");
        отметка.classList.remove("address-warn");
        if (индекс) { состояние.postal_code = индекс; сообщить(); }
      },
      наВвод: () => {
        clearTimeout(таймерДома);
        const номер = домВвод.value.trim();
        применитьНомерДома(номер);
        const родитель = родительДома();
        if (!номер || !родитель) { отметка.textContent = ""; return; }
        // Свободно набранный номер по-прежнему сверяется с классификатором
        // отдельным запросом: то, что список подсказок его не показал в
        // ЭТОТ момент (запрос ещё не пришёл или номер набран не до конца),
        // не значит, что дома нет вовсе.
        таймерДома = setTimeout(async () => {
          try {
            const r = await deps.api("/address/check-house?parent=" + encodeURIComponent(родитель)
              + "&number=" + encodeURIComponent(номер));
            if (r.found) {
              отметка.textContent = "Дом есть в классификаторе"
                + (r.postal_code ? ", индекс " + r.postal_code : "") + ".";
              отметка.classList.remove("address-warn");
              if (r.postal_code) { состояние.postal_code = r.postal_code; сообщить(); }
            } else {
              отметка.textContent = "Такого дома в классификаторе нет — адрес всё равно сохранится.";
              отметка.classList.add("address-warn");
            }
          } catch (e) { отметка.textContent = ""; }
        }, 300);
      },
    });

    const итог = эл("div", "hint-text address-summary");
    итог.textContent = состояние.address
      + (состояние.postal_code ? " · индекс " + состояние.postal_code : "");
    контейнер.appendChild(итог);

    if (canEdit) {
      const строка = эл("div", "hint-text address-mode-hint");
      const кнопка = эл("button", "link-like", "Ввести вручную");
      кнопка.type = "button";
      кнопка.addEventListener("click", () => {
        // Привязка снимается, а СТРОКА остаётся: человек уточняет адрес,
        // которого классификатор не знает, а не начинает с нуля.
        состояние.address_code = null;
        состояние.address_source = null;
        состояние.address_parts = null;
        сообщить();
        перерисовать(true);
      });
      строка.append("Адреса нет в классификаторе? ", кнопка);
      контейнер.appendChild(строка);
    }
  }

  // Уточнение — всегда, в обоих режимах. Отдельно от адреса, потому что
  // классификатор его не знает и при пересборке строки затёр бы.
  const уточнение = эл("label", "object-field object-field-wide");
  уточнение.appendChild(эл("span", null, "Уточнение"));
  const уточнВвод = document.createElement("input");
  уточнВвод.type = "text";
  уточнВвод.placeholder = "Корпус, строение, участок, ориентир";
  уточнВвод.value = состояние.address_note || "";
  if (!canEdit) уточнВвод.disabled = true;
  уточнВвод.addEventListener("input", () => {
    состояние.address_note = уточнВвод.value;
    сообщить();
  });
  уточнение.appendChild(уточнВвод);
  сетка.appendChild(уточнение);
}
