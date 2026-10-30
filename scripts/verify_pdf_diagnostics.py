"""Реальный конвейер на синтетическом PDF: прогресс и графические замечания."""
import io
import sqlite3
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import pdf_diagnostics, pdf_import
from scripts.gen_synthetic_pdf_set import build


def check(value, message):
    assert value, message
    print('OK ' + message)


conn = sqlite3.connect(':memory:')
conn.row_factory = sqlite3.Row
conn.executescript((Path(__file__).resolve().parents[1] / 'app/schema.sql').read_text())
obj = conn.execute("INSERT INTO objects(name) VALUES ('Тест замечаний PDF')").lastrowid
doc = build('small')
data = doc.tobytes()
doc.close()
events = []
analysis = pdf_import.analyze(conn, obj, data, 'synthetic.pdf',
                              on_progress=lambda *args: events.append(args))
plans = [e for e in events if e[0] == 'Снимаю картинки планов']
total = plans[-1][3]
check([e[2] for e in plans] == list(range(total + 1)),
      'счётчик планов проходит каждый этаж от нуля до итога')
check(all(e[1] is not None and e[1] > 0 and e[3] == total for e in plans),
      'на каждом шаге известны номер листа и общее число этажей')
check(len(analysis['warning_details']) == len(analysis['warnings']) > 0,
      'каждое предупреждение получает графический комментарий')
located = [d for d in analysis['warning_details'] if d['figures']]
check(bool(located), 'отсечённые фигуры сохраняются для подсветки')
for detail in located:
    check(detail['page'] is not None and detail['floor'] is not None,
          'геометрия привязана к исходному листу и конкретному этажу')
    break
index = located[0]['index']
image = Image.open(io.BytesIO(pdf_diagnostics.render(analysis, index))).convert('RGB')
pixels = image.tobytes()
check(any(pixels[i] > 170 and pixels[i + 1] < 100 and pixels[i + 2] < 100
          for i in range(0, len(pixels), 3)),
      'на фрагменте присутствует красная подсветка фигур')
overview = Image.open(io.BytesIO(pdf_diagnostics.render(analysis, index, overview=True)))
check(max(image.size) <= 2401 and max(overview.size) <= 2401,
      'фрагмент и общий вид имеют ограниченное разрешение')
whole = pdf_diagnostics.PdfWarning('Не найдены отметки окон')
metadata = pdf_diagnostics.describe([whole], 22)[0]
check(metadata['page'] is None and metadata['figures'] == 0 and len(metadata['pages']) == 22,
      'общая ошибка не получает вымышленный контур и позволяет открыть исходные листы')
print('Все проверки пройдены')
