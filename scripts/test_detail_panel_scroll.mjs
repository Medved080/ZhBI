// Реальный сценарий: короткий асинхронный плейсхолдер не должен
// сбросить scrollTop до появления следующей карточки.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../app/static/v2/detail-panel-scroll.js', import.meta.url),'utf8');
const { createDetailPanelScroll } = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
class Panel {
  constructor(){this.height=300;this.clientHeight=300;this.top=0;this.scrollLeft=0;this.attributes=new Map();this.firstElementChild=null;this.html='';}
  get scrollTop(){return this.top;}
  set scrollTop(value){this.top=Math.max(0,Math.min(value,this.height-this.clientHeight));}
  setAttribute(k,v){this.attributes.set(k,v);}
  removeAttribute(k){this.attributes.delete(k);}
  render(html,height){this.html=html;this.height=height;this.scrollTop=this.top;this.firstElementChild={style:{},inert:false};}
}
let alive=true;const frames=[];
const keeper=createDetailPanelScroll({alive:()=>alive,schedule:fn=>frames.push(fn)}),body=new Panel();
const ready={scope:'object:1:element',complete:true},loading={scope:'object:1:element',loading:true};
const flush=()=>{while(frames.length)frames.shift()();};
keeper.update(body,ready,()=>body.render('A',1300));flush();body.scrollTop=700;
let painted=false;
assert.equal(keeper.update(body,loading,()=>{painted=true;body.render('Загрузка…',40);}),false);
assert.equal(painted,false);assert.equal(body.html,'A');assert.equal(body.scrollTop,700);assert.equal(body.firstElementChild.inert,true);
assert.equal(body.attributes.get('aria-busy'),'true');
// Повторные снимки сцены и быстрый выбор ещё одного элемента не схлопывают карточку.
keeper.update(body,loading,()=>body.render('Загрузка…',40));assert.equal(body.scrollTop,700);
keeper.update(body,ready,()=>body.render('B',1400));assert.equal(body.scrollTop,700);assert.equal(body.firstElementChild.inert,false);
assert.equal(body.attributes.has('aria-busy'),false);flush();assert.equal(body.scrollTop,700);
// Восстановление следующим кадром не перезаписывает ручную прокрутку.
keeper.update(body,ready,()=>body.render('C',1400));body.scrollTop=740;flush();assert.equal(body.scrollTop,740);
// Первая карточка и другой объект показывают собственную загрузку.
keeper.update(body,{scope:'object:2:element',loading:true},()=>body.render('Загрузка…',40));assert.equal(body.scrollTop,0);assert.equal(body.html,'Загрузка…');
keeper.update(body,{scope:'object:2:element',complete:true},()=>body.render('D',1500));flush();assert.equal(body.scrollTop,0);
// Ошибка не оставляет старые значения активными; короткая карточка естественно ограничивает прокрутку.
body.scrollTop=1000;keeper.update(body,{scope:'object:2:element'},()=>body.render('Ошибка',40));flush();assert.equal(body.scrollTop,0);
keeper.update(body,ready,()=>body.render('E',1400));body.scrollTop=650;
keeper.update(body,ready,()=>body.render('F',900));assert.equal(body.scrollTop,600);flush();assert.equal(body.scrollTop,600);
// Отложенный callback не трогает уже закрытое рабочее место.
keeper.update(body,ready,()=>body.render('G',1400));alive=false;body.scrollTop=200;flush();assert.equal(body.scrollTop,200);
console.log('PASS: stable loading, repeated selection, response, manual scroll, first card, object change, errors, shorter content, disposal.');
