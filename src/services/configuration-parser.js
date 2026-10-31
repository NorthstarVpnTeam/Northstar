'use strict';

/**
 * Defensive configuration parser.
 *
 * Accepts a single URI (VLESS / VMess / Trojan / Shadowsocks / SOCKS / HTTP)
 * or a whole document, and produces a normalized internal representation.
 * Malformed input is rejected with a reason; it never throws to the caller.
 *
 * The normalized shape:
 * {
 *   id, protocol, label, country|null, flag|null, host, port,
 *   security, network, transport, sni, raw (original URI)  -- raw never logged
 * }
 */

const crypto = require('crypto');
const { detectCountry } = require('./country-detector');
const { PROTOCOLS, LIMITS } = require('../shared/constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^[a-zA-Z0-9._~:[\]-]+$/;

class ParseError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

function isNonEmptyString(v, max = 4096) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function safeDecode(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURI(value);
    } catch {
      return fallback || value;
    }
  }
}

function decodeBase64Url(str) {
  if (typeof str !== 'string' || str.length === 0) return '';
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parsePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function makeId(protocol, host, port, discriminator) {
  const material = `${protocol}|${host}|${port}|${discriminator}`;
  return 's_' + crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!isNonEmptyString(h, 253)) return null;
  if (!HOST_RE.test(h)) return null;
  return h;
}

/**
 * Normalizes the trailing numeric suffix of a label:
 *   "Netherlands 001" -> "Netherlands 01"
 *   "Netherlands 002" -> "Netherlands 02"
 *   "Netherlands 010" -> "Netherlands 10"
 * Only the trailing number is touched; all other digits are preserved.
 */
function normalizeServerName(label) {
  if (typeof label !== 'string') return '';
  const cleaned = label.replace(/\s+/g, ' ').trim();
  const m = /^(.*?)(\d+)$/.exec(cleaned);
  if (!m) return cleaned;
  const head = m[1].replace(/[\s._|-]+$/, '').trimEnd();
  const num = Number.parseInt(m[2], 10);
  if (!Number.isFinite(num)) return cleaned;
  const padded = String(num).padStart(2, '0');
  return head ? `${head} ${padded}` : padded;
}

const FLAG_RE = /(?:\p{RI}\p{RI})+/gu;

/** Strips the leading flag emoji from a fragment. */
function stripFlag(fragment) {
  return String(fragment || '')
    .replace(FLAG_RE, '')
    .replace(/^[\s\-–—•|/\\]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Derives a human label from a fragment; falls back to protocol + host. */
function deriveLabel(fragment, fallback) {
  const stripped = stripFlag(fragment);
  if (stripped) return normalizeServerName(stripped);
  return fallback;
}

function finalize(entry, fragment) {
  const label = deriveLabel(
    fragment,
    `${entry.protocol.toUpperCase()} ${entry.host}:${entry.port}`
  );
  const country = detectCountry(fragment) || detectCountry(label);
  entry.label = label;
  entry.country = country ? country.name : null;
  entry.countryCode = country ? country.code : null;
  entry.flag = country ? country.flag : '';
  entry.id = makeId(
    entry.protocol,
    entry.host,
    entry.port,
    fragment || `${entry.label}|${entry.network || ''}`
  );
  return entry;
}

/* ------------------------------------------------------------------ VLESS */

function parseVless(uri, fragment) {
  const body = uri.slice('vless://'.length);
  const at = body.indexOf('@');
  if (at <= 0) throw new ParseError('vless: missing credentials');
  const userInfo = body.slice(0, at);
  const rest = body.slice(at + 1);

  const qIndex = rest.indexOf('?');
  const hostPort = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  const colon = hostPort.lastIndexOf(':');
  if (colon <= 0) throw new ParseError('vless: missing host or port');
  const host = normalizeHost(hostPort.slice(0, colon));
  const port = parsePort(hostPort.slice(colon + 1));
  if (!host) throw new ParseError('vless: invalid host');
  if (port === null) throw new ParseError('vless: invalid port');

  const uuid = safeDecode(userInfo).trim();
  if (!UUID_RE.test(uuid)) throw new ParseError('vless: id is not a valid UUID');

  const params = new URLSearchParams(query);
  const security = (params.get('security') || 'none').toLowerCase();
  const network = (params.get('type') || 'tcp').toLowerCase();

  if (!['none', 'tls', 'reality'].includes(security)) {
    throw new ParseError('vless: unsupported security');
  }

  const entry = {
    protocol: 'vless',
    host,
    port,
    id: '',
    label: '',
    country: null,
    countryCode: null,
    flag: '',
    security,
    network,
    transport: network,
    sni: params.get('sni') || params.get('host') || '',
    flow: params.get('flow') || '',
    extra: {
      encryption: params.get('encryption') || 'none',
      pbk: params.get('pbk') || '',
      sid: params.get('sid') || '',
      fp: params.get('fp') || '',
      path: params.get('path') || '',
      host: params.get('host') || '',
      alpn: params.get('alpn') || '',
      allowInsecure: params.get('allowInsecure') === '1' || params.get('insecure') === '1',
    },
    credential: uuid,
  };
  return finalize(entry, fragment);
}

/* ------------------------------------------------------------------ VMess */

function parseVmess(uri, fragment) {
  const payload = uri.slice('vmess://'.length).trim();
  const jsonText = decodeBase64Url(payload);
  if (!jsonText) throw new ParseError('vmess: payload is not valid base64');
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new ParseError('vmess: payload is not valid JSON');
  }
  if (!data || typeof data !== 'object') throw new ParseError('vmess: empty payload');

  const host = normalizeHost(String(data.add || data.host || ''));
  const port = parsePort(data.port);
  if (!host) throw new ParseError('vmess: invalid address');
  if (port === null) throw new ParseError('vmess: invalid port');
  const uuid = String(data.id || '').trim();
  if (!uuid) throw new ParseError('vmess: missing id');

  const network = String(data.net || 'tcp').toLowerCase();
  const tlsRaw = String(data.tls || '').toLowerCase();
  const security = tlsRaw === 'tls' ? 'tls' : 'none';

  const entry = {
    protocol: 'vmess',
    host,
    port,
    id: '',
    label: '',
    country: null,
    countryCode: null,
    flag: '',
    security,
    network,
    transport: network,
    sni: String(data.sni || data.host || ''),
    flow: '',
    extra: {
      aid: String(data.aid || '0'),
      path: String(data.path || ''),
      host: String(data.host || ''),
      type: String(data.type || ''),
      alpn: String(data.alpn || ''),
      scy: String(data.scy || 'auto'),
      allowInsecure: String(data.allowInsecure || '') === '1',
    },
    credential: uuid,
  };
  // VMess keeps its display name in the JSON `ps` field, not a URI fragment.
  const labelSource = fragment || String(data.ps || '');
  return finalize(entry, labelSource);
}

/* ----------------------------------------------------------------- Trojan */

function parseTrojan(uri, fragment) {
  const body = uri.slice('trojan://'.length);
  const at = body.lastIndexOf('@');
  if (at <= 0) throw new ParseError('trojan: missing credentials');
  const userInfo = body.slice(0, at);
  const rest = body.slice(at + 1);

  const qIndex = rest.indexOf('?');
  const hostPort = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  const colon = hostPort.lastIndexOf(':');
  if (colon <= 0) throw new ParseError('trojan: missing host or port');
  const host = normalizeHost(hostPort.slice(0, colon));
  const port = parsePort(hostPort.slice(colon + 1));
  if (!host) throw new ParseError('trojan: invalid host');
  if (port === null) throw new ParseError('trojan: invalid port');

  const password = safeDecode(userInfo);
  if (!isNonEmptyString(password, 512)) throw new ParseError('trojan: missing password');

  const params = new URLSearchParams(query);
  const security = (params.get('security') || 'tls').toLowerCase();
  const network = (params.get('type') || 'tcp').toLowerCase();
  if (security !== 'tls' && security !== 'none') {
    throw new ParseError('trojan: unsupported security');
  }

  const entry = {
    protocol: 'trojan',
    host,
    port,
    id: '',
    label: '',
    country: null,
    countryCode: null,
    flag: '',
    security,
    network,
    transport: network,
    sni: params.get('sni') || params.get('host') || host,
    flow: '',
    extra: {
      path: params.get('path') || '',
      host: params.get('host') || '',
      alpn: params.get('alpn') || '',
      fp: params.get('fp') || '',
      allowInsecure:
        params.get('allowInsecure') === '1' || params.get('insecure') === '1',
    },
    credential: password,
  };
  return finalize(entry, fragment);
}

/* -------------------------------------------------------- Shadowsocks */

function parseShadowsocks(uri, fragment) {
  const body = uri.slice('ss://'.length);
  const at = body.lastIndexOf('@');
  if (at === -1) throw new ParseError('ss: missing server address');

  let userInfoRaw = body.slice(0, at);
  const rest = body.slice(at + 1);

  const qIndex = rest.indexOf('?');
  const hostPort = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  const colon = hostPort.lastIndexOf(':');
  if (colon <= 0) throw new ParseError('ss: missing host or port');
  const host = normalizeHost(hostPort.slice(0, colon));
  const port = parsePort(hostPort.slice(colon + 1));
  if (!host) throw new ParseError('ss: invalid host');
  if (port === null) throw new ParseError('ss: invalid port');

  // Legacy SIP002: userInfo may be plain base64 of "method:password".
  if (!userInfoRaw.includes(':')) {
    userInfoRaw = decodeBase64Url(userInfoRaw);
    if (!userInfoRaw.includes(':')) {
      throw new ParseError('ss: credentials are not in method:password form');
    }
  } else {
    userInfoRaw = safeDecode(userInfoRaw);
  }

  const sep = userInfoRaw.indexOf(':');
  const method = userInfoRaw.slice(0, sep).trim().toLowerCase();
  const password = userInfoRaw.slice(sep + 1);
  if (!method) throw new ParseError('ss: missing cipher method');
  if (!isNonEmptyString(password, 512)) throw new ParseError('ss: missing password');

  const params = new URLSearchParams(query);
  const pluginRaw = params.get('plugin') || '';
  let plugin = '';
  let pluginOpts = '';
  if (pluginRaw) {
    const parts = pluginRaw.split(';');
    plugin = parts[0] || '';
    pluginOpts = parts.slice(1).join(';');
  }

  const entry = {
    protocol: 'ss',
    host,
    port,
    id: '',
    label: '',
    country: null,
    countryCode: null,
    flag: '',
    security: 'none',
    network: 'tcp',
    transport: 'tcp',
    sni: '',
    flow: '',
    extra: {
      cipher: method,
      plugin,
      pluginOpts,
    },
    credential: password,
  };
  return finalize(entry, fragment);
}

/* --------------------------------------------------------- SOCKS / HTTP */

function parseProxyLink(uri, protocol, fragment) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ParseError(`${protocol}: invalid URL`);
  }
  const host = normalizeHost(parsed.hostname);
  const port = parsePort(parsed.port || (protocol === 'http' ? '80' : '1080'));
  if (!host) throw new ParseError(`${protocol}: invalid host`);
  if (port === null) throw new ParseError(`${protocol}: invalid port`);

  let credential = '';
  if (parsed.username) {
    const user = safeDecode(parsed.username);
    const pass = safeDecode(parsed.password || '');
    credential = pass ? `${user}:${pass}` : user;
    if (!isNonEmptyString(user, 256)) throw new ParseError(`${protocol}: invalid username`);
  }

  const entry = {
    protocol,
    host,
    port,
    id: '',
    label: '',
    country: null,
    countryCode: null,
    flag: '',
    security: 'none',
    network: 'tcp',
    transport: 'tcp',
    sni: '',
    flow: '',
    extra: {},
    credential,
  };
  return finalize(entry, fragment);
}

/* ------------------------------------------------------------- dispatch */

const PARSERS = {
  vless: parseVless,
  vmess: parseVmess,
  trojan: parseTrojan,
  ss: parseShadowsocks,
  socks: (uri, fragment) => parseProxyLink(uri, 'socks', fragment),
  socks5: (uri, fragment) => parseProxyLink(uri, 'socks', fragment),
  socks4: (uri, fragment) => parseProxyLink(uri, 'socks', fragment),
  http: (uri, fragment) => parseProxyLink(uri, 'http', fragment),
  https: (uri, fragment) => parseProxyLink(uri, 'http', fragment),
};

/**
 * Parses a single configuration URI.
 * @param {string} uri
 * @returns {object} normalized entry
 * @throws {ParseError}
 */
function parseConfig(uri) {
  if (typeof uri !== 'string') throw new ParseError('entry is not a string');
  const trimmed = uri.trim();
  if (!trimmed) throw new ParseError('entry is empty');
  if (trimmed.length > 64 * 1024) throw new ParseError('entry is too long');
  if (/[\r\n\t]/.test(trimmed)) throw new ParseError('entry contains control characters');

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed);
  if (!schemeMatch) throw new ParseError('entry has no URI scheme');
  const scheme = schemeMatch[1].toLowerCase();

  if (!PROTOCOLS.includes(scheme) && !PARSERS[scheme]) {
    throw new ParseError(`unsupported scheme: ${scheme}`, 'unsupported');
  }
  const parser = PARSERS[scheme];
  if (!parser) throw new ParseError(`unsupported scheme: ${scheme}`, 'unsupported');

  const hashIndex = trimmed.indexOf('#');
  const fragment = hashIndex === -1 ? '' : safeDecode(trimmed.slice(hashIndex + 1));
  const withoutFragment = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);

  const entry = parser(withoutFragment, fragment);
  entry.raw = trimmed;
  return entry;
}

/**
 * Parses a whole document (newline separated).
 * @returns {{entries: object[], stats: object, errors: Array<{line:number,reason:string,code:string}>}}
 */
function parseDocument(text) {
  const stats = {
    received: 0,
    parsed: 0,
    rejected: 0,
    unsupported: 0,
    duplicates: 0,
    kept: 0,
  };
  const errors = [];
  const entries = [];
  const seen = new Map();

  if (typeof text !== 'string' || text.trim() === '') {
    return { entries, stats, errors: [{ line: 0, reason: 'empty document', code: 'empty' }] };
  }

  const lines = text.split(/\r?\n/);
  stats.received = lines.filter((l) => l.trim().length > 0).length;

  let lineNo = 0;
  for (const rawLine of lines) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) continue;
    if (entries.length >= LIMITS.MAX_SERVERS) {
      errors.push({ line: lineNo, reason: 'server limit reached', code: 'limit' });
      stats.rejected += 1;
      continue;
    }
    let entry;
    try {
      entry = parseConfig(line);
    } catch (err) {
      const code = err instanceof ParseError ? err.code : 'invalid';
      const reason = err instanceof Error ? err.message : 'unknown error';
      errors.push({ line: lineNo, reason, code });
      if (code === 'unsupported') stats.unsupported += 1;
      stats.rejected += 1;
      continue;
    }

    // Deduplicate on a stable key: protocol + endpoint + credential identity.
    const credentialId =
      entry.credential && entry.credential.length <= 64
        ? crypto.createHash('sha256').update(entry.credential).digest('hex').slice(0, 16)
        : '';
    const key = `${entry.protocol}|${entry.host}|${entry.port}|${credentialId}`;
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    seen.set(key, entry);
    entries.push(entry);
    stats.parsed += 1;
  }

  stats.kept = entries.length;
  return { entries, stats, errors };
}

/** Returns a log-safe summary of an entry (never credentials or raw URI). */
function describe(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    protocol: entry.protocol,
    label: entry.label,
    country: entry.country,
    flag: entry.flag,
    host: entry.host,
    port: entry.port,
    security: entry.security,
    network: entry.network,
  };
}

module.exports = {
  parseConfig,
  parseDocument,
  normalizeServerName,
  describe,
  ParseError,
};