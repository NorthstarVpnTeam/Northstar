'use strict';

/**
 * Settings persistence with validation, corruption tolerance and a change
 * listener. Writes are debounced and atomic (write temp file + rename).
 *
 * Pure Node so it can be unit tested without Electron.
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS } = require('../shared/constants');
const { validateSettingsUpdate, coerceSettings } = require('../shared/validation');

const SETTINGS_FILE = 'settings.json';

class SettingsService {
  /**
   * @param {string} userDataDir directory that holds settings.json
   * @param {{onChanged?:(settings:object)=>void}} [options]
   */
  constructor(userDataDir, options = {}) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, SETTINGS_FILE);
    this.settings = { ...DEFAULT_SETTINGS };
    this.onChanged = options.onChanged || null;
    this._writeTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.settings = coerceSettings(parsed);
    } catch (err) {
      // Corrupted settings: back up the file and fall back to defaults.
      try {
        if (fs.existsSync(this.file)) {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        }
      } catch {
        /* ignore */
      }
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  get() {
    return { ...this.settings };
  }

  /**
   * Applies a partial update. Returns { ok, settings?, error? }.
   * @param {object} patch
   */
  update(patch) {
    const validated = validateSettingsUpdate(patch);
    if (!validated.ok) return { ok: false, error: validated.error };

    const next = { ...this.settings, ...validated.value };
    // Cross-field checks.
    if (next.socksPort === next.httpPort) {
      return { ok: false, error: 'SOCKS and HTTP ports must differ' };
    }
    this.settings = next;
    this._scheduleWrite();
    if (this.onChanged) this.onChanged(this.get());
    return { ok: true, settings: this.get() };
  }

  /** Restores factory defaults. */
  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._scheduleWrite(true);
    if (this.onChanged) this.onChanged(this.get());
    return this.get();
  }

  _scheduleWrite(immediate = false) {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    const delay = immediate ? 0 : 250;
    this._writeTimer = setTimeout(() => this._flush(), delay);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  /** Synchronously persists pending changes (used on app quit). */
  flush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._flush();
  }

  _flush() {
    this._writeTimer = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Never crash the app over a settings write; surface it to the caller.
      this.lastWriteError = err && err.message;
    }
  }
}

module.exports = { SettingsService, SETTINGS_FILE };