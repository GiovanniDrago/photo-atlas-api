import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChildQuery } from '../src/services/kdrive.js';

test('child query encodes the type filter as an array', () => {
  const raw = buildChildQuery({ type: 'dir', limit: 100 });
  assert.match(raw, /type%5B%5D=dir/);
  const parsed = new URLSearchParams(raw);
  assert.equal(parsed.get('type[]'), 'dir');
  assert.equal(parsed.get('limit'), '100');
});

test('child query includes the cursor for pagination', () => {
  const parsed = new URLSearchParams(buildChildQuery({ type: 'file', cursor: 'abc123' }));
  assert.equal(parsed.get('type[]'), 'file');
  assert.equal(parsed.get('cursor'), 'abc123');
});

test('child query omits empty filters', () => {
  assert.equal(buildChildQuery(), '');
  assert.equal(buildChildQuery({ limit: 50 }), 'limit=50');
});
