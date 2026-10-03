(()=>{
 'use strict';
 const root=document.getElementById('pc-file-list'),status=document.getElementById('pc-files-status'),input=document.getElementById('pc-file-input'),drop=document.getElementById('pc-file-drop');
 let currentKey=null,revision=0,uploading=false;
 const api=window.CalcZhBIAPI;
 const size=value=>value>=1048576?(value/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МБ':Math.max(1,Math.ceil(value/1024))+' КБ';
 async function render(){
  const key=currentKey,version=++revision;if(!key)return;
  document.getElementById('pc-upload-files').hidden=api.user?.role==='viewer';
  try{
   const files=await api.request('/calc/api/products/'+key+'/files');
   if(version!==revision||key!==currentKey)return;root.replaceChildren();
   if(status.dataset.error==='true'){status.textContent='';status.dataset.error='false';}
   if(!files.length){const empty=document.createElement('p');empty.className='pc-context';empty.textContent='К этому изделию файлы пока не прикреплены.';root.append(empty);return;}
   for(const file of files){
    const row=document.createElement('div');row.className='pc-file-row';
    const description=document.createElement('div'),name=document.createElement('strong'),info=document.createElement('span');name.textContent=file.name;info.textContent=size(file.size)+' · '+new Date(file.createdAt).toLocaleDateString('ru-RU');info.className='pc-context';description.append(name,info);
    const download=document.createElement('a');download.href='/calc/api/files/'+encodeURIComponent(file.id)+'/download';download.textContent='Скачать';download.setAttribute('aria-label','Скачать '+file.name);download.className='pc-file-download';
    row.append(description,download);root.append(row);
   }
  }catch(error){if(version===revision){status.textContent=error.status===404?'Сначала сохраните новое изделие.':error.message;status.dataset.error='true';}}
 }
 async function addFiles(fileList,key){
  if(uploading||!key||!fileList.length||api.user?.role==='viewer')return;
  const files=Array.from(fileList);uploading=true;document.getElementById('pc-upload-files').disabled=true;status.textContent='Сохраняю файлы на сервере…';status.dataset.error='false';
  try{
   await window.CalcZhBIFlushSaves?.();
   const body=new FormData();for(const file of files)body.append('files',file);
   await api.request('/calc/api/products/'+key+'/files',{method:'POST',body});
   if(currentKey===key)status.textContent='Файлы сохранены на сервере: '+files.length+'.';await render();
  }catch(error){if(currentKey===key){status.textContent=error.message;status.dataset.error='true';}}
  finally{uploading=false;document.getElementById('pc-upload-files').disabled=false;input.value='';}
 }
 document.getElementById('pc-upload-files').addEventListener('click',()=>input.click());
 input.addEventListener('change',()=>void addFiles(input.files,currentKey));
 drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('pc-dragging');});
 drop.addEventListener('dragleave',()=>drop.classList.remove('pc-dragging'));
 drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('pc-dragging');void addFiles(event.dataTransfer.files,currentKey);});
 window.addEventListener('calczhbi:product',event=>{if(currentKey!==event.detail){currentKey=event.detail;status.textContent='';void render();}});
 window.addEventListener('calczhbi:saved',()=>void render());
 if(window.CalcZhBIProjectKey){currentKey=window.CalcZhBIProjectKey;void render();}
 async function legacyFiles(){
  if(!window.indexedDB)return [];
  if(indexedDB.databases){const databases=await indexedDB.databases();if(!databases.some(db=>db.name==='calczhbi-project-files'))return [];}
  return new Promise((resolve,reject)=>{
   const request=indexedDB.open('calczhbi-project-files',1);request.onupgradeneeded=()=>{request.transaction.abort();resolve([]);};request.onerror=()=>resolve([]);
   request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('files')){db.close();resolve([]);return;}const tx=db.transaction('files','readonly'),query=tx.objectStore('files').getAll();tx.oncomplete=()=>{db.close();resolve(query.result);};tx.onerror=()=>{db.close();reject(new Error('Не удалось прочитать прежние файлы браузера.'));};};
  });
 }
 window.CalcZhBIMigrateLegacyFiles=async mapping=>{
  const files=await legacyFiles();
  for(const record of files){
   const target=mapping[record.productKey];if(!target)continue;
   const marker='calczhbi-file-migrated-'+target+'-'+record.id;if(localStorage.getItem(marker))continue;
   const body=new FormData();body.append('files',new File([record.blob],record.name,{type:record.blob.type||'application/octet-stream'}));
   await api.request('/calc/api/products/'+target+'/files',{method:'POST',headers:{'X-Migration-Key':record.id},body});localStorage.setItem(marker,'1');
  }
  if(files.length){document.getElementById('pc-migration-status').textContent='Изделия и прежние файлы перенесены на сервер. Локальная копия сохранена.';await render();}
 };
})();
