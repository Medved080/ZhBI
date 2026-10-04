import hashlib
import json
import secrets
import base64
import os
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import auth
from .config import Settings
from .paths import WEB_DIR
from .database import PROFILE_ID, PROJECT_ID, SCHEMA_VERSION, audit, connect, dumps, initialize, now, transaction
from .repository import get_product, save_product, pricing_context, profile_with_prices
from .schemas import BrowserImport, ProductSave, ProfileSave
from .prices import PricesSave, get_prices, update_prices, get_profile, update_profile
from .document_models import ASSETS, model as document_model, model_readiness
from .norms import NormsSave,get_norms,update_norms,apply_norms
from .source_sheets import sheets_for,preview_path
from .commercial_references import commercial_reference, reference_catalog
from . import recovery, runtime
from .recovery_schema import ConnectionConfig, BatchCreate, PublishRequest, StrictModel
from typing import Literal


class RecoveryRetry(StrictModel):
    stage: Literal['continue','reading','assembly'] = 'continue'


def recovery_admin(request: Request):
    user=auth.writer(request)
    if user['role']!='admin': raise HTTPException(403,'Подключение и публикация доступны администратору')
    return user



WEB_FILES = ["app.js", "recovery.js", "money-format.js", "api-client.js", "project-files.js", "history.js", "export-xlsx.js", "viewer-3d.js", "drawing-geometry.js", "solid-geometry.js", "edge-dimensions.js", "norms.js", "project-report.js", "source-sheets.js", "commercial-reference.js", "sketch-geometry.js", "styles.css", "theme.css", "sync-panel.js", "collisions.js"]


def file_metadata(row):
    return {"id": row["id"], "name": row["original_name"], "size": row["size"], "sha256": row["sha256"], "createdAt": row["created_at"], "downloadUrl": "/calc/api/files/" + row["id"] + "/download"}


