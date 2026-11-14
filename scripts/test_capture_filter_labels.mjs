import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app/static/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function zakhvatkaLabelFor(value) {');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start);
const context = vm.createContext({
  PLACEMENT_NONE: '__none__',
  placementNoneLabel: () => '— не определено —',
  zoneNameById: id => `зона #${id}`,
  state: {
    zones: [],
    zoneLabels: [
      { id: 100, number: 1, name: 'Ось 1' },
      { id: 101, number: 2, name: 'Ось А' },
      { id: 102, number: 3, name: 'Захватка 3' },
      { id: 103, number: 4, name: '' },
      { id: 104, number: null, name: 'Северный фасад' },
    ],
  },
});
vm.runInContext(source.slice(start, end), context);
assert.equal(context.zakhvatkaLabelFor(100), 'Захватка 1. Ось 1');
assert.equal(context.zakhvatkaLabelFor(101), 'Захватка 2. Ось А');
assert.equal(context.zakhvatkaLabelFor(102), 'Захватка 3');
assert.equal(context.zakhvatkaLabelFor(103), 'Захватка 4');
assert.equal(context.zakhvatkaLabelFor(104), 'Северный фасад');
assert.equal(context.zakhvatkaLabelFor('__none__'), '— не определено —');
assert.equal(context.zakhvatkaLabelFor(999), 'зона #999');
context.state.zones = context.state.zoneLabels;
delete context.state.zoneLabels;
assert.equal(context.zakhvatkaLabelFor(100), 'Захватка 1. Ось 1');
console.log('Capture filter labels: 8 checks passed');
