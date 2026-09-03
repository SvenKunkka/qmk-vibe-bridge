/**
 * Built-in Protocol Profiles (round-15). Each profile cites its official
 * source. Capability states are honest: a protocol that does not define a
 * capability declares `unsupported`; a capability whose availability depends
 * on the user's firmware declares `requires-user-profile` / `unknown`.
 */

import type { CapabilityMap } from '../capabilities/model';
import type { ProtocolProfile } from './types';

export const QMK_RAW_HID_PAGE = 0xff60;
export const QMK_RAW_HID_USAGE = 0x61;
export const QMK_RAW_HID_REPORT_SIZE = 32;

const EVIDENCE_QMK_RAWHID: import('./types').EvidenceSource[] = [
  { url: 'https://docs.qmk.fm/features/rawhid', type: 'official-docs', version: 'master', notes: 'usage 0xFF60/0x61, RAW_EPSIZE=32, raw_hid_receive/send' },
];
const EVIDENCE_VIA: import('./types').EvidenceSource[] = [
  { url: 'https://github.com/qmk/qmk_firmware/blob/master/quantum/via.h', type: 'upstream-source', version: 'master', notes: 'VIA_PROTOCOL_VERSION 0x000D; commands 0x01-0x15; channels 0-5; lighting value ids' },
  { url: 'https://github.com/qmk/qmk_firmware/blob/master/quantum/via.c', type: 'upstream-source', version: 'master', notes: 'wire [cmd, channel, value_id, data]; set 0x07/get 0x08/save 0x09; unhandled 0xFF' },
  { url: 'https://github.com/the-via/app/blob/main/src/utils/keyboard-api.ts', type: 'upstream-source', version: 'main', notes: 'echo validation of command bytes' },
  { url: 'https://www.caniusevia.com/docs/specification', type: 'official-docs', notes: 'definition v3 schema (no lighting property)' },
];
const EVIDENCE_VIAL: import('./types').EvidenceSource[] = [
  { url: 'https://github.com/vial-kb/vial-qmk/blob/master/quantum/vial.h', type: 'upstream-source', version: 'master', notes: 'VIAL_PROTOCOL_VERSION 6; 0xFE prefix; commands 0x00-0x0D' },
  { url: 'https://github.com/vial-kb/vial-qmk/blob/master/quantum/vial.c', type: 'upstream-source', version: 'master', notes: 'fixed 32B packets; get_keyboard_id -> version+UID' },
];
const EVIDENCE_ZMK_STUDIO: import('./types').EvidenceSource[] = [
  { url: 'https://zmk.dev/docs/development/studio-rpc-protocol', type: 'official-docs', version: 'main', notes: 'framing SoF 0xAB/Esc 0xAC/EoF 0xAD; CDC-ACM + GATT UUIDs' },
  { url: 'https://github.com/zmkfirmware/zmk-studio-messages/blob/main/proto/zmk/core.proto', type: 'upstream-source', version: 'main', notes: 'core.Request: get_device_info=1,get_lock_state=2,lock=3,reset_settings=4; NO unlock RPC; lock_state_changed notification' },
  { url: 'https://github.com/zmkfirmware/zmk-studio-messages/blob/main/proto/zmk/keymap.proto', type: 'upstream-source', version: 'main', notes: 'runtime keymap requests' },
];

/** Bare QMK Raw HID: a bidirectional 32-byte transport, NOT a control protocol. */
export const qmkRawHidProfile: ProtocolProfile = {
  schemaVersion: 1,
  profileId: 'qmk-rawhid',
  displayName: 'QMK Raw HID (transport only)',
  protocol: 'qmk-raw-hid',
  protocolVersion: '1.0',
  usagePage: QMK_RAW_HID_PAGE,
  usageId: QMK_RAW_HID_USAGE,
  interface: 'hid-raw',
  reportSize: QMK_RAW_HID_REPORT_SIZE,
  transport: ['usb-hid'],
  capabilities: {
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
  },
  sourceUrl: 'https://docs.qmk.fm/features/rawhid',
  sourceType: 'official-docs',
  evidence: EVIDENCE_QMK_RAWHID,
  safetyPolicy: { activeProbeAllowed: false, confirmationRequiredOnFirstWrite: false, maxWritesPerMinute: 0 },
  responseValidator: 'none',
  verifiedStatus: 'verified-simulator',
  verifiedPlatforms: ['macos'],
  hardwareValidation: { status: 'verified-simulator', platforms: ['macos'] },
  riskLevel: 'none',
  activeProbeAllowed: false, // never probe a bare Raw HID endpoint
  notes: 'QMK Raw HID is only a transport. Detection yields transport-available + capabilities-unknown; zero writes until a verified profile matches.',
};

/**
 * VIA (QMK's VIA firmware feature). Identification requires either a known
 * VID/PID (from the upstream VIA keyboard registry) or an explicit user
 * assignment of this profile — usage 0xFF60/0x61 alone is NOT enough, because
 * every QMK Raw HID keyboard matches those.
 */
export const viaProfile: ProtocolProfile = {
  schemaVersion: 1,
  profileId: 'via',
  displayName: 'VIA',
  protocol: 'via',
  protocolVersion: '0x000D', // VIA_PROTOCOL_VERSION in qmk via.h
  usagePage: QMK_RAW_HID_PAGE,
  usageId: QMK_RAW_HID_USAGE,
  interface: 'hid-raw',
  reportSize: QMK_RAW_HID_REPORT_SIZE,
  transport: ['usb-hid'],
  capabilities: {
    // round-16 (P1-3): declarations match the adapter's implementation. VIA
    // lighting/haptics are NOT implemented (they require a per-keyboard
    // definition/profile for exact channel values) — declared unsupported,
    // never "requires-user-profile" without a handler.
    'read-key-event': 'unsupported', // id_switch_matrix_state NOT implemented
    'read-encoder-event': 'unsupported',
    'set-indicator': 'unknown',
    // round-17 (P4): VIA lighting IS implemented (official channels) but only
    // becomes usable after a bound definition + channel probe — hence
    // requires-user-profile (the adapter HAS handlers for these).
    'set-rgb': 'requires-user-profile', // rgblight channel (2), hue/sat
    'set-rgb-matrix': 'requires-user-profile', // rgb_matrix channel (3), hue/sat
    'set-backlight': 'requires-user-profile', // backlight channel (1), brightness
    'display-text': 'unsupported',
    'display-icon': 'unsupported',
    'haptic': 'unsupported', // not implemented
    'runtime-keymap': 'supported', // dynamic keymap (id_dynamic_keymap_*) — implemented
    'approval-input': 'unsupported',
    'profile-switch': 'unsupported',
  },
  readCommandMapping: {
    'runtime-keymap': { cmd: 0x04, shape: '[layer,row,col] -> keycode u16 BE]' },
    'set-rgb': { get: [0x08, 2, 4], shape: 'hue,sat readback' },
    'set-rgb-matrix': { get: [0x08, 3, 4], shape: 'hue,sat readback' },
    'set-backlight': { get: [0x08, 1, 1], shape: 'brightness 0..255 readback' },
  },
  writeCommandMapping: {
    'runtime-keymap': { cmd: 0x05, shape: '[layer,row,col,keycode hi,keycode lo]' },
    'set-rgb': { set: [0x07, 2, 4], save: [0x09, 2], shape: 'rgblight hue,sat' },
    'set-rgb-matrix': { set: [0x07, 3, 4], save: [0x09, 3], shape: 'rgb_matrix hue,sat' },
    'set-backlight': { set: [0x07, 1, 1], save: [0x09, 1], shape: 'brightness 0..255' },
  },
  payloadValidator: 'builtin',
  responseValidator: 'readback',
  safetyPolicy: { activeProbeAllowed: true, confirmationRequiredOnFirstWrite: true, maxWritesPerMinute: 120 },
  evidence: EVIDENCE_VIA,
  sourceUrl: 'https://www.caniusevia.com/docs/specification',
  sourceType: 'official-docs',
  verifiedStatus: 'not-verified',
  verifiedPlatforms: [],
  hardwareValidation: { status: 'not-verified', platforms: [] },
  riskLevel: 'medium', // writes touch keymap EEPROM / lighting
  activeProbeAllowed: true, // VIA magic + get-protocol-version is the protocol's own handshake
  notes: 'VIA speaks over the same 0xFF60/0x61 interface as bare QMK Raw HID. Profile must be matched by VID/PID registry or explicit user assignment before any probe. Round-16: this adapter implements protocol identification + LIMITED runtime-keymap writes only; it does NOT provide AI lighting/OLED output paths (not implemented, declared unsupported).',
};

/** Vial (fork of VIA with its own magic byte 0xFE). */
export const vialProfile: ProtocolProfile = {
  schemaVersion: 1,
  profileId: 'vial',
  displayName: 'Vial',
  protocol: 'vial',
  protocolVersion: '0x00000006', // VIAL_PROTOCOL_VERSION in vial-qmk vial.h
  usagePage: QMK_RAW_HID_PAGE,
  usageId: QMK_RAW_HID_USAGE,
  interface: 'hid-raw',
  reportSize: QMK_RAW_HID_REPORT_SIZE,
  transport: ['usb-hid'],
  capabilities: {
    // round-16 (P1-3): declarations match the adapter's implementation.
    'read-key-event': 'unsupported',
    'read-encoder-event': 'unsupported',
    'set-indicator': 'unknown',
    'set-rgb': 'unknown',
    'set-rgb-matrix': 'unsupported', // vialrgb not implemented
    'set-backlight': 'unsupported',
    'display-text': 'unsupported',
    'display-icon': 'unsupported',
    'haptic': 'unsupported',
    'runtime-keymap': 'unsupported', // keymap editing (needs definition JSON) NOT implemented
    'approval-input': 'unsupported',
    'profile-switch': 'unsupported',
  },
  sourceUrl: 'https://get.vial.today/',
  sourceType: 'official-docs',
  evidence: EVIDENCE_VIAL,
  safetyPolicy: { activeProbeAllowed: true, confirmationRequiredOnFirstWrite: true, maxWritesPerMinute: 0 },
  verifiedStatus: 'not-verified',
  verifiedPlatforms: [],
  hardwareValidation: { status: 'not-verified', platforms: [] },
  riskLevel: 'medium',
  activeProbeAllowed: true, // 0xFE + vial_get_keyboard_id is the protocol's own handshake
  notes: 'Vial packets are fixed 32 bytes with msg[0]=0xFE and msg[1]=command. Same interface-match caveats as VIA.',
};

/** ZMK Studio RPC (zmk-studio-messages). */
export const zmkStudioProfile: ProtocolProfile = {
  schemaVersion: 1,
  profileId: 'zmk-studio',
  displayName: 'ZMK Studio',
  protocol: 'zmk-studio-rpc',
  protocolVersion: 'studio-rpc (protobuf)',
  interface: 'cdc-acm', // USB CDC-ACM serial or BLE GATT service
  transport: ['usb-cdc-acm', 'ble-gatt'],
  capabilities: {
    'read-key-event': 'unsupported', // Studio RPC does not stream key events
    'read-encoder-event': 'unsupported',
    'set-indicator': 'unsupported',
    'set-rgb': 'unsupported', // Studio RPC has no RGB control
    'set-rgb-matrix': 'unsupported',
    'set-backlight': 'unsupported',
    'display-text': 'unsupported', // no OLED/screen control in Studio RPC
    'display-icon': 'unsupported',
    'haptic': 'unsupported',
    'runtime-keymap': 'supported', // keymap get/set/save/discard — requires unlock
    'approval-input': 'unsupported',
    'profile-switch': 'unsupported',
  },
  sourceUrl: 'https://zmk.dev/docs/development/studio-rpc-protocol',
  sourceType: 'official-docs',
  evidence: EVIDENCE_ZMK_STUDIO,
  safetyPolicy: { activeProbeAllowed: true, confirmationRequiredOnFirstWrite: true, maxWritesPerMinute: 120 },
  responseValidator: 'readback',
  verifiedStatus: 'not-verified',
  verifiedPlatforms: [],
  hardwareValidation: { status: 'not-verified', platforms: [] },
  riskLevel: 'medium',
  activeProbeAllowed: true, // framed get_device_info Request is the protocol's own identification
  notes: 'Runtime keymap support does NOT imply RGB/OLED/AI control. If the keyboard firmware does not enable ZMK Studio, show "Studio endpoint unavailable / feature not enabled in current firmware".',
};

/** AKP — optional extension protocol (this project's own custom protocol, migrated here). */
export const akpExtensionProfile: ProtocolProfile = {
  schemaVersion: 1,
  profileId: 'akp-extension',
  displayName: 'AKP Extension',
  protocol: 'akp',
  protocolVersion: '1.0',
  usagePage: QMK_RAW_HID_PAGE,
  usageId: QMK_RAW_HID_USAGE,
  interface: 'hid-raw',
  reportSize: QMK_RAW_HID_REPORT_SIZE,
  transport: ['usb-hid'],
  capabilities: {
    'read-key-event': 'supported', // CMD / KEYEVENT messages
    'read-encoder-event': 'supported', // ENCODER messages
    'set-indicator': 'supported', // status LED (STATE payload + RGB)
    'set-rgb': 'supported', // RGB message (solid / effect)
    'set-rgb-matrix': 'supported', // per-key RGB message
    'set-backlight': 'unsupported', // AKP v1 has no distinct backlight control
    'display-text': 'supported', // SCREEN message
    'display-icon': 'unsupported', // SCREEN is text lines only
    'haptic': 'unsupported', // AKP v1 defines no haptic control
    'runtime-keymap': 'unsupported', // AKP v1 does not define runtime keymap editing
    'approval-input': 'supported', // F13–F24 / dedicated approval keys (CMD)
    'profile-switch': 'unsupported', // AKP v1 defines no profile switch command
  },
  sourceUrl: 'https://github.com/your-org/qmk-vibe-bridge/blob/main/docs/PROTOCOLS.md#akp-extension',
  sourceType: 'design',
  safetyPolicy: { activeProbeAllowed: true, confirmationRequiredOnFirstWrite: true, maxWritesPerMinute: 600 },
  verifiedStatus: 'verified-simulator',
  verifiedPlatforms: ['macos'],
  hardwareValidation: { status: 'verified-simulator', platforms: ['macos'] },
  riskLevel: 'medium',
  activeProbeAllowed: true, // HELLO handshake is AKP's own identification
  notes: 'Optional extension protocol (compatibility matrix layer C). Requires the optional extension firmware; NEVER a global gate for other keyboards.',
};

/** Simulator profile for virtual devices. */
export const simulatorProfile: ProtocolProfile = {
  schemaVersion: 1,
  profileId: 'simulator',
  displayName: 'Simulator (TCP)',
  protocol: 'simulator',
  protocolVersion: '1.0',
  interface: 'tcp',
  reportSize: 32,
  transport: ['tcp'],
  capabilities: {
    'read-key-event': 'supported',
    'read-encoder-event': 'supported',
    'set-indicator': 'supported',
    'set-rgb': 'supported',
    'set-rgb-matrix': 'supported',
    'set-backlight': 'supported',
    'display-text': 'supported',
    'display-icon': 'supported',
    'haptic': 'supported',
    'runtime-keymap': 'supported',
    'approval-input': 'supported',
    'profile-switch': 'supported',
  },
  sourceUrl: 'https://github.com/your-org/qmk-vibe-bridge/blob/main/docs/ARCHITECTURE.md#simulator',
  sourceType: 'design',
  safetyPolicy: { activeProbeAllowed: true, confirmationRequiredOnFirstWrite: false, maxWritesPerMinute: 600 },
  verifiedStatus: 'verified-simulator',
  verifiedPlatforms: ['macos', 'linux', 'windows'],
  hardwareValidation: { status: 'verified-simulator', platforms: ['macos', 'linux', 'windows'] },
  riskLevel: 'none',
  activeProbeAllowed: true,
  notes: 'Simulator results never substitute for real protocol verification.',
};

export const BUILTIN_PROFILES: ProtocolProfile[] = [
  qmkRawHidProfile,
  viaProfile,
  vialProfile,
  zmkStudioProfile,
  akpExtensionProfile,
  simulatorProfile,
];

export function isQmkRawHidInterface(usagePage: number | undefined, usageId: number | undefined): boolean {
  return usagePage === QMK_RAW_HID_PAGE && usageId === QMK_RAW_HID_USAGE;
}
