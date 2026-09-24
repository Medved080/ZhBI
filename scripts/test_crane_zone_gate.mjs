import assert from 'node:assert/strict';
import { checkWrite } from '../app/static/v2/write-gate.js';

const base = '/objects/1/crane-zone-versions/drafts';
assert.equal(checkWrite('POST', base, {}).allowed, true);
assert.equal(checkWrite('PATCH', `${base}/2`, {
  edit_token: 1, zones: [], overrides: {}, note: '',
}).allowed, true);
assert.equal(checkWrite('PATCH', `${base}/2`, {
  edit_token: 1, zones: [], overrides: {}, note: '', contract_id: 9,
}).allowed, false);
assert.equal(checkWrite('POST', `${base}/2/publish`, {
  edit_token: 2, effective_date: '2026-09-25',
}).allowed, true);
assert.equal(checkWrite('POST', `${base}/2/publish`, {
  edit_token: 2, effective_date: 'tomorrow',
}).allowed, false);
assert.equal(checkWrite('POST', `${base}/2/publish`, {
  edit_token: 2, effective_date: '2026-09-25', contract_id: 9,
}).allowed, false);
console.log('crane zone write gate: 6 checks passed');
