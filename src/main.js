'use strict';

/**
 * SKN Launcher — desktop shell around the official web driver
 * (https://launcher.skn.net.cn/#/keymap).
 *
 * The web driver talks to the keyboard over WebHID with the VIA protocol, so the
 * desktop app only has to provide what a browser normally provides:
 *   - HID device selection (auto-picked, no browser chooser),
 *   - persistent device permission, so the keyboard reconnects without prompting,
 *   - an offline cache of the web app, so key remapping keeps working unreachable.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { WebCache, CACHEABLE_HOSTS } = require('./cache');
const { DeviceStore, describe, scoreDevice } = require('./devices');
const { layout, devLayout, staysOnAppVolume, avoidsSystemLocations } = require('./paths');

// Opt-in file log (used by the build self-test): SKN_LOG_FILE=<path>.
const LOG_FILE = process.env.SKN_LOG_FILE || '';
if (LOG_FILE) {
  const write = (level, args) => {
    let line;
    try {
      line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    } catch {
      line = args.map(String).join(' ');
    }
    try {
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} ${line}\n`, 'utf8');
    } catch {
      /* logging must never break the app */
    }
  };
  const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  console.log = (...a) => { write('INFO', a); orig.log(...a); };
  console.warn = (...a) => { write('WARN', a); orig.warn(...a); };
  console.error = (...a) => { write('ERROR', a); orig.error(...a); };
}

const APP_ORIGIN = 'https://launcher.skn.net.cn';
const START_URL = `${APP_ORIGIN}/#/keymap`;
const APP_HOSTS = new Set(CACHEABLE_HOSTS);
const WINDOW_TITLE = 'SKN 键盘驱动';
const APP_ID = 'com.skn.launcher';

// Chromium's WebHID blocklist hides keyboard-like collections; a vendor driver
// needs the vendor raw-HID interface visible.
app.commandLine.appendSwitch('disable-hid-blocklist');
app.setAppUserModelId(APP_ID);

// Nothing may be written outside the app's own runtime folder (see paths.js):
// the browser profile, Chromium's temp files, crash dumps and logs all stay
// beside the executable, on whatever drive the user put it on.
applyUserPaths();

const SELFTEST = process.env.SKN_SELFTEST || '';
const FORCE_OFFLINE = process.env.SKN_FORCE_OFFLINE === '1';

// Build-time diagnostic: try one startup setting at a time without touching the
// shipped defaults. Inert unless SKN_TEST_MODE is set.
const TEST_MODE = process.env.SKN_TEST_MODE || '';
if (TEST_MODE) {
  console.log('[boot] test mode:', TEST_MODE);
  if (TEST_MODE === 'gpu-off') app.disableHardwareAcceleration();
  else if (TEST_MODE === 'gpu-sandbox-off') app.commandLine.appendSwitch('disable-gpu-sandbox');
  else if (TEST_MODE === 'no-sandbox') app.commandLine.appendSwitch('no-sandbox');
  else if (TEST_MODE === 'no-sandbox-in-code') app.commandLine.appendSwitch('no-sandbox');
}

/**
 * Keymap key motion override, loaded once at startup.
 *
 * The official stylesheet gives every keycap `transition: all .1s linear` (and
 * its direction layers `.5s`), so as the layout data arrives the keys visibly
 * settle into place one after another instead of just appearing. motion.css
 * neutralises exactly those rules and nothing else. Set SKN_NO_MOTION=1 to run
 * the official motion untouched.
 */
const MOTION_CSS = process.env.SKN_NO_MOTION === '1'
  ? ''
  : (() => {
      try {
        return fs.readFileSync(path.join(__dirname, 'motion.css'), 'utf8');
      } catch (error) {
        console.error('[motion] cannot read motion.css:', error.message);
        return '';
      }
    })();

const ALLOWED_PERMISSIONS = new Set([
  'hid', 'usb', 'serial',
  'clipboard-read', 'clipboard-sanitized-write',
  'fullscreen', 'pointerLock',
]);

let mainWindow = null;
let chooserWindow = null;
let chooserResolve = null;
let chooserPool = [];
let cache = null;
let deviceStore = null;
let ses = null;

/* ------------------------------------------------------------------ helpers */

/**
 * Point Electron's own paths at the runtime folder the launcher stub unpacked
 * into. This is what keeps %APPDATA%, %LOCALAPPDATA% and %TEMP% untouched:
 * userData covers the whole Chromium profile (Cache, GPUCache, IndexedDB,
 * Local Storage, ...), and temp / crashDumps / logs are redirected separately
 * because Chromium would otherwise use the system locations for them.
 */
function applyUserPaths() {
  const dirs = app.isPackaged ? layout(process.execPath) : devLayout(app.getAppPath());

  try {
    for (const dir of [dirs.data, dirs.temp, dirs.crashDumps, dirs.logs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    app.setPath('userData', dirs.data);
    app.setPath('temp', dirs.temp);
    app.setPath('crashDumps', dirs.crashDumps);
    if (typeof app.setAppLogsPath === 'function') app.setAppLogsPath(dirs.logs);
    console.log(
      '[boot] runtime folder:', dirs.root,
      '| same volume as the exe:', staysOnAppVolume(dirs, process.execPath),
      '| avoids system locations:', avoidsSystemLocations(dirs),
    );
  } catch (err) {
    console.error('[boot] cannot prepare the runtime folder:', err.message);
  }
}

const isAppUrl = (url) => {
  try {
    return APP_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

function assetPath(...parts) {
  return path.join(__dirname, 'assets', ...parts);
}

function windowIcon() {
  const png = assetPath('icon.png');
  const ico = assetPath('icon.ico');
  try {
    if (fs.existsSync(png)) return nativeImage.createFromPath(png);
    if (fs.existsSync(ico)) return nativeImage.createFromPath(ico);
  } catch {
    /* icon is cosmetic */
  }
  return undefined;
}

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* first run */
  }
  return { width: 1500, height: 940, maximized: false };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2),
      'utf8'
    );
  } catch {
    /* not important */
  }
}

/* -------------------------------------------------------------- HID devices */

/**
 * Decide which HID device to hand to the page when it calls requestDevice.
 * Preference order: an already paired keyboard, then a single unambiguous
 * keyboard, then ask the user (several different keyboards plugged in).
 */
function chooseHidDevice(details, callback) {
  const visible = Array.isArray(details?.deviceList) ? details.deviceList.slice() : [];
  const ranked = visible
    .map((device) => ({ device, score: scoreDevice(device) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.device);
  const pool = ranked.length ? ranked : visible;

  console.log(`[hid] requestDevice: ${visible.length} visible, ${pool.length} candidate(s)`);
  for (const device of pool) console.log('[hid]   candidate', JSON.stringify(describe(device)));

  if (!pool.length) {
    console.warn('[hid] no candidate device — is the keyboard plugged in?');
    callback('');
    return;
  }

  const known = pool.find((device) => deviceStore.isKnown(device));
  if (known) {
    console.log('[hid] auto-connecting paired device:', describe(known).name);
    deviceStore.remember(known);
    callback(known.deviceId);
    return;
  }

  const distinctModels = new Set(pool.map((d) => `${d.vendorId}_${d.productId}`));
  if (distinctModels.size === 1) {
    console.log('[hid] single keyboard model present — auto-connecting');
    deviceStore.remember(pool[0]);
    callback(pool[0].deviceId);
    return;
  }

  if (chooserWindow && !chooserWindow.isDestroyed()) {
    console.warn('[hid] device chooser already open; ignoring concurrent request');
    callback('');
    return;
  }

  console.log('[hid] several keyboards present — asking the user');
  promptForDevice(pool).then((deviceId) => callback(deviceId || ''));
}

function promptForDevice(pool) {
  chooserPool = pool.slice();
  return new Promise((resolve) => {
    chooserResolve = resolve;

    chooserWindow = new BrowserWindow({
      width: 520,
      height: 460,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '选择要连接的键盘',
      parent: mainWindow || undefined,
      icon: windowIcon(),
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'chooser-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    chooserWindow.setMenuBarVisibility(false);
    chooserWindow.loadFile(path.join(__dirname, 'chooser.html'));
    chooserWindow.webContents.once('did-finish-load', sendChooserDevices);
    // Closing the window by any route (X button, Alt+F4) counts as "cancelled".
    chooserWindow.on('closed', () => settleChooser(''));
  });
}

/**
 * Finish a pending selection exactly once. Idempotent, because the window's
 * "closed" event also fires when we destroy it here.
 */
function settleChooser(deviceId) {
  const resolve = chooserResolve;
  chooserResolve = null;
  const win = chooserWindow;
  chooserWindow = null;
  chooserPool = [];
  if (win && !win.isDestroyed()) win.destroy();
  if (resolve) resolve(deviceId || '');
}

function sendChooserDevices() {
  if (!chooserWindow || chooserWindow.isDestroyed()) return;
  chooserWindow.webContents.send(
    'chooser:devices',
    chooserPool.map((device) => ({ ...describe(device), deviceId: device.deviceId }))
  );
}

function registerHid(session_) {
  session_.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  session_.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  // Remembers devices across restarts: the page can open a paired keyboard
  // without going through the picker again.
  session_.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'hid') return false;
    if (details.origin && !isAppUrl(details.origin)) return false;
    const known = deviceStore.isKnown(details.device);
    if (known) console.log('[hid] permission auto-granted for paired device:', describe(details.device).name);
    return known;
  });

  session_.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    chooseHidDevice(details, callback);
  });

  // The page also probes WebUSB / WebSerial for some models; answer instead of
  // letting the request hang forever.
  session_.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const list = details?.deviceList || [];
    const distinct = new Set(list.map((d) => `${d.vendorId}_${d.productId}`));
    callback(list.length && distinct.size === 1 ? list[0].deviceId : '');
  });

  session_.on('select-serial-port', (event, portList, _wc, callback) => {
    if (typeof _wc === 'function') {
      // older signature: (event, portList, callback)
      event.preventDefault();
      _wc('');
      return;
    }
    event.preventDefault();
    const list = Array.isArray(portList) ? portList : [];
    callback(list.length === 1 ? list[0].portId : '');
  });

  // Only fire while a selection is pending: keep the chooser list live.
  session_.on('hid-device-added', (_event, device) => {
    if (!chooserWindow || chooserWindow.isDestroyed()) return;
    if (scoreDevice(device) > 0 && !chooserPool.some((d) => d.deviceId === device.deviceId)) {
      chooserPool.push(device);
      sendChooserDevices();
    }
  });
}

/* ------------------------------------------------------------ window & menu */

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 640,
    title: WINDOW_TITLE,
    icon: windowIcon(),
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  if (state.maximized) mainWindow.maximize();

  const wc = mainWindow.webContents;

  // Re-injected per document (so a reload keeps it); SPA route changes reuse the
  // same document and therefore keep the override in place.
  if (MOTION_CSS) {
    wc.on('dom-ready', () => {
      wc.insertCSS(MOTION_CSS).catch((error) => {
        console.error('[motion] insertCSS failed:', error.message);
      });
    });
  }

  wc.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(WINDOW_TITLE);
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  wc.on('render-process-gone', (_event, details) => {
    console.error('[window] renderer gone:', details.reason);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => saveWindowState(mainWindow));

  mainWindow.loadURL(START_URL);

  if (SELFTEST) runSelfTest(wc);
}

/**
 * Headless verification used while building the app: reports what actually
 * rendered, whether WebHID is exposed, and whether the cache served the page.
 * Enabled only through SKN_SELFTEST, so it can never run for real users.
 */
function runSelfTest(wc) {
  const report = { offline: FORCE_OFFLINE, mode: SELFTEST };

  const finish = async () => {
    try {
      report.page = await wc.executeJavaScript(`(async () => {
        let hidDevices = -1;
        try { hidDevices = (await navigator.hid.getDevices()).length; } catch (e) { hidDevices = 'error: ' + e.message; }
        // Direct proof that the offline cache served this app shell.
        let cacheProof = null;
        try {
          const r = await fetch('/', { cache: 'no-store' });
          cacheProof = { status: r.status, fromCache: r.headers.get('x-skn-cache') };
        } catch (e) { cacheProof = { error: e.message }; }
        return {
          url: location.href,
          title: document.title,
          hasHid: 'hid' in navigator,
          hasAppRoot: !!document.querySelector('app-root'),
          childNodes: document.querySelector('app-root') ? document.querySelector('app-root').childElementCount : -1,
          hidDevices,
          cacheProof,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
        };
      })()`);
    } catch (err) {
      report.pageError = err.message;
    }

    if (SELFTEST === 'full') {
      try {
        report.hidProbe = await wc.executeJavaScript(`(async () => {
          try {
            const picked = await navigator.hid.requestDevice({
              filters: [
                { usage: 97, usagePage: 65376 },
                { usage: 1, usagePage: 140 },
                { usage: 1, usagePage: 65473 },
                { usage: 1, usagePage: 65290 },
              ],
            });
            return { selected: picked.map((d) => d.productName || d.productId) };
          } catch (e) { return { error: e.message }; }
        })()`);
      } catch (err) {
        report.hidProbeError = err.message;
      }
    }

    try {
      report.cache = await cache.summary();
    } catch (err) {
      report.cacheError = err.message;
    }

    console.log('[selftest] ' + JSON.stringify(report));
    const outFile = process.env.SKN_SELFTEST_OUT;
    if (outFile) {
      try {
        fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
      } catch (err) {
        console.error('[selftest] could not write report:', err.message);
      }
    }
    setTimeout(() => app.exit(0), 250);
  };

  wc.once('did-finish-load', () => setTimeout(finish, SELFTEST === 'full' ? 9000 : 1500));
  wc.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    report.loadError = { errorCode, errorDescription, validatedURL };
    finish();
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新载入界面', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        {
          label: '检查更新（清空离线缓存后重载）',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => forceUpdate(),
        },
        { type: 'separator' },
        { label: '忘记已配对键盘', click: () => forgetDevices() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开 SKN 驱动官网', click: () => shell.openExternal(APP_ORIGIN).catch(() => {}) },
        { label: '离线缓存状态', click: () => showCacheStatus() },
        { label: '关于', click: () => showAbout() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function forceUpdate() {
  await cache?.clear();
  await ses?.clearCache();
  if (ses) await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  mainWindow?.webContents.reloadIgnoringCache();
}

function forgetDevices() {
  const devices = deviceStore.list();
  if (!devices.length) {
    dialog.showMessageBox(mainWindow, { type: 'info', title: 'SKN 键盘驱动', message: '当前没有记住任何键盘。' });
    return;
  }
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['取消', '忘记全部'],
    defaultId: 0,
    cancelId: 0,
    title: 'SKN 键盘驱动',
    message: `已记住 ${devices.length} 个键盘`,
    detail: devices.map((d) => `· ${d.name || `${d.vendorId}:${d.productId}`}`).join('\n'),
  });
  if (choice !== 1) return;
  deviceStore.devices = [];
  deviceStore.save();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'SKN 键盘驱动',
    message: '已清除记录。下次连接时请重新选择键盘。',
  });
}

async function showCacheStatus() {
  const s = await cache.summary();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'SKN 键盘驱动',
    message: s.entries ? `离线缓存：${s.entries} 个文件，约 ${s.megabytes} MB` : '离线缓存为空。',
    detail:
      `命中 ${s.hits} 次 / 未命中 ${s.misses} 次 / 写入 ${s.stored} 次\n` +
      `离线兜底 ${s.offlineFallbacks} 次\n\n` +
      `缓存目录：${path.join(app.getPath('userData'), 'webcache')}`,
  });
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于',
    message: `${WINDOW_TITLE} ${app.getVersion()}`,
    detail:
      `官方网页驱动 launcher.skn.net.cn 的桌面外壳。\n` +
      `键盘通信：WebHID（VIA 协议），由应用内 Chromium 直接完成，不经过网络。\n` +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: ['确定'],
  });
}

/* --------------------------------------------------------------------- boot */

async function registerCache(session_) {
  cache = new WebCache(path.join(app.getPath('userData'), 'webcache'));
  await cache.init();
  cache.setOfflinePage(path.join(__dirname, 'offline.html'));
  try {
    session_.protocol.handle('https', (request) => cache.handle(request));
    console.log('[cache] offline cache active');
  } catch (err) {
    console.warn('[cache] could not intercept https — running online-only:', err.message);
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    ses = session.defaultSession;
    deviceStore = new DeviceStore(path.join(app.getPath('userData'), 'paired-devices.json'));

    await registerCache(ses);
    registerHid(ses);
    buildMenu();
    createWindow();

    ipcMain.on('chooser:ready', () => sendChooserDevices());

    ipcMain.on('chooser:pick', (_event, deviceId) => {
      const chosen = chooserPool.find((d) => d.deviceId === deviceId);
      if (chosen) {
        deviceStore.remember(chosen);
        console.log('[hid] user selected:', describe(chosen).name);
      }
      settleChooser(deviceId);
    });

    ipcMain.on('chooser:cancel', () => settleChooser(''));
  });

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}