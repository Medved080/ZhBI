"""Все классы стали: обновление норм, сохранение и независимый расход по диаметрам."""
import json
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.calc.document_models import catalog
from app.calc.norms import (NormsSave,complete_norms,get_norms,reinforcement_spec,
                            resource_key,initial_norms,match_resource,parameters_for,update_norms)


def legacy_norms():
    params=initial_norms()
    params.pop('resourceDefaults',None)
    params['resources']={}
    # Формат до разделения: девять строк из двух исходных Excel-калькуляций.
    a,b=(catalog()[key] for key in ('1KS1-r1','2KS3-r1'))
    for ra,rb in zip(a['resources'],b['resources']):
        project=Decimal(str(ra['projectQty']))+Decimal(str(rb['projectQty']))
        production=Decimal(str(ra['qty']))+Decimal(str(rb['qty']))
        params['resources'][ra['id']]={
            'name':ra['name'] if ra['id']!='mainsteel' else 'Продольная арматура А600С',
            'unit':ra['unit'],'factor':str(production/project),'rate':ra['rate'],
            'projectTotal':str(project),'productionTotal':str(production)}
    return params


class NormDiametersTest(unittest.TestCase):
    def test_complete_preserves_custom_factor_metadata_and_input(self):
        old=legacy_norms()
        old['resources']['mainsteel']['factor']='1.07234567890123456789'
        old['groups']={'Колонны':{'confirmed':True,'hoursPerM3':'6'}}
        before=deepcopy(old)
        new=complete_norms(old)
        self.assertEqual(old,before)
        self.assertNotIn('mainsteel',new['resources'])
        diameters={spec[1] for doc in catalog().values() for r in doc['resources'] if (spec:=reinforcement_spec(r)) and spec[0]=='A600C'}
        self.assertEqual({k for k in new['resources'] if 'A600C' in k},{f'steel{d}A600C' for d in diameters})
        for d in diameters:self.assertEqual(new['resources'][f'steel{d}A600C']['factor'],'1.07234567890123456789')
        self.assertEqual(new['groups'],old['groups'])
        self.assertEqual(new['resources']['steel28A600C']['projectTotal'],'0.6237')
        self.assertEqual(new['resources']['steel36A600C']['productionTotal'],'2.282')
        self.assertIsNone(new['resources']['steel32A600C']['projectTotal'])
        self.assertEqual(complete_norms(new),new)
        new['resources']['steel28A600C']['factor']='1.15'
        self.assertEqual(complete_norms(new)['resources']['steel28A600C']['factor'],'1.15')

    def test_all_classes_are_covered_without_duplicates(self):
        old=legacy_norms();new=complete_norms(old)
        specs={spec for doc in catalog().values() for r in doc['resources'] if (spec:=reinforcement_spec(r))}
        actual=[reinforcement_spec(r) for r in new['resources'].values() if reinforcement_spec(r)]
        self.assertEqual(set(actual),specs)
        self.assertEqual(len(actual),len(specs))
        self.assertEqual({s[0] for s in specs},{'A240','A300','A500','A500C','A600C','Vr1','K7'})
        for spec in specs:self.assertIn(resource_key(spec),new['resources'])
        self.assertEqual(new['resources']['steel18A500C']['factor'],'1')
        self.assertEqual(new['resources']['steel18A500C']['factorBasis'],'project')
        self.assertFalse(new['resources']['steel18A500C']['roundUp'])
        for key in ['steel3Vr1','steel5Vr1','steel10Vr1','steel14Vr1','steel16Vr1']:
            self.assertEqual(new['resources'][key]['factor'],old['resources']['wire']['factor'])
        self.assertEqual(new['resources']['steel8A500C']['factor'],old['resources']['steel8']['factor'])
        new['resources']['steel10A500C']['factor']='1.11'
        new['resources']['steel5Vr1']['factor']='1.6'
        for name,expected in [('Арматура Ø10 А500С','1.11'),('Арматура Ø10 А500','1'),('Проволока Ø5 Вр1','1.6'),('Канат К7 Ø12','1')]:
            self.assertEqual(match_resource({'name':name},new)['factor'],expected)
        self.assertEqual(new['resources']['steel3Vr1']['factor'],old['resources']['wire']['factor'])

    def test_project_only_norm_does_not_round_until_allowance_is_set(self):
        norms=initial_norms()
        doc={'id':'test','projectVolume':'1','resources':[
            {'id':key,'name':name,'projectQty':'0.0001234','rate':'100'}
            for key,name in [('steel18A500C','Арматура Ø18 А500С'),('steel12K7','Канат К7 Ø12')]]}
        prices={'concrete':{'default':'100'},'labour':{'rate':'50'},'materials':{}}
        with patch('app.calc.source_policy.ensure_model'):
            before=parameters_for(doc,{'parameters':norms},prices)['resources']
            norms['resources']['steel18A500C']['factor']='1.1'
            after=parameters_for(doc,{'parameters':norms},prices)['resources']
        self.assertEqual([r['qty'] for r in before],['0.0001234','0.0001234'])
        self.assertEqual([r['qty'] for r in after],['0.001','0.0001234'])

    def test_missing_catalog_and_new_diameter(self):
        old=legacy_norms()
        with patch('app.calc.norms.catalog',return_value={}):
            self.assertEqual(complete_norms(old),old)
        new=complete_norms(old)
        new['resources']['steel28A600C']['factor']='1.15'
        models=deepcopy(catalog())
        models['new']={'resources':[{'name':'Арматура Ø40 А600С'}]}
        with patch('app.calc.norms.catalog',return_value=models):
            completed=complete_norms(new)
        self.assertEqual(completed['resources']['steel40A600C']['factor'],old['resources']['mainsteel']['factor'])
        self.assertEqual(completed['resources']['steel28A600C']['factor'],'1.15')

    def test_upgrade_from_a600_only_layout_preserves_manual_settings(self):
        old=legacy_norms()
        old['resources']['steel10a500']['factor']='1.0876543210987654321'
        split=complete_norms(old)
        old['resourceDefaults']={'A600C':old['resources'].pop('mainsteel')}
        old['resources'].update({k:r for k,r in split['resources'].items() if k.endswith('A600C')})
        old['resources']['steel28A600C']['factor']='1.16'
        old['resources']['steel40A500C']={'name':'Арматура Ø40 А500С','unit':'т','factor':'1.13','rate':'123','note':'ручная позиция'}
        old['groups']={'Колонны':{'confirmed':True}}
        before=deepcopy(old)
        new=complete_norms(old)
        self.assertEqual(old,before)
        self.assertEqual(new['resources']['steel10A500C']['factor'],'1.0876543210987654321')
        self.assertEqual(new['resources']['steel28A600C']['factor'],'1.16')
        self.assertEqual(new['resources']['steel40A500C'],old['resources']['steel40A500C'])
        self.assertEqual(new['groups'],old['groups'])
        self.assertEqual(complete_norms(new),new)

    def test_calculations_unchanged_until_diameter_is_edited(self):
        old=legacy_norms();new=complete_norms(old)
        prices={'concrete':{'default':'100'},'labour':{'rate':'50'},'materials':{}}
        # Проверка всех реальных спецификаций без чтения PDF; допуск листов
        # проверяется отдельно в test_calc_source_policy.py.
        with patch('app.calc.source_policy.ensure_model'):
            for doc in catalog().values():
                with self.subTest(model=doc['id']):
                    before=parameters_for(doc,{'parameters':old},prices)
                    after=parameters_for(doc,{'parameters':new},prices)
                    self.assertEqual(before,after)
        new['resources']['steel28A600C']['factor']='1.2'
        for model_id,expected in [('1KS1-r1','1.050091172369408988523007616'),('2KS3-r1','1.2')]:
            resource=next(r for r in catalog()[model_id]['resources'] if r['id']=='mainsteel')
            self.assertEqual(match_resource(resource,new)['factor'],expected)
        doc={'id':'test','projectVolume':'1','resources':[
            {'id':f'steel{d}A600C','name':f'Арматура Ø{d} А600С','projectQty':'1','rate':'100'} for d in (28,36)]}
        with patch('app.calc.source_policy.ensure_model'):
            rows=parameters_for(doc,{'parameters':new},prices)['resources']
        self.assertEqual([r['qty'] for r in rows],['1.200','1.051'])

    def test_get_is_read_only_and_save_keeps_version_conflicts(self):
        from fastapi import HTTPException
        with sqlite3.connect(':memory:') as conn:
            conn.row_factory=sqlite3.Row
            conn.execute('CREATE TABLE production_norms(id TEXT PRIMARY KEY,version INTEGER,parameters_json TEXT,updated_at TEXT,actor_id TEXT)')
            conn.execute('CREATE TABLE audit_log(actor_id TEXT,action TEXT,entity_id TEXT,detail_json TEXT,created_at TEXT)')
            raw=json.dumps(legacy_norms())
            conn.execute('INSERT INTO production_norms VALUES(?,?,?,?,?)',('msu-1-columns',7,raw,'2026-01-01','test'))
            current=get_norms(conn)
            self.assertEqual(conn.execute('SELECT parameters_json FROM production_norms').fetchone()[0],raw)
            body=NormsSave(expectedVersion=7,concreteFactor=current['parameters']['concreteFactor'],
                           hoursPerM3=current['parameters']['hoursPerM3'],
                           resources={k:{'factor':r['factor']} for k,r in current['parameters']['resources'].items()})
            body.resources['steel28A600C'].factor=Decimal('1.12')
            saved=update_norms(conn,body,'test')
            self.assertEqual(saved['version'],8)
            self.assertEqual(get_norms(conn),{**saved,'updatedAt':get_norms(conn)['updatedAt']})
            self.assertEqual(saved['parameters']['resources']['steel28A600C']['factor'],'1.12')
            self.assertEqual(saved['parameters']['resources']['steel36A600C']['factor'],current['parameters']['resources']['steel36A600C']['factor'])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM audit_log').fetchone()[0],1)
            with self.assertRaises(HTTPException) as error:update_norms(conn,body,'test')
            self.assertEqual(error.exception.status_code,409)
            body.expectedVersion=8
            del body.resources['steel28A600C']
            with self.assertRaises(HTTPException) as error:update_norms(conn,body,'test')
            self.assertEqual(error.exception.status_code,422)

    def test_initial_prices_and_legacy_packages_match_by_diameter(self):
        from app.calc.database import PROFILE,PROFILE_ID
        from app.calc.prices import initial_prices
        with sqlite3.connect(':memory:') as conn:
            conn.execute('CREATE TABLE calculation_profiles(id TEXT,parameters_json TEXT)')
            conn.execute('CREATE TABLE production_norms(id TEXT,parameters_json TEXT)')
            conn.execute('INSERT INTO calculation_profiles VALUES(?,?)',(PROFILE_ID,json.dumps(PROFILE)))
            conn.execute('INSERT INTO production_norms VALUES(?,?)',('msu-1-columns',json.dumps(legacy_norms())))
            old=initial_prices(conn)
            conn.execute('UPDATE production_norms SET parameters_json=?',(json.dumps(initial_norms()),))
            self.assertEqual(initial_prices(conn),old)


if __name__=='__main__':unittest.main()
