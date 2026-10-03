"""Local HTTP inference only; no SDK, cloud fallback, redirects or document URLs."""
import base64
import io
import ipaddress
import json
import re
import secrets
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener
from PIL import Image, ImageDraw, ImageFont
from .database import dumps


class InferenceError(Exception):
    pass


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


def chat(config, settings, messages, schema, name='recovery', transport=None):
    validate_endpoint(config,settings,resolve=transport is None)
    if config.provider=='openai':
        base=config.baseUrl.rstrip('/')
        if not urlsplit(base).path.rstrip('/'): base+='/v1'
        url=base+'/chat/completions'
        converted=[]
        for message in messages:
            content=[{'type':'text','text':message['content']}]
            content += [{'type':'image_url','image_url':{'url':'data:image/png;base64,'+i}} for i in message.get('images',[])]
            converted.append({'role':message['role'],'content':content if message.get('images') else message['content']})
        body={'model':config.model,'messages':converted,'temperature':0,'max_tokens':config.maxTokens,
              'response_format':{'type':'json_schema','json_schema':{'name':name,'schema':schema}}}
    else:
        base=config.baseUrl.rstrip('/')
        url=base+('/chat' if urlsplit(base).path.rstrip('/').endswith('/api') else '/api/chat')
        body={'model':config.model,'messages':messages,'stream':False,'format':schema,
              'options':{'temperature':0,'num_predict':config.maxTokens}}
    headers={'Content-Type':'application/json'}
    if settings.qwen_api_key: headers['Authorization']='Bearer '+settings.qwen_api_key
    if transport:
        response=transport(url,body,headers,config.timeoutSeconds)
    else:
        try:
            request=Request(url,data=dumps(body).encode(),headers=headers,method='POST')
            with build_opener(ProxyHandler({}),NoRedirect()).open(request,timeout=config.timeoutSeconds) as result:
                raw=result.read(8*1048576+1)
                if len(raw)>8*1048576: raise InferenceError('Ответ Qwen превышает допустимый размер')
            response=json.loads(raw)
        except HTTPError as error:
            raise InferenceError(f'Qwen вернул HTTP {error.code}. Проверьте модель, поддержку изображений и JSON Schema') from None
        except (URLError,TimeoutError,OSError):
            raise InferenceError('Qwen недоступен или истекло время ожидания. Проверьте адрес и сеть') from None
        except (json.JSONDecodeError,UnicodeError):
            raise InferenceError('API Qwen вернул некорректный JSON') from None
    try:
        if config.provider=='openai':
            choice=response['choices'][0]
            if choice.get('finish_reason')=='length': raise InferenceError('Ответ Qwen обрезан лимитом токенов. Увеличьте лимит или сократите число листов')
            content=choice['message']['content']
        else:
            if response.get('done_reason')=='length': raise InferenceError('Ответ Qwen обрезан лимитом токенов')
            content=response['message']['content']
        content=re.sub(r'^```(?:json)?\s*|\s*```$','',content.strip())
        value=json.loads(content,parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite number')))
        if not isinstance(value,dict): raise ValueError()
        return value
    except (KeyError,IndexError,TypeError,ValueError,AttributeError):
        raise InferenceError('Qwen не вернул полный объект по JSON-схеме') from None


def probe(config,settings,transport=None):
    if not config.model.strip(): raise ValueError('Укажите название установленной модели')
    code=str(secrets.randbelow(900)+100)
    image=Image.new('RGB',(400,160),'white')
    ImageDraw.Draw(image).text((35,25),code,fill='black',font=ImageFont.load_default(size=90))
    output=io.BytesIO();image.save(output,format='PNG');image.close()
    schema={'type':'object','properties':{'code':{'type':'string'}},'required':['code'],'additionalProperties':False}
    response=chat(config,settings,[{'role':'user','content':'Прочитай три цифры на изображении. Верни только JSON с полем code.','images':[base64.b64encode(output.getvalue()).decode()]}],schema,'vision_probe',transport)
    if response.get('code')!=code:
        raise InferenceError('Тест чтения изображения не пройден. Проверьте мультимодальную модель и передачу изображений')
    return {'ok':True,'vision':True,'structuredOutput':True,'model':config.model,
            'note':'Проверено чтение тестового изображения. Точность на проектных чертежах оценивается отдельно.'}
