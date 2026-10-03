from decimal import Decimal, localcontext

from .database import PROFILE
from .document_models import model, resource_cost


def calculate(product, extra, overrides, profile=None):
    profile = profile or PROFILE
    with localcontext() as context:
        context.prec = 40
        D = lambda value: Decimal(str(value))
        volume, concrete_rate, labour_hours = D(product["volume"]), D(product["concreteRate"]), D(product["hours"])
        material = volume * concrete_rate + D(product["otherMaterials"])
        labour = labour_hours * D(product["normsLabourRate"] if product.get("normsLabourRate") is not None else profile["labourRate"])
        cost = material + labour + labour * D(profile["socialPercent"]) / 100
        for code in ["energy", "overhead", "admin", "commercial"]:
            cost += material * D(profile[code + "Percent"]) / 100
        service_margin = D(profile["profitPercent"])
        document = model(product.get("documentModelId"))
        resources = (product.get("documentModel") or {}).get("resources", document["resources"]) if document else []
        resource_amount = sum((D(r["qty"])*D(r["rate"]) for r in resources),D(0))
        material_codes = {"concrete", "rest"} | {r["id"] for r in resources}
        definitions = [
            ("concrete", "Бетон " + product["concreteClass"], "м³", volume, concrete_rate),
            *((r["id"], r["name"], r["unit"], D(r["qty"]), D(r["rate"])) for r in resources),
            ("rest", "Прочие материалы" if document else "Арматура и прочие материалы", "компл.", D(1), D(product["otherMaterials"]) - resource_amount),
            ("labour", "Производственный труд", "чел·ч", labour_hours, D(product["normsLabourRate"] if product.get("normsLabourRate") is not None else profile["labourRate"])),
            ("soc", "Страховые взносы", "%", D(profile["socialPercent"]), labour / 100),
        ]
        for code, name in [("energy", "Энергоуслуги"), ("overhead", "Общепроизводственные"), ("admin", "Административные"), ("commercial", "Коммерческие")]:
            definitions.append((code, name, "%", D(profile[code + "Percent"]), material / 100))
        extra_cost = sum((D(row["qty"]) * D(row["rate"]) for row in extra), D(0))
        definitions.extend((r["id"], r["name"], r["unit"], D(r["qty"]), D(r["rate"])) for r in extra)
        definitions.extend([
            ("profit", "Прибыль при марже " + str(service_margin) + "%", "%", service_margin, (cost + extra_cost) / (1 - service_margin / 100) / 100),
            ("delivery", "Доставка", "%", D(profile["deliveryPercent"]), material / 100),
        ])
        rows, amounts, total, base_total, effective_cost = [], {}, D(0), D(0), D(0)
        for code, name, unit, qty, rate in definitions:
            manual = {key: D(value) for key, value in overrides.get(code, {}).items() if value not in (None, "")}
            effective_qty = manual.get("qty", qty)
            effective_rate = rate
            if code == "soc":
                effective_rate = amounts["labour"] / 100
            if code in {"energy", "overhead", "admin", "commercial", "delivery"}:
                effective_rate = sum((amounts[c] for c in material_codes), D(0)) / 100
            if code == "profit":
                if effective_qty >= 100:
                    raise ValueError("Маржа должна быть меньше 100%")
                effective_rate = effective_cost / (1 - effective_qty / 100) / 100
            effective_rate = manual.get("rate", effective_rate)
            amount = manual.get("amount", effective_qty * effective_rate)
            if any(not value.is_finite() or value < 0 for value in [qty, rate, effective_qty, effective_rate, amount]):
                raise ValueError("Недопустимое значение калькуляции")
            amounts[code] = amount
            total += amount
            base_total += qty * rate
            if code not in {"profit", "delivery"}:
                effective_cost += amount
            rows.append({"id": code, "name": name, "unit": unit, "qty": float(qty), "rate": float(rate), "manual": {k: str(v) for k, v in manual.items()}, "effective": {"qty": float(effective_qty), "rate": float(effective_rate), "amount": float(amount)}, "precise": {"qty": str(qty), "rate": str(rate), "amount": str(qty * rate), "effectiveAmount": str(amount)}})
        vat = D(profile["vatPercent"])
        return {"product": {**product, "material": float(material), "labour": float(labour), "price": float(base_total)}, "rows": rows, "baseTotal": float(base_total), "total": float(total), "vatPercent": float(vat), "precise": {"baseTotal": str(base_total), "total": str(total), "grossTotal": str(total * (1 + vat / 100))}}
