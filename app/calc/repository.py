import hashlib
import json
from uuid import uuid4

from fastapi import HTTPException

from .calculation import calculate
from .database import PROFILE_ID, PROJECT_ID, audit, dumps, now
from .document_models import model_summary, model


MANUAL = ('volume', 'hours', 'concreteRate', 'otherMaterials')


def profile_with_prices(profile, prices):
    """Профиль расчёта, где ставка труда и цена бетона по умолчанию берутся из прайса (проценты и НДС остаются профильными)."""
    return {**profile, "labourRate": prices["labour"]["rate"], "defaultConcreteRate": prices["concrete"]["default"]}


def pricing_context(conn):
    """Нормы и прайс, по которым считаются изделия. Грузится один раз на запрос (рабочая область считает сотни изделий)."""
    from .norms import get_norms
    from .prices import get_prices
    try:
        norms = get_norms(conn)
    except (FileNotFoundError, KeyError):
        norms = None      # каталог моделей на сервер ещё не поставлен
    return {"prices": get_prices(conn, persist=False), "norms": norms}


def dynamic_values(row, ctx):
    """Значения изделия, которые считаются от текущих норм и расценок: {поле: значение}, плюс 'resources' (расход и цена по ресурсам).
    Поля из manual_fields (ручные правки пользователя) не пересчитываются. Изделие вне КЖИ-каталога считает на лету только цену бетона."""
    from decimal import Decimal
    from .norms import parameters_for
    from .prices import concrete_rate
    manual = set(json.loads(row["manual_fields"] or "[]"))
    prices = ctx["prices"]["parameters"]
    document = model(row["document_model_id"]) if row["document_model_id"] else None
    result = {}
    if ctx["norms"] and document and document.get("kind") == "registry" and row["norms_version"] is not None:
        values = parameters_for(document, ctx["norms"], prices, volume=Decimal(row["volume"]) if "volume" in manual else None, concrete_class=row["concrete_class"],
                                concrete_price=Decimal(row["concrete_rate"]) if "concreteRate" in manual else None)
        for field in MANUAL:
            if field not in manual:
                result[field] = values[field]
        result["resources"] = values["resources"]
        result["registry"] = True
    elif "concreteRate" not in manual:
        result["concreteRate"] = concrete_rate(prices, row["concrete_class"])
    return result


def get_product(conn, product_id, ctx=None):
    row = conn.execute("SELECT * FROM products WHERE id=?", (str(product_id),)).fetchone()
    if not row:
        raise HTTPException(404, "Изделие не найдено")
    ctx = ctx or pricing_context(conn)
    dynamic = dynamic_values(row, ctx)
    product = {
        "id": row["id"], "version": row["version"], "projectId": row["project_id"], "name": row["name"],
        "concreteClass": row["concrete_class"], "volume": float(row["volume"]), "weight": float(row["steel_weight"]),
        "hours": float(row["labour_hours"]), "concreteRate": float(row["concrete_rate"]), "otherMaterials": float(row["other_materials"]),
        "geometry": {k: float(v) for k, v in json.loads(row["geometry_json"]).items()} if row["geometry_json"] else None,
        "volumeFromGeometry": bool(row["volume_from_geometry"]), "source": row["source"], "updatedAt": row["updated_at"],
        "legacyKey": row["legacy_key"],
        "documentModelId": row["document_model_id"], "documentModel": model_summary(row["document_model_id"]),
    }
    from .recovery import effective_model_id
    display_id=effective_model_id(conn,row['id'],row['document_model_id'])
    product['displayModelId']=display_id
    if display_id!=row['document_model_id']:
        product['documentModel']=model_summary(display_id)
    for field in MANUAL:
        if field in dynamic:
            product[field] = float(dynamic[field])
    product['manualFields'] = json.loads(row['manual_fields'] or '[]')
    product['pricesVersion'] = ctx['prices']['version']
    product['normsLabourRate'] = None if dynamic.get('registry') else (float(row['norms_labour_rate']) if row['norms_labour_rate'] else None)
    product['normsVersion'] = row['norms_version']
    document = product['documentModel']
    from .discrepancies import for_model
    product['discrepancies'] = for_model(conn,row['document_model_id'])
    if document:
        document = {**document, 'resources': [dict(r) for r in document['resources']]}
        if 'resources' in dynamic:
            # расход и цена ресурсов считаются от текущих норм и прайса; ручные правки строк лежат в line_overrides и накладываются поверх
            document['resources'] = [{**r, 'qty': float(r['qty'])} for r in dynamic['resources']]
        else:
            stored = {r['code']:r for r in conn.execute('SELECT * FROM product_resource_baselines WHERE product_id=?',(row['id'],))}
            for resource in document['resources']:
                if resource['id'] in stored:
                    resource.update(qty=float(stored[resource['id']]['quantity']),rate=stored[resource['id']]['rate'])
        if row['norms_version']:
            document['normsVersion']=row['norms_version']
            document['notes']=[note for note in document['notes'] if not note.startswith('Производственные припуски')]
            document['notes'].append('Производственный расход и труд предварительно рассчитаны по нормам от двух исходных колонн, версия '+str(row['norms_version'])+'. Цены — по прайс-листу сервиса, версия '+str(ctx['prices']['version'])+': при смене расценок стоимость пересчитывается сама.')
            if product['volume']>0:document['issues']=[issue for issue in document['issues'] if issue!='Не задана трудоёмкость']
        if document.get('preview3d'):
            document['notes']=[note for note in document['notes'] if not note.startswith('3D-геометрия')]+document['preview3d']['notes']
        product['documentModel']=document
    from .discrepancies import quality_issues
    product['dataIssues'] = quality_issues(product)
    # Use decimal strings from the DB in authoritative calculation, not the float transport representation.
    exact = {**product, "volume": row["volume"], "weight": row["steel_weight"], "hours": row["labour_hours"], "concreteRate": row["concrete_rate"], "otherMaterials": row["other_materials"], "normsLabourRate": None if dynamic.get("registry") else row["norms_labour_rate"]}
    for field in MANUAL:
        if field in dynamic:
            exact[field] = str(dynamic[field])
    extra = [{"id": r["code"], "name": r["name"], "unit": r["unit"], "qty": r["quantity"], "rate": r["rate"], "detail": "Пользовательская статья входит в базу прибыли."} for r in conn.execute("SELECT * FROM extra_lines WHERE product_id=? ORDER BY sort_order", (row["id"],))]
    overrides = {r["line_code"]: {key: r[column] for key, column in [("qty", "quantity"), ("rate", "rate"), ("amount", "amount")] if r[column] is not None} for r in conn.execute("SELECT * FROM line_overrides WHERE product_id=?", (row["id"],))}
    profile = conn.execute("SELECT * FROM calculation_profiles WHERE id=?", (row["profile_id"],)).fetchone()
    parameters = profile_with_prices(json.loads(profile["parameters_json"]), ctx["prices"]["parameters"])
    snapshot = calculate(exact, extra, overrides, parameters)
    snapshot["product"] = {**snapshot["product"], **product, "material": snapshot["product"]["material"], "labour": snapshot["product"]["labour"], "price": snapshot["baseTotal"]}
    snapshot["profileId"], snapshot["profileVersion"], snapshot["pricesVersion"] = profile["id"], profile["version"], ctx["prices"]["version"]
    return {"product": snapshot["product"], "extra": [{**r, "qty": float(r["qty"]), "rate": float(r["rate"])} for r in extra], "overrides": overrides, "snapshot": snapshot}


def save_product(conn, body, actor, legacy_key=None, baseline_resources=None, norms_version=None, labour_rate=None):
    request_id = str(body.requestId)
    request_hash = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    replay = conn.execute("SELECT * FROM mutations WHERE request_id=?", (request_id,)).fetchone()
    if replay:
        if replay["actor_id"] != actor or replay["request_hash"] != request_hash:
            raise HTTPException(409, "Идентификатор запроса уже использован")
        return json.loads(replay["response_json"])
    p = body.product
    identifier = str(p.id)
    old = conn.execute("SELECT version FROM products WHERE id=?", (identifier,)).fetchone()
    version = old["version"] if old else 0
    if version != body.expectedVersion:
        raise HTTPException(409, {"message": "Изделие изменено другим пользователем", "current": get_product(conn, identifier) if old else None})
    from decimal import Decimal
    ctx = pricing_context(conn)
    manual = body.manualFields if body.manualFields is not None else (json.loads(conn.execute("SELECT manual_fields FROM products WHERE id=?", (identifier,)).fetchone()[0] or "[]") if old else [])
    resources=baseline_resources
    if resources is None and p.documentModelId:
        row_like = {"manual_fields": dumps(manual), "document_model_id": p.documentModelId, "norms_version": norms_version if norms_version is not None else (conn.execute("SELECT norms_version FROM products WHERE id=?", (identifier,)).fetchone()[0] if old else None),
                    "volume": str(p.volume), "concrete_class": p.concreteClass, "concrete_rate": str(p.concreteRate)}
        dynamic = dynamic_values(row_like, ctx)
        if "resources" in dynamic:
            resources = dynamic["resources"]
        else:
            resources=[dict(r) for r in model(p.documentModelId)['resources']]
            stored={r['code']:r for r in conn.execute('SELECT * FROM product_resource_baselines WHERE product_id=?',(identifier,))}
            for r in resources:
                if r['id'] in stored:r.update(qty=stored[r['id']]['quantity'],rate=stored[r['id']]['rate'])
    cost=sum((Decimal(str(r['qty']))*Decimal(r['rate']) for r in resources or []),Decimal(0))
    if p.otherMaterials<cost - Decimal("0.01"):raise HTTPException(422,'Стоимость материалов меньше суммы ресурсных позиций')
    timestamp = now()
    values = (p.name, p.concreteClass, str(p.volume), str(p.weight), str(p.hours), str(p.concreteRate), str(p.otherMaterials), dumps(p.geometry.model_dump(mode="json")) if p.geometry else None, int(p.volumeFromGeometry), p.source, version + 1, timestamp)
    if old:
        conn.execute("UPDATE products SET name=?,concrete_class=?,volume=?,steel_weight=?,labour_hours=?,concrete_rate=?,other_materials=?,geometry_json=?,volume_from_geometry=?,source=?,version=?,updated_at=? WHERE id=?", (*values, identifier))
    else:
        conn.execute("INSERT INTO products(name,concrete_class,volume,steel_weight,labour_hours,concrete_rate,other_materials,geometry_json,volume_from_geometry,source,version,updated_at,id,project_id,profile_id,legacy_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (*values, identifier, PROJECT_ID, PROFILE_ID, legacy_key, timestamp))
    conn.execute("UPDATE products SET document_model_id=?,manual_fields=? WHERE id=?", (p.documentModelId, dumps(manual), identifier))
    conn.execute("DELETE FROM extra_lines WHERE product_id=?", (identifier,))
    conn.execute("DELETE FROM line_overrides WHERE product_id=?", (identifier,))
    for index, row in enumerate(body.extra):
        conn.execute("INSERT INTO extra_lines VALUES(?,?,?,?,?,?,?)", (identifier, row.id, row.name, row.unit, str(row.qty), str(row.rate), index))
    for code, override in body.overrides.items():
        values = [str(v) if v is not None else None for v in [override.qty, override.rate, override.amount]]
        if any(value is not None for value in values):
            conn.execute("INSERT INTO line_overrides VALUES(?,?,?,?,?)", (identifier, code, *values))
    if baseline_resources is not None:
        conn.execute('DELETE FROM product_resource_baselines WHERE product_id=?',(identifier,))
        for r in baseline_resources:conn.execute('INSERT INTO product_resource_baselines VALUES(?,?,?,?)',(identifier,r['id'],str(r['qty']),str(r['rate'])))
    if norms_version is not None:conn.execute('UPDATE products SET norms_version=?,norms_labour_rate=? WHERE id=?',(norms_version,str(labour_rate),identifier))
    result = get_product(conn, identifier)
    snapshot = result["snapshot"]
    conn.execute("INSERT INTO calculation_versions VALUES(?,?,?,?,?,?,?,?)", (str(uuid4()), identifier, version + 1, snapshot["profileId"], snapshot["profileVersion"], dumps(snapshot), actor, timestamp))
    audit(conn, actor, "product.created" if not old else "product.updated", identifier, {"version": version + 1})
    conn.execute("INSERT INTO mutations VALUES(?,?,?,?,?)", (request_id, actor, request_hash, dumps(result), timestamp))
    return result
