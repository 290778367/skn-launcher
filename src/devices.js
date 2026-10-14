'use strict';

/**
 * Paired-device store and HID selection scoring.
 *
 * The launcher asks for HID devices with these top-level collections (taken from
 * its own `navigator.hid.requestDevice` filters):
 *   {usage: 97, usagePage: 65376}  -> 0xFF60 / 0x61  VIA & QMK raw HID (main channel)
 *   {usage: 1,  usagePage: 65473}  -> 0xFFC1 / 0x01
 *   {usage: 1,  usagePage: 65290}  -> 0xFF0A / 0x01
 *   {usage: 1,  usagePage: 140}    -> 0x008C / 0x01  vendor keyboard page
 *
 * Scoring lets us pick the vendor raw-HID interface of a keyboard even when the
 * same keyboard also exposes a boot-keyboard collection, and lets us recognise
 * "the same keyboard again" across restarts.
 */

const fs = require('node:fs');
const path = require('node:path');

const VENDOR_COLLECTIONS = [
  { usagePage: 0xff60, usage: 0x61 }, // most specific: the channel the keymap UI needs
  { usagePage: 0xffc1, usage: 0x01 },
  { usagePage: 0xff0a, usage: 0x01 },
  { usagePage: 0x008c, usage: 0x01 },
];

const VENDOR_PAGES = new Set(VENDOR_COLLECTIONS.map((c) => c.usagePage));

/** Higher is better; 0 means "not a launcher-managed interface". */
function scoreDevice(device) {
  const collections = Array.isArray(device?.collections) ? device.collections : [];
  let best = 0;
  for (const col of collections) {
    const page = col?.usagePage;
    const usage = col?.usage;
    for (let i = 0; i < VENDOR_COLLECTIONS.length; i++) {
      const want = VENDOR_COLLECTIONS[i];
      let s = 0;
      if (page === want.usagePage && usage === want.usage) {
        s = (VENDOR_COLLECTIONS.length - i) * 10; // exact collection match
      } else if (page === want.usagePage) {
        s = 1; // right vendor page, unexpected usage: weak credit
      }
      if (s > best) best = s;
    }
  }
  return best;
}

function deviceKey(device) {
  return `${device?.vendorId}_${device?.productId}`;
}

function describe(device) {
  const pages = (device?.collections || [])
    .map((c) => `0x${Number(c?.usagePage ?? 0).toString(16).toUpperCase()}`)
    .slice(0, 4)
    .join(', ');
  return {
    deviceId: device?.deviceId,
    name: device?.name || `HID ${device?.vendorId?.toString(16)}:${device?.productId?.toString(16)}`,
    vendorId: device?.vendorId,
    productId: device?.productId,
    serialNumber: device?.serialNumber || '',
    usagePages: pages,
    score: scoreDevice(device),
  };
}

class DeviceStore {
  constructor(file, limit = 20) {
    this.file = file;
    this.limit = limit;
    this.devices = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.devices = Array.isArray(raw?.devices) ? raw.devices : [];
    } catch {
      this.devices = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ devices: this.devices }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[devices] could not persist paired devices:', err.message);
    }
  }

  /** Remember a freshly chosen device, most-recent first. */
  remember(device) {
    if (!device) return;
    const entry = {
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber || '',
      name: device.name || '',
      lastSeen: Date.now(),
    };
    const key = deviceKey(device);
    const idx = this.devices.findIndex((d) => deviceKey(d) === key);
    if (idx >= 0) this.devices[idx] = { ...this.devices[idx], ...entry };
    else this.devices.push(entry);
    this.devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    this.devices = this.devices.slice(0, this.limit);
    this.save();
  }

  /**
   * True when this device was granted before. Serial numbers are only compared
   * when both sides have one, because many keyboards report none at all.
   */
  isKnown(device) {
    if (!device) return false;
    const key = deviceKey(device);
    return this.devices.some((d) => {
      if (deviceKey(d) !== key) return false;
      if (!d.serialNumber || !device.serialNumber) return true;
      return d.serialNumber === device.serialNumber;
    });
  }

  list() {
    return this.devices;
  }
}

module.exports = { DeviceStore, scoreDevice, deviceKey, describe, VENDOR_COLLECTIONS, VENDOR_PAGES };