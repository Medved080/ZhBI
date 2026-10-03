"""Commercial source values are read-only and never part of a calculation baseline."""
import json
from decimal import Decimal, localcontext
from functools import lru_cache

from .document_models import ASSETS, model
from .repository import get_product


@lru_cache(maxsize=1)
def reference_catalog():
    return json.loads((ASSETS / 'promka-commercial-references.json').read_text())


def commercial_reference(conn, product_id):
    current = get_product(conn, product_id)
    data = reference_catalog()
    product = current['product']
    entry = data['entries'].get(product.get('documentModelId'))
    result = {
        'productId': product['id'], 'productVersion': product['version'],
        'available': False, 'filename': data['filename'], 'sheet': data['sheet'],
        'sourceUrl': '/api/commercial-reference-source', 'auditUrl': '/api/commercial-reference-audit',
        'instructionUrl': '/api/document-source/' + data['instructionSourceId'] + '#page=1',
        'sourceSha256': data['sha256'], 'vatNote': data['vatNote'], 'revisionNote': data['revisionNote'],
    }
    if not entry:
        result['note'] = 'Подтверждённая привязка положительной цены КП отсутствует. Пустые значения, нули и неоднозначные строки исключены; причины доступны в реестре сверки.'
        return result
    drawing = model(product['documentModelId'])
    if not drawing or drawing.get('projectVolume') is None or drawing['source']['sha256'] != entry['drawing']['sha256'] or Decimal(str(drawing['projectVolume'])) != Decimal(entry['projectVolume']):
        result['note'] = 'Каталог изменился после сверки КП. Привязка требует повторной проверки.'
        return result
    with localcontext() as context:
        context.prec = 40
        price, volume = Decimal(entry['pricePerM3']), Decimal(entry['sourceVolume'])
        if price <= 0 or volume <= 0:
            result['note'] = 'В источнике нет положительной цены и объёма для сравнения.'
            return result
        unit = price * volume
        quantity = Decimal(entry['sourceQuantity']) if entry['sourceQuantity'] else None
        gross = Decimal(current['snapshot']['precise']['grossTotal'])
        result.update({
            'available': True, 'row': entry['row'], 'sourceTitle': entry['title'],
            'priceCell': entry['priceCell'], 'priceFormula': entry['priceFormula'],
            'drawingUrl': '/api/document-source/' + entry['drawing']['sourceId'] + '#page=' + str(entry['drawing']['pdfPage']),
            'drawingRevision': entry['drawing']['revision'], 'sourceQuantity': entry['sourceQuantity'],
            'sourceVolume': entry['sourceVolume'], 'pricePerM3Gross': str(price),
            'unitPriceGross': str(unit), 'sourceLotGross': str(unit * quantity) if quantity else None,
            'savedCalculationGross': str(gross), 'differenceGross': str(gross - unit),
            'differencePercent': str((gross / unit - 1) * 100),
            'calculationVatPercent': str(current['snapshot']['vatPercent']),
            'note': 'Справочный ориентир по СЗ от 09.09.2026. Расчёт сравнения выполнен для сохранённой калькуляции на одно изделие.',
        })
    return result
