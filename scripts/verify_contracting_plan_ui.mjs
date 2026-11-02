// Настоящий браузер и вход на синтетическом/обезличенном стенде; порт 8000 запрещён.
import {session} from './verify_admin_lib.mjs';
import {readFileSync,mkdirSync} from 'node:fs';
const base=process.argv[2]||'http://127.0.0.1:8096';
if(new URL(base).port==='8000')throw Error('Production UI запрещён');
const oid=Number(process.argv[3]||10001),prefix=`UI-${Date.now()}`,out='/private/tmp/cp-ui-shots';mkdirSync(out,{recursive:true});
let checks=0;
function ok(label,value){if(!value)throw Error(label);console.log('PASS '+label);checks++;}
const b=await session(base,'admin',{width:1440,height:900});
const click=async sel=>{await b.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);await b.clickSel(sel);};
const fill=async (name,value)=>{const sel=`.cp-form [name="${name}"]`;await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
const tick=async (name,value=true)=>{await b.eval(`(()=>{const e=document.querySelector('.cp-form [name="${name}"]');e.checked=${value};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
const save=async()=>{await click('.cp-form button[type=submit]');await b.waitFor('!document.querySelector(".cp-form") || !!document.querySelector(".cp-form-error")?.textContent');const error=await b.eval('document.querySelector(".cp-form-error")?.textContent||""');if(error)throw Error('Сохранение: '+error);};
const data=()=>b.eval(`fetch('/objects/${oid}/contracting-plan').then(r=>r.json())`);
try{
 await b.goto(`${base}/v2?object_id=${oid}#/contracting-plan`);await b.waitFor('!!document.querySelector(".cp-tabs")');
 ok('новый экран подключен к оболочке',await b.eval('document.querySelector(".cp-root h2").textContent.includes("СМР")'));
 await click('[data-action="tab"][data-id="rd"]');await click('[data-action="new-rd"]');
 await fill('code',prefix);await fill('name','Синтетическая марка РД');await fill('responsible_id',1);await fill('note','Условие выдачи: после согласования');await fill('customer_agreement','На согласовании');await save();let d=await data();const rd=d.rd.find(r=>r.code===prefix).id;
 for(const title of ['Монтаж корпуса','Отделка корпуса']){await click(`[data-action="new-work"][data-id="${rd}"]`);await fill('title',title);await fill('required_start','2026-12-20');await save();}
 d=await data();const works=d.work.filter(w=>w.rd_id===rd);
 await click(`[data-action="edit-rd"][data-id="${rd}"]`);await tick('composition_confirmed');await save();
 ok('РД детализирована и ответственный сохранен',(await data()).rd.find(r=>r.id===rd).composition_confirmed===1);
 await click('[data-action="tab"][data-id="lots"]');await click('[data-action="new-lot"]');await fill('code',prefix+'-Л');await fill('title','Синтетический лот');await fill('pto_id',1);await fill('required_start','2026-12-20');await fill('vor_due','2026-11-10');await fill('tz_due','2026-11-12');await fill('note','Проблема конкурса, решение до 09.11');await fill('gpr_note','Проблема ГПР, решение до 10.11');await save();d=await data();const lot=d.lot.find(l=>l.code===prefix+'-Л').id;
 await b.eval(`(()=>{const e=document.querySelector('[data-search]');e.value=${JSON.stringify(prefix)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 ok('примечания и срок решения видны в реестре',await b.eval('document.querySelector("[data-view]").textContent.includes("Проблема конкурса, решение до 09.11") && document.querySelector("[data-view]").textContent.includes("Проблема ГПР, решение до 10.11")'));
 await click(`[data-action="select-lot"][data-id="${lot}"]`);
 for(const w of works){await click(`[data-action="new-assignment"][data-id="${lot}"]`);await fill('work_id',w.id);ok('целая позиция по умолчанию 100%',await b.eval('document.querySelector("[name=share]").value==="100"'));await fill('rd_planned','2026-11-01');await fill('rd_agreed','2026-11-02');await fill('rd_issued','2026-11-02');await tick('rd_sufficient');await fill('rd_scope','Корпус 1, конкурсная часть');await fill('rd_ref','https://example.invalid/rd');await save();}
 for(let i=0;i<works.length;i++){await click(`[data-action="new-vor"][data-id="${lot}"]`);await fill('number',prefix+'-ВОР-'+i);await fill('document_date','2026-11-02');await fill('reference','https://example.invalid/vor');await b.eval(`(()=>{const e=document.querySelector('[name=item_ids][value="${works[i].id}"]');e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await save();}
 await click(`[data-action="new-tz"][data-id="${lot}"]`);ok('несколько ВОР доступны для выбора в ТЗ',await b.eval('document.querySelectorAll("[name=item_ids]").length===2'));await fill('number',prefix+'-ТЗ');await fill('document_date','2026-11-02');await fill('reference','https://example.invalid/tz');await b.eval('document.querySelectorAll("[name=item_ids]").forEach(e=>{e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));})');await save();
 d=await data();const tz=d.document.find(x=>x.number===prefix+'-ТЗ').id;ok('состав ТЗ сохранен из двух ВОР',d.tz_vor.filter(x=>x.tz_id===tz).length===2);
 const audit=readFileSync(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const [w,h] of [[1440,900],[2560,1440]]){await b.viewport(w,h);await b.eval('window.scrollTo(0,0)');await b.shot(`${out}/lots-${w}.png`);const result=await b.eval(`(()=>{${audit};return {align:alignAudit(document.querySelector('.cp-root')),size:sizeAudit(document.querySelector('.cp-root')),overflow:document.documentElement.scrollWidth>innerWidth};})()`);ok(`выравнивание ${w}`,!result.align.length&&!result.size.length&&!result.overflow);}
 await click(`[data-action="upload"][data-id="${lot}"]`);await fill('tz_id',tz);await fill('uploaded_date','2026-11-02');await fill('upload_ref','1С: синтетическая запись UI');
 for(const [w,h] of [[1440,900],[2560,1440]]){await b.viewport(w,h);await b.eval('document.querySelector(".cp-editor").scrollIntoView({block:"start"})');await b.shot(`${out}/form-${w}.png`);const result=await b.eval(`(()=>{${audit};return {align:alignAudit(document.querySelector('.cp-editor')),size:sizeAudit(document.querySelector('.cp-editor'))};})()`);ok(`форма выровнена ${w}`,!result.align.length&&!result.size.length);}
 await save();ok('реальный UI завершил лот с документами',(await data()).lot.find(l=>l.id===lot).status==='completed');
 await click(`[data-action="snapshot"][data-id="${lot}"]`);ok('зафиксированный состав доступен',await b.eval('!!document.querySelector(".cp-frozen") && document.querySelector(".cp-frozen").textContent.includes("Монтаж корпуса")'));await click('[data-action="close-snapshot"]');
 await click(`[data-action="reopen"][data-id="${lot}"]`);await fill('reason','Синтетическое уточнение');await save();ok('возобновление снимает факт 1С',(await data()).lot.find(l=>l.id===lot).uploaded_date===null);
 await click(`[data-action="edit-lot"][data-id="${lot}"]`);await fill('note','Несохранённый ввод');
 await b.eval(`(async()=>{const d=await fetch('/objects/${oid}/contracting-plan').then(r=>r.json());await fetch('/objects/${oid}/contracting-plan/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:d.revision,action:'save_lot',payload:{id:${lot},code:${JSON.stringify(prefix+'-Л')},title:'Изменено параллельно',pto_id:1,required_start:'2026-12-20'}})});})()`);
 await click('.cp-form button[type=submit]');await b.waitFor('document.querySelector(".cp-form-error")?.textContent.includes("другим пользователем")');ok('конфликт сохраняет ввод',await b.eval('document.querySelector("[name=note]").value==="Несохранённый ввод"'));
 await b.offline(true);await click('.cp-form button[type=submit]');await b.waitFor('document.querySelector(".cp-form-error")?.textContent.includes("Результат сохранения неизвестен")');ok('сбой сети сохраняет ввод',await b.eval('document.querySelector("[name=note]").value==="Несохранённый ввод"'));await b.offline(false);
 ok('нет ошибок JS',b.exceptions.length===0);
 console.log(`SUCCESS: ${checks} UI checks; screenshots ${out}`);
}finally{await b.close();}
