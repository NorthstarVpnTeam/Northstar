'use strict';

/**
 * Server store: holds the current configuration list, the selection, per-server
 * latency results and grouping. Pure in-memory logic (persistence lives in
 * settings-store), so it is easy to unit test.
 */

const { parseDocument } = require('./configuration-parser');

const UNKNOWN_GROUP = 'Unknown';

/** Stable, non-reordering comparison used when auto-sort is off. */
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

class ServerStore {
  constructor() {
    this.servers = [];
    this.selectedId = null;
    this.stats = { received: 0, parsed: 0, rejected: 0, duplicates: 0, unsupported: 0, kept: 0 };
    this.errors = [];
    this.source = '';
    this.fetchedAt = 0;
    /** id -> { ms, kind, at, ok } */
    this.latency = new Map();
  }

  /** Replaces the whole list from a document. Returns ingest stats. */
  loadDocument(text, source) {
    const { entries, stats, errors } = parseDocument(text);
    this.servers = entries;
    this.stats = stats;
    this.errors = errors.slice(0, 200);
    this.source = source || '';
    this.fetchedAt = Date.now();
    // Keep latency results only for servers that still exist.
    const ids = new Set(entries.map((e) => e.id));
    for (const key of [...this.latency.keys()]) {
      if (!ids.has(key)) this.latency.delete(key);
    }
    if (this.selectedId && !ids.has(this.selectedId)) this.selectedId = null;
    return stats;
  }

  get count() {
    return this.servers.length;
  }

  get(id) {
    return this.servers.find((s) => s.id === id) || null;
  }

  select(id) {
    if (id !== null && !this.get(id)) return false;
    this.selectedId = id;
    return true;
  }

  setLatency(id, result) {
    if (!this.get(id)) return false;
    this.latency.set(id, result);
    return true;
  }

  getLatency(id) {
    return this.latency.get(id) || null;
  }

  clearLatency() {
    this.latency.clear();
  }

  clear() {
    this.servers = [];
    this.stats = { received: 0, parsed: 0, rejected: 0, duplicates: 0, unsupported: 0, kept: 0 };
    this.errors = [];
    this.latency.clear();
    this.selectedId = null;
    this.fetchedAt = 0;
    this.source = '';
  }

  /**
   * Returns server rows enriched with latency, ready for the renderer.
   * Never includes `raw` (full configuration URI) or credentials.
   */
  listRows() {
    return this.servers.map((s) => {
      const l = this.latency.get(s.id);
      return {
        id: s.id,
        protocol: s.protocol,
        label: s.label,
        country: s.country || UNKNOWN_GROUP,
        countryCode: s.countryCode || null,
        flag: s.flag || '',
        host: s.host,
        port: s.port,
        security: s.security,
        network: s.network,
        selected: s.id === this.selectedId,
        latency: l ? l.ms : null,
        latencyKind: l ? l.kind : null,
        latencyOk: l ? Boolean(l.ok) : null,
        latencyAt: l ? l.at : null,
      };
    });
  }

  /**
   * Groups rows by country. Each group is sorted alphabetically; callers apply
   * latency sorting on top when enabled.
   * @param {{sort?: 'latency'|'name'|'country'|'protocol', hideFailed?: boolean}} options
   */
  groups(options = {}) {
    const rows = this.listRows();
    const filtered = options.hideFailed
      ? rows.filter((r) => r.latencyOk === null || r.latencyOk === true)
      : rows;

    const byCountry = new Map();
    for (const row of filtered) {
      const key = row.country || UNKNOWN_GROUP;
      if (!byCountry.has(key)) {
        byCountry.set(key, {
          name: key,
          flag: row.flag || (key === UNKNOWN_GROUP ? '🌐' : ''),
          code: row.countryCode || null,
          servers: [],
        });
      }
      const group = byCountry.get(key);
      if (!group.flag && row.flag) group.flag = row.flag;
      group.servers.push(row);
    }

    const sortMode = options.sort || 'name';
    const latencyOf = (r) => (r.latency === null || r.latency === undefined ? Infinity : r.latency);

    for (const group of byCountry.values()) {
      group.servers.sort((a, b) => {
        switch (sortMode) {
          case 'latency': {
            const la = latencyOf(a);
            const lb = latencyOf(b);
            if (la !== lb) return la - lb;
            return naturalCompare(a.label, b.label);
          }
          case 'protocol':
            return naturalCompare(a.protocol, b.protocol) || naturalCompare(a.label, b.label);
          case 'country':
            return naturalCompare(a.label, b.label);
          case 'name':
          default:
            return naturalCompare(a.label, b.label);
        }
      });
      group.count = group.servers.length;
      group.measured = group.servers.filter((s) => s.latencyOk === true).length;
    }

    const groups = [...byCountry.values()];
    groups.sort((a, b) => {
      if (a.name === UNKNOWN_GROUP) return 1;
      if (b.name === UNKNOWN_GROUP) return -1;
      return naturalCompare(a.name, b.name);
    });
    return groups;
  }

  /**
   * Client-side filtering used by the server browser.
   * @param {{query?:string, protocol?:string, status?:'all'|'ok'|'failed'|'untested'}} filter
   */
  search(filter = {}) {
    const query = (filter.query || '').trim().toLowerCase();
    const protocol = filter.protocol || 'all';
    const status = filter.status || 'all';

    return this.listRows().filter((row) => {
      if (protocol !== 'all' && row.protocol !== protocol) return false;
      if (status === 'ok' && row.latencyOk !== true) return false;
      if (status === 'failed' && row.latencyOk !== false) return false;
      if (status === 'untested' && row.latencyOk !== null) return false;
      if (status === 'selected' && !row.selected) return false;
      if (!query) return true;
      return (
        row.label.toLowerCase().includes(query) ||
        String(row.country).toLowerCase().includes(query) ||
        row.protocol.toLowerCase().includes(query)
      );
    });
  }

  /** Top-level ingest metadata for the UI (no credentials). */
  meta() {
    return {
      source: this.source,
      fetchedAt: this.fetchedAt,
      stats: { ...this.stats },
      errorCount: this.errors.length,
      errors: this.errors.slice(0, 50),
    };
  }
}

module.exports = { ServerStore, UNKNOWN_GROUP };