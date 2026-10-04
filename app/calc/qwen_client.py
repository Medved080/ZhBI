"""Local HTTP inference only; no SDK, cloud fallback, redirects or document URLs."""
import base64
import io
import ipaddress
import json
import re
import secrets
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener
from PIL import Image, ImageDraw, ImageFont
from .database import dumps


class InferenceError(Exception):
    pass


class InferenceCancelled(InferenceError):
    """Запрос прерван по команде (пауза/отмена партии): соединение закрыто, сервер нейросети перестаёт генерировать."""


class InferenceTruncated(InferenceError):
    """Ответ оборван лимитом токенов или признан зациклившимся. partial — всё, что модель успела выдать (для спасения готовых фактов и диагностики)."""
    def __init__(self,message,partial='',deltas=0,reasoning=0,loop=False):
        super().__init__(message);self.partial=partial;self.deltas=deltas;self.reasoning=reasoning;self.loop=loop


class InferenceTimeout(InferenceError):
    """Сервер нейросети не прислал ни байта за тайм-аут (часто — модель ещё загружается в память)."""
    first_token=False


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InferenceError('Перенаправления API Qwen запрещены')


def validate_endpoint(config, settings, resolve=False):
    if ':cloud' in config.model.lower() or config.model.lower().endswith('-cloud'):
        raise ValueError('Выберите локально установленную модель; облачные модели отключены')
    parsed=urlsplit(config.baseUrl)
    try: port=parsed.port
    except ValueError: raise ValueError('Некорректный порт Qwen')
    if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or any(ord(c)<33 for c in config.baseUrl):
        raise ValueError('Укажите HTTP(S)-адрес API без пароля, параметров и фрагментов')
    if port is not None and not 1<=port<=65535:
        raise ValueError('Некорректный порт Qwen')
    host=parsed.hostname.lower()
    explicitly_allowed=host in settings.qwen_allowed_hosts
    def local_ip(value):
        ip=ipaddress.ip_address(value)
        # Limit to actual intranet ranges, not all addresses ipaddress calls private.
        return ip.is_loopback or any(ip in net for net in (
            ipaddress.ip_network('10.0.0.0/8'),ipaddress.ip_network('172.16.0.0/12'),
            ipaddress.ip_network('192.168.0.0/16'),ipaddress.ip_network('fc00::/7')) if ip.version==net.version)
    if not explicitly_allowed:
        if host not in {'localhost','::1'}:
            try: allowed=local_ip(host)
            except ValueError: allowed=False
            if not allowed:
                raise ValueError('Используйте локальный/IP-адрес внутренней сети. Для собственного DNS/публичного сервера задайте CALCZHB_QWEN_ALLOWED_HOSTS на backend')
        if resolve:
            try: addresses=socket.getaddrinfo(host,port or (443 if parsed.scheme=='https' else 80),type=socket.SOCK_STREAM)
            except OSError: raise InferenceError('Не удалось определить адрес сервера Qwen')
            if not addresses or not all(local_ip(a[4][0]) for a in addresses):
                raise InferenceError('Адрес Qwen разрешился за пределы внутренней сети')
    if '..' in parsed.path.split('/'):
        raise ValueError('Недопустимый путь API')
    return parsed


def api_base(config):
    """Базовый адрес API из того, что ввёл человек. Допускается ссылка на любой маршрут сервера (…/v1/models, …/api/v1/models,
    …/v1/chat/completions, …/api/tags): лишнее отбрасывается. OpenAI-совместимый API: …/v1 (у LM Studio ссылка …/api/v1 — это
    тот же сервер, чат — по …/v1). Ollama: адрес без пути."""
    parsed=urlsplit(config.baseUrl.strip());origin=f'{parsed.scheme}://{parsed.netloc}'
    path='/'+parsed.path.strip('/') if parsed.path.strip('/') else ''
    for suffix in ('/chat/completions','/completions','/models','/api/chat','/api/tags','/api/generate'):
        if path.endswith(suffix): path=path[:-len(suffix)]
    if config.provider=='ollama':
        return origin+('' if path in {'','/api'} else path.removesuffix('/api'))
    if path in {'','/api'}: path='/v1'
    elif path.endswith('/api/v1'): path=path[:-len('/api/v1')]+'/v1'
    return origin+path


def looping(text):
    """Признак зацикливания: хвост (300 знаков) повторяется в последних 4000 знаках не меньше четырёх раз."""
    if len(text)<1500: return False
    tail=text[-300:]
    return text[-4000:].count(tail)>=4


def _read_stream(request,config,progress,cancel=None):
    """Чтение ответа по мере поступления (SSE у OpenAI-совместимых API, NDJSON у Ollama). Тайм-аут сокета действует на КАЖДОЕ ожидание данных:
    это тайм-аут простоя (в том числе до первого токена), а не предел общей длительности ответа. Общий предел — 30 минут."""
    import http.client,threading
    parsed=urlsplit(request.full_url);connection_class=http.client.HTTPSConnection if parsed.scheme=='https' else http.client.HTTPConnection
    connection=connection_class(parsed.hostname,parsed.port,timeout=config.timeoutSeconds)
    state={'done':False,'cancelled':False}
    def watcher():
        # Пауза/отмена должны останавливать модель СРАЗУ: закрытие соединения прерывает чтение (в том числе ожидание первого токена)
        # и заставляет сервер нейросети прекратить генерацию.
        while not state['done']:
            try: stop=cancel and cancel()
            except Exception: stop=False  # noqa: BLE001
            if stop:
                state['cancelled']=True
                try:
                    if connection.sock is not None: connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                try: connection.close()
                except OSError: pass
                return
            time.sleep(0.4)
    if cancel: threading.Thread(target=watcher,name='qwen-cancel-watch',daemon=True).start()
    started=time.time();info={'state':'connecting','elapsed':0.0,'sinceLast':0.0,'deltas':0,'reasoningDeltas':0,'chars':0}
    last_emit=[0.0]
    def emit(force=False,**fields):
        now_=time.time();info.update(fields);info['elapsed']=now_-started
        if progress and (force or now_-last_emit[0]>=0.5): last_emit[0]=now_;progress(dict(info))
    emit(True)
    content=[];usage=None;finish=None;last_data=started;openai=config.provider=='openai';tail=''
    try:
        headers=dict(request.header_items())
        connection.request('POST',(parsed.path or '/')+('?'+parsed.query if parsed.query else ''),body=request.data,headers=headers)
        result=connection.getresponse()
        if result.status>=300: raise HTTPError(request.full_url,result.status,result.reason,result.headers,result)
        emit(True,state='waiting_first_token')
        ctype=result.headers.get('Content-Type','').lower()
        if openai and 'event-stream' not in ctype:
            raw=result.read(8*1048576+1)   # сервер проигнорировал stream и ответил целиком
            if len(raw)>8*1048576: raise InferenceError('Ответ Qwen превышает допустимый размер')
            emit(True,state='generating');return json.loads(raw)
        for line in result:
            now_=time.time()
            if now_-started>1800: raise InferenceError('Ответ Qwen идёт дольше 30 минут: прерываю')
            info['sinceLast']=now_-last_data
            line=line.strip()
            if not line or line.startswith(b':'): emit();continue
            last_data=now_
            if openai:
                if not line.startswith(b'data:'): continue
                payload=line[5:].strip()
                if payload==b'[DONE]': break
                obj=json.loads(payload)
                if obj.get('error'): raise InferenceError('Qwen сообщил об ошибке: '+str(obj['error'])[:300])
                if obj.get('usage'): usage=obj['usage']
                choice=(obj.get('choices') or [{}])[0];delta=choice.get('delta') or {}
                text=delta.get('content') or '';thought=delta.get('reasoning_content') or delta.get('reasoning') or ''
                if choice.get('finish_reason'): finish=choice['finish_reason']
            else:
                obj=json.loads(line)
                if obj.get('error'): raise InferenceError('Ollama сообщил об ошибке: '+str(obj['error'])[:300])
                text=(obj.get('message') or {}).get('content') or '';thought=(obj.get('message') or {}).get('thinking') or ''
                if obj.get('done'):
                    finish=obj.get('done_reason') or 'stop'
                    usage={'completion_tokens':obj.get('eval_count'),'prompt_tokens':obj.get('prompt_eval_count')}
            if text:
                content.append(text);tail=(tail+text)[-4200:]
                if info['deltas']%40==39 and looping(tail): raise InferenceTruncated('Модель зациклилась: выдаёт одно и то же. Ответ прерван',''.join(content),info['deltas'],info['reasoningDeltas'],True)
            fields={'state':'generating','chars':info['chars']+len(text)}
            if text: fields['deltas']=info['deltas']+1
            if thought: fields['reasoningDeltas']=info['reasoningDeltas']+1
            if usage and usage.get('completion_tokens'): fields['tokens']=usage['completion_tokens']
            emit(info['state']!='generating',**fields)
            if info['chars']>8*1048576: raise InferenceError('Ответ Qwen превышает допустимый размер')
    except (OSError,ValueError,AttributeError,http.client.HTTPException) as error:
        if state['cancelled']: raise InferenceCancelled('Запрос прерван: задание остановлено (пауза или отмена)') from None
        raise
    finally:
        state['done']=True
        try: connection.close()
        except OSError: pass
    if state['cancelled']: raise InferenceCancelled('Запрос прерван: задание остановлено (пауза или отмена)')
    emit(True)
    stats={'deltas':info['deltas'],'reasoningDeltas':info['reasoningDeltas'],'chars':info['chars']}
    if openai: return {'choices':[{'finish_reason':finish,'message':{'content':''.join(content)}}],'usage':usage,'stats':stats}
    return {'done_reason':finish,'message':{'content':''.join(content)},'usage':usage,'stats':stats}


