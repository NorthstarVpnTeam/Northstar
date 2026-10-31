'use strict';

/**
 * Input validation shared by IPC handlers and services.
 * Every function returns { ok: boolean, value?: any, error?: string } and never
 * throws on malformed input.
 */

const {
  DEFAULT_SETTINGS,
  LIMITS,
  PROTOCOLS,
  SORT_MODES,
  PING_INTERVAL_OPTIONS,
  MEASUREMENT,
} = require('./constants');

const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function ok(value) {
  return { ok: true, value };
}
function fail(error) {
  return { ok: false, error };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePort(value, field = 'port') {
  if (typeof value !== 'number') return fail(`${field} must be a number`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < LIMITS.PORT_MIN || n > LIMITS.PORT_MAX) {
    return fail(`${field} must be an integer between ${LIMITS.PORT_MIN} and ${LIMITS.PORT_MAX}`);
  }
  return ok(n);
}

function validateUrl(value, field = 'url') {
  if (typeof value !== 'string' || value.trim() === '') return fail(`${field} is required`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return fail(`${field} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fail(`${field} must use http or https`);
  }
  if (parsed.username || parsed.password) return fail(`${field} must not contain credentials`);
  return ok(parsed.toString());
}

function validateServerId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return fail('serverId is not a valid identifier');
  }
  return ok(value);
}

function validateMeasurementType(value, allowed = Object.values(MEASUREMENT)) {
  if (!allowed.includes(value)) return fail(`measurement must be one of: ${allowed.join(', ')}`);
  return ok(value);
}

/**
 * Validates a partial settings update. Unknown keys are rejected so a rogue
 * renderer cannot inject arbitrary state.
 */
function validateSettingsUpdate(patch) {
  if (!isPlainObject(patch)) return fail('settings must be an object');
  const known = Object.keys(DEFAULT_SETTINGS);
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!known.includes(key)) return fail(`unknown setting: ${key}`);
    switch (key) {
      case 'configSource': {
        const r = validateUrl(value, key);
        if (!r.ok) return r;
        out[key] = r.value;
        break;
      }
      case 'systemProxy':
      case 'tunMode':
      case 'autoRefresh':
      case 'autoPing':
      case 'autoSort':
      case 'hideFailed':
      case 'validateOnConnect':
      case 'connectOnLaunch':
      case 'reduceMotion':
      case 'compactRows':
      case 'verboseLogging': {
        if (typeof value !== 'boolean') return fail(`${key} must be a boolean`);
        out[key] = value;
        break;
      }
      case 'pingTimeoutMs': {
        const n = Number(value);
        if (typeof value !== 'number' || !Number.isInteger(n) || n < LIMITS.PING_TIMEOUT_MIN || n > LIMITS.PING_TIMEOUT_MAX) {
          return fail(
            `pingTimeoutMs must be between ${LIMITS.PING_TIMEOUT_MIN} and ${LIMITS.PING_TIMEOUT_MAX}`
          );
        }
        out[key] = n;
        break;
      }
      case 'pingIntervalMs': {
        const n = Number(value);
        if (typeof value !== 'number' || !PING_INTERVAL_OPTIONS.includes(n)) {
          return fail(`pingIntervalMs must be one of: ${PING_INTERVAL_OPTIONS.join(', ')}`);
        }
        out[key] = n;
        break;
      }
      case 'autoRefreshIntervalMin': {
        const n = Number(value);
        if (typeof value !== 'number' || !Number.isInteger(n) || n < 15 || n > 1440) {
          return fail('autoRefreshIntervalMin must be between 15 and 1440 minutes');
        }
        out[key] = n;
        break;
      }
      case 'sortBy': {
        if (!SORT_MODES.includes(value)) return fail(`sortBy must be one of: ${SORT_MODES.join(', ')}`);
        out[key] = value;
        break;
      }
      case 'measurementType':
      case 'validationType': {
        const r = validateMeasurementType(value);
        if (!r.ok) return r;
        out[key] = r.value;
        break;
      }
      case 'socksPort':
      case 'httpPort': {
        const r = validatePort(value, key);
        if (!r.ok) return r;
        out[key] = r.value;
        break;
      }
      case 'theme': {
        if (value !== 'light' && value !== 'dark') return fail('theme must be light or dark');
        out[key] = value;
        break;
      }
      case 'corePath': {
        if (typeof value !== 'string') return fail('corePath must be a string');
        if (value.length > 512) return fail('corePath is too long');
        out[key] = value.trim();
        break;
      }
      default:
        return fail(`unhandled setting: ${key}`);
    }
  }
  if (Object.keys(out).length === 0) return fail('no valid settings supplied');
  if (typeof out.socksPort === 'number' && out.socksPort === out.httpPort) {
    return fail('socksPort and httpPort must differ');
  }
  return ok(out);
}

/** Validates a latency test request coming from the renderer. */
function validateLatencyRequest(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const type = payload.type === undefined ? MEASUREMENT.TCP : payload.type;
  const t = validateMeasurementType(type);
  if (!t.ok) return t;

  if (payload.ids !== undefined) {
    if (!Array.isArray(payload.ids)) return fail('ids must be an array');
    if (payload.ids.length > LIMITS.MAX_SERVERS) return fail('too many ids');
    for (const id of payload.ids) {
      const r = validateServerId(id);
      if (!r.ok) return r;
    }
    return ok({ type: t.value, ids: payload.ids.slice() });
  }
  if (payload.all === true) return ok({ type: t.value, all: true });
  return fail('either ids or all is required');
}

/** Validates a connection request. */
function validateConnectRequest(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const r = validateServerId(payload.serverId);
  if (!r.ok) return r;
  return ok({ serverId: r.value });
}

/** Validates a speed test request. */
function validateSpeedRequest(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const direction = payload.direction;
  if (direction !== 'download' && direction !== 'upload') {
    return fail('direction must be download or upload');
  }
  const viaProxy = payload.viaProxy === undefined ? true : Boolean(payload.viaProxy);
  return ok({ direction, viaProxy });
}

/** Validates an arbitrary protocol string. */
function validateProtocol(value) {
  return PROTOCOLS.includes(value) ? ok(value) : fail(`unsupported protocol: ${value}`);
}

/** Coerces a settings file loaded from disk into a valid settings object. */
function coerceSettings(raw) {
  const base = { ...DEFAULT_SETTINGS };
  if (!isPlainObject(raw)) return base;
  const candidate = { ...base };
  for (const key of Object.keys(base)) {
    if (raw[key] !== undefined) candidate[key] = raw[key];
  }
  const validated = validateSettingsUpdate(candidate);
  if (validated.ok) return { ...base, ...validated.value };
  // Fall back field by field so one corrupt value does not discard everything.
  const safe = { ...base };
  for (const key of Object.keys(base)) {
    const single = validateSettingsUpdate({ [key]: candidate[key] });
    if (single.ok) safe[key] = single.value[key];
  }
  return safe;
}

module.exports = {
  ok,
  fail,
  isPlainObject,
  validatePort,
  validateUrl,
  validateServerId,
  validateMeasurementType,
  validateSettingsUpdate,
  validateLatencyRequest,
  validateConnectRequest,
  validateSpeedRequest,
  validateProtocol,
  coerceSettings,
};