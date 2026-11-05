import type { DeviceDescriptor } from './types.js';

/**
 * Default viewport for new profiles: Safari's logical resolution on a 14-inch MacBook Pro,
 * shared with the `MacBook Pro` device preset below.
 */
export const DEFAULT_VIEWPORT = {
  width: 1512,
  height: 982,
  deviceScaleFactor: 2,
} as const;

export const DEVICES: Record<string, DeviceDescriptor> = {
  'iPhone 14': {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  },
  'iPad': {
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
  },
  'MacBook Pro': {
    width: DEFAULT_VIEWPORT.width,
    height: DEFAULT_VIEWPORT.height,
    deviceScaleFactor: DEFAULT_VIEWPORT.deviceScaleFactor,
    mobile: false,
  },
};

export function getDevice(name: string): DeviceDescriptor | undefined {
  const key = Object.keys(DEVICES).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? DEVICES[key] : undefined;
}

export function listDevices(): string[] {
  return Object.keys(DEVICES);
}

/**
 * Parse a `--window WxH` value for `profiles create` and `profiles edit`, or null when malformed
 * so callers emit their own error.
 */
export function parseWindowSize(raw: string): { width: number; height: number } | null {
  const m = String(raw).match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Parse a `--position X,Y` value. Negative coordinates are valid — a window may
 * sit on a display left of or above the primary one.
 */
export function parseWindowPosition(raw: string): { x: number; y: number } | null {
  const m = String(raw).match(/^(-?\d+),(-?\d+)$/);
  if (!m) return null;
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}
