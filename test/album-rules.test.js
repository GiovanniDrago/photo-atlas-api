import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlbumWhere,
  rulesAreEmpty,
  validateAlbumRules,
} from '../src/services/album-rules.js';

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function compile(rules) {
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  return { where: buildAlbumWhere(rules, push), params };
}

test('empty rules are valid and match nothing extra', () => {
  assert.deepEqual(validateAlbumRules(null), { rules: {} });
  assert.deepEqual(validateAlbumRules({}), { rules: {} });
  assert.equal(rulesAreEmpty({}), true);
  assert.equal(rulesAreEmpty({ all: [] }), false);
  assert.deepEqual(compile({}), { where: [], params: [] });
});

test('date ranges are normalized to ISO and compiled', () => {
  const parsed = validateAlbumRules({
    all: [
      { field: 'taken_at', op: 'between', value: ['2024-01-01', '2024-12-31'] },
      { field: 'backed_up_at', op: 'gte', value: '2025-06-01T10:00:00Z' },
    ],
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.rules.all[0].value[0], '2024-01-01T00:00:00.000Z');
  const { where, params } = compile(parsed.rules);
  assert.deepEqual(where, [
    '((m.taken_at >= $1 AND m.taken_at <= $2) AND m.backed_up_at >= $3)',
  ]);
  assert.deepEqual(params, [
    '2024-01-01T00:00:00.000Z',
    '2024-12-31T00:00:00.000Z',
    '2025-06-01T10:00:00.000Z',
  ]);
});

test('location compiles to ST_DWithin with meters', () => {
  const parsed = validateAlbumRules({
    all: [{ field: 'location', op: 'within', value: { lat: 45.07, lon: 7.68, radius_m: 5000 } }],
  });
  assert.equal(parsed.error, undefined);
  const { where, params } = compile(parsed.rules);
  assert.match(where[0], /ST_DWithin\(m\.geog, ST_SetSRID\(ST_MakePoint\(\$1, \$2\), 4326\)::geography, \$3\)/);
  assert.deepEqual(params, [7.68, 45.07, 5000]);
});

test('any groups are ORed, all groups are ANDed', () => {
  const any = validateAlbumRules({
    any: [
      { field: 'media_type', op: 'eq', value: 'video' },
      { field: 'backup_status', op: 'in', value: ['pending', 'failed'] },
    ],
  });
  assert.equal(any.error, undefined);
  const { where, params } = compile(any.rules);
  assert.equal(where[0], '(m.media_type = $1 OR m.backup_status = ANY($2::text[]))');
  assert.deepEqual(params, ['video', ['pending', 'failed']]);
});

test('source, device and name conditions compile', () => {
  const parsed = validateAlbumRules({
    all: [
      { field: 'source_id', op: 'eq', value: UUID.toUpperCase() },
      { field: 'device_id', op: 'eq', value: UUID },
      { field: 'name', op: 'contains', value: '100%_IMG' },
      { field: 'taken_at', op: 'is_null' },
    ],
  });
  assert.equal(parsed.error, undefined);
  const { where, params } = compile(parsed.rules);
  assert.equal(parsed.rules.all[0].value, UUID);
  assert.equal(
    where[0],
    "(m.source_id = $1 AND s.device_id = $2 AND m.name ILIKE $3 ESCAPE '\\' AND m.taken_at IS NULL)",
  );
  assert.deepEqual(params, [UUID, UUID, '%100\\%\\_IMG%']);
});

test('invalid rules are rejected', () => {
  const cases = [
    { rules: { all: 'nope' } },
    { rules: { any: [{ field: 'unknown', op: 'eq', value: 1 }] } },
    { rules: { all: [{ field: 'taken_at', op: 'eq', value: '2024-01-01' }] } },
    { rules: { all: [{ field: 'taken_at', op: 'between', value: ['2024-02-01', '2024-01-01'] }] } },
    { rules: { all: [{ field: 'taken_at', op: 'gte', value: 'not-a-date' }] } },
    { rules: { all: [{ field: 'location', op: 'within', value: { lat: 100, lon: 0, radius_m: 1000 } }] } },
    { rules: { all: [{ field: 'location', op: 'within', value: { lat: 45, lon: 0, radius_m: 10 } }] } },
    { rules: { all: [{ field: 'location', op: 'within', value: { lat: 45, lon: 0, radius_m: 9999999 } }] } },
    { rules: { all: [{ field: 'media_type', op: 'eq', value: 'audio' }] } },
    { rules: { all: [{ field: 'backup_status', op: 'in', value: [] }] } },
    { rules: { all: [{ field: 'source_id', op: 'eq', value: 'not-a-uuid' }] } },
    { rules: { all: [{ field: 'name', op: 'contains', value: '   ' }] } },
    { rules: { all: [{ field: 'name', op: 'eq', value: 'x' }] } },
    { rules: { all: [{ field: 'taken_at', op: 'gte', value: '2024-01-01' }], any: [] } },
    { rules: { all: [] } },
    {
      rules: {
        all: Array.from({ length: 21 }, () => ({ field: 'media_type', op: 'eq', value: 'image' })),
      },
    },
    { rules: [] },
  ];
  for (const entry of cases) {
    const parsed = validateAlbumRules(entry.rules);
    assert.ok(parsed.error, JSON.stringify(entry.rules));
  }
});

test('a single condition can be given as all or any', () => {
  for (const group of ['all', 'any']) {
    const parsed = validateAlbumRules({
      [group]: [{ field: 'metadata_status', op: 'eq', value: 'full' }],
    });
    assert.equal(parsed.error, undefined);
    assert.deepEqual(compile(parsed.rules).where, ['(m.metadata_status = $1)']);
  }
});
