// The scene only requests a menu. All writes stay in V2's existing element operations.
export function createSceneContextMenu({getScene,canWrite,label,color,onStatus}){
 let root=null,target=null,abort=null;
 function close(focus=false){abort?.abort();abort=null;root?.remove();root=null;target=null;if(focus)document.querySelector('iframe.ws-frame')?.focus();}
 function sync(){const s=getScene();if(target&&(!canWrite()||!s?.loaded||s.objectId!==target.objectId||s.selectedId!==target.id||s.view!==target.view||s.selected?.current_status!==target.status))close();}
 function open({id,x,y}){
  close();const s=getScene();
  if(!canWrite()||!s?.loaded||s.error||s.selectedId!==id||!s.selected||s.readOnly)return;
  target={id,objectId:s.objectId,view:s.view,status:s.selected.current_status};
  root=document.createElement('div');root.className='v2-scene-context';root.setAttribute('role','menu');root.setAttribute('aria-label','Сменить статус изделия');
  const title=document.createElement('strong');title.className='v2-scene-context-title';title.textContent=`${s.selected.mark||id} — сменить статус`;root.append(title);
  for(const status of [...new Set(s.statusOrder||[])]){
   const b=document.createElement('button');b.type='button';b.dataset.contextStatus=status;b.setAttribute('role','menuitem');b.disabled=status===s.selected.current_status;
   const dot=document.createElement('i');dot.className='ws-sw';dot.style.backgroundColor=color(status);b.append(dot,document.createTextNode(label(status)));
   if(b.disabled){b.classList.add('current');b.setAttribute('aria-label',`${label(status)} — текущий статус`);}
   b.addEventListener('click',()=>{const current=getScene();if(!canWrite()||current?.objectId!==target?.objectId||current?.selectedId!==id){close();return;}close();onStatus(id,status);});root.append(b);
  }
  document.body.append(root);const box=root.getBoundingClientRect();root.style.left=Math.max(8,Math.min(x,window.innerWidth-box.width-8))+'px';root.style.top=Math.max(8,Math.min(y,window.innerHeight-box.height-8))+'px';
  abort=new AbortController();const opts={signal:abort.signal};
  document.addEventListener('pointerdown',e=>{if(!root?.contains(e.target))close();},{...opts,capture:true});
  document.addEventListener('keydown',e=>{
   if(e.key==='Escape'){e.preventDefault();close(true);return;}
   if(e.key==='Tab'){close();return;}
   if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
   e.preventDefault();const buttons=[...root.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);
   const index=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[index]?.focus();
  },opts);
  window.addEventListener('resize',()=>close(),opts);document.addEventListener('scroll',e=>{if(!root?.contains(e.target))close();},{...opts,capture:true});
  root.querySelector('button:not(:disabled)')?.focus();
 }
 return{open,close,sync,destroy:close};
}
