 function printCapacity(){
   const paperHeight=q('#cf-format').value==='A3'?420:297;
   // 6 mm margins, 12 mm header, 9 mm table head, 8 mm footer, 1 mm rounding reserve.
   return Math.max(1,Math.floor((paperHeight-12-30)/(boards[board].ops.length*6)));
 }
 function printPages(){
   const floors=q('#cf-scope').value==='all'?ranges.flatMap(r=>r.floors):ranges[ri].floors;
   const capacity=printCapacity(),pages=[];
   for(let i=0;i<floors.length;i+=capacity)pages.push({floors:floors.slice(i,i+capacity)});
   return pages;
 }
 function paperHtml(r,index,total){
   const ops=boards[board].ops;
   // A section absent on the entire sheet does not reserve an empty column.
   const sections=[...(r.floors.some(f=>f<=0)?[0]:[]),...(r.floors.some(f=>f<=10)?[1]:[]),2];
   const label=s=>s===0?'Рампа':`Секция ${s}`;
   const floorName=f=>f===26?'КР':f===25?'ТЭ':String(f);
   let rows='';
   for(const f of r.floors){
     for(let o=0;o<ops.length;o++){
       rows+=`<tr class="${o===0?'floor-start':''}" data-floor="${f}">`;
       if(o===0)rows+=`<th class="paper-floor" rowspan="${ops.length}">${floorName(f)}</th>`;
       for(const s of sections){
         if(f===-1&&s===2)continue;
         const shared=f===-1&&s===1,realSection=shared?3:s,colspan=shared?2:1;
         const absent=(s===0&&f>0)||!exists(f,s);
         if(absent){rows+='<td colspan="2" class="paper-absent"></td>';continue;}
         const na=!applicable(f,realSection,o),p=percent(board,f,realSection,o);
         let opLabel=ops[o];
         if(shared&&o===0)opLabel='Паркинг · '+opLabel;
         if(s===1&&o===0&&f===10)opLabel='КР · '+opLabel;
         if(s===1&&o===0&&f===9)opLabel='ТЭ · '+opLabel;
         rows+=`<td colspan="${colspan}" class="paper-current"><div><span>${opLabel}</span><b>${na?'—':p+'%'}</b></div></td><td colspan="${colspan}" class="paper-new" aria-label="${blockLabel(f,realSection)}, ${ops[o]}, ${na?'не применяется':'новый факт, пустое поле'}">${na?'—':''}</td>`;
       }
       rows+='</tr>';
     }
   }
   return `<header class="sheet-head"><div><strong>Шахматка · ${boards[board].name}</strong><span>Дата факта: <b>${fmt(q('#cf-date').value)}</b></span></div><div><span>Демообъект · Корпус 1 · уровни ${floorName(r.floors[0])}…${floorName(r.floors.at(-1))}</span><span>Ответственный: __________________</span></div><div><span>Снимок системы: ${fmt(today)} · итоговый процент 0–100</span><span>${q('#cf-format').value} · книжная</span></div></header><table class="paper-matrix" aria-label="Бланк обхода по этажам и секциям"><colgroup><col style="width:8mm">${sections.map(()=>'<col><col>').join('')}</colgroup><thead><tr><th rowspan="2">Эт.</th>${sections.map(s=>`<th colspan="2">${label(s)}</th>`).join('')}</tr><tr>${sections.map(()=>'<th>Операция · в системе</th><th>Новый факт, %</th>').join('')}</tr></thead><tbody>${rows}</tbody></table><footer class="sheet-foot"><div>Пусто — без записи; 0 — нулевой факт; «—» — не применяется. КР — кровля; ТЭ — техэтаж.</div><div><span>${r.floors.includes(0)?'Рампа: ур. 0 → 1 эт. · ':''}Подпись: ______________</span><span>${board==='finish'?'ОТД':'МОН'} / К1 · Лист ${index+1} из ${total}</span></div></footer>`;
 }
 function renderPrint(){
   const pages=printPages();printPage=Math.min(printPage,pages.length-1);
   const r=pages[printPage];
   q('#cf-page-label').textContent=`Лист ${printPage+1} из ${pages.length} · ${r.floors.length} уровней`;
   q('#cf-prev').disabled=printPage===0;q('#cf-next').disabled=printPage===pages.length-1;
   q('#cf-paper').classList.toggle('a3',q('#cf-format').value==='A3');
   q('#cf-paper').innerHTML=paperHtml(r,printPage,pages.length);
   q('#cf-print-hint').textContent=`До ${printCapacity()} этажей на листе · ${boards[board].ops.length} операции · строка 6 мм · новые значения всегда пустые.`;
 }
