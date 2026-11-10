"""Per-document montage positions and preparation ordered by forecast start."""
from copy import deepcopy
import unittest
from test_snz import fixture, schedule
from app.snz_ordering import normalize_montage


class OrderingTests(unittest.TestCase):
    def test_scopes_are_contiguous_and_issued_assignments_are_untouched(self):
        state, elements = fixture((1, 2, 3, 4))
        for a, value in zip(state['assignments'], [14, 18, 85, 90]):
            a['priority'] = value
        state['assignments'][2]['shift'] = 'night'
        state['assignments'][3]['crew_id'] = 'install2'
        original = deepcopy(state)
        normalize_montage(state)
        self.assertEqual([a['priority'] for a in state['assignments']], [1, 2, 1, 1])
        normalize_montage(original, [1])
        self.assertEqual([a['priority'] for a in original['assignments']], [14, 18, 1, 1])
        result = schedule(original, elements)
        self.assertEqual(result['item_priorities'], {'1': 1, '2': 2})

    def test_montage_cannot_overtake_first_item_with_later_readiness(self):
        state, elements = fixture((1, 2, 3), (('prepare', 20, 0), ('scaffold', 60, 0), ('install', 30, 120)))
        card = deepcopy(state['cards'][0]);card['id'] = 'direct'
        card['steps'] = [step for step in card['steps'] if step['operation_id'] != 'scaffold']
        state['cards'].append(card)
        state['assignments'][1]['card_id'] = 'direct'
        state['assignments'][2].update(card_id='direct', crew_id='install2')
        result = schedule(state, elements)
        installs = [t for t in result['tasks'] if t['operation_id'] == 'install']
        self.assertEqual([t['element_ids'][0] for t in installs], [1, 2])
        self.assertEqual(installs[0]['segments'][0]['start'], '2026-11-10T09:20')
        # Calendar wait belongs to this item's next operation, not the next item.
        self.assertEqual(installs[1]['segments'][0]['start'], '2026-11-10T09:50')
        prep = schedule(state, elements, day='2026-11-09', shift='night', crew='preparation')
        self.assertEqual([t['element_ids'][0] for t in prep['tasks']], [3, 1, 2])
        self.assertEqual(prep['item_priorities'], {'3': 1, '1': 2, '2': 3})

    def test_unknown_start_last_and_night_prepared_during_same_day(self):
        state, elements = fixture((1, 2), (('prepare', 20, 0), ('install', 30, 0)), shift='night')
        card = deepcopy(state['cards'][0]);card['id'] = 'unknown';card['steps'][1]['minutes'] = None
        state['cards'].append(card);state['assignments'][0]['card_id'] = 'unknown'
        result = schedule(state, elements, crew='preparation')
        self.assertEqual([t['element_ids'][0] for t in result['tasks']], [2, 1])
        self.assertEqual(result['start'], '2026-11-10T08:00')
        self.assertEqual(result['item_priorities'], {'2': 1, '1': 2})

    def test_preparation_uses_frozen_start_of_issued_montage(self):
        state, elements = fixture((1, 2), (('prepare', 20, 0), ('install', 30, 0)))
        state['assignments'][1]['crew_id'] = 'install2'
        first = schedule(state, elements, crew='install1')
        first['tasks'][0]['segments'] = [{'start': '2026-11-10T12:00', 'end': '2026-11-10T12:30', 'minutes': 30}]
        before = deepcopy(first)
        prep = schedule(state, elements, [first], day='2026-11-09', shift='night', crew='preparation')
        self.assertEqual([t['element_ids'][0] for t in prep['tasks']], [2, 1])
        self.assertEqual(first, before)

    def test_forecast_does_not_mutate_manual_fields_or_history(self):
        state, elements = fixture((1, 2), (('prepare', 20, 0), ('install', 30, 0)))
        before = deepcopy(state)
        schedule(state, elements, day='2026-11-09', shift='night', crew='preparation')
        self.assertEqual(state, before)


if __name__ == '__main__':unittest.main(verbosity=2)
