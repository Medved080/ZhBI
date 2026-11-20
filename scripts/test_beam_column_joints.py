"""Regression test of the joint geometry and independent SNZ life cycle."""
import json
import unittest

from fastapi import HTTPException
import test_snz as support
from app import beam_column_joints as joints


def footprint(x, y, width, depth):
    return [[x - width / 2, y - depth / 2], [x + width / 2, y - depth / 2],
            [x + width / 2, y + depth / 2], [x - width / 2, y + depth / 2]]


class JointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.IntegrationTests.setUpClass()
        cls.db = support.IntegrationTests.db
        cls.snz = support.IntegrationTests.snz
        cls.user = support.IntegrationTests.admin
        conn = cls.db.get_connection()
        cls.object_id = conn.execute("INSERT INTO objects(name) VALUES ('Узлы СНЗ — проверка')").lastrowid
        def zone(name, number, kind):
            return conn.execute(
                "INSERT INTO zones(source_file,dxf_handle,category,name,number,object_id) VALUES ('joints.dxf',?,?,?,?,?)",
                (name, kind, name, number, cls.object_id)).lastrowid

        late_crane = zone('Кран 1', 1, 'Кран')
        early_crane = zone('Кран 2', 2, 'Кран')
        late = zone('Стоянка 2', 2, 'Стоянка')
        early = zone('Стоянка 10', 10, 'Стоянка')
        capture = zone('Захватка 2', 2, 'Захватка')
        conn.executemany("INSERT INTO schedule_flow(object_id,crane_name,stance_name,floor,order_no) VALUES (?,?,?,?,?)",
                         [(cls.object_id, 'Кран 1', 'Стоянка 2', 1, 3), (cls.object_id, 'Кран 2', 'Стоянка 10', 1, 1)])
        cls.early = (early_crane, early, capture)
        cls.columns = []
        cls.beams = []
        for handle, kind, x, y, w, d, z, crane, stance, area in [
            ('lower', 'Колонна', 0, 0, 600, 600, 0, late_crane, late, None),
            ('upper', 'Колонна', 0, 0, 600, 600, 5000, None, None, None),
            ('right', 'Ригель', 3000, 0, 5160, 600, 5000, late_crane, late, None),
            ('left', 'Ригель', -3000, 0, 5160, 600, 5000, *cls.early),
            ('unrelated', 'Ригель', 0, 4000, 12000, 600, 5000, None, None, None),
        ]:
            eid = conn.execute(
                """INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,element_uid,
                   axis_status,address,object_id,x,y,floor,elevation_mm,outline_json,zone_crane_id,zone_stance_id,zone_zakhvatka_id)
                   VALUES ('joints.dxf',?,'joints',?,?,'manual',?,'matched','1 / А',?,?,?,1,?,?,?,?,?)""",
                (handle, kind, handle, handle, cls.object_id, x, y, z, json.dumps(footprint(x, y, w, d)),
                 crane, stance, area)).lastrowid
            if kind == 'Колонна':
                cls.columns.append(eid)
            elif handle != 'unrelated':
                cls.beams.append(eid)
        conn.commit()
        conn.close()

    def state(self):
        return self.snz.get_state(self.object_id, self.user)

    def save(self, data):
        body = {k: v for k, v in data['state'].items() if k != 'facts'}
        return self.snz.save_state(self.object_id, self.snz.StateIn(revision=data['revision'], **body), self.user)

    def issue(self, revision, shift):
        body = dict(revision=revision, date='2026-11-20', shift=shift, crew_id='install1')
        preview = self.snz.preview(self.object_id, self.snz.PlanIn(**body), self.user)
        issue = self.snz.issue(self.object_id, self.snz.IssueIn(
            **body, expected_hash=preview['fingerprint'], request_id=f'joint_{shift}'), self.user)
        return preview, issue

    def test_geometry_and_rebar_fact_survive_shift_transfer(self):
        data = self.state()
        joint, = (e for e in data['elements'] if e['id'] < 0)
        eid = joint['id']
        self.assertEqual(joint['current_status'], joints.ABSENT)
        self.assertEqual(joint['column_ids'], self.columns)
        self.assertEqual(joint['beam_ids'], self.beams)
        self.assertEqual((joint['elevation_mm'], joint['height_mm']), (5000, 600))
        self.assertEqual(set(x for x, _ in joint['outline']), {-420, 420})
        self.assertEqual(tuple(joint[f'zone_{key}_id'] for key in ('crane', 'stance', 'zakhvatka')), self.early)
        self.assertEqual(eid, joints.joint_id({'id': 9999, 'element_uid': 'lower'}, 5000))
        self.assertEqual(joint['suggested_card_id'], joints.CARD_ID)

        card = next(c for c in data['state']['cards'] if c['id'] == joints.CARD_ID)
        self.assertEqual([step['minutes'] for step in card['steps']], [None, None])
        for step in card['steps']:
            step['minutes'] = 30
        assignment = dict(element_id=eid, crew_id='install1', card_id=joints.CARD_ID,
                          date='2026-11-20', shift='day', priority=1)
        data['state']['assignments'].append(assignment)
        assigned = self.save(data)
        preview, issued = self.issue(assigned['revision'], 'day')
        self.assertEqual([t['operation_id'] for t in preview['tasks']], [joints.REBAR_OP, joints.CONCRETE_OP])
        rebar, concrete = [t['key'] for t in preview['tasks']]
        self.assertEqual(preview['tasks'][1]['dependencies'], [rebar])

        def fact(task, order, timestamp):
            return self.snz.complete(self.object_id, self.snz.FactIn(
                revision=order['revision'], order_id=order['id'], task_key=task, completed_at=timestamp), self.user)

        with self.assertRaises(HTTPException) as pending:
            fact(concrete, issued, '2026-11-20T09:30:00')
        self.assertEqual(pending.exception.status_code, 409)
        armed = fact(rebar, issued, '2026-11-20T09:00:00')
        self.assertEqual(next(e for e in self.state()['elements'] if e['id'] == eid)['current_status'], joints.REBAR)

        scope = self.snz.preview_close_orders(self.object_id, date=self.snz.date(2026, 11, 20),
                                             shift='day', crew_id='install1', user=self.user)
        self.assertEqual(scope['pending_element_ids'], [eid])
        self.snz.close_issued_orders(self.object_id, self.snz.CloseScopeIn(
            revision=armed['revision'], date='2026-11-20', shift='day', crew_id='install1',
            expected_hash=scope['fingerprint'], request_id='joint_close'), self.user)
        closed = self.snz.read_order(self.object_id, issued['id'], self.user)
        self.assertEqual(closed['items'][0]['current_status'], joints.REBAR)

        data = self.state()
        self.assertFalse(data['state']['assignments'])
        data['state']['assignments'].append({**assignment, 'shift': 'night'})
        preview, issued = self.issue(self.save(data)['revision'], 'night')
        self.assertEqual([t['key'] for t in preview['tasks']], [concrete])
        self.assertTrue(preview['tasks'][0]['segments'])
        fact(concrete, issued, '2026-11-20T21:00:00')
        completed = self.state()
        self.assertEqual(next(e for e in completed['elements'] if e['id'] == eid)['current_status'], joints.CONCRETE)
        conn = self.db.get_connection()
        try:
            changes = joints.joint_changes(joints.joint_state(conn, self.object_id)[1])
            self.assertEqual(changes, [{'id': eid, 'planned_installation_date': '2026-11-20',
                                       'current_status': joints.CONCRETE}])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM status_history WHERE element_id=?', (eid,)).fetchone()[0], 0)
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()