def build_router(settings):
    router = APIRouter(prefix="/calc", dependencies=[Depends(runtime.require_ready)])
    @router.get("/api/health")
    def health():
        conn = connect(settings.database_path)
        try:
            version = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
            conn.execute("SELECT 1 FROM products LIMIT 1").fetchone()
            from . import BUILD
            return {"ok": version == SCHEMA_VERSION, "schema": version, "schema_expected": SCHEMA_VERSION, "build": BUILD}
        finally:
            conn.close()

    @router.get("/api/auth/me")
    def me(user=Depends(auth.current_user)):
        return user

    @router.post("/api/marks/resolve")
    def resolve_marks(body: dict, user=Depends(auth.current_user)):
        """Изделия калькулятора по маркам элементов схемы ЖБИ (кнопка «Открыть в калькуляторе»)."""
        from . import marks
        items = body.get("marks")
        if not isinstance(items, list) or len(items) > marks.MAX_BATCH or not all(isinstance(i, dict) for i in items):
            raise HTTPException(422, "Нужен список marks объектов {mark, type}, не более %d" % marks.MAX_BATCH)
        conn = connect(settings.database_path)
        try:
            return {"results": marks.resolve(conn, items)}
        finally:
            conn.close()

    def effective_model(conn, product_id):
        row = conn.execute("SELECT id,document_model_id FROM products WHERE id=?", (str(product_id),)).fetchone()
        if not row:
            raise HTTPException(404, "Изделие не найдено")
        return recovery.effective_model_id(conn, row["id"], row["document_model_id"])

    @router.get("/api/products/{product_id}/collisions")
    def product_collisions(product_id: UUID, user=Depends(auth.current_user)):
        from . import collisions
        conn = connect(settings.database_path)
        try:
            return collisions.listing(conn, effective_model(conn, product_id))
        finally:
            conn.close()

    @router.post("/api/products/{product_id}/collisions/{key}/notes", status_code=201)
    def collision_note(product_id: UUID, key: str, body: dict, user=Depends(auth.writer)):
        from . import collisions
        with transaction(settings.database_path) as conn:
            collisions.add_note(conn, effective_model(conn, product_id), key, str(body.get("text", "")), user)
            return collisions.listing(conn, effective_model(conn, product_id))

    @router.put("/api/products/{product_id}/collisions/{key}/status")
    def collision_status(product_id: UUID, key: str, body: dict, user=Depends(auth.writer)):
        from . import collisions
        with transaction(settings.database_path) as conn:
            collisions.set_status(conn, effective_model(conn, product_id), key, str(body.get("status", "")), user)
            return collisions.listing(conn, effective_model(conn, product_id))

    ws_cache = {}

    def packed(request, data):
        """JSON, сжатый gzip, если клиент это принимает и ответ большой: каталог из 1008 изделий весит десятки мегабайт, и без сжатия
        первая загрузка страницы по сети (VPN, корпоративный прокси) занимала минуты."""
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        headers = {"Vary": "Accept-Encoding", "Cache-Control": "no-store"}
        if len(body) > 65536 and "gzip" in request.headers.get("accept-encoding", ""):
            import gzip
            return Response(gzip.compress(body, 5), media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
        return Response(body, media_type="application/json", headers=headers)

    def workspace_signature(conn):
        import os as _os
        def mtime(name):
            try: return _os.stat(ASSETS / name).st_mtime_ns
            except OSError: return 0
        return (conn.execute("SELECT COUNT(*),MAX(updated_at) FROM products").fetchone()[:], conn.execute("SELECT MAX(version) FROM production_norms").fetchone()[0], conn.execute("SELECT MAX(version) FROM price_list").fetchone()[0], conn.execute("SELECT MAX(version) FROM calculation_profiles").fetchone()[0],
                conn.execute("SELECT COUNT(*),MAX(updated_at) FROM model_discrepancies").fetchone()[:], conn.execute("SELECT COUNT(*) FROM recovery_publications").fetchone()[0],
                conn.execute("SELECT zhbi_project_name FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()[0],
                mtime("promka-models.json"), mtime("promka-register.json"), mtime("promka-solid-models.json"), mtime("promka-discrepancies.json"))

    @router.get("/api/workspace")
    def workspace(request: Request, lite: int = 0, user=Depends(auth.current_user)):
        """lite=1 — для первой загрузки страницы: без снимков расчёта и без реестра расхождений по каждому изделию (это десятки МБ);
        расхождения догружаются для открытого изделия через GET /api/products/{id}. Ответ кешируется до изменения данных."""
        conn = connect(settings.database_path)
        try:
            conn.execute("BEGIN")
            project = conn.execute("SELECT name,zhbi_project_id,zhbi_project_name FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
            if project["zhbi_project_id"] is None:  # проект «Москвич» мог появиться в ЖБИ после старта
                from .link import link_project
                if link_project(settings)["linked"]:
                    project = conn.execute("SELECT name,zhbi_project_id,zhbi_project_name FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
            key = (bool(lite), "gzip" in request.headers.get("accept-encoding", ""), workspace_signature(conn))
            if key in ws_cache:
                return ws_cache[key]
            rows = conn.execute("SELECT id FROM products ORDER BY created_at,id").fetchall()
            profile = conn.execute("SELECT parameters_json FROM calculation_profiles WHERE id=?", (PROFILE_ID,)).fetchone()
            installation = conn.execute("SELECT value FROM application_meta WHERE key='installation_id'").fetchone()[0]
            ctx = pricing_context(conn)
            entries = [get_product(conn, r[0], ctx) for r in rows]
            if lite:
                for entry in entries:
                    entry.pop("snapshot", None)
                    entry["product"].pop("discrepancies", None)
                    entry["product"].pop("dataIssues", None)
            payload = {"project": {"id": PROJECT_ID, "name": project["zhbi_project_name"] or project["name"], "zhbiProjectId": project["zhbi_project_id"], "linked": project["zhbi_project_id"] is not None}, "products": entries, "profile": profile_with_prices(json.loads(profile[0]), ctx["prices"]["parameters"]), "settings": {"pricesVersion": ctx["prices"]["version"], "profileVersion": conn.execute("SELECT version FROM calculation_profiles WHERE id=?", (PROFILE_ID,)).fetchone()[0]}, "installationId": installation, "lite": bool(lite)}
            response = packed(request, payload)
            if len(ws_cache) > 6:
                ws_cache.clear()
            ws_cache[key] = response
            return response
        finally:
            conn.close()

    @router.get('/api/recovery/config')
    def recovery_configuration(user=Depends(auth.current_user)):
        return recovery.get_configuration(settings)

    @router.put('/api/recovery/config')
    def recovery_save_configuration(body: ConnectionConfig,user=Depends(recovery_admin)):
        return recovery.save_configuration(settings,body,user['id'])

    @router.post('/api/recovery/models')
    def recovery_models(body: ConnectionConfig,user=Depends(recovery_admin)):
        from . import qwen_client
        try: return qwen_client.list_models(body,settings)
        except (ValueError,qwen_client.InferenceError) as error: raise HTTPException(422,str(error))

    @router.post('/api/recovery/connection-test',status_code=202)
    def recovery_probe(user=Depends(recovery_admin)):
        return recovery.start_probe(settings)

    @router.get('/api/recovery/connection-test')
    def recovery_probe_state(user=Depends(auth.current_user)):
        return recovery.probe_state()

    @router.post('/api/recovery/force-stop')
    def recovery_force_stop(user=Depends(recovery_admin)):
        return recovery.force_stop(settings,user['id'])

    @router.post('/api/recovery/batches',status_code=201)
    def recovery_start_batch(body: BatchCreate,user=Depends(auth.writer)):
        return recovery.create_batch(settings,body,user['id'])

    @router.post('/api/recovery/batches/{batch_id}/{action}')
    def recovery_batch_action(batch_id: UUID,action: Literal['pause','resume','cancel'],user=Depends(auth.writer)):
        return recovery.control_batch(settings,batch_id,action,user['id'])

    @router.get('/api/recovery/jobs')
    def recovery_jobs(batchId: UUID | None=None,offset: int=Query(default=0,ge=0),user=Depends(auth.current_user)):
        return recovery.list_jobs(settings,str(batchId) if batchId else None,offset)

    @router.get('/api/recovery/jobs/{job_id}')
    def recovery_job(job_id: UUID,user=Depends(auth.current_user)):
        return recovery.get_job(settings,job_id)

    @router.get('/api/recovery/jobs/{job_id}/candidate')
    def recovery_candidate(job_id: UUID,user=Depends(auth.current_user)):
        return recovery.candidate(settings,job_id)

    @router.post('/api/recovery/jobs/{job_id}/retry')
    def recovery_retry(job_id: UUID,body: RecoveryRetry,user=Depends(auth.writer)):
        return recovery.retry_job(settings,job_id,body.stage,user['id'])

    @router.post('/api/recovery/jobs/{job_id}/publish')
    def recovery_publish(job_id: UUID,body: PublishRequest,user=Depends(recovery_admin)):
        return recovery.publish_candidate(settings,job_id,body,user['id'])

    @router.get('/api/recovery/jobs/{job_id}/export')
    def recovery_export(job_id: UUID,user=Depends(auth.current_user)):
        result=recovery.candidate(settings,job_id)
        detail=recovery.get_job(settings,job_id)
        return JSONResponse({**result,'input':detail['input'],'draft':detail['draft']},
                            headers={'Content-Disposition':f'attachment; filename="recovery-{job_id}.json"'})

    @router.get('/api/recovery/jobs/{job_id}/sources/{source_id}/{pdf_page}/image')
    def recovery_source_image(job_id: UUID,source_id: str,pdf_page: int,user=Depends(auth.current_user)):
        job=recovery.get_job(settings,job_id)
        sheet=next((p for p in job['input'].get('sheets',[]) if p['sourceId']==source_id and p['pdfPage']==pdf_page),None)
        if not sheet: raise HTTPException(404,'Лист не входит в сохранённое задание')
        return FileResponse(preview_path(settings,sheet),media_type='image/png')

    @router.get('/api/products/{product_id}/source-sheets')
    def source_sheets(product_id: UUID, user=Depends(auth.current_user)):
        conn=connect(settings.database_path)
        try:return sheets_for(conn,product_id)
        finally:conn.close()

    @router.get('/api/products/{product_id}/commercial-reference')
    def product_commercial_reference(product_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            conn.execute('BEGIN')
            return commercial_reference(conn, product_id)
        finally:
            conn.close()

    @router.get('/api/commercial-reference-source')
    def commercial_reference_source(user=Depends(auth.current_user)):
        data = reference_catalog()
        return FileResponse(ASSETS / 'sources' / data['storageName'], filename=data['filename'],
                            media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

    @router.get('/api/commercial-reference-audit')
    def commercial_reference_audit(user=Depends(auth.current_user)):
        return FileResponse(ASSETS / 'promka-commercial-reference-audit.json', media_type='application/json',
                            filename='Сверка цен КП.json')

    @router.get('/api/products/{product_id}/source-sheets/{sheet_id}/image')
    def source_sheet_image(product_id: UUID, sheet_id: str, user=Depends(auth.current_user)):
        conn=connect(settings.database_path)
        try:sheet=next((s for s in sheets_for(conn,product_id)['sheets'] if s['id']==sheet_id),None)
        finally:conn.close()
        if not sheet:raise HTTPException(404,'Лист не связан с этим изделием')
        return FileResponse(preview_path(settings,sheet),media_type='image/png')

    @router.get("/api/document-models/{model_id}")
    def drawing_model(request: Request, model_id: str, user=Depends(auth.current_user)):
        entry = document_model(model_id)
        if not entry:
            raise HTTPException(404, "Модель по чертежам не найдена")
        return packed(request, entry)

    @router.get("/api/document-models/{model_id}/qa")
    def model_qa(model_id: str, user=Depends(auth.current_user)):
        entry = document_model(model_id)
        solid = entry.get('solidModel') if entry else None
        if not solid:
            raise HTTPException(404, "Протокол поставки не найден")
        return {**{k:solid[k] for k in ['id','alias','status','delivery','qa','qaScope','pending','evidence','notes']},
                'issues':solid.get('issues', []), 'deliveryIssues':solid.get('deliveryIssues', [])}

    @router.get('/api/model-results')
    def model_results(user=Depends(auth.current_user)):
        path = ASSETS / 'promka-solid-supplies.json'
        supplies = json.loads(path.read_text()) if path.exists() else {}
        names = {'claude-columns':'Клод · нижние колонны', 'codex-upper-columns':'Codex · верхние колонны',
                 'codex-abk-columns':'Codex · колонны АБК', 'main':'Основной исполнитель'}
        groups = {key:{'id':key, 'name':supply.get('label') or names.get(key,key), 'capturedAt':supply.get('capturedAt'),
                       'report':supply['report'], 'models':[]} for key,supply in supplies.items()}
        groups['main'] = {'id':'main', 'name':names['main'], 'capturedAt':None,
                          'report':'Две исходные колонны имеют полные визуальные модели. БЛ1–БЛ3 и 2Рк1–2Рк3 — индивидуальные частичные сборки; ограничения и исходные листы находятся в карточках.', 'models':[]}
        with connect(settings.database_path) as conn:
            rows = conn.execute('SELECT id,name,document_model_id FROM products WHERE project_id=? ORDER BY name', (PROJECT_ID,)).fetchall()
            rows=[dict(row,display_id=recovery.effective_model_id(conn,row['id'],row['document_model_id'])) for row in rows]
        for row in rows:
            entry = document_model(row['display_id']); readiness = model_readiness(entry) if entry else {}
            if readiness.get('status') not in {'complete','partial'}: continue
            solid = entry.get('solidModel', {}); worker = solid.get('delivery',{}).get('worker','main')
            groups.setdefault(worker,{'id':worker,'name':'Локальный Qwen','capturedAt':None,'report':'Индивидуальные частичные редакции локальной обработки. Основания и открытые вопросы сохранены в карточках; полнота не удостоверена.','models':[]})
            groups[worker]['models'].append({'productId':row['id'], 'modelId':row['display_id'],
                                             'alias':entry.get('alias',row['name']), 'status':readiness['status'],
                                             'label':readiness['label'], 'pending':solid.get('pending',entry.get('preview3d',{}).get('pendingReinforcement',[]))})
        return {'groups':list(groups.values()), 'limitation':'Показаны все подключённые индивидуальные модели, включая частичные. Габаритные схемы остаются в общем списке изделий. Частичная модель не означает завершённую проверку или допуск в производство.'}

    @router.get("/api/document-source/promka-columns")
    def drawing_source(user=Depends(auth.current_user)):
        return FileResponse(ASSETS / "promka-source.pdf", media_type="application/pdf", content_disposition_type="inline", filename="promka-columns.pdf")

    @router.get("/api/document-source/{source_id}")
    def register_source(source_id: str, user=Depends(auth.current_user)):
        manifest = ASSETS / "promka-sources.json"
        sources = json.loads(manifest.read_text()) if manifest.exists() else {}
        source = sources.get(source_id)
        if not source:
            raise HTTPException(404, "Альбом не найден")
        return FileResponse(ASSETS / "sources" / source["storageName"], media_type="application/pdf", content_disposition_type="inline", filename=source["filename"])

    @router.get('/api/norms')
    def norms(user=Depends(auth.current_user)):
        with transaction(settings.database_path) as conn:
            return get_norms(conn)

    @router.get('/api/prices')
    def prices(user=Depends(auth.current_user)):
        with transaction(settings.database_path) as conn:
            return {**get_prices(conn), "profile": get_profile(conn)}

    @router.put('/api/prices')
    def save_prices(body: PricesSave, user=Depends(auth.writer)):
        with transaction(settings.database_path) as conn:
            return {**update_prices(conn, body, user['id']), "profile": get_profile(conn)}

    @router.put('/api/profile')
    def save_profile(body: ProfileSave, user=Depends(auth.writer)):
        with transaction(settings.database_path) as conn:
            update_profile(conn, body, user['id'])
            return {**get_prices(conn), "profile": get_profile(conn)}

    @router.get('/api/project-report')
    def whole_project_report(user=Depends(auth.current_user)):
        from .discrepancies import project_report
        conn=connect(settings.database_path)
        try:
            conn.execute('BEGIN')
            return project_report(conn)
        finally:conn.close()

    @router.put('/api/norms')
    def save_norms(body: NormsSave, user=Depends(auth.writer)):
        with transaction(settings.database_path) as conn:
            return update_norms(conn,body,user['id'])

    @router.post('/api/norms/apply')
    def apply_production_norms(user=Depends(auth.writer)):
        with transaction(settings.database_path) as conn:
            return apply_norms(conn,user['id'])

    @router.post("/api/products")
    def save(body: ProductSave, user=Depends(auth.writer)):
        with transaction(settings.database_path) as conn:
            return save_product(conn, body, user["id"])

    @router.get("/api/products/{product_id}")
    def product(product_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            return get_product(conn, product_id)
        finally:
            conn.close()

    @router.get("/api/calculation-export-template")
    def calculation_export_template(user=Depends(auth.current_user)):
        # Reference titles/quotes belong to the project, never public static assets.
        return FileResponse(ASSETS / "calculation-export-template.json", media_type="application/json", headers={"Cache-Control": "private, no-store"})

    @router.get("/api/products/{product_id}/calculation")
    def calculation(product_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            return get_product(conn, product_id)["snapshot"]
        finally:
            conn.close()

    @router.get("/api/products/{product_id}/history")
    def history(product_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            get_product(conn, product_id)
            return [dict(r) for r in conn.execute("SELECT id,product_version,profile_version,actor_id,created_at FROM calculation_versions WHERE product_id=? ORDER BY product_version DESC LIMIT 100", (str(product_id),))]
        finally:
            conn.close()

    @router.get("/api/products/{product_id}/history/{version_id}")
    def history_snapshot(product_id: UUID, version_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            row = conn.execute("SELECT snapshot_json FROM calculation_versions WHERE product_id=? AND id=?", (str(product_id), str(version_id))).fetchone()
            if not row:
                raise HTTPException(404, "Версия расчёта не найдена")
            return json.loads(row[0])
        finally:
            conn.close()

    @router.post("/api/migrate-browser")
    def migrate(body: BrowserImport, user=Depends(auth.writer)):
        with transaction(settings.database_path) as conn:
            prior = conn.execute("SELECT mapping_json FROM browser_imports WHERE browser_id=?", (str(body.browserId),)).fetchone()
            if prior:
                return {"mapping": json.loads(prior[0])}
            mapping = {}
            for entry in body.products:
                seed = conn.execute("SELECT id,version FROM products WHERE legacy_key=?", (entry.legacyKey,)).fetchone() if entry.legacyKey else None
                identifier = seed["id"] if seed and seed["version"] == 1 else str(uuid4())
                entry.product.id = UUID(identifier)
                save_product(conn, ProductSave(product=entry.product, extra=entry.extra, overrides=entry.overrides, expectedVersion=1 if seed and seed["version"] == 1 else 0), user["id"])
                if entry.legacyKey:
                    mapping[entry.legacyKey] = identifier
            conn.execute("INSERT INTO browser_imports VALUES(?,?,?,?)", (str(body.browserId), dumps(mapping), user["id"], now()))
            audit(conn, user["id"], "browser.imported", str(body.browserId), {"count": len(body.products)})
            return {"mapping": mapping}

    @router.get("/api/products/{product_id}/files")
    def list_files(product_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            get_product(conn, product_id)
            return [file_metadata(r) for r in conn.execute("SELECT * FROM project_files WHERE product_id=? ORDER BY created_at,id", (str(product_id),))]
        finally:
            conn.close()

    @router.post("/api/products/{product_id}/files")
    async def upload_files(product_id: UUID, request: Request, files: list[UploadFile] = File(...), user=Depends(auth.writer)):
        if len(files) > 20:
            raise HTTPException(422, "За один раз можно загрузить не более 20 файлов")
        migration_key = request.headers.get("x-migration-key")
        if migration_key and (len(files) != 1 or len(migration_key) > 100):
            raise HTTPException(422, "Недопустимый ключ переноса файла")
        conn = connect(settings.database_path)
        try:
            get_product(conn, product_id)
        finally:
            conn.close()
        created_paths, records, committed = [], [], False
        try:
            for uploaded in files:
                identifier = str(uuid4())
                storage_name = identifier + ".bin"
                path = settings.data_dir / "uploads" / storage_name
                created_paths.append(path)
                size, checksum = 0, hashlib.sha256()
                with path.open("xb") as stream:
                    while chunk := await uploaded.read(65536):
                        size += len(chunk)
                        if size > settings.max_upload_mb * 1048576:
                            raise HTTPException(413, f"Файл превышает {settings.max_upload_mb} МБ")
                        checksum.update(chunk)
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                filename = (uploaded.filename or "Проектный файл").replace("\\", "/").rsplit("/", 1)[-1]
                filename = "".join(c for c in filename if ord(c) >= 32)[:255] or "Проектный файл"
                records.append({"id": identifier, "product_id": str(product_id), "original_name": filename, "storage_name": storage_name, "size": size, "sha256": checksum.hexdigest(), "mime_type": uploaded.content_type or "application/octet-stream", "migration_key": migration_key, "actor_id": user["id"], "created_at": now()})
            with transaction(settings.database_path) as conn:
                if migration_key:
                    prior = conn.execute("SELECT * FROM project_files WHERE product_id=? AND migration_key=?", (str(product_id), migration_key)).fetchone()
                    if prior:
                        if prior["sha256"] != records[0]["sha256"]:
                            raise HTTPException(409, "Ключ переноса относится к другому файлу")
                        for path in created_paths:
                            path.unlink(missing_ok=True)
                        return [file_metadata(prior)]
                for record in records:
                    conn.execute("INSERT INTO project_files(id,product_id,original_name,storage_name,size,sha256,mime_type,migration_key,actor_id,created_at) VALUES(:id,:product_id,:original_name,:storage_name,:size,:sha256,:mime_type,:migration_key,:actor_id,:created_at)", record)
                    audit(conn, user["id"], "file.uploaded", record["id"], {"productId": str(product_id), "sha256": record["sha256"], "size": record["size"]})
            committed = True
            return [file_metadata(r) for r in records]
        except BaseException:
            if not committed:
                for path in created_paths:
                    path.unlink(missing_ok=True)
            raise
        finally:
            for uploaded in files:
                await uploaded.close()

    @router.get("/api/files/{file_id}/download")
    def download(file_id: UUID, user=Depends(auth.current_user)):
        conn = connect(settings.database_path)
        try:
            row = conn.execute("SELECT * FROM project_files WHERE id=?", (str(file_id),)).fetchone()
            if not row:
                raise HTTPException(404, "Файл не найден")
            path = settings.data_dir / "uploads" / row["storage_name"]
            if not path.is_file():
                raise HTTPException(404, "Файл недоступен в хранилище")
            return FileResponse(path, filename=row["original_name"], media_type="application/octet-stream")
        finally:
            conn.close()

    @router.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    # Deliberate allowlist: only the calculator front-end, never data, assets or code.
    def asset_endpoint(filename):
        def asset():
            return FileResponse(WEB_DIR / filename)
        return asset

    for name in WEB_FILES:
        router.add_api_route("/" + name, asset_endpoint(name), methods=["GET"])
    return router
