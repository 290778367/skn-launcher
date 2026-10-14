/**
 * Every location this app may write to, resolved in exactly one place.
 *
 * The rule: all of it lives under a single directory next to the app
 * executable - never %APPDATA%, %LOCALAPPDATA%, %TEMP% or anything else on a
 * different drive. The launcher stub creates that directory (hidden) and
 * unpacks the app into it; this module then points Electron's own paths
 * (profile, temp, crash dumps, logs) inside it so Chromium cannot scatter
 * files either.
 *
 * Pure functions only - no Electron, no I/O - so tools/paths-test.mjs can prove
 * the rule without starting the app.
 */
const path = require('node:path');

/** Folder the stub unpacks into; also the folder a plain folder build uses. */
const RUNTIME_FOLDER = 'SKN 键盘驱动';

/** Dev-only root, so a checkout never writes to the user profile either. */
const DEV_FOLDER = '.dev';

/**
 * @param {string} root directory that holds the app
 * @returns {{root: string, data: string, temp: string, crashDumps: string, logs: string}}
 */
function layoutFromRoot(root) {
  return {
    root,
    data: path.join(root, 'data'),
    temp: path.join(root, 'temp'),
    crashDumps: path.join(root, 'crash'),
    logs: path.join(root, 'logs'),
  };
}

/** Layout for a packaged app: <exe folder>\... */
function layout(exePath) {
  return layoutFromRoot(path.dirname(exePath));
}

/** Layout for a dev checkout: <project>\.dev\... */
function devLayout(projectRoot) {
  return layoutFromRoot(path.join(projectRoot, DEV_FOLDER));
}

/** Volume a path lives on, e.g. "d:\" - the only thing that must match. */
function volumeOf(target) {
  return path.parse(path.resolve(target)).root.toLowerCase();
}

/**
 * True when every directory sits on the same volume as the app itself. The app
 * is allowed to write next to itself and nowhere else; if this is ever false,
 * something silently moved a path to another drive.
 */
function staysOnAppVolume(dirs, exePath) {
  const volume = volumeOf(exePath);
  return Object.values(dirs).every((dir) => volumeOf(dir) === volume);
}

/** Absolute paths that must never appear, whatever the exe location. */
const FORBIDDEN_FRAGMENTS = ['AppData', 'Application Data'];

/** True when none of the directories names an OS-level scattered location. */
function avoidsSystemLocations(dirs) {
  return Object.values(dirs).every(
    (dir) => !FORBIDDEN_FRAGMENTS.some((fragment) => path.resolve(dir).includes(fragment)),
  );
}

module.exports = {
  RUNTIME_FOLDER,
  DEV_FOLDER,
  layoutFromRoot,
  layout,
  devLayout,
  volumeOf,
  staysOnAppVolume,
  avoidsSystemLocations,
};