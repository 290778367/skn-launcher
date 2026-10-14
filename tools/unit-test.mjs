/**
 * Headless unit tests for the pure logic (no Electron needed):
 * device scoring for HID selection, and the paired-device store.
 * Run: node tools/unit-test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { scoreDevice, DeviceStore, describe } = require('../src/devices.js');

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

const via = (deviceId = 'via-1') => ({
  deviceId,
  vendorId: 0x3434,
  productId: 0xd028,
  name: 'SKN Keyboard',
  serialNumber: '',
  collections: [
    { usagePage: 0x01, usage: 0x06 }, // boot keyboard
    { usagePage: 0xff60, usage: 0x61 }, // VIA raw HID
  ],
});

const bootOnly = () => ({
  deviceId: 'boot-1',
  vendorId: 0x046d,
  productId: 0xc31c,
  name: 'Plain USB Keyboard',
  collections: [{ usagePage: 0x01, usage: 0x06 }],
});

const vendorC1 = () => ({
  deviceId: 'c1-1',
  vendorId: 0x3434,
  productId: 0xd030,
  name: 'SKN 2.4G Dongle',
  collections: [{ usagePage: 0xffc1, usage: 0x01 }],
});

console.log('scoreDevice');
const sVia = scoreDevice(via());
const sBoot = scoreDevice(bootOnly());
const sC1 = scoreDevice(vendorC1());
check('VIA raw-HID interface scores highest', sVia > 0 && sVia > sC1, `(via=${sVia}, c1=${sC1})`);
check('0xFFC1 dongle is recognised', sC1 > 0, `(c1=${sC1})`);
check('plain keyboard scores 0 (never auto-picked)', sBoot === 0, `(boot=${sBoot})`);
check('malformed device does not throw', scoreDevice({}) === 0 && scoreDevice(null) === 0);

console.log('describe');
const described = describe(via());
check('describe exposes detection fields', described.vendorId === 0x3434 && described.score === sVia);
check('describe lists usage pages', /FF60/.test(described.usagePages), described.usagePages);

console.log('DeviceStore');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skn-store-'));
const storeFile = path.join(tmpDir, 'paired-devices.json');

const store = new DeviceStore(storeFile);
check('starts empty', store.list().length === 0);
check('unknown device is not known', store.isKnown(via()) === false);

store.remember(via());
check('remembered device is known', store.isKnown(via()) === true);
check('different product is not known', store.isKnown(vendorC1()) === false);
check('persisted to disk', fs.existsSync(storeFile));

const reloaded = new DeviceStore(storeFile);
check('survives a restart', reloaded.isKnown(via()) === true);

reloaded.remember(via());
check('re-remembering does not duplicate', reloaded.list().length === 1, `(len=${reloaded.list().length})`);

// serial-number matching: only compared when both sides have one
const serialStore = new DeviceStore(path.join(tmpDir, 'serial.json'));
const withSerial = { ...via('s-1'), serialNumber: 'ABC123' };
serialStore.remember(withSerial);
check('same serial matches', serialStore.isKnown({ ...withSerial, deviceId: 'other' }) === true);
check('different serial does not match', serialStore.isKnown({ ...withSerial, serialNumber: 'ZZZ' }) === false);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);