'use strict';

/**
 * Configuration parser tests: valid entries, malformed entries, missing
 * fields, URL-encoded names, unusual characters, deduplication and stats.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseConfig,
  parseDocument,
  ParseError,
} = require('../src/services/configuration-parser');

const VLESS =
  'vless://a715374a-a745-4800-889b-0c864fad5ca0@212.103.62.233:443?security=reality&encryption=none&pbk=d9PiZnm10DBNrlT1ixDCgEk0iU1Hv8Jk1xEI4-Oe6jU&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=www.apple.com&sid=35d45334668b3ac5#%F0%9F%87%BA%F0%9F%87%B8%20United%20States%20001';

// VMess fixtures are built programmatically so the base64 payload is exact.
const VMESS_OBJECT = {
  v: '2',
  ps: '\u{1F1FA}\u{1F1F8} United States 781',
  add: '47.88.79.34',
  port: '443',
  id: '9b31490d-190e-4e1e-af0a-72cab43e7c3b',
  aid: '0',
  scy: 'auto',
  net: 'ws',
  type: '',
  host: 'rib9jxayoqjgn2kw.v.3dns.vip',
  path: '/ws-vmess',
  tls: 'tls',
  sni: 'rib9jxayoqjgn2kw.v.3dns.vip',
};
const VMESS =
  'vmess://' + Buffer.from(JSON.stringify(VMESS_OBJECT)).toString('base64');
const VMESS_BASE64URL =
  'vmess://' + Buffer.from(JSON.stringify(VMESS_OBJECT)).toString('base64url');

const TROJAN =
  'trojan://humanity@188.114.98.0:443?path=%2Fassignment&security=tls&alpn=http%2F1.1&insecure=0&host=www.calmlunch.com&fp=chrome&type=ws&sni=www.calmlunch.com#%F0%9F%87%A8%F0%9F%87%A6%20Canada%20794';

const SS =
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@192.168.100.1:8888#%F0%9F%87%AF%F0%9F%87%B5%20Japan%20010';

const SOCKS = 'socks://user:pass@10.0.0.1:1080#My%20SOCKS%20Server';
const HTTP = 'http://10.0.0.2:8080#Plain%20HTTP';

describe('parseConfig — valid entries', () => {
  test('parses a VLESS reality link with a flag fragment', () => {
    const entry = parseConfig(VLESS);
    assert.equal(entry.protocol, 'vless');
    assert.equal(entry.host, '212.103.62.233');
    assert.equal(entry.port, 443);
    assert.equal(entry.security, 'reality');
    assert.equal(entry.network, 'tcp');
    assert.equal(entry.flow, 'xtls-rprx-vision');
    assert.equal(entry.sni, 'www.apple.com');
    assert.equal(entry.credential, 'a715374a-a745-4800-889b-0c864fad5ca0');
    assert.equal(entry.label, 'United States 01');
    assert.equal(entry.country, 'United States');
    assert.equal(entry.flag, '🇺🇸');
    assert.ok(entry.id.startsWith('s_'));
    assert.equal(entry.raw, VLESS);
  });

  test('parses a base64 VMess link', () => {
    const entry = parseConfig(VMESS);
    assert.equal(entry.protocol, 'vmess');
    assert.equal(entry.host, '47.88.79.34');
    assert.equal(entry.port, 443);
    assert.equal(entry.network, 'ws');
    assert.equal(entry.security, 'tls');
    assert.equal(entry.extra.path, '/ws-vmess');
    assert.equal(entry.sni, 'rib9jxayoqjgn2kw.v.3dns.vip');
    assert.equal(entry.label, 'United States 781');
    assert.equal(entry.country, 'United States');
    assert.equal(entry.credential, '9b31490d-190e-4e1e-af0a-72cab43e7c3b');
  });

  test('parses base64url (unpadded) VMess payloads', () => {
    const entry = parseConfig(VMESS_BASE64URL);
    assert.equal(entry.protocol, 'vmess');
    assert.equal(entry.host, '47.88.79.34');
  });

  test('parses a Trojan ws link with URL-encoded path', () => {
    const entry = parseConfig(TROJAN);
    assert.equal(entry.protocol, 'trojan');
    assert.equal(entry.host, '188.114.98.0');
    assert.equal(entry.port, 443);
    assert.equal(entry.security, 'tls');
    assert.equal(entry.network, 'ws');
    assert.equal(entry.extra.path, '/assignment');
    assert.equal(entry.credential, 'humanity');
    assert.equal(entry.country, 'Canada');
    assert.equal(entry.flag, '🇨🇦');
  });

  test('parses a Shadowsocks link', () => {
    const entry = parseConfig(SS);
    assert.equal(entry.protocol, 'ss');
    assert.equal(entry.host, '192.168.100.1');
    assert.equal(entry.port, 8888);
    assert.equal(entry.extra.cipher, 'aes-256-gcm');
    assert.equal(entry.credential, 'password');
    assert.equal(entry.country, 'Japan');
  });

  test('parses legacy SIP002 ss (base64 userinfo without colon)', () => {
    const entry = parseConfig('ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#Test');
    assert.equal(entry.protocol, 'ss');
    assert.equal(entry.extra.cipher, 'aes-256-gcm');
    assert.equal(entry.credential, 'pass'); // base64("aes-256-gcm:pass")
  });

  test('parses SOCKS and HTTP proxy links with credentials', () => {
    const socks = parseConfig(SOCKS);
    assert.equal(socks.protocol, 'socks');
    assert.equal(socks.host, '10.0.0.1');
    assert.equal(socks.port, 1080);
    assert.equal(socks.credential, 'user:pass');
    assert.equal(socks.label, 'My SOCKS Server');

    const http = parseConfig(HTTP);
    assert.equal(http.protocol, 'http');
    assert.equal(http.port, 8080);
    assert.equal(http.credential, '');
  });

  test('handles a fragment with unusual characters and percent-encoding', () => {
    const entry = parseConfig(`${VLESS.split('#')[0]}#Caf%C3%A9%20%26%20Bar%20007`);
    assert.equal(entry.label, 'Café & Bar 07');
  });

  test('handles no fragment — falls back to protocol + endpoint label', () => {
    const entry = parseConfig('trojan://secret@1.2.3.4:443');
    assert.equal(entry.label, 'TROJAN 1.2.3.4:443');
    assert.equal(entry.country, null);
  });

  test('IPv6 hosts in brackets', () => {
    const entry = parseConfig('trojan://pw@[2001:db8::1]:8443#Test');
    assert.equal(entry.host, '2001:db8::1');
    assert.equal(entry.port, 8443);
  });
});

describe('parseConfig — malformed entries are rejected, never thrown to caller', () => {
  const cases = [
    ['not a uri at all'],
    ['vless://missing-at-sign:443'],
    ['vless://not-a-uuid@1.2.3.4:443'],
    ['vless://uuid@1.2.3.4:99999'],
    ['vless://uuid@:443'],
    ['vless://uuid@'],
    ['vmess://!!!not-base64!!!'],
    ['vmess://' + Buffer.from('{not json}').toString('base64')],
    ['vmess://' + Buffer.from('{"add":"1.2.3.4"}').toString('base64')], // missing port/id
    ['trojan://@1.2.3.4:443'],
    ['trojan://pw@1.2.3.4:notaport'],
    ['ss://noseparator'],
    ['ss://userwithoutmethod@1.2.3.4:8388'],
    ['ss://method@1.2.3.4:8388'], // no password part
    ['socks://[unclosed:1080'],
    [''],
    ['   '],
    ['vless://\nnewlines@1.2.3.4:443'],
    [null],
    [42],
    ['unknownscheme://whatever@1.2.3.4:443'],
    ['hysteria2://whatever@1.2.3.4:443'],
  ];

  for (const [input] of cases) {
    test(`rejects: ${JSON.stringify(input).slice(0, 60)}`, () => {
      assert.throws(() => parseConfig(input), (err) => err instanceof ParseError || err instanceof TypeError);
    });
  }

  test('unsupported schemes are flagged with code "unsupported"', () => {
    try {
      parseConfig('hysteria2://x@1.2.3.4:443');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'unsupported');
    }
  });

  test('parser never leaks the credential into the error message', () => {
    try {
      parseConfig('vless://super-secret-uuid-value@1.2.3.4:99999');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!err.message.includes('super-secret-uuid-value'));
    }
  });
});

describe('parseDocument', () => {
  const doc = [VLESS, '', TROJAN, 'garbage-line', VLESS, SS, 'vmess://bad'].join('\n');

  test('counts received/parsed/rejected/duplicates correctly', () => {
    const { entries, stats, errors } = parseDocument(doc);
    assert.equal(stats.received, 6); // non-empty lines
    assert.equal(stats.parsed, 3); // VLESS, TROJAN, SS
    assert.equal(stats.duplicates, 1); // repeated VLESS
    assert.equal(stats.rejected, 2); // garbage + bad vmess
    assert.equal(stats.unsupported, 0);
    assert.equal(stats.kept, entries.length);
    assert.equal(entries.length, 3);
    assert.equal(errors.length, 2);
    assert.ok(errors.every((e) => typeof e.line === 'number' && e.reason));
  });

  test('does not crash on empty documents', () => {
    const empty = parseDocument('');
    assert.equal(empty.entries.length, 0);
    assert.ok(empty.errors.length > 0);
    const blank = parseDocument('\n\n  \n');
    assert.equal(blank.stats.received, 0);
  });

  test('deduplicates identical endpoints with different fragments', () => {
    const a = 'trojan://pw@1.2.3.4:443#Server%20A';
    const b = 'trojan://pw@1.2.3.4:443#Server%20B';
    const { stats, entries } = parseDocument(`${a}\n${b}`);
    assert.equal(entries.length, 1);
    assert.equal(stats.duplicates, 1);
  });

  test('different credentials on the same endpoint are kept', () => {
    const a = 'trojan://pw1@1.2.3.4:443#A';
    const b = 'trojan://pw2@1.2.3.4:443#B';
    const { entries } = parseDocument(`${a}\n${b}`);
    assert.equal(entries.length, 2);
  });

  test('handles CRLF documents and trailing whitespace', () => {
    const { entries } = parseDocument(`${VLESS}\r\n${SS}  \r\n`);
    assert.equal(entries.length, 2);
  });
});