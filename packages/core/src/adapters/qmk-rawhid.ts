/**
 * qmk-rawhid adapter (round-15).
 *
 * QMK Raw HID is ONLY a bidirectional 32-byte transport — not a unified
 * RGB/OLED/screen/AI control protocol. Therefore this adapter:
 *   - declares capabilities-unknown (never ready, never a control protocol);
 *   - sends NO probes, NO AKP HELLO, NO custom packets;
 *   - performs zero writes;
 *   - identification is purely declarative (usage 0xFF60/0x61 matched).
 */

import type { CapabilityId, CapabilityMap, CapabilityOp } from '../capabilities/model';
import { NO_CAPABILITIES } from '../capabilities/model';
import type { AdapterContext, IdentifyResult, OpResult, ProtocolAdapter } from './types';

export const QMK_RAWHID_ADAPTER_ID = 'qmk-rawhid';

export class QmkRawHidAdapter implements ProtocolAdapter {
  readonly id = QMK_RAWHID_ADAPTER_ID;
  readonly profileId = 'qmk-rawhid';
  /** transport-only: no control capabilities are implemented */
  static readonly implementedCapabilities: CapabilityId[] = [];

  async identify(ctx: AdapterContext): Promise<IdentifyResult> {
    ctx.onLog(
      'info',
      `[qmk-rawhid] 0xFF60/0x61 interface at ${ctx.transport.exactPath} — transport only, capabilities unknown, zero writes`,
    );
    // round-16 (P1-2): a bare Raw HID transport declares NO control protocol —
    // status is 'transport-only', never 'identified', so the device manager
    // keeps capabilitiesKnown=false and the UI shows the read-only banner.
    return {
      status: 'transport-only',
      capabilities: { ...NO_CAPABILITIES },
    };
  }

  async apply(_op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    // The gate never lets a bare Raw HID transport op through (no capability
    // is declared), but double-guard here: this adapter writes NOTHING.
    ctx.onLog('error', '[qmk-rawhid] write refused: bare Raw HID transport defines no capabilities');
    return { ok: false, error: 'qmk-rawhid adapter performs zero writes', wrote: false };
  }

  async close(): Promise<void> {
    /* nothing to tear down */
  }
}

export function unknownCapabilities(): CapabilityMap {
  return { ...NO_CAPABILITIES };
}
