(()=>{
 'use strict';
 // Роли кнопок: во всём калькуляторе (разделы, окна, формы) кнопка — явный элемент, а не «текст в рамочке».
 // primary — главное действие (залита акцентом), accent — вспомогательное действие (акцентная рамка), danger — опасное (красная рамка), neutral — закрыть, отмена, навигация.
 // Роль ставится атрибутом data-role по назначению кнопки (id, тип, текст); внешний вид — стили `[data-role]` в styles.css. Вкладки, строки списка, меню и переключатели видов не затрагиваются.
 const EXCLUDE='.pc-primary-tabs,.pc-tabs,.pc-product-row,.pc-group-toggle,.pc-settings-tabs,.pc-sh-filter,.pc-service-menu,.pc-article,.pc-recovery-source,.pc-model-results-marks,[role=tab],[data-view],[data-settings-section],[data-history-kind],[data-report-product],[data-collision-open],[data-source-sheet],[data-source-job],[data-product]';
 const PRIMARY_IDS=new Set(['pc-export','pc-export-one','pc-recovery-start','pc-conflict-mine']);
 const DANGER_IDS=new Set(['pc-clear','pc-reset-confirm']);
 const NEUTRAL_IDS=new Set(['pc-catalog-close','pc-search-clear','pc-selection-clear','pc-catalog-open','pc-catalog-options','pc-batch-toggle','pc-reveal-product','pc-dialog-close','pc-dialog-cancel','pc-reset-cancel','pc-model-results-close','pc-commercial-close','pc-palette-close','pc-calculation-expand','pc-camera-expand','pc-camera-reset','pc-sheet-fit','pc-sheet-prev','pc-sheet-next','pc-sheet-minus','pc-sheet-plus','pc-report-close','pc-report-prev','pc-report-next','pc-recovery-prev','pc-recovery-next','pc-products-open','pc-home-products']);
 const PRIMARY_TEXT=['Применить изменения','Сохранить расценки и нормы','Сохранить изделие','Подключить частичную версию','Добавить комментарий','Войти','Сохранить','Отправить','Выдать токен','Запустить обработку'];
 const DANGER_TEXT=['Удалить','Сбросить','Остановить всё','Отменить партию','Убрать доверие'];
 const NEUTRAL_TEXT=['Отмена','×','Закрыть','Снять','Развернуть','Свернуть','Вписать','←','→','−','+','Назад','Вернуться','Скрыть каталог','Предыдущая','Следующая','Выбрать несколько','Выбрать изделие','Вид'];
 const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
 function roleOf(el){
  if(el.matches(EXCLUDE)||el.closest(EXCLUDE))return '';
  if(el.id&&NEUTRAL_IDS.has(el.id))return 'neutral';
  if(el.id&&DANGER_IDS.has(el.id))return 'danger';
  if(el.id&&PRIMARY_IDS.has(el.id))return 'primary';
  if(el.hasAttribute('data-close')||el.hasAttribute('data-target-cancel'))return 'neutral';
  if(el.hasAttribute('data-target-delete')||el.hasAttribute('data-cert-clear')||el.hasAttribute('data-force-stop'))return 'danger';
  if(el.hasAttribute('data-send'))return 'primary';
  const text=clean(el.textContent).replace(/\s*[▾▸]\s*$/,'');
  if(el.classList.contains('pc-primary')||el.getAttribute('type')==='submit')return DANGER_TEXT.some(t=>text.startsWith(t))?'danger':'primary';
  if(DANGER_TEXT.some(t=>text.startsWith(t)))return 'danger';
  if(PRIMARY_TEXT.includes(text))return 'primary';
  if(NEUTRAL_TEXT.some(t=>text===t||(t.length>3&&text.startsWith(t))))return 'neutral';
  return 'accent';
 }
 // заголовки раскрывающихся блоков в окнах и разделах — полосы со стрелкой (меню «Ещё», «Сервис», «Действия» и блок готовности оформлены отдельно)
 const MENUS=new Set(['Ещё','Сервис','Действия']);
 function disclosure(el){
  if(el.closest('.pc-home-detail,.pc-tabs,.pc-service-menu,#pc-sync-dialog'))return false;
  return !MENUS.has(clean(el.textContent).replace(/\s*[▾▸]\s*$/,''))&&!!el.closest('dialog,#pc-norms-panel,#pc-project-report-panel,.pc-calculation,#precast-concept');
 }
 function apply(scope=document){
  for(const el of scope.querySelectorAll?.('button')||[]){
   if(el.dataset.role)continue;const role=roleOf(el);if(role)el.dataset.role=role;
  }
  for(const el of scope.querySelectorAll?.('summary')||[]){
   if(el.dataset.role)continue;
   if(clean(el.textContent).replace(/\s*[▾▸]\s*$/,'')==='Действия'&&el.closest('#pc-calculation-panel,.pc-calculation,#precast-concept')){el.dataset.role='menu';continue;}      // выпадающее меню действий калькуляции — кнопка со стрелкой
   if(disclosure(el))el.dataset.role='disclosure';
  }
 }
 window.CalcZhBIButtons={apply,roleOf};
 let timer=0;
 new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>apply(document),100);}).observe(document.body,{childList:true,subtree:true});
 apply(document);
})();
