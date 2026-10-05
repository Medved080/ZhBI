// Layout/navigation only. Calculations, persistence and server writes remain in their existing modules.
(()=>{
 'use strict';
 const root=document.getElementById('precast-concept'),q=s=>root.querySelector(s),main=q('.pc-main');
 const views=['calculation','model','tech','issues','collisions','sources','sheets','history'];
 const groups={documents:['sheets','sources'],review:['issues','collisions']};
 let view='calculation',compare=false,settingsView='prices';
 const remembered={documents:'sheets',review:'issues'};
 function syncViews(){
  const group=Object.keys(groups).find(k=>groups[k].includes(view));
  for(const v of views){const panel=q('#pc-'+v+'-panel');panel.hidden=root.dataset.section!=='products'||v!==view;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',group?'pc-tab-'+group:v==='model'?'pc-tab-model':v==='calculation'?'pc-tab-calculation':'pc-more-label');}
  q('.pc-more-menu summary').id='pc-more-label';
  root.querySelectorAll('.pc-tabs [data-view]').forEach(b=>{const active=b.dataset.view===view;b.setAttribute('aria-pressed',String(active));if(b.getAttribute('role')==='tab'){b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}});
  root.querySelectorAll('[data-tab-group]').forEach(b=>{const active=b.dataset.tabGroup===group;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;if(active)b.setAttribute('aria-controls','pc-'+view+'-panel');});
  root.querySelectorAll('[data-subtabs]').forEach(n=>n.hidden=n.dataset.subtabs!==group);
  q('.pc-more-menu summary').classList.toggle('pc-current-view',view==='tech'||view==='history');
 }
 function enter(section){
  root.dataset.section=section;
  if(section==='home')main.dataset.home='1';else delete main.dataset.home;
  q('#pc-home-panel').hidden=section!=='home';q('#pc-norms-panel').hidden=section!=='norms';q('#pc-project-report-panel').hidden=section!=='reports';
  q('.pc-header').hidden=section!=='products';q('.pc-tabs').hidden=section!=='products';
  root.querySelectorAll('.pc-workspace-nav [data-section]').forEach(b=>{if(b.dataset.section===section)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  q('#pc-home-open').setAttribute('aria-pressed',String(section==='home'));
  if(section!=='products')delete root.dataset.pickerOpen;
  syncViews();
 }
 function products(){window.CalcZhBINorms?.close();window.CalcZhBIProjectReport?.close();enter('products');}
 function setView(next,notify=true){
  if(!views.includes(next))next='calculation';
  if(root.dataset.section!=='products')products();
  view=next;for(const group of Object.keys(groups))if(groups[group].includes(view))remembered[group]=view;
  syncViews();root.querySelectorAll('.pc-more-menu').forEach(d=>d.open=false);
  if(notify)window.dispatchEvent(new CustomEvent('calczhbi:view',{detail:view}));
 }
 function updateCompare(){
  q('#pc-calculation').dataset.compare=String(compare);q('#pc-compare').checked=compare;
  root.querySelectorAll('.pc-detail td').forEach(td=>td.colSpan=compare?8:5);
 }
 function catalog(){
  const mobile=matchMedia('(max-width:740px)').matches;
  if(mobile)root.dataset.pickerOpen=String(root.dataset.pickerOpen!=='true');
  else root.dataset.catalogHidden=String(root.dataset.catalogHidden!=='true');
  updateCatalogButton();if(mobile&&root.dataset.pickerOpen==='true')q('#pc-product-search').focus();
 }
 function updateCatalogButton(){const mobile=matchMedia('(max-width:740px)').matches;q('#pc-catalog-close').hidden=!mobile;q('#pc-catalog-open').textContent=mobile?'Выбрать изделие':root.dataset.catalogHidden==='true'?'Показать каталог':'Скрыть каталог';q('#pc-catalog-open').setAttribute('aria-expanded',String(mobile?root.dataset.pickerOpen==='true':root.dataset.catalogHidden!=='true'));}
 function bindSettings(panel){
  const apply=()=>{panel.querySelectorAll('[data-settings-panel]').forEach(p=>p.hidden=p.dataset.settingsPanel!==settingsView);panel.querySelectorAll('[data-settings-section]').forEach(b=>{const on=b.dataset.settingsSection===settingsView;b.setAttribute('aria-pressed',String(on));});};
  panel.querySelectorAll('[data-settings-section]').forEach(b=>b.addEventListener('click',()=>{settingsView=b.dataset.settingsSection;apply();}));apply();
 }
 q('#pc-products-open').addEventListener('click',products);
 q('#pc-catalog-open').addEventListener('click',catalog);
 q('#pc-catalog-close').addEventListener('click',()=>{delete root.dataset.pickerOpen;updateCatalogButton();q('#pc-catalog-open').focus();});
 q('#pc-catalog-options').addEventListener('click',()=>{const p=q('#pc-catalog-options-panel');p.hidden=!p.hidden;q('#pc-catalog-options').setAttribute('aria-expanded',String(!p.hidden));});
 q('#pc-compare').addEventListener('change',e=>{compare=e.target.checked;updateCompare();window.dispatchEvent(new CustomEvent('calczhbi:ui-change'));});
 root.addEventListener('click',e=>{
  const group=e.target.closest('[data-tab-group]');if(group)q('.pc-tabs [data-view="'+remembered[group.dataset.tabGroup]+'"]').click();
  if(e.target.closest('.pc-service-menu button'))q('.pc-service-menu').open=false;
  if(e.target.closest('[data-product]')){delete root.dataset.pickerOpen;updateCatalogButton();}
 });
 q('.pc-primary-tabs').addEventListener('keydown',e=>{const tabs=[...q('.pc-primary-tabs').querySelectorAll('[role="tab"]')],index=tabs.indexOf(e.target);if(index<0)return;let next;if(e.key==='ArrowRight')next=(index+1)%tabs.length;if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();tabs[next].click();tabs[next].focus();}});
 document.addEventListener('click',e=>root.querySelectorAll('details.pc-service-menu,details.pc-more-menu,details.pc-row-menu').forEach(d=>{if(!d.contains(e.target))d.open=false;}));
 document.addEventListener('keydown',e=>{if(e.key!=='Escape'||document.querySelector('dialog[open]'))return;root.querySelectorAll('details[open]').forEach(d=>{d.open=false;d.querySelector('summary')?.focus();});if(root.dataset.pickerOpen==='true'){delete root.dataset.pickerOpen;updateCatalogButton();q('#pc-catalog-open').focus();}});
 window.addEventListener('resize',updateCatalogButton);
 window.CalcZhBIUI={
  enter,products,setView,updateCompare,bindSettings,
  get view(){return view;},get section(){return root.dataset.section;},
  preferences(){return {view,compare};},
  init(saved={},linked=false){compare=Boolean(saved.compare);updateCompare();setView(linked?'calculation':saved.view||'calculation');},
 };
 enter('products');updateCatalogButton();
})();
