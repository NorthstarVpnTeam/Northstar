'use strict';

/**
 * Generates a proxy-core (Xray-compatible) configuration object from a
 * normalized server entry.
 *
 * The generated document is written to a private temp file and passed to the
 * core with `spawn(..., ['-c', file])` — never interpolated into a shell.
 *
 * Supported: vless, vmess, trojan, shadowsocks, socks, http.
 * Unsupported transports/security combinations throw ConfigError so the caller
 * can report an honest failure instead of launching a broken core.
 */

class ConfigError extends Error {
  constructor(message, code = 'config-invalid') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const SUPPORTED_TRANSPORTS = new Set(['tcp', 'ws', 'grpc', 'http', 'h2', 'xhttp', 'kcp', 'quic']);
const SUPPORTED_SECURITY = new Set(['none', 'tls', 'reality']);

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('Server port is invalid.');
  }
}

function buildStreamSettings(entry) {
  const network = (entry.network || 'tcp').toLowerCase();
  const security = (entry.security || 'none').toLowerCase();

  if (!SUPPORTED_TRANSPORTS.has(network)) {
    throw new ConfigError(`Transport "${network}" is not supported by this build.`, 'unsupported-transport');
  }
  if (!SUPPORTED_SECURITY.has(security)) {
    throw new ConfigError(`Security "${security}" is not supported.`, 'unsupported-security');
  }

  const stream = { network: network === 'h2' ? 'http' : network === 'xhttp' ? 'xhttp' : network };

  if (security === 'tls') {
    const extra = entry.extra || {};
    stream.security = 'tls';
    stream.tlsSettings = {
      serverName: entry.sni || entry.host,
      allowInsecure: Boolean(extra.allowInsecure),
      ...(extra.alpn ? { alpn: extra.alpn.split(',').filter(Boolean) } : {}),
      ...(extra.fp ? { fingerprint: extra.fp } : {}),
    };
  } else if (security === 'reality') {
    const extra = entry.extra || {};
    if (!extra.pbk) {
      throw new ConfigError('Reality security requires a public key (pbk).', 'missing-pbk');
    }
    stream.security = 'reality';
    stream.realitySettings = {
      serverName: entry.sni || entry.host,
      fingerprint: extra.fp || 'chrome',
      publicKey: extra.pbk,
      shortId: extra.sid || '',
      ...(extra.spiderX ? { spiderX: extra.spiderX } : {}),
    };
  } else {
    stream.security = 'none';
  }

  const extra = entry.extra || {};
  if (network === 'ws') {
    stream.wsSettings = {
      path: extra.path || '/',
      ...(extra.host ? { headers: { Host: extra.host } } : {}),
    };
  } else if (network === 'grpc') {
    stream.grpcSettings = { serviceName: extra.path || extra.serviceName || '' };
  } else if (network === 'http' || network === 'xhttp' || network === 'h2') {
    stream.httpSettings = {
      path: extra.path || '/',
      ...(extra.host ? { host: [extra.host] } : {}),
    };
  } else if (network === 'kcp') {
    stream.kcpSettings = {
      mtu: 1350,
      tti: 20,
      uplinkCapacity: 5,
      downlinkCapacity: 20,
      congestion: false,
      header: { type: extra.headerType && extra.headerType !== 'none' ? extra.headerType : 'none' },
    };
  }

  return stream;
}

function buildOutbound(entry) {
  assertPort(entry.port);
  if (!entry.host) throw new ConfigError('Server address is missing.');

  const extra = entry.extra || {};
  const stream = buildStreamSettings(entry);

  switch (entry.protocol) {
    case 'vless': {
      if (!entry.credential) throw new ConfigError('VLESS id is missing.');
      return {
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: entry.host,
              port: entry.port,
              users: [
                {
                  id: entry.credential,
                  encryption: extra.encryption || 'none',
                  ...(entry.flow ? { flow: entry.flow } : {}),
                },
              ],
            },
          ],
        },
        streamSettings: stream,
      };
    }
    case 'vmess': {
      if (!entry.credential) throw new ConfigError('VMess id is missing.');
      return {
        protocol: 'vmess',
        settings: {
          vnext: [
            {
              address: entry.host,
              port: entry.port,
              users: [
                {
                  id: entry.credential,
                  security: extra.scy && extra.scy !== 'auto' ? extra.scy : 'auto',
                  ...(extra.aid && extra.aid !== '0' ? { alterId: Number(extra.aid) || 0 } : {}),
                },
              ],
            },
          ],
        },
        streamSettings: stream,
      };
    }
    case 'trojan': {
      if (!entry.credential) throw new ConfigError('Trojan password is missing.');
      return {
        protocol: 'trojan',
        settings: {
          servers: [{ address: entry.host, port: entry.port, password: entry.credential }],
        },
        streamSettings: stream,
      };
    }
    case 'ss': {
      if (!entry.credential) throw new ConfigError('Shadowsocks password is missing.');
      if (!extra.cipher) throw new ConfigError('Shadowsocks cipher is missing.');
      const server = {
        address: entry.host,
        port: entry.port,
        method: extra.cipher,
        password: entry.credential,
      };
      if (extra.plugin) {
        server.plugin = extra.plugin;
        server.pluginOpts = extra.pluginOpts || '';
      }
      return { protocol: 'shadowsocks', settings: { servers: [server] }, streamSettings: stream };
    }
    case 'socks': {
      const server = { address: entry.host, port: entry.port };
      if (entry.credential) {
        const [user, ...rest] = String(entry.credential).split(':');
        server.users = [{ user, pass: rest.join(':') }];
      }
      return { protocol: 'socks', settings: { servers: [server] }, streamSettings: stream };
    }
    case 'http': {
      const server = { address: entry.host, port: entry.port };
      if (entry.credential) {
        const [user, ...rest] = String(entry.credential).split(':');
        server.users = [{ user, pass: rest.join(':') }];
      }
      return { protocol: 'http', settings: { servers: [server] }, streamSettings: stream };
    }
    default:
      throw new ConfigError(`Protocol "${entry.protocol}" is not supported.`, 'unsupported-protocol');
  }
}

/**
 * Builds the full core document.
 * @param {object} entry normalized server entry
 * @param {{socksPort:number, httpPort:number, logLevel?:string, dns?:string[], tun?:boolean}} options
 */
function buildCoreConfig(entry, options) {
  if (!entry || typeof entry !== 'object') throw new ConfigError('Server entry is required.');
  const apiPort = options.apiPort ? Number(options.apiPort) : 0;
  if (apiPort && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)) {
    throw new ConfigError('Core API port is invalid.');
  }
  const socksPort = Number(options.socksPort);
  const httpPort = Number(options.httpPort);
  if (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535) {
    throw new ConfigError('Local SOCKS port is invalid.');
  }
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new ConfigError('Local HTTP port is invalid.');
  }
  if (socksPort === httpPort) {
    throw new ConfigError('Local SOCKS and HTTP ports must differ.');
  }

  const outbound = buildOutbound(entry);

  const inbounds = [
    {
      tag: 'socks-in',
      listen: '127.0.0.1',
      port: socksPort,
      protocol: 'socks',
      settings: { udp: false, auth: 'noauth' },
    },
    {
      tag: 'http-in',
      listen: '127.0.0.1',
      port: httpPort,
      protocol: 'http',
      settings: {},
    },
  ];

  // Optional system-wide TUN mode (documented Xray "tun" inbound). It needs
  // administrator rights: creating an interface and installing routes are
  // privileged operations. Without autoSystemRoutingTable the interface would
  // exist but carry no traffic, so both are set together. autoOutboundsInterface
  // keeps the core's own outbound traffic out of the TUN to avoid a routing loop.
  const tunEnabled = Boolean(options.tun);
  if (tunEnabled) {
    inbounds.push({
      tag: 'tun-in',
      protocol: 'tun',
      settings: {
        name: 'northstar0',
        desc: 'Northstar',
        mtu: 1500,
        gateway: ['10.184.0.1/30'],
        autoSystemRoutingTable: ['0.0.0.0/0', '::/0'],
        autoOutboundsInterface: 'auto',
      },
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
        metadataOnly: false,
        routeOnly: false,
      },
    });
  }

  const outbounds = [
    { ...outbound, tag: 'proxy' },
    { protocol: 'freedom', tag: 'direct', settings: {} },
    { protocol: 'blackhole', tag: 'blocked', settings: {} },
  ];

  const rules = [
    { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
    { type: 'field', protocol: ['bittorrent'], outboundTag: 'blocked' },
  ];

  if (tunEnabled) {
    // Explicitly send TUN traffic to the proxy so no config can demote the
    // system-wide route to a direct connection. Private ranges and torrents
    // above still win, so LAN traffic keeps working.
    rules.unshift({ type: 'field', inboundTag: ['tun-in'], outboundTag: 'proxy' });
  }

  const config = {
    log: { loglevel: options.logLevel || 'warning', access: '', error: '' },
    inbounds,
    outbounds,
    routing: {
      domainStrategy: 'UseIP',
      rules,
    },
  };

  // Optional stats API so throughput can be *measured* rather than invented.
  // If querying fails later, throughput is reported as unavailable.
  if (apiPort) {
    config.api = { tag: 'api', services: ['StatsService'] };
    config.stats = {};
    config.policy = {
      levels: {
        '0': {
          statsInboundUplink: true,
          statsInboundDownlink: true,
          statsUserUplink: true,
          statsUserDownlink: true,
        },
      },
    };
    config.inbounds.push({
      tag: 'api-in',
      listen: '127.0.0.1',
      port: apiPort,
      protocol: 'dokodemo-door',
      settings: { network: 'tcp,udp' },
    });
    config.outbounds.push({ protocol: 'freedom', tag: 'api', settings: {} });
    config.routing.rules.unshift({ type: 'field', inboundTag: ['api'], outboundTag: 'api' });
  }

  return config;
}

/** Secrets that must never appear in logs or diagnostics. */
function collectSecrets(entry) {
  const secrets = [];
  if (!entry) return secrets;
  if (entry.credential) secrets.push(String(entry.credential));
  const extra = entry.extra || {};
  for (const key of ['pbk', 'path', 'host']) {
    if (extra[key] && String(extra[key]).length >= 6) secrets.push(String(extra[key]));
  }
  if (entry.sni && entry.sni !== entry.host) secrets.push(String(entry.sni));
  return secrets.filter((s, i, arr) => s && arr.indexOf(s) === i);
}

/** Replaces every known secret in a text chunk with a redaction marker. */
function redact(text, secrets) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const secret of secrets || []) {
    if (secret && secret.length >= 4) out = out.split(String(secret)).join('[redacted]');
  }
  // Defence in depth: mask anything that looks like a credential URI.
  out = out.replace(/\b(?:vless|vmess|trojan|ss|socks5?):\/\/\S+/gi, '[redacted-uri]');
  return out;
}

module.exports = {
  buildCoreConfig,
  buildOutbound,
  buildStreamSettings,
  collectSecrets,
  redact,
  ConfigError,
};