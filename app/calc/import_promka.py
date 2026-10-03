from uuid import uuid4

from .database import SEED_IDS, audit, transaction
from .document_models import model
from .repository import get_product, save_product
from .schemas import ProductSave


def import_promka(settings):
    """Bind reviewed drawings without replacing quantities, prices or user's extras."""
    results = []
    with transaction(settings.database_path) as conn:
        for identifier, model_id in zip(SEED_IDS, ["1KS1-r1", "2KS3-r1"]):
            if not conn.execute("SELECT 1 FROM products WHERE id=?", (identifier,)).fetchone():
                continue
            entry = get_product(conn, identifier)
            p = entry["product"]
            if p["documentModelId"] == model_id:
                continue
            overrides = entry["overrides"]
            # An old aggregate override has to retain its meaning after unfolding materials.
            if overrides.get("rest"):
                old_rest = next(r for r in entry["snapshot"]["rows"] if r["id"] == "rest")
                overrides["rest"] = {"amount": old_rest["precise"]["effectiveAmount"]}
                for resource in model(model_id)["resources"]:
                    overrides[resource["id"]] = {"amount": "0"}
            p.update(documentModelId=model_id, volumeFromGeometry=False)
            body = ProductSave.model_validate({"product": p, "overrides": overrides, "extra": entry["extra"], "expectedVersion": p["version"], "requestId": str(uuid4())})
            result = save_product(conn, body, "system")
            audit(conn, "system", "drawing.imported", identifier, {"modelId": model_id, "source": model(model_id)["source"]})
            results.append({"name": p["name"], "modelId": model_id, "version": result["product"]["version"], "before": entry["snapshot"]["total"], "after": result["snapshot"]["total"]})
    return results
