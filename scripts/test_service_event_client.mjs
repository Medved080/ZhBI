// Error correlation remains visible in both browser clients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { api } from '../app/static/v2/api.js';
let response = () => new Response(JSON.stringify({detail:'Внутренняя ошибка сервера',request_id:'body-id'}), {status:500,headers:{'Content-Type':'application/json','X-Request-ID':'header-id'}});
globalThis.fetch = async () => response();
await assert.rejects(api.get('/calc/api/products/test'), e => e.requestId === 'header-id' && e.message.includes('Запрос: header-id') && e.detail.includes('Внутренняя ошибка'));
response = () => new Response(JSON.stringify({detail:'Ошибка',request_id:'body-id'}), {status:500});
await assert.rejects(api.get('/test'), e => e.requestId === 'body-id');
const context = vm.createContext({window:{}, document:{getElementById:()=>null}, FormData, fetch:async()=>new Response(JSON.stringify({detail:'Внутренняя ошибка сервиса'}), {status:503,headers:{'X-Request-ID':'calc-id'}})});
vm.runInContext(fs.readFileSync('app/calc/web/api-client.js','utf8'), context);
await assert.rejects(context.window.CalcZhBIAPI.request('/calc/api/test'), e => e.status === 503 && e.requestId === 'calc-id' && e.message.includes('Запрос: calc-id'));
console.log('V2 and Calculator clients preserve request IDs in errors.');
