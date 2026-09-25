// Generic rule engine for smart albums. Rules are stored as JSON:
//   { "all": [ { "field": "taken_at", "op": "between", "value": [from, to] }, ... ] }
//   { "any": [ ... ] }
// Every leaf is validated and compiled to parameterized SQL through the `push`
// helper, exactly like the /api/media filter builder. The engine already
// supports type/source/device/backup_status/metadata_status/name: the app only
// exposes a subset in its builder.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_FIELDS = new Set(['taken_at', 'backed_up_at']);

const ENUM_FIELDS = {
  media_type: ['image', 'video'],
  metadata_status: ['none', 'partial', 'full'],
  backup_status: ['none', 'pending', 'uploading', 'uploaded', 'failed', 'skipped'],
};

const MAX_CONDITIONS = 20;
const MAX_NAME_LENGTH = 120;
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 500000;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function parseDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeGroup(group) {
  if (group == null) return [];
  if (!Array.isArray(group)) return null;
  if (group.length > MAX_CONDITIONS) return null;
  const conditions = [];
  for (const entry of group) {
    if (entry == null || typeof entry !== 'object') return null;
    const condition = normalizeCondition(entry);
    if (condition == null) return null;
    conditions.push(condition);
  }
  return conditions;
}

function normalizeCondition(entry) {
  const field = entry.field;
  const op = entry.op;
  if (typeof field !== 'string' || typeof op !== 'string') return null;

  if (DATE_FIELDS.has(field)) {
    if (op === 'is_null') return { field, op };
    if (op === 'between') {
      if (!Array.isArray(entry.value) || entry.value.length !== 2) return null;
      const from = parseDate(entry.value[0]);
      const to = parseDate(entry.value[1]);
      if (from == null || to == null || from > to) return null;
      return { field, op, value: [from, to] };
    }
    if (op === 'gte' || op === 'lte') {
      const date = parseDate(entry.value);
      if (date == null) return null;
      return { field, op, value: date };
    }
    return null;
  }

  if (field === 'location') {
    if (op !== 'within') return null;
    const value = entry.value;
    if (value == null || typeof value !== 'object') return null;
    const lat = Number(value.lat);
    const lon = Number(value.lon);
    const radius = Number(value.radius_m);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    if (!Number.isFinite(radius) || radius < MIN_RADIUS_M || radius > MAX_RADIUS_M) return null;
    return { field, op, value: { lat, lon, radius_m: Math.round(radius) } };
  }

  if (field === 'media_type' || field === 'metadata_status') {
    if (op !== 'eq') return null;
    const allowed = ENUM_FIELDS[field];
    if (typeof entry.value !== 'string' || !allowed.includes(entry.value)) return null;
    return { field, op, value: entry.value };
  }

  if (field === 'backup_status') {
    if (op === 'eq') {
      if (typeof entry.value !== 'string' || !ENUM_FIELDS.backup_status.includes(entry.value)) {
        return null;
      }
      return { field, op, value: entry.value };
    }
    if (op === 'in') {
      if (!Array.isArray(entry.value) || entry.value.length === 0) return null;
      const values = entry.value.filter(
        (value) => typeof value === 'string' && ENUM_FIELDS.backup_status.includes(value),
      );
      if (values.length !== entry.value.length) return null;
      return { field, op, value: values };
    }
    return null;
  }

  if (field === 'source_id' || field === 'device_id') {
    if (op !== 'eq' || !isUuid(entry.value)) return null;
    return { field, op, value: entry.value.toLowerCase() };
  }

  if (field === 'name') {
    if (op !== 'contains') return null;
    if (typeof entry.value !== 'string') return null;
    const value = entry.value.trim();
    if (value.length === 0 || value.length > MAX_NAME_LENGTH) return null;
    return { field, op, value };
  }

  return null;
}

/// Validates and normalizes stored rules. Returns `{ rules }` or `{ error }`.
export function validateAlbumRules(input) {
  if (input == null) return { rules: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'rules must be an object' };
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return { rules: {} };
  if (keys.length > 1 || !['all', 'any'].includes(keys[0])) {
    return { error: 'rules must have exactly one of all or any' };
  }
  const conditions = normalizeGroup(input[keys[0]]);
  if (conditions == null || conditions.length === 0) {
    return { error: 'rules conditions are invalid' };
  }
  return { rules: { [keys[0]]: conditions } };
}

export function rulesAreEmpty(rules) {
  if (rules == null || typeof rules !== 'object') return true;
  return !Array.isArray(rules.all) && !Array.isArray(rules.any);
}

/// Compiles validated rules into SQL conditions; the caller joins them with
/// AND next to the owner filter. `push` parameterizes values and returns `$n`.
export function buildAlbumWhere(rules, push) {
  if (rulesAreEmpty(rules)) return [];
  const group = Array.isArray(rules.all) ? rules.all : rules.any;
  const join = Array.isArray(rules.all) ? ' AND ' : ' OR ';
  const compiled = group.map((condition) => compileCondition(condition, push));
  return [`(${compiled.join(join)})`];
}

function compileCondition(condition, push) {
  const column = condition.field === 'backed_up_at' ? 'm.backed_up_at' : 'm.taken_at';
  switch (condition.field) {
    case 'taken_at':
    case 'backed_up_at':
      if (condition.op === 'is_null') return `${column} IS NULL`;
      if (condition.op === 'between') {
        return `(${column} >= ${push(condition.value[0])} AND ${column} <= ${push(condition.value[1])})`;
      }
      return `${column} ${condition.op === 'gte' ? '>=' : '<='} ${push(condition.value)}`;
    case 'location': {
      const { lat, lon, radius_m: radius } = condition.value;
      const lonParam = push(lon);
      const latParam = push(lat);
      const radiusParam = push(radius);
      return `ST_DWithin(m.geog, ST_SetSRID(ST_MakePoint(${lonParam}, ${latParam}), 4326)::geography, ${radiusParam})`;
    }
    case 'media_type':
      return `m.media_type = ${push(condition.value)}`;
    case 'metadata_status':
      return `m.metadata_status = ${push(condition.value)}`;
    case 'backup_status':
      return condition.op === 'in'
        ? `m.backup_status = ANY(${push(condition.value)}::text[])`
        : `m.backup_status = ${push(condition.value)}`;
    case 'source_id':
      return `m.source_id = ${push(condition.value)}`;
    case 'device_id':
      return `s.device_id = ${push(condition.value)}`;
    case 'name': {
      const escaped = condition.value.replace(/[\\%_]/g, '\\$&');
      return `m.name ILIKE ${push(`%${escaped}%`)} ESCAPE '\\'`;
    }
    default:
      return 'TRUE';
  }
}
