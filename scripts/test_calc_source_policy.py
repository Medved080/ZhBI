"""Regression gates for cancelled drawing pages. Synthetic fixtures, no live DB writes."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.calc import source_policy as sp, document_models as dm
from app.calc.source_link_repairs import MODEL_IDS, SOURCE_SHA, repair_links, repair_assets, validate_assets
from app.calc.calculation import calculate
from app.calc.repository import dynamic_values, save_product
from app.calc.schemas import ProductSave
from app.calc.sync import apply_package, SyncError, FORMAT
from app.calc.database import SCHEMA_VERSION, PROJECT_ID


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root/'sources').mkdir()
        self.pdf = self.root/'sources/doc05.pdf'
        # The review is the test trust root; no production review data is modified.
        self.pdf.write_bytes(b'%PDF-test-immutable-review-fixture')
        self.sha = hashlib.sha256(self.pdf.read_bytes()).hexdigest()
        self.meta = {'doc05': {'storageName': 'doc05.pdf', 'pages': 330, 'sha256': self.sha}}
        (self.root/'promka-sources.json').write_text(json.dumps(self.meta))
        review = self.root/'review.json'
        review.write_text(json.dumps({'albums': {self.sha: {'pages': 330, 'annulledPages': [110]}}}))
        self.review = patch.object(sp, 'REVIEW_FILE', review)
        self.review.start()
        self.policy = sp.SourcePolicy(self.root)
        self.model = {'id': 'test', 'kind': 'registry', 'source': {'id': 'doc05', 'productPage': 305, 'sha256': self.sha},
                      'components': [{'name': 'КПВ10', 'pdfPage': 111, 'sheet': 98}], 'groups': [], 'resources': []}

    def tearDown(self):
        self.review.stop()
        self.temp.cleanup()

    def blocked(self, action, code=None):
        with self.assertRaises(sp.SourceSheetBlocked) as caught: action()
        self.assertEqual(caught.exception.status_code, 409)
        if code: self.assertEqual(caught.exception.detail['code'], code)

    def test_active_cancelled_unknown_and_invalid_page(self):
        self.policy.page('doc05', 111)
        self.blocked(lambda: self.policy.page('doc05', 110), 'annulled_source_sheet')
        for page in [0, 331, '111', True, [111]]:
            self.blocked(lambda: self.policy.page('doc05', page))
        self.blocked(lambda: self.policy.page('unknown', 111))

    def test_pdf_replacement_missing_and_unreviewed_revision(self):
        self.policy.page('doc05', 111)  # warm hash cache
        self.pdf.write_bytes(b'%PDF-changed-after-review')
        self.blocked(lambda: self.policy.page('doc05', 111))
        new_sha=hashlib.sha256(self.pdf.read_bytes()).hexdigest()
        self.meta['doc05']['sha256']=new_sha
        (self.root/'promka-sources.json').write_text(json.dumps(self.meta))
        self.blocked(lambda: sp.SourcePolicy(self.root).page('doc05',111))
        self.pdf.unlink()
        self.blocked(lambda: self.policy.page('doc05',111))

    def test_all_provenance_paths_including_recursive_readings(self):
        self.policy.model(self.model)
        for field in ['primary','component','reading','assembly','solid','concrete']:
            m=copy.deepcopy(self.model)
            if field=='primary':m['source']['productPage']=110
            elif field=='component':m['components'][0]['pdfPage']=110
            elif field=='reading':m['readings']={'sheet':{'doc':5,'page':110}}
            elif field=='assembly':m['readings']={'sourcePages':[{'sourceId':'doc05','pdfPage':110}]}
            elif field=='solid':m['solidModel']={'sourceId':'doc05','groups':[{'sourcePages':[110]}]}
            else:m['readings']={'concreteClassSource':{'sourceId':'doc05','pdfPage':110}}
            with self.subTest(field=field): self.blocked(lambda:self.policy.model(m),'annulled_source_sheet')
        m=copy.deepcopy(self.model);m['source']['sha256']='0'*64
        self.blocked(lambda:self.policy.model(m))
        self.blocked(lambda:self.policy.model({'id':'missing-source','resources':[]}))

    def test_reading_is_rejected_before_model_values_change(self):
        from app.calc.readings import apply_readings
        m=copy.deepcopy(self.model);m.update(projectVolume=None,concreteClass='Не указан')
        models={'test':m};before=copy.deepcopy(models)
        (self.root/'promka-readings.json').write_text(json.dumps({'test':{'sheet':{'doc':5,'page':110},'volume':99}}))
        self.blocked(lambda:apply_readings(models,self.root),'annulled_source_sheet')
        self.assertEqual(models,before)

    def test_manual_values_cannot_bypass_calculation_or_save_or_replay(self):
        bad=copy.deepcopy(self.model);bad['components'][0]['pdfPage']=110
        with patch.object(dm,'ASSETS',self.root),patch.object(dm,'model',return_value=bad),patch('app.calc.calculation.model',return_value=bad),patch('app.calc.repository.model',return_value=bad):
            self.blocked(lambda:calculate({'documentModelId':'test'},[],{}),'annulled_source_sheet')
            from app.calc.norms import parameters_for
            self.blocked(lambda:parameters_for(bad,{}, {},volume=1),'annulled_source_sheet')
            row={'document_model_id':'test','manual_fields':'["volume","hours","otherMaterials"]'}
            self.blocked(lambda:dynamic_values(row,{'prices':{'parameters':{}},'norms':None}),'annulled_source_sheet')
            body=ProductSave.model_validate({'product':{'id':str(uuid4()),'name':'test','concreteClass':'В40','volume':1,'weight':0,'hours':0,'concreteRate':0,'otherMaterials':0,'source':'project','documentModelId':'test'},'expectedVersion':0,'requestId':str(uuid4())})
            # No connection is needed: guard must precede all SQL and mutation replay.
            self.blocked(lambda:save_product(None,body,'tester',baseline_resources=[]),'annulled_source_sheet')

    def test_registry_import_rejects_before_transaction_or_prices(self):
        import importlib
        module=importlib.import_module('app.calc.import_register')
        bad=copy.deepcopy(self.model);bad['components'][0]['pdfPage']=110
        with patch.object(dm,'ASSETS',self.root),patch.object(module,'catalog',return_value={'test':bad}),patch.object(module,'transaction') as tx:
            self.blocked(lambda:module.import_register(None),'annulled_source_sheet')
            tx.assert_not_called()

    def test_sync_batch_checks_sources_before_any_write(self):
        bad=copy.deepcopy(self.model);bad['components'][0]['pdfPage']=110
        from app.calc.sync import sha_of, PRODUCT_COLUMNS_SKIP_IN_HASH, PRODUCT_CHILDREN
        row={'id':str(uuid4()),'document_model_id':'test'}
        bundle={'row':row,**{k:[] for k,_ in PRODUCT_CHILDREN}}
        bundle['contentHash']=sha_of({'row':row,**{k:bundle[k] for k,_ in PRODUCT_CHILDREN}})
        package={'format':FORMAT,'schema':SCHEMA_VERSION,'projectKey':PROJECT_ID,'products':[bundle]}
        with self.assertRaises(SyncError):
            apply_package(None,package,'tester',source_models={'test':bad},source_policy=self.policy)

    def test_staged_catalog_is_validated_instead_of_installed_catalog(self):
        (self.root/'promka-register.json').write_text(json.dumps({'test':self.model}))
        staging=self.root/'incoming.json';bad=copy.deepcopy(self.model);bad['source']['productPage']=110
        staging.write_text(json.dumps({'test':bad}))
        resolve=lambda name:staging if name=='promka-register.json' else self.root/name
        self.blocked(lambda:validate_assets(self.root,resolve),'annulled_source_sheet')
        incoming_pdf=self.root/'incoming.pdf';incoming_pdf.write_bytes(b'%PDF-tampered-staged')
        resolve=lambda name:incoming_pdf if name=='sources/doc05.pdf' else self.root/name
        self.blocked(lambda:validate_assets(self.root,resolve))
        # Raw incoming source metadata may not falsify the PDF digest.
        fake=copy.deepcopy(self.meta);fake['doc05']['sha256']='a'*64
        incoming=self.root/'incoming-sources.json';incoming.write_text(json.dumps(fake))
        resolve=lambda name:incoming if name=='promka-sources.json' else self.root/name
        self.blocked(lambda:validate_assets(self.root,resolve))

    def test_sync_commit_rejects_staged_bad_catalog_before_mutation(self):
        from types import SimpleNamespace
        from app.calc.sync import Staging
        from app.calc import sync_api
        staging=Staging(self.root/'staging')
        bad=copy.deepcopy(self.model);bad['components'][0]['pdfPage']=110
        raw=json.dumps({'test':bad}).encode()
        target=staging.done('asset','promka-register.json');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        (self.root/'promka-register.json').write_text(json.dumps({'test':self.model}))
        package={'assets':[{'path':'promka-register.json','sha256':hashlib.sha256(raw).hexdigest()}]}
        with patch.object(sync_api,'needed',return_value=([],[])),patch.object(sync_api,'connect'),patch.object(sync_api,'blob_sources',return_value={}),patch.object(sync_api,'transaction') as tx,patch.object(sync_api,'install_assets') as install,patch.object(sync_api,'_log'):
            with self.assertRaises(SyncError):
                sync_api.commit_package(SimpleNamespace(database_path=self.root/'test.db'),staging,self.root,self.root/'uploads',package,None,'tester')
            tx.assert_not_called();install.assert_not_called()

    def test_verified_link_repair_preserves_every_other_value_and_backup(self):
        original={k:{**copy.deepcopy(self.model),'id':k,'source':{'id':'doc05','productPage':305,'sha256':SOURCE_SHA},
                     'resources':[{'qty':4.2}],'components':[{'name':'Каркас пространственный КПВ10','pdfPage':110,'sheet':97}]} for k in MODEL_IDS}
        actual=copy.deepcopy(original);self.assertEqual(repair_links(actual),3)
        for k in MODEL_IDS:
            self.assertEqual(actual[k]['components'][0],{'name':'Каркас пространственный КПВ10','pdfPage':111,'sheet':98})
            expected=copy.deepcopy(original[k]);expected['components'][0].update(pdfPage=111,sheet=98)
            self.assertEqual(actual[k],expected)
        self.assertEqual(repair_links(actual),0)
        path=self.root/'promka-register.json';raw=json.dumps(original,ensure_ascii=False).encode();path.write_bytes(raw)
        self.assertEqual(repair_assets(self.root),3)
        backups=list((self.root/'.source-link-backups').glob('*.json'));self.assertEqual(len(backups),1);self.assertEqual(backups[0].read_bytes(),raw)
        updated=path.read_bytes();self.assertEqual(repair_assets(self.root),0);self.assertEqual(path.read_bytes(),updated)
        wrong=copy.deepcopy(original);next(iter(wrong.values()))['source']['sha256']='0'*64
        self.assertEqual(repair_links(wrong),2)

    def test_ocr_cache_and_candidate_search_reject_cancelled_pages(self):
        sys.path.insert(0,str(ROOT/'scripts/prototypes/vector_ocr'))
        from steel import RebarAssembler
        rows={110:[{'name':'Масса','qty':'1'}],111:[{'name':'Масса','qty':'1'}]}
        allowed=lambda d,p:self.policy.allowed('doc%02d'%d,p)
        assembler=RebarAssembler(lambda d,p:rows.get(p),{},window=1,page_allowed=allowed)
        self.assertEqual(assembler.find_by_mass(5,110,1),111)
        with self.assertRaises(ValueError):assembler.assemble(5,110)
        result=assembler.assemble(5,111);self.assertEqual(result['sourcePages'],{(5,111)})
        assembler.page_allowed=lambda d,p:False
        with self.assertRaises(ValueError):assembler.assemble(5,111)

    def test_ocr_reader_blocks_before_parsing_pdf(self):
        sys.path.insert(0,str(ROOT/'scripts'))
        from build_calc_readings import read_rows
        with patch.object(dm,'ASSETS',self.root):
            self.blocked(lambda:read_rows((5,110)),'annulled_source_sheet')

    def test_production_preflight_is_readonly_and_counts_manual_data(self):
        import sqlite3
        from app.calc.deployment_check import check_sources
        from app.calc import manage
        import contextlib,io
        database=self.root/'snapshot.sqlite3'
        with sqlite3.connect(database) as c:
            c.execute('CREATE TABLE schema_migrations(version INTEGER)')
            c.execute('INSERT INTO schema_migrations VALUES(?)',(SCHEMA_VERSION,))
            c.execute('CREATE TABLE products(document_model_id TEXT,manual_fields TEXT)')
            c.execute('INSERT INTO products VALUES(?,?)',('test','["volume"]'))
        (self.root/'promka-register.json').write_text(json.dumps({'test':self.model}))
        before={p.name:p.read_bytes() for p in [database,self.root/'promka-register.json']}
        report=check_sources(self.root,database)
        self.assertTrue(report['ready']);self.assertEqual(report['linkedProducts'],1);self.assertEqual(report['productsWithManualFields'],1)
        with patch.object(manage,'initialize') as initialize,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(manage.main(['check-sources','--assets',str(self.root),'--database',str(database)]),0)
            initialize.assert_not_called()
        for name,raw in before.items():self.assertEqual((self.root/name).read_bytes(),raw)
        self.assertFalse((self.root/'.source-link-backups').exists())
        with sqlite3.connect(database) as c:c.execute('UPDATE products SET document_model_id="missing"')
        report=check_sources(self.root,database)
        self.assertFalse(report['ready']);self.assertEqual(report['errors'][0]['code'],'missing_models')

    def test_production_preflight_blocks_unsafe_catalog_and_has_nonzero_cli_exit(self):
        import sqlite3,contextlib,io
        from app.calc.deployment_check import check_sources
        from app.calc import manage
        database=self.root/'snapshot.sqlite3'
        with sqlite3.connect(database) as c:
            c.execute('CREATE TABLE schema_migrations(version INTEGER)')
            c.execute('INSERT INTO schema_migrations VALUES(?)',(SCHEMA_VERSION,))
            c.execute('CREATE TABLE products(document_model_id TEXT,manual_fields TEXT)')
        bad=copy.deepcopy(self.model);bad['components'][0]['pdfPage']=110
        (self.root/'promka-register.json').write_text(json.dumps({'test':bad}))
        report=check_sources(self.root,database)
        self.assertFalse(report['ready']);self.assertEqual(report['errors'][0]['code'],'annulled_source_sheet')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(manage.main(['check-sources','--assets',str(self.root),'--database',str(database)]),2)
        nonexistent=self.root/'does-not-exist.sqlite3'
        self.assertFalse(check_sources(self.root,nonexistent)['ready']);self.assertFalse(nonexistent.exists())

    def test_preview_cache_cannot_bypass_page_policy(self):
        from app.calc import source_sheets
        with patch.object(source_sheets,'ASSETS',self.root):
            self.blocked(lambda:source_sheets.preview_path(None,{'sourceId':'doc05','pdfPage':110}),'annulled_source_sheet')


if __name__=='__main__':unittest.main(verbosity=2)
