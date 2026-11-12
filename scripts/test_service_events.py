"""Isolated regression checks for diagnostic events and journal filters.

Run: .venv312/bin/python scripts/test_service_events.py
Uses a temporary DB, no lifespan/startup and no production writes.
"""
import asyncio
import gzip
import json
import logging
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
WORK = tempfile.TemporaryDirectory(prefix='zhbi_events_')
os.environ['ZHBI_DB_PATH'] = str(Path(WORK.name) / 'test.db')
os.environ['ZHBI_CALC_DIR'] = str(Path(WORK.name) / 'calc')
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from app import main, activity, error_log
from app.service_events import safe_query, safe_text


class ASGIClient:
    """Exercise the actual middleware stack without optional HTTP clients."""
    def __init__(self, app): self.app = app
    def get(self, path, params=None, headers=None):
        if params: path += '?' + urlencode(params)
        url = urlsplit(path)
        async def call():
            messages, received = [], False
            async def receive():
                nonlocal received
                if not received:
                    received = True
                    return {'type': 'http.request', 'body': b'', 'more_body': False}
                await asyncio.Event().wait()
            async def send(message): messages.append(message)
            scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'},
                     'http_version': '1.1', 'method': 'GET', 'scheme': 'http',
                     'path': url.path, 'raw_path': url.path.encode(), 'root_path': '',
                     'query_string': url.query.encode(), 'headers': list((headers or {}).items()),
                     'client': ('127.0.0.1', 1234), 'server': ('test', 80)}
            try: await self.app(scope, receive, send)
            except Exception:
                if not any(m['type'] == 'http.response.start' for m in messages): raise
            start = next(m for m in messages if m['type'] == 'http.response.start')
            body = b''.join(m.get('body', b'') for m in messages if m['type'] == 'http.response.body')
            if dict(start['headers']).get(b'content-encoding') == b'gzip': body = gzip.decompress(body)
            body = body.decode()
            return SimpleNamespace(status_code=start['status'], text=body,
                headers={k.decode().lower(): v.decode() for k,v in start['headers']}, json=lambda: json.loads(body))
        return asyncio.run(call())


@main.app.get('/calc/api/_journal-test/{kind}')
def diagnostic_route(kind: str):
    if kind == 'exception':
        raise ValueError('Неизвестная ставка бетона')
    if kind == 'wrapped':
        try:
            raise RuntimeError('source calculator unavailable')
        except RuntimeError as exc:
            raise HTTPException(503, 'Внутренняя ошибка сервиса') from exc
    if kind == 'manual':
        return JSONResponse({'detail': 'Ручной отказ сервиса'}, status_code=502)
    if kind == 'compressed':
        return JSONResponse({'detail': 'Подробная ошибка ' * 100}, status_code=502)
    if kind == 'denied':
        raise HTTPException(403, 'Нет доступа')
    if kind == 'operation':
        activity.log('service_diagnostic', request_id='existing-operation-id')
        return {'ok': True}
    activity.log('service_diagnostic', details={'сообщение': 'Внутри запроса'})
    return {'ok': True}


class ServiceEventsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = sqlite3.connect(os.environ['ZHBI_DB_PATH'])
        conn.execute('CREATE TABLE activity_log(id INTEGER PRIMARY KEY, ' + ','.join(
            f'{c} ' + ('REAL' if c == 'duration_ms' else 'INTEGER' if c in {'user_id', 'entity_id', 'impersonator_user_id'} else 'TEXT')
            for c in activity._COLUMNS) + ')')
        conn.commit(); conn.close()
        for route in main.app.routes:
            if getattr(route, 'endpoint', None) is main.search_activity:
                main.app.dependency_overrides[route.dependant.dependencies[0].call] = lambda: {'id': 7}
        cls.client = ASGIClient(main.app)

    def setUp(self):
        while not activity._queue.empty(): activity._queue.get_nowait()
        error_log._seen.clear()
        c = sqlite3.connect(os.environ['ZHBI_DB_PATH'])
        c.execute('DELETE FROM activity_log'); c.commit(); c.close()
        self.actor = patch('app.error_log._user_for_log', return_value=(7, 'Тестовый администратор'))
        self.actor.start()

    def tearDown(self): self.actor.stop()

    def flush(self):
        events = []
        while not activity._queue.empty(): events.append(activity._queue.get_nowait())
        c = sqlite3.connect(os.environ['ZHBI_DB_PATH'])
        activity._write_batch(c, events); c.close()
        return events

    def test_exception_each_request_has_id_cause_trace_duration_and_actor(self):
        for _ in range(2):
            response = self.client.get('/calc/api/_journal-test/exception?token=private-value&mark=К1')
            self.assertEqual(response.status_code, 500)
            self.assertEqual(response.json()['request_id'], response.headers['x-request-id'])
        events = self.flush()
        self.assertEqual(len(events), 2)
        self.assertEqual(len({e['request_id'] for e in events}), 2)
        for event in events:
            d = json.loads(event['details'])
            self.assertEqual(event['user_id'], 7)
            self.assertGreater(event['duration_ms'], 0)
            self.assertIn('ValueError', d['трассировка'])
            self.assertIn('Неизвестная ставка бетона', d['сообщение'])
            self.assertNotIn('private-value', d['параметры'])
            self.assertEqual(d['подсистема'], 'calc')

    def test_http_wrapped_failure_keeps_cause_and_manual_response_detail(self):
        r = self.client.get('/calc/api/_journal-test/wrapped')
        self.assertEqual(r.status_code, 503)
        events = self.flush()
        self.assertEqual(len(events), 1)
        self.assertIn('source calculator unavailable', json.loads(events[0]['details'])['трассировка'])
        self.assertEqual(json.loads(events[0]['details'])['тип ошибки'], 'RuntimeError')
        self.client.get('/calc/api/_journal-test/manual')
        self.assertEqual(json.loads(self.flush()[0]['details'])['сообщение'], 'Ручной отказ сервиса')

    def test_success_events_correlate_and_denied_responses_are_not_duplicated(self):
        r = self.client.get('/calc/api/_journal-test/ok')
        events = self.flush()
        self.assertEqual(len(events), 2)
        self.assertTrue(all(e['request_id'] == r.headers['x-request-id'] for e in events))
        for _ in range(2): self.client.get('/calc/api/_journal-test/denied')
        self.assertEqual(len(self.flush()), 1)

    def test_background_diagnostics_and_filters_with_historical_invalid_json(self):
        logging.getLogger('app.calc.recovery').error('Фоновая задача сломана')
        self.client.get('/calc/api/_journal-test/exception')
        events = self.flush()
        c = sqlite3.connect(os.environ['ZHBI_DB_PATH'])
        c.execute("INSERT INTO activity_log(at,action,details) VALUES('2026-01-01','legacy','not-json')")
        c.commit(); c.close()
        cases = [({'subsystem': 'calc', 'status': 500}, 1), ({'logger': 'recovery'}, 1),
                 ({'text': 'фОНОВАЯ'}, 1), ({'detail_key': 'сообщение', 'detail_value': 'СТАВКА'}, 1),
                 ({'request_id': events[1]['request_id']}, 1), ({'method': 'GET', 'exception_type': 'ValueError'}, 1)]
        for params, expected in cases:
            r = self.client.get('/activity', params=params)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()['total'], expected, params)
        r = self.client.get('/activity', params={'limit': 1})
        self.assertEqual(r.json()['total'], 3)
        self.assertEqual(len(r.json()['rows']), 1)
        self.assertEqual(self.client.get('/activity?status=nope').status_code, 400)
        self.assertEqual(self.client.get('/activity?unknown_field=value').status_code, 400)
        self.assertEqual(self.client.get('/activity?limit=0').status_code, 422)

    def test_secret_redaction(self):
        self.assertNotIn('hunter2', safe_text('password=hunter2 token=hunter2 Bearer hunter2'))
        self.assertNotIn('hunter2', safe_query('access_token=hunter2&password=hunter2&mark=К1'))

    def test_existing_operation_groups_remain_searchable_by_http_request(self):
        response = self.client.get('/calc/api/_journal-test/operation')
        events = self.flush()
        self.assertEqual(events[0]['request_id'], 'existing-operation-id')
        result = self.client.get('/activity', {'request_id': response.headers['x-request-id']})
        self.assertEqual(result.json()['total'], 2)
        self.assertEqual(self.client.get('/activity?request_id=existing-operation-id').json()['total'], 1)

    def test_invalid_numeric_filters_fail_cleanly(self):
        for query in ['duration_ms=NaN', 'duration_ms=inf', 'duration_ms=-1', 'id=999999999999999999999999999']:
            self.assertEqual(self.client.get('/activity?' + query).status_code, 400, query)

    def test_compressed_manual_error_keeps_its_explanation(self):
        r = self.client.get('/calc/api/_journal-test/compressed', headers={b'accept-encoding': b'gzip'})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.headers.get('content-encoding'), 'gzip')
        self.assertEqual(json.loads(self.flush()[0]['details'])['сообщение'], 'Подробная ошибка ' * 100)

    def test_recovery_job_error_is_visible_even_when_local_job_journal_fails(self):
        from app.calc.recovery_live import Trace
        trace = Trace(SimpleNamespace(database_path=Path(WORK.name) / 'missing-recovery.db'), 'job-42')
        trace.note('Соединение с моделью оборвалось', 'error')
        events = self.flush()
        self.assertEqual(len(events), 1)
        details = json.loads(events[0]['details'])
        self.assertEqual(details['задание'], 'job-42')
        self.assertEqual(details['этап'], 'prepare')
        self.assertEqual(events[0]['category'], 'error')


if __name__ == '__main__': unittest.main(verbosity=2)
