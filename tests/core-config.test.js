'use strict';

/**
 * Core configuration generation tests: per-protocol outbounds, stream
 * settings, validation errors and secret redaction.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCoreConfig,
  collectSecrets,
  redact,
  ConfigError,
} = require('../src/services/core-config');

const baseEntry = {
  protocol: 'vless',
  host: 'example.com',
  port: 443,
  credential: 'a715374a-a745-4800-889b-0c864fad5ca0',
  security: 'reality',
  network: 'tcp',
  transport: 'tcp',
  sni: 'www.apple.com',
  flow: 'xtls-rprx-vision',
  extra: { pbk: 'PUBLICKEYVALUE', sid: '35d4', fp: 'chrome', encryption: 'none' },
};

const ports = { socksPort: 10808, httpPort: 10809 };

describe('buildCoreConfig', () => {
  test('produces inbounds, outbounds and routing', () => {
    const config = buildCoreConfig(baseEntry, ports);
    assert.equal(config.inbounds.length, 2);
    const socks = config.inbounds.find((i) => i.protocol === 'socks');
    const http = config.inbounds.find((i) => i.protocol === 'http');
    assert.equal(socks.port, 10808);
    assert.equal(socks.listen, '127.0.0.1');
    assert.equal(http.port, 10809);
    assert.equal(config.outbounds[0].protocol, 'vless');
    assert.equal(config.outbounds[0].tag, 'proxy');
    assert.ok(config.routing.rules.length >= 1);
    assert.equal(JSON.stringify(config).includes(baseEntry.credential), true); // config needs it
  });

  test('vless reality stream settings carry serverName, publicKey, flow', () => {
    const config = buildCoreConfig(baseEntry, ports);
    const outbound = config.outbounds[0];
    assert.equal(outbound.streamSettings.security, 'reality');
    assert.equal(outbound.streamSettings.realitySettings.serverName, 'www.apple.com');
    assert.equal(outbound.streamSettings.realitySettings.publicKey, 'PUBLICKEYVALUE');
    assert.equal(outbound.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
    assert.equal(outbound.settings.vnext[0].port, 443);
  });

  test('reality without pbk is rejected', () => {
    const entry = { ...baseEntry, extra: { fp: 'chrome' } };
    assert.throws(() => buildCoreConfig(entry, ports), (err) => err instanceof ConfigError);
  });

  test('vmess maps to vnext with security field', () => {
    const config = buildCoreConfig(
      { ...baseEntry, protocol: 'vmess', security: 'tls', network: 'ws', extra: { path: '/ws', aid: '0', scy: 'auto' } },
      ports
    );
    const outbound = config.outbounds[0];
    assert.equal(outbound.protocol, 'vmess');
    assert.equal(outbound.settings.vnext[0].users[0].security, 'auto');
    assert.equal(outbound.streamSettings.network, 'ws');
    assert.equal(outbound.streamSettings.wsSettings.path, '/ws');
    assert.equal(outbound.streamSettings.security, 'tls');
    assert.equal(outbound.streamSettings.tlsSettings.serverName, 'www.apple.com');
  });

  test('trojan maps to servers with password', () => {
    const config = buildCoreConfig(
      { ...baseEntry, protocol: 'trojan', security: 'tls', network: 'ws', credential: 'secretpw', extra: { path: '/x' } },
      ports
    );
    const outbound = config.outbounds[0];
    assert.equal(outbound.protocol, 'trojan');
    assert.equal(outbound.settings.servers[0].password, 'secretpw');
    assert.equal(outbound.settings.servers[0].address, 'example.com');
  });

  test('shadowsocks maps method and password', () => {
    const config = buildCoreConfig(
      { ...baseEntry, protocol: 'ss', security: 'none', credential: 'pw', extra: { cipher: 'aes-128-gcm' } },
      ports
    );
    const server = config.outbounds[0].settings.servers[0];
    assert.equal(server.method, 'aes-128-gcm');
    assert.equal(server.password, 'pw');
    assert.equal(config.outbounds[0].streamSettings.security, 'none');
  });

  test('socks/http outbounds include credentials when present', () => {
    const withCreds = buildCoreConfig(
      { ...baseEntry, protocol: 'socks', security: 'none', credential: 'user:pass', extra: {} },
      ports
    );
    assert.equal(withCreds.outbounds[0].settings.servers[0].users[0].user, 'user');
    assert.equal(withCreds.outbounds[0].settings.servers[0].users[0].pass, 'pass');

    const noCreds = buildCoreConfig(
      { ...baseEntry, protocol: 'http', security: 'none', credential: '', extra: {} },
      ports
    );
    assert.equal(noCreds.outbounds[0].settings.servers[0].users, undefined);
  });

  test('invalid ports are rejected', () => {
    assert.throws(() => buildCoreConfig(baseEntry, { socksPort: 70000, httpPort: 10809 }), ConfigError);
    assert.throws(() => buildCoreConfig(baseEntry, { socksPort: 10808, httpPort: 10808 }), ConfigError);
    assert.throws(() => buildCoreConfig(baseEntry, { socksPort: 'abc', httpPort: 10809 }), ConfigError);
  });

  test('unsupported transport is rejected honestly', () => {
    assert.throws(
      () => buildCoreConfig({ ...baseEntry, network: 'weird-transport' }, ports),
      (err) => err instanceof ConfigError && err.code === 'unsupported-transport'
    );
  });

  test('missing credentials are rejected per protocol', () => {
    for (const protocol of ['vless', 'vmess', 'trojan', 'ss']) {
      assert.throws(
        () => buildCoreConfig({ ...baseEntry, protocol, credential: '', extra: { cipher: 'aes-256-gcm' } }, ports),
        ConfigError,
        `${protocol} should reject empty credentials`
      );
    }
  });

  test('TUN mode adds a tun inbound with routes and sniffing', () => {
    const config = buildCoreConfig(baseEntry, { ...ports, tun: true });
    const tun = config.inbounds.find((i) => i.protocol === 'tun');
    assert.ok(tun, 'tun inbound should exist');
    assert.equal(tun.tag, 'tun-in');
    assert.ok(Array.isArray(tun.settings.gateway) && tun.settings.gateway.length > 0);
    assert.deepEqual(tun.settings.autoSystemRoutingTable, ['0.0.0.0/0', '::/0']);
    assert.equal(tun.settings.autoOutboundsInterface, 'auto'); // avoids routing loops
    assert.equal(tun.sniffing.enabled, true);

    const tunRule = config.routing.rules.find((r) => r.inboundTag && r.inboundTag.includes('tun-in'));
    assert.ok(tunRule, 'TUN traffic must be routed explicitly');
    assert.equal(tunRule.outboundTag, 'proxy');
    // The TUN inbound never listens on a TCP port.
    assert.equal(tun.port, undefined);
    assert.equal(tun.listen, undefined);
  });

  test('no TUN inbound unless requested', () => {
    const config = buildCoreConfig(baseEntry, ports);
    assert.equal(config.inbounds.find((i) => i.protocol === 'tun'), undefined);
    assert.equal(
      config.routing.rules.some((r) => r.inboundTag && r.inboundTag.includes('tun-in')),
      false
    );
  });

  test('api port option adds stats endpoints', () => {
    const config = buildCoreConfig(baseEntry, { ...ports, apiPort: 10085 });
    assert.ok(config.api);
    assert.ok(config.stats);
    const apiInbound = config.inbounds.find((i) => i.tag === 'api-in');
    assert.equal(apiInbound.port, 10085);
    assert.ok(config.policy.levels['0'].statsInboundDownlink);
  });
});

describe('secret redaction', () => {
  test('collects and masks credentials in log output', () => {
    const secrets = collectSecrets(baseEntry);
    assert.ok(secrets.includes(baseEntry.credential));

    const text = `connect failed for id=${baseEntry.credential} pbk=PUBLICKEYVALUE`;
    const safe = redact(text, secrets);
    assert.ok(!safe.includes(baseEntry.credential));
    assert.ok(!safe.includes('PUBLICKEYVALUE'));
    assert.ok(safe.includes('[redacted]'));
  });

  test('masks any configuration URI that slips into output', () => {
    const safe = redact('oops vless://uuid@1.2.3.4:443#frag leaked', []);
    assert.ok(!safe.includes('vless://'));
    assert.ok(safe.includes('[redacted-uri]'));
  });

  test('redact handles empty input safely', () => {
    assert.equal(redact('', ['x']), '');
    assert.equal(redact(null, ['x']), null);
    assert.equal(redact('unchanged', []), 'unchanged');
  });
});
