/* Grouped monetary display; storage and calculations use unformatted decimal strings. */
(()=>{
 'use strict';
 const separator='\u00a0',spaces=/\s/g;
 const formatter=new Intl.NumberFormat('ru-RU',{useGrouping:true,minimumFractionDigits:2,maximumFractionDigits:2});
 function canonical(value){return String(value??'').replace(spaces,'').replace(',','.');}
 function expand(value){
  const match=value.match(/^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if(!match||!Number.isFinite(Number(value)))return value;
  const digits=match[2]+(match[3]||''),point=match[2].length+Number(match[4]);
  if(Math.abs(point)>1000)return value;
  return match[1]+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
 }
 function editable(value){
  const raw=expand(canonical(value));if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))return raw;
  const [integer,fraction]=raw.split('.');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g,separator)+(fraction===undefined?'':','+fraction);
 }
 function read(input){return canonical(input.value);}
 function validate(input){
  const raw=read(input),value=Number(raw),min=input.getAttribute('min'),max=input.getAttribute('max');
  let message='';
  if(raw&&(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)||!Number.isFinite(value)))message='Введите сумму числом, например 12 345,67.';
  else if(raw&&min!==null&&value<Number(min))message='Минимальное значение: '+editable(min)+'.';
  else if(raw&&max!==null&&value>Number(max))message='Максимальное значение: '+editable(max)+'.';
  input.setCustomValidity(message);return !message;
 }
 function update(input){
  if(!validate(input))return;
  const old=input.value,start=input.selectionStart,end=input.selectionEnd,next=editable(old);
  if(next===old)return;
  const caret=position=>{
   if(position===null)return next.length;
   const logical=old.slice(0,position).replace(spaces,'').length;let count=0,index=0;
   while(index<next.length&&count<logical){if(!/\s/.test(next[index]))count++;index++;}
   return index;
  };
  input.value=next;input.setSelectionRange(caret(start),caret(end));
 }
 document.addEventListener('input',event=>{if(event.target.matches?.('input[data-money]')&&!event.isComposing)update(event.target);},true);
 document.addEventListener('focusout',event=>{if(event.target.matches?.('input[data-money]'))update(event.target);},true);
 document.addEventListener('submit',event=>{
  let valid=true;for(const input of event.target.querySelectorAll('input[data-money]'))valid=validate(input)&&valid;
  if(!valid){event.preventDefault();event.target.reportValidity();}
 },true);
 window.CalcZhBIMoney={format:value=>formatter.format(Number(value)),editable,read,validate};
})();
