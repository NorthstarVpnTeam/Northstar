'use strict';

/**
 * Conservative country detection for server labels.
 *
 * Only two signals are used:
 *   1. A leading flag emoji (regional indicator pair) in the raw label.
 *   2. An exact country-name match on the label with the trailing number and
 *      any flag removed.
 *
 * If neither yields a confident result the caller receives `null` and the
 * server is grouped under "Unknown". No IP geolocation is performed.
 */

const FLAG_NAMES = {
  AF: 'Afghanistan', AL: 'Albania', DZ: 'Algeria', AR: 'Argentina', AM: 'Armenia',
  AU: 'Australia', AT: 'Austria', AZ: 'Azerbaijan', BH: 'Bahrain', BD: 'Bangladesh',
  BY: 'Belarus', BE: 'Belgium', BZ: 'Belize', BO: 'Bolivia', BR: 'Brazil',
  BG: 'Bulgaria', KH: 'Cambodia', CM: 'Cameroon', CA: 'Canada', CL: 'Chile',
  CN: 'China', CO: 'Colombia', CR: 'Costa Rica', HR: 'Croatia', CY: 'Cyprus',
  CZ: 'Czechia', DK: 'Denmark', DO: 'Dominican Republic', EC: 'Ecuador', EG: 'Egypt',
  EE: 'Estonia', FI: 'Finland', FR: 'France', GE: 'Georgia', DE: 'Germany',
  GH: 'Ghana', GR: 'Greece', GT: 'Guatemala', HK: 'Hong Kong', HU: 'Hungary',
  IS: 'Iceland', IN: 'India', ID: 'Indonesia', IR: 'Iran', IE: 'Ireland',
  IL: 'Israel', IT: 'Italy', JM: 'Jamaica', JP: 'Japan', JO: 'Jordan',
  KZ: 'Kazakhstan', KE: 'Kenya', KR: 'South Korea', KW: 'Kuwait', LV: 'Latvia',
  LB: 'Lebanon', LT: 'Lithuania', LU: 'Luxembourg', MO: 'Macao', MY: 'Malaysia',
  MT: 'Malta', MX: 'Mexico', MD: 'Moldova', MN: 'Mongolia', ME: 'Montenegro',
  MA: 'Morocco', MM: 'Myanmar', NP: 'Nepal', NL: 'Netherlands', NZ: 'New Zealand',
  NG: 'Nigeria', MK: 'North Macedonia', NO: 'Norway', OM: 'Oman', PK: 'Pakistan',
  PA: 'Panama', PE: 'Peru', PH: 'Philippines', PL: 'Poland', PT: 'Portugal',
  PR: 'Puerto Rico', QA: 'Qatar', RO: 'Romania', RU: 'Russia', SA: 'Saudi Arabia',
  RS: 'Serbia', SG: 'Singapore', SK: 'Slovakia', SI: 'Slovenia', ZA: 'South Africa',
  ES: 'Spain', LK: 'Sri Lanka', SE: 'Sweden', CH: 'Switzerland', SY: 'Syria',
  TW: 'Taiwan', TH: 'Thailand', TN: 'Tunisia', TR: 'Turkey', UA: 'Ukraine',
  AE: 'United Arab Emirates', GB: 'United Kingdom', US: 'United States',
  UY: 'Uruguay', UZ: 'Uzbekistan', VE: 'Venezuela', VN: 'Vietnam', YE: 'Yemen',
  ZM: 'Zambia', ZW: 'Zimbabwe',
};

/** Extra spellings mapped to ISO codes. Keys must already be normalized. */
const EXTRA_ALIASES = {
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
  america: 'US',
  'u s': 'US',
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  'the netherlands': 'NL',
  holland: 'NL',
  'russian federation': 'RU',
  'republic of korea': 'KR',
  'korea': 'KR',
  's korea': 'KR',
  'hongkong': 'HK',
  'h k': 'HK',
  'republic of china': 'TW',
  'czech republic': 'CZ',
  'uae': 'AE',
  'emirates': 'AE',
  'turkiye': 'TR',
  'ir': 'IR',
  'viet nam': 'VN',
  'myanmar burma': 'MM',
  'bosnia and herzegovina': 'BA',
  'north macedonia': 'MK',
  'macedonia': 'MK',
};

const ALIASES = new Map();
for (const [code, name] of Object.entries(FLAG_NAMES)) {
  ALIASES.set(name.toLowerCase(), code);
}
for (const [alias, code] of Object.entries(EXTRA_ALIASES)) {
  ALIASES.set(alias, code);
}

/**
 * Regional-indicator pairs (flag emoji). Matched as code points, so this must
 * keep the /u flag: surrogate escapes would never match a real emoji.
 */
const FLAG_EMOJI_RE = /(?:\p{RI}\p{RI})+/gu;
const TRAILING_NUMBER_RE = /[\s._|-]+\d+\s*$/;

/** Extracts an ISO country code from a leading flag emoji, or null. */
function codeFromFlag(label) {
  if (typeof label !== 'string') return null;
  FLAG_EMOJI_RE.lastIndex = 0; // shared /g regex: never trust its state
  const m = FLAG_EMOJI_RE.exec(label);
  if (!m || m.index !== 0) return null;
  const pair = m[0];
  const points = [
    pair.charCodeAt(0) - 0xd83c,
    pair.charCodeAt(1) - 0xdde6,
    pair.charCodeAt(2) - 0xd83c,
    pair.charCodeAt(3) - 0xdde6,
  ];
  if (points.some((p) => Number.isNaN(p) || p < 0 || p > 25)) return null;
  const code = String.fromCharCode(65 + points[1]) + String.fromCharCode(65 + points[3]);
  return FLAG_NAMES[code] ? code : null;
}

/** Removes flag emoji and decorative separators from the start of a label. */
function stripDecoration(label) {
  return String(label || '')
    .replace(FLAG_EMOJI_RE, '')
    .replace(/^[\s\-–—•|/\\]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalizes a country-ish name for alias lookup. */
function normalizeCountryKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
}

/**
 * Returns { code, name, flag } or null when the country cannot be identified
 * confidently.
 * @param {string} rawLabel
 * @returns {{code:string,name:string,flag:string}|null}
 */
function detectCountry(rawLabel) {
  if (typeof rawLabel !== 'string' || rawLabel.trim() === '') return null;

  const flagCode = codeFromFlag(rawLabel);
  if (flagCode) {
    return { code: flagCode, name: FLAG_NAMES[flagCode], flag: flagFor(flagCode) };
  }

  let base = stripDecoration(rawLabel);
  base = base.replace(TRAILING_NUMBER_RE, '').trim();
  if (!base) return null;

  const key = normalizeCountryKey(base);
  if (!key) return null;

  let code = ALIASES.get(key) || null;

  // Also accept a name that is an exact prefix match of a known country, e.g.
  // "Germany FRA-01" -> Germany, but only when the remainder carries no extra
  // country-like word (kept intentionally conservative).
  if (!code) {
    for (const [alias, aliasCode] of ALIASES) {
      if (key.startsWith(alias + ' ')) {
        code = aliasCode;
        break;
      }
    }
  }

  if (!code || !FLAG_NAMES[code]) return null;
  return { code, name: FLAG_NAMES[code], flag: flagFor(code) };
}

/** Builds a flag emoji from an ISO 3166-1 alpha-2 code; '' if unknown. */
function flagFor(code) {
  if (typeof code !== 'string' || code.length !== 2) return '';
  const upper = code.toUpperCase();
  if (!FLAG_NAMES[upper]) return ''; // only real ISO codes get flags
  const A = 0x1f1e6;
  const first = upper.charCodeAt(0) - 65;
  const second = upper.charCodeAt(1) - 65;
  if (first < 0 || first > 25 || second < 0 || second > 25) return '';
  return String.fromCodePoint(A + first, A + second);
}

module.exports = {
  detectCountry,
  codeFromFlag,
  stripDecoration,
  normalizeCountryKey,
  flagFor,
  FLAG_NAMES,
};