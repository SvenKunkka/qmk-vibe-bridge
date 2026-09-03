/**
 * Device states (round-15). The status ladder is monotone in information:
 * hardware-detected -> transport-available -> protocol-identified ->
 * capabilities-known -> limited | ready, with terminal states
 * unsupported / permission-denied / disconnected / error.
 */

export type DeviceStatus =
  | 'hardware-detected'
  | 'transport-available'
  | 'protocol-identified'
  | 'capabilities-known'
  | 'limited'
  | 'ready'
  | 'unsupported'
  | 'permission-denied'
  | 'disconnected'
  | 'error';

export const DEVICE_STATUSES: DeviceStatus[] = [
  'hardware-detected',
  'transport-available',
  'protocol-identified',
  'capabilities-known',
  'limited',
  'ready',
  'unsupported',
  'permission-denied',
  'disconnected',
  'error',
];

/** Whether a status allows any write (gate still applies). */
export function statusAllowsWrite(s: DeviceStatus): boolean {
  return s === 'ready' || s === 'limited' || s === 'capabilities-known';
}
