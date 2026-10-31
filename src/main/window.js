'use strict';

/**
 * BrowserWindow construction with Electron security best practices:
 * context isolation on, renderer Node integration off, sandbox on,
 * webview tag off, navigation and window-open restricted to http(s).
 *
 * The window is frameless: the renderer draws a macOS-style titlebar with
 * traffic-light controls (see index.html / styles.css), which talk to the
 * main process over allowlisted IPC channels.
 */

const path = require('path');
const { BrowserWindow, shell } = require('electron');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

/**
 * @param {object} [options]
 * @param {boolean} [options.devTools]
 * @returns {BrowserWindow}
 */
function createMainWindow(options = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    show: false,
    // Frameless so the renderer can draw the traffic-light titlebar.
    frame: false,
    // Keeps standard window behaviour on Windows: edge resizing and snapping.
    thickFrame: true,
    backgroundColor: '#f5f5f7',
    title: 'Northstar V2Ray',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: options.devTools === true,
    },
  });

  win.loadFile(path.join(RENDERER_DIR, 'index.html'));

  win.once('ready-to-show', () => win.show());

  // Block navigation away from the app document.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed urls */
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const isAppFile = url.startsWith('file://');
    if (!isAppFile) event.preventDefault();
  });

  return win;
}

module.exports = { createMainWindow };
