"""Help completeness and role filtering; no application database is opened."""
import contextlib
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app import training_content as content
from app.features import FEATURES, FEATURES_BY_KEY, READ, WRITE

spec=importlib.util.spec_from_file_location('coverage_gate',ROOT/'scripts/check_training_coverage.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)


class HelpCoverageTests(unittest.TestCase):
    def run_gate(self):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):code=gate.main()
        return code,out.getvalue()

    def test_every_registered_feature_has_an_instruction_and_guard_passes(self):
        self.assertFalse(content.missing_features())
        self.assertFalse(content.unknown_blocks())
        self.assertEqual(self.run_gate()[0],0)
        self.assertEqual({b.feature for b in content.BLOCKS if b.feature},{f.key for f in FEATURES})

    def test_new_sections_respect_read_write_and_absent_rights(self):
        for block in content.NEW_SECTION_BLOCKS:
            with self.subTest(feature=block.feature):
                self.assertFalse(any(b.feature==block.feature for b,_,_ in content.blocks_for({})))
                read=[ps for b,ps,_ in content.blocks_for({block.feature:READ}) if b.feature==block.feature]
                self.assertEqual(len(read),1)
                self.assertTrue(read[0]);self.assertTrue(all(p.level==READ for p in read[0]))
                write=[ps for b,ps,_ in content.blocks_for({block.feature:WRITE}) if b.feature==block.feature]
                self.assertEqual(write[0],block.paragraphs)
                self.assertTrue(all(q.level==READ for _,q in content.questions_for({block.feature:READ},block.feature)))
                self.assertEqual(len(content.questions_for({block.feature:WRITE},block.feature)),len(block.questions))

    def test_snz_instructions_follow_plan_and_status_permissions(self):
        by_key={b.key:b for b in content.BLOCKS}
        self.assertIn('СНЗ',by_key['workspace_foreman'].title)
        plan=' '.join(p.text for p in by_key['planned_date'].paragraphs if p.level==WRITE)
        for phrase in ('12 карт','60 минут','40','Узлы ригелей','Выдать СНЗ','Спорные нормы'):
            self.assertIn(phrase,plan)
        self.assertIn('вкладка «Факт»',' '.join(p.text for p in by_key['planned_date'].paragraphs))
        self.assertIn('Не учитывать факт',' '.join(p.text for p in by_key['planned_date'].paragraphs))
        fact=[p for p in by_key['status'].paragraphs if 'Факт СНЗ ставят' in p.text]
        self.assertEqual(len(fact),1);self.assertEqual(fact[0].level,WRITE)
        self.assertFalse(any('Факт СНЗ ставят' in p.text for _,ps,_ in content.blocks_for({'status':READ}) for p in ps))
        self.assertEqual(content.CONTENT_VERSION,'2026-11-12.7')

    def test_a_future_section_without_help_fails_the_gate(self):
        new=FEATURES[0]._replace(key='future_help_regression',title='Тестовый новый раздел')
        all_features=[*FEATURES,new]
        with patch.object(content,'FEATURES',all_features),patch.object(gate,'FEATURES',all_features),patch.object(gate,'FEATURES_BY_KEY',{**FEATURES_BY_KEY,new.key:new}):
            code,text=self.run_gate()
        self.assertEqual(code,1);self.assertIn(new.key,text)

    def test_invalid_paragraph_level_fails_the_gate(self):
        first=content.BLOCKS[0]._replace(paragraphs=[content.Para('unexpected','Текст')])
        with patch.object(gate,'BLOCKS',[first,*content.BLOCKS[1:]]):code,text=self.run_gate()
        self.assertEqual(code,1);self.assertIn('неверный уровень абзаца',text)

    def test_duplicate_question_id_fails_the_gate(self):
        first=content.BLOCKS[0]._replace(questions=content.BLOCKS[0].questions*2)
        with patch.object(gate,'BLOCKS',[first,*content.BLOCKS[1:]]):code,text=self.run_gate()
        self.assertEqual(code,1);self.assertIn('встречается дважды',text)

    def test_duplicate_block_feature_fails_the_gate(self):
        block=next(b for b in content.BLOCKS if b.feature)
        extra=block._replace(key='duplicate-feature-check',questions=[])
        with patch.object(gate,'BLOCKS',[*content.BLOCKS,extra]):code,text=self.run_gate()
        self.assertEqual(code,1);self.assertIn('повторяется блок раздела',text)


if __name__=='__main__':unittest.main(verbosity=2)
