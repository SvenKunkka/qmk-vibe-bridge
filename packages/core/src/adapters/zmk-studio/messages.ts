/**
 * ZMK Studio RPC messages (round-15), hand-coded against the official
 * zmk-studio-messages protobuf definitions:
 * https://github.com/zmkfirmware/zmk-studio-messages/blob/main/proto/zmk/studio.proto
 *
 * Only the subset used by this adapter is implemented: core (device info,
 * lock state, lock) and keymap (get_keymap) — plus response/notification
 * decoding. Everything else is untouched.
 */

import {
  pbDecode, pbEncode, pbGet, pbAsVarint, pbAsString, pbNested,
  type PbField,
} from './protobuf';

// ---- zmk.studio top level (studio.proto) ----

export interface StudioRequest {
  requestId: number;
  core?: CoreRequest;
  keymap?: KeymapRequest;
}

export type CoreRequest =
  | { kind: 'get_device_info' }
  | { kind: 'get_lock_state' }
  | { kind: 'lock' }
  | { kind: 'reset_settings' };

export type KeymapRequest = { kind: 'get_keymap' };

export function encodeStudioRequest(req: StudioRequest): Uint8Array {
  const fields: PbField[] = [{ field: 1, value: { kind: 'varint', value: req.requestId } }];
  if (req.core) {
    fields.push(pbNested(3, encodeCoreRequest(req.core)));
  }
  if (req.keymap) {
    fields.push(pbNested(5, encodeKeymapRequest(req.keymap)));
  }
  return pbEncode(fields);
}

export function encodeCoreRequest(req: CoreRequest): PbField[] {
  const kindField = {
    get_device_info: { field: 1, value: { kind: 'varint', value: 1 } },
    get_lock_state: { field: 2, value: { kind: 'varint', value: 1 } },
    lock: { field: 3, value: { kind: 'varint', value: 1 } },
    reset_settings: { field: 4, value: { kind: 'varint', value: 1 } },
  }[req.kind] as PbField;
  return [kindField];
}

export function encodeKeymapRequest(req: KeymapRequest): PbField[] {
  if (req.kind === 'get_keymap') {
    return [{ field: 1, value: { kind: 'varint', value: 1 } }];
  }
  return [];
}

// ---- decoding ----

export type CoreResponse =
  | { kind: 'get_device_info'; name: string; serialNumber: Uint8Array }
  | { kind: 'get_lock_state'; lockState: 'locked' | 'unlocked' }
  | { kind: 'reset_settings' }
  | { kind: 'simple_error'; code: number };

export interface KeymapData {
  layerCount: number;
  layers: Array<{ id: number; name: string }>;
}

export interface StudioResponse {
  /** undefined for notifications (they carry no request id) */
  requestId?: number;
  core?: CoreResponse;
  keymap?: KeymapData;
  /** true when the response is a meta simple_error (no subsystem) */
  error?: boolean;
}

const LOCKED = 0;
const UNLOCKED = 1;

export interface StudioNotification {
  /** true when this is a lock_state_changed notification */
  lockStateChanged?: 'locked' | 'unlocked';
}

export function decodeStudioResponse(bytes: Uint8Array): (StudioResponse & StudioNotification) | null {
  const top = pbDecode(bytes);
  // Response { oneof type { RequestResponse=1 | Notification=2 } }
  const notif = pbGet(top, 2);
  if (notif) {
    // Notification { oneof subsystem { core.Notification = 2 | keymap.Notification = 5 } }
    const notifFields = pbDecode((notif as { value: Uint8Array }).value);
    const coreNotif = pbGet(notifFields, 2);
    if (coreNotif) {
      // core.Notification { oneof { LockState lock_state_changed = 1 } }
      const coreNotifFields = pbDecode((coreNotif as { value: Uint8Array }).value);
      const lockState = pbAsVarint(pbGet(coreNotifFields, 1));
      if (lockState !== undefined) {
        return { lockStateChanged: lockState === UNLOCKED ? 'unlocked' : 'locked' };
      }
    }
    return {};
  }
  const rr = pbGet(top, 1);
  if (!rr) return null;
  const rrFields = pbDecode((rr as { value: Uint8Array }).value);
  const requestId = pbAsVarint(pbGet(rrFields, 1)) ?? -1;
  const out: StudioResponse = { requestId };
  const meta = pbGet(rrFields, 2);
  if (meta) {
    const metaFields = pbDecode((meta as { value: Uint8Array }).value);
    const simpleErr = pbAsVarint(pbGet(metaFields, 2));
    out.error = simpleErr !== undefined;
    if (simpleErr !== undefined) {
      out.core = { kind: 'simple_error', code: simpleErr };
    }
    return out;
  }
  const core = pbGet(rrFields, 3);
  if (core) {
    const coreFields = pbDecode((core as { value: Uint8Array }).value);
    const info = pbGet(coreFields, 1);
    if (info) {
      const infoFields = pbDecode((info as { value: Uint8Array }).value);
      out.core = {
        kind: 'get_device_info',
        name: pbAsString(pbGet(infoFields, 1)) ?? '',
        serialNumber: Uint8Array.from((pbGet(infoFields, 2) as { value: Uint8Array } | undefined)?.value ?? []),
      };
      return out;
    }
    const lockState = pbAsVarint(pbGet(coreFields, 2));
    if (lockState !== undefined) {
      out.core = { kind: 'get_lock_state', lockState: lockState === UNLOCKED ? 'unlocked' : 'locked' };
      return out;
    }
    const reset = pbAsVarint(pbGet(coreFields, 4));
    if (reset !== undefined) {
      out.core = { kind: 'reset_settings' };
      return out;
    }
    return out;
  }
  const keymap = pbGet(rrFields, 5);
  if (keymap) {
    const kmFields = pbDecode((keymap as { value: Uint8Array }).value);
    const keymapMsg = pbGet(kmFields, 1);
    if (keymapMsg) {
      const km = pbDecode((keymapMsg as { value: Uint8Array }).value);
      const layerCount = pbAsVarint(pbGet(km, 2)) ?? 0;
      const layers: Array<{ id: number; name: string }> = [];
      // repeated message field: ALL field-1 values concatenated
      const sub = km
        .filter((f) => f.field === 1)
        .map((f) => pbDecode((f.value as { value: Uint8Array }).value));
      for (const layerFields of sub) {
        const id = pbAsVarint(pbGet(layerFields, 1)) ?? 0;
        const name = pbAsString(pbGet(layerFields, 2)) ?? '';
        layers.push({ id, name });
      }
      out.keymap = { layerCount, layers };
      return out;
    }
  }
  return out;
}

/** decode a repeated length-delimited message field (concatenated sub-messages). */
function decodeRepeatedMessages(bytes: Uint8Array): PbField[][] {
  const out: PbField[][] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const len = readVarintSimple(bytes, pos);
    pos = len.next;
    const end = pos + len.value;
    if (end > bytes.length) break;
    out.push(pbDecode(bytes.subarray(pos, end)));
    pos = end;
  }
  return out;
}

function readVarintSimple(bytes: Uint8Array, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let i = pos;
  while (i < bytes.length) {
    const b = bytes[i];
    result |= (b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) break;
  }
  return { value: result, next: i };
}

// ---- response encoders (used by the virtual ZMK Studio device) ----


/** RequestResponse { request_id, core: GetDeviceInfoResponse }.
 *  core.Response { get_device_info = field 1 (message GetDeviceInfoResponse) };
 *  RequestResponse { core = field 3 }. */
export function encodeGetDeviceInfoResponse(requestId: number, name: string, serialNumber: Uint8Array): Uint8Array {
  const info: PbField[] = [
    { field: 1, value: { kind: 'string', value: name } },
    { field: 2, value: { kind: 'bytes', value: serialNumber } },
  ];
  const coreResponse: PbField[] = [{ field: 1, value: { kind: 'bytes', value: pbEncode(info) } }];
  return encodeRequestResponse(requestId, [{ field: 3, value: { kind: 'bytes', value: pbEncode(coreResponse) } }]);
}

/** RequestResponse { request_id, core: LockState (enum) }.
 *  core.Response { get_lock_state = field 2 (enum LockState) }. */
export function encodeLockStateResponse(requestId: number, unlocked: boolean): Uint8Array {
  const coreResponse: PbField[] = [{ field: 2, value: { kind: 'varint', value: unlocked ? UNLOCKED : LOCKED } }];
  return encodeRequestResponse(requestId, [{ field: 3, value: { kind: 'bytes', value: pbEncode(coreResponse) } }]);
}

/** RequestResponse { request_id, meta: simple_error }.
 *  meta.Response { simple_error = field 2 (enum ErrorConditions) };
 *  RequestResponse { meta = field 2 }. */
export function encodeSimpleErrorResponse(requestId: number, code: number): Uint8Array {
  const metaResponse: PbField[] = [{ field: 2, value: { kind: 'varint', value: code } }];
  return encodeRequestResponse(requestId, [{ field: 2, value: { kind: 'bytes', value: pbEncode(metaResponse) } }]);
}

/** RequestResponse { request_id, keymap: Keymap }.
 *  keymap.Response { get_keymap = field 1 (message Keymap) };
 *  RequestResponse { keymap = field 5 }. */
export function encodeKeymapResponse(requestId: number, layerCount: number, layerNames: string[]): Uint8Array {
  const layers: PbField[] = layerNames.map((name, i) =>
    pbNested(1, [
      { field: 1, value: { kind: 'varint', value: i } },
      { field: 2, value: { kind: 'string', value: name } },
    ]),
  );
  const keymapMsg: PbField[] = [
    ...layers,
    { field: 2, value: { kind: 'varint', value: layerCount } },
  ];
  const keymapResponse: PbField[] = [{ field: 1, value: { kind: 'bytes', value: pbEncode(keymapMsg) } }];
  return encodeRequestResponse(requestId, [{ field: 5, value: { kind: 'bytes', value: pbEncode(keymapResponse) } }]);
}

function encodeRequestResponse(requestId: number, subsystem: PbField[]): Uint8Array {
  const rr: PbField[] = [
    { field: 1, value: { kind: 'varint', value: requestId } },
    ...subsystem,
  ];
  // Response { RequestResponse = field 1 }
  return pbEncode([{ field: 1, value: { kind: 'bytes', value: pbEncode(rr) } }]);
}

/** Response { Notification { core.Notification { lock_state_changed } } }.
 *  Sent by the firmware when the lock state changes (physical unlock). */
export function encodeLockStateNotification(unlocked: boolean): Uint8Array {
  const coreNotif: PbField[] = [{ field: 1, value: { kind: 'varint', value: unlocked ? UNLOCKED : LOCKED } }];
  const notif: PbField[] = [{ field: 2, value: { kind: 'bytes', value: pbEncode(coreNotif) } }];
  // Response { Notification = field 2 }
  return pbEncode([{ field: 2, value: { kind: 'bytes', value: pbEncode(notif) } }]);
}