def chat(config, settings, messages, schema, name='recovery', transport=None, progress=None, cancel=None):
    validate_endpoint(config,settings,resolve=transport is None)
    if config.provider=='openai':
        url=api_base(config)+'/chat/completions'
        converted=[]
        for message in messages:
            content=[{'type':'text','text':message['content']}]
            content += [{'type':'image_url','image_url':{'url':'data:image/png;base64,'+i}} for i in message.get('images',[])]
            converted.append({'role':message['role'],'content':content if message.get('images') else message['content']})
        body={'model':config.model,'messages':converted,'temperature':0,'max_tokens':config.maxTokens,
              'response_format':{'type':'json_schema','json_schema':{'name':name,'schema':schema}}}
        if transport is None: body.update(stream=True,stream_options={'include_usage':True})
    else:
        url=api_base(config)+'/api/chat'
        body={'model':config.model,'messages':messages,'stream':transport is None,'format':schema,
              'options':{'temperature':0,'num_predict':config.maxTokens}}
    headers={'Content-Type':'application/json'}
    if settings.qwen_api_key: headers['Authorization']='Bearer '+settings.qwen_api_key
    if transport:
        response=transport(url,body,headers,config.timeoutSeconds)
    else:
        try:
            request=Request(url,data=dumps(body).encode(),headers=headers,method='POST')
            response=_read_stream(request,config,progress,cancel)
        except HTTPError as error:
            try: snippet=error.read(600).decode('utf-8','replace').strip()
            except OSError: snippet=''
            raise InferenceError(diagnose(config,settings,url,error.code,snippet)) from None
        except InferenceError: raise
        except (URLError,TimeoutError,OSError) as error:
            reason=str(getattr(error,'reason',error))[:160]
            if isinstance(error,TimeoutError) or 'timed out' in reason.lower():
                timeout=InferenceTimeout(f'Qwen не прислал данных {config.timeoutSeconds} с ({url}). Крупная модель может загружаться в память сервера нейросети — увеличьте «Тайм-аут» (300–600 с) и повторите, лучше сначала загрузив модель в LM Studio/Ollama')
                timeout.first_token=True
                raise timeout from None
            raise InferenceError(f'Qwen недоступен по адресу {url}: {reason}. Проверьте адрес, порт и что сервер нейросети запущен') from None
        except (json.JSONDecodeError,UnicodeError):
            raise InferenceError('API Qwen вернул некорректный JSON') from None
    try:
        if config.provider=='openai':
            choice=response['choices'][0]
            if choice.get('finish_reason')=='length':
                st=response.get('stats') or {}
                raise InferenceTruncated(f'Ответ Qwen обрезан лимитом {config.maxTokens} токенов (получено ~{st.get("deltas","?")} токенов ответа'+(f', рассуждение {st["reasoningDeltas"]}' if st.get('reasoningDeltas') else '')+')',choice.get('message',{}).get('content') or '',st.get('deltas',0),st.get('reasoningDeltas',0))
            content=choice['message']['content']
        else:
            if response.get('done_reason')=='length':
                st=response.get('stats') or {}
                raise InferenceTruncated(f'Ответ Qwen обрезан лимитом {config.maxTokens} токенов',response.get('message',{}).get('content') or '',st.get('deltas',0),st.get('reasoningDeltas',0))
            content=response['message']['content']
        content=re.sub(r'^```(?:json)?\s*|\s*```$','',content.strip())
        value=json.loads(content,parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite number')))
        if not isinstance(value,dict): raise ValueError()
        return value
    except (KeyError,IndexError,TypeError,ValueError,AttributeError):
        raise InferenceError('Qwen не вернул полный объект по JSON-схеме') from None


def _get_json(url,timeout=6):
    try:
        with build_opener(ProxyHandler({}),NoRedirect()).open(Request(url,method='GET'),timeout=timeout) as result:
            return json.loads(result.read(1048576))
    except (HTTPError,URLError,TimeoutError,OSError,ValueError,InferenceError):
        return None


def diagnose(config,settings,url,code,snippet):
    """Понятное объяснение HTTP-ошибки API нейросети: что за адрес ответил и какие модели там установлены."""
    parsed=urlsplit(config.baseUrl);origin=f'{parsed.scheme}://{parsed.netloc}'
    text=f'Qwen вернул HTTP {code} по адресу {url}.'
    if snippet: text+=f' Ответ сервера: {re.sub(r"<[^>]+>"," ",snippet)[:300].strip()}.'
    if code in {404,405}:
        health=_get_json(origin+'/health')
        if isinstance(health,dict) and health.get('status')=='ok':
            return text+f' Этот адрес ({origin}) отвечает как сам сервис ЖБИ, а не как нейросеть: порт 8000 занят ЖБИ. Укажите адрес сервера нейросети (Ollama — http://127.0.0.1:11434 с типом API «Ollama»; vLLM/LM Studio — их адрес с /v1 и тип «OpenAI-совместимый»).'
        models=None
        tags=_get_json(origin+'/api/tags')
        if isinstance(tags,dict) and isinstance(tags.get('models'),list): models=[m.get('name') for m in tags['models'] if isinstance(m,dict)]
        else:
            listing=_get_json(origin+'/v1/models')
            if isinstance(listing,dict) and isinstance(listing.get('data'),list): models=[m.get('id') for m in listing['data'] if isinstance(m,dict)]
        if models is not None:
            if config.model not in models: text+=f' Модель «{config.model}» не найдена на сервере. Установленные модели: {", ".join(m for m in models if m)[:400] or "нет"}.'
            else: text+=f' Модель «{config.model}» на сервере есть, но адрес API не подходит: проверьте тип API (Ollama /api/chat или OpenAI-совместимый /v1/chat/completions).'
        else:
            text+=' Не удалось определить тип сервера: проверьте тип API (Ollama или OpenAI-совместимый), адрес и порт.'
    elif code in {400,422}:
        text+=' Сервер отклонил запрос: модель может не поддерживать изображения или JSON Schema.'
    elif code in {401,403}:
        text+=' Сервер требует ключ доступа: задайте CALCZHB_QWEN_API_KEY на backend.'
    else:
        text+=' Проверьте модель, поддержку изображений и JSON Schema.'
    return text


def list_models(config,settings,getter=None):
    """Модели, установленные на сервере нейросети (для выбора в форме): Ollama /api/tags, OpenAI-совместимые /v1/models,
    LM Studio /api/v1/models. Запрос идёт с backend: адрес может быть доступен только серверу, а не браузеру."""
    validate_endpoint(config,settings,resolve=getter is None)
    getter=getter or _get_json
    parsed=urlsplit(config.baseUrl);origin=f'{parsed.scheme}://{parsed.netloc}';base=api_base(config)
    urls=[origin+'/api/tags'] if config.provider=='ollama' else [base+'/models',origin+'/api/v1/models',origin+'/v1/models']
    for url in dict.fromkeys(urls):
        payload=getter(url)
        rows=payload.get('data') or payload.get('models') if isinstance(payload,dict) else payload
        if not isinstance(rows,list): continue
        found=[]
        for row in rows:
            if isinstance(row,str): found.append({'id':row,'vision':None});continue
            if not isinstance(row,dict): continue
            name=row.get('id') or row.get('key') or row.get('name') or row.get('model')
            if not name: continue
            caps=row.get('capabilities')
            vision=(row.get('type')=='vlm' or bool(row.get('vision')) or (isinstance(caps,dict) and bool(caps.get('vision'))) or (isinstance(caps,list) and 'vision' in caps)) or None
            found.append({'id':str(name),'vision':vision})
        if found: return {'url':url,'models':found}
    raise InferenceError('Список моделей не получен: сервер нейросети не ответил по адресам '+', '.join(urls))


def _probe_image(code):
    image=Image.new('RGB',(640,260),'white')
    ImageDraw.Draw(image).text((70,20),code,fill='black',font=ImageFont.load_default(size=190))
    output=io.BytesIO();image.save(output,format='PNG');image.close()
    return base64.b64encode(output.getvalue()).decode()


def probe(config,settings,transport=None):
    if not config.model.strip(): raise ValueError('Укажите название установленной модели')
    schema={'type':'object','properties':{'code':{'type':'string'}},'required':['code'],'additionalProperties':False}
    answers=[];used=set()
    for _ in range(2):  # две попытки с разными числами: одиночная ошибка чтения не должна браковать модель
        code=str(secrets.randbelow(900)+100)
        while code in used: code=str(secrets.randbelow(900)+100)
        used.add(code)
        response=chat(config,settings,[{'role':'user','content':'На изображении трёхзначное число. Прочитай его. Верни только JSON с полем code.','images':[_probe_image(code)]}],schema,'vision_probe',transport)
        got=str(response.get('code','')).strip()
        answers.append((code,got))
        if got==code:
            return {'ok':True,'vision':True,'structuredOutput':True,'model':config.model,
                    'note':'Модель прочитала число на тестовом изображении. Точность на проектных чертежах оценивается отдельно.'}
    shown='; '.join(f'ожидалось «{c}», модель ответила «{g or "пусто"}»' for c,g in answers)
    raise InferenceError('Тест чтения изображения не пройден (' + shown + '). Если ответы не похожи на цифры или пустые — модель не получает изображение: загрузите в LM Studio мультимодальную (VLM) версию модели, проверьте поддержку изображений и контекст не меньше 8192 токенов, отключите режим рассуждений (thinking). Если цифры близки, но неточны — модель слабовата для чертежей, возьмите крупнее')
