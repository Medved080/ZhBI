// Independent stages: quantity coverage, payment-request coverage, recorded expense.
// Planned ZRDS amounts and bank execution status are not in this export.
export function documentIndicators(doc){
  const requests=doc.requests.filter(r=>!r.raw.cancelled);
  const orders=[...doc.orders.values()].filter(o=>o.lines.some(l=>!l.raw.cancelled));
  if(!requests.length)return ["orders","requests","expense"].map((kind,i)=>({kind,code:["ЗП","ЗРДС","₽"][i],state:"cancelled",label:"Нет действующих позиций",hint:"Все позиции ЗВП отменены; в исполнении не учитываются."}));
  const covered=requests.filter(r=>r.qty>0 && r.ordered+1e-9>=r.qty).length;
  const touched=requests.filter(r=>r.ordered>1e-9).length;
  const orderState=covered===requests.length?"full":touched?"partial":orders.length?"unknown":"none";
  const coveredOrders=orders.filter(o=>o.payments.length).length;
  const requestState=!coveredOrders?"none":coveredOrders===orders.length?"full":"partial";
  const byPayment=new Map();
  orders.forEach((order,oi)=>order.payments.forEach((payment,pi)=>{
    const key=JSON.stringify([order.document??oi,payment.raw?.ref??payment.raw?.source_row??pi]);
    byPayment.set(key,{amount:(byPayment.get(key)?.amount||0)+payment.amount});
  }));
  const payments=[...byPayment.values()];
  const expenses=payments.filter(p=>p.amount>0).length;
  const expenseState=!payments.length?"none":expenses===payments.length?"full":expenses?"partial":"waiting";
  return [
    {kind:"orders",code:"ЗП",state:orderState,label:{full:"Заказано полностью",partial:"Заказано частично",none:"Заказы отсутствуют",unknown:"Требует сопоставления"}[orderState],
      hint:"Полностью заказано позиций: "+covered+" из "+requests.length+". Сопоставленный заказ есть у "+touched+" позиций."+(orderState==="unknown"?" ЗП созданы, но номенклатура ещё не сопоставлена.":"")},
    {kind:"requests",code:"ЗРДС",state:requestState,label:{full:"ЗРДС созданы для всех ЗП",partial:"ЗРДС созданы для части ЗП",none:"ЗРДС отсутствуют"}[requestState],
      hint:"ЗРДС созданы для "+coveredOrders+" из "+orders.length+" действующих ЗП. Это охват заказов документами; плановые суммы ЗРДС в выгрузке отсутствуют."},
    {kind:"expense",code:"₽",state:expenseState,label:!payments.length?"ЗРДС отсутствуют":expenses===payments.length?"Расход отражён по всем ЗРДС":expenses?"Расход отражён по части ЗРДС":"Ожидают отражения оплаты",
      hint:"Расход отражён по "+expenses+" из "+payments.length+" ЗРДС; без расхода: "+(payments.length-expenses)+". Плановая сумма и банковский статус отдельных ЗРДС не переданы, поэтому полнота оплаты каждой заявки неизвестна."}
  ];
}
