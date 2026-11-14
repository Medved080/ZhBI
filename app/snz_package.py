"""Build a complete daily download before sending any bytes to the client."""
from tempfile import SpooledTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

from app.snz_daily_report import build_xlsx as build_daily_xlsx, drawing_order
from app.snz_export import build_xlsx


def build_package(report, day, render_pdf):
    archive = SpooledTemporaryFile(max_size=16 * 1024 * 1024, mode='w+b')
    try:
        with ZipFile(archive, 'w', compression=ZIP_DEFLATED) as bundle:
            for order in report['snapshots']:
                name = f"СНЗ-{order['id']}-ред-{order.get('order_revision', 1)}"
                bundle.writestr(f'{name}/{name}.xlsx', build_xlsx(order))
                bundle.writestr(f'{name}/{name}-планы.pdf', render_pdf(order))
            bundle.writestr(f'Реестр-СНЗ-{day.isoformat()}.xlsx', build_daily_xlsx(report))
            bundle.writestr(f'Планы-за-день-{day.isoformat()}.pdf', render_pdf(drawing_order(report)))
        archive.seek(0)
        return archive
    except BaseException:
        archive.close()
        raise


def archive_chunks(archive):
    try:
        while chunk := archive.read(64 * 1024):
            yield chunk
    finally:
        archive.close()
