(()=>{
 const dialog=document.getElementById('pc-login-dialog'),form=document.getElementById('pc-login-form');
 let user=null,loginPromise=null,finishLogin=null;
 class ApiError extends Error{constructor(message,status,detail){super(message);this.status=status;this.detail=detail;}}
 async function request(path,options={}){
  const headers={...options.headers};
  if(options.body&&!(options.body instanceof FormData))headers['Content-Type']='application/json';
  if(options.method&&options.method!=='GET'&&user)headers['X-CSRF-Token']=user.csrfToken;
  let response;
  try{response=await fetch(path,{...options,headers,credentials:'same-origin'});}catch{throw new ApiError('Не удалось связаться с сервером. Изменения сохранены как локальный черновик.',0);}
  const payload=await response.json().catch(()=>null);
  if(!response.ok){const detail=payload?.detail;const message=typeof detail==='string'?detail:detail?.message||(Array.isArray(detail)?'Проверьте параметры изделия: '+(detail[0]?.msg||'недопустимые значения'):(response.status===502||response.status===504?'Прокси не дождался ответа сервера (HTTP '+response.status+'). Операция могла продолжиться на сервере — подождите и обновите состояние':'Ошибка сервера (HTTP '+response.status+')'));throw new ApiError(message,response.status,detail);}
  return payload;
 }
 // Гамма и тёмная/светлая схема — те же, что в ЖБИ (v2/main.js applyThemeFamily); значения токенов — theme.css.
 const SKINS=new Set(['gos','msu','graphite','indigo','neon','emerald','sand']),DARK=new Set(['graphite','indigo','neon']);
 function applySkin(theme){try{const skin=SKINS.has(theme)?theme:'gos';document.documentElement.dataset.skin=skin;document.documentElement.style.colorScheme=DARK.has(skin)?'dark':'light';}catch{}}
 async function ready(){
  try{user=await request('/calc/api/auth/me');applySkin(user.uiTheme);return user;}catch(error){
   if(error.status===401){location.assign('/');return new Promise(()=>{});}
   throw error;}
 }
 // Вход и выход — общие с ЖБИ: подсистема собственных сеансов не ведёт.
 async function logout(){location.assign('/');}
 window.CalcZhBIAPI={request,ready,logout,get user(){return user;},ApiError};
})();
