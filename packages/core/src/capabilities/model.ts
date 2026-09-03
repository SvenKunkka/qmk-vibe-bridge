/**
 * Capability Model (round-15). The unified capability vocabulary every
 * Protocol Adapter must declare per device. Adapters must return exactly one
 * of the CapabilityState values for each capability id — a protocol that does
 * not define a capability must say `unsupported` or `unknown`, never fake a
 * "supported" state.
 */

export const CAPABILITY_IDS = [
  'read-key-event',
  'read-encoder-event',
  'set-indicator',
  'set-rgb',
  'set-rgb-matrix',
  'set-backlight',
  'display-text',
  'display-icon',
  'haptic',
  'runtime-keymap',
  'approval-input',
  'profile-switch',
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type CapabilityState =
  | 'supported'
  | 'unsupported'
  | 'unknown'
  | 'read-only'
  | 'requires-user-profile'
  | 'requires-optional-extension';

export type CapabilityMap = Record<CapabilityId, CapabilityState>;

export const UNKNOWN_CAPABILITIES: CapabilityMap = {
  'read-key-event': 'unknown',
  'read-encoder-event': 'unknown',
  'set-indicator': 'unknown',
  'set-rgb': 'unknown',
  'set-rgb-matrix': 'unknown',
  'set-backlight': 'unknown',
  'display-text': 'unknown',
  'display-icon': 'unknown',
  'haptic': 'unknown',
  'runtime-keymap': 'unknown',
  'approval-input': 'unknown',
  'profile-switch': 'unknown',
};

/** A protocol that defines none of the capabilities (e.g. bare QMK Raw HID). */
export const NO_CAPABILITIES: CapabilityMap = {
  'read-key-event': 'unsupported',
  'read-encoder-event': 'unsupported',
  'set-indicator': 'unsupported',
  'set-rgb': 'unsupported',
  'set-rgb-matrix': 'unsupported',
  'set-backlight': 'unsupported',
  'display-text': 'unsupported',
  'display-icon': 'unsupported',
  'haptic': 'unsupported',
  'runtime-keymap': 'unsupported',
  'approval-input': 'unsupported',
  'profile-switch': 'unsupported',
};

export function capabilityOf(
  caps: CapabilityMap,
  id: CapabilityId,
): CapabilityState {
  return caps[id] ?? 'unknown';
}

/**
 * An operation the mapping engine wants to perform on a device. It is passed
 * to the Capability Gate; only gate-allowed ops are ever handed to an adapter.
 */
export type CapabilityOpKind =
  | 'set-indicator'
  | 'set-rgb'
  | 'set-rgb-matrix'
  | 'set-backlight'
  | 'display-text'
  | 'display-icon'
  | 'haptic'
  | 'runtime-keymap'
  | 'approval-input'
  | 'profile-switch';

export interface CapabilityOp {
  kind: CapabilityOpKind;
  /** device the op targets */
  deviceId: string;
  /** human description for the UI ("pending operation" panel) */
  label: string;
  /** structured payload, validated per profile before write */
  payload: unknown;
  /** true when the op only reads from the device (never writes) */
  readOnly?: boolean;
}

/** read-key-event / read-encoder-event are read-only by definition. */
export const READ_CAPABILITIES = new Set<CapabilityId>(['read-key-event', 'read-encoder-event']);
