/**
 * Adapter factory (round-15): instantiate the adapter for a matched profile.
 * Each adapter is independent — no adapter gates any other device.
 */

import type { ProtocolAdapter } from './types';
import { QmkRawHidAdapter } from './qmk-rawhid';
import { ViaAdapter } from './via';
import { VialAdapter } from './vial';
import { ZmkStudioAdapter } from './zmk-studio';
import { AkpExtensionAdapter } from './akp-extension';
import { SimulatorAdapter } from './simulator';

export function createAdapter(profileId: string): ProtocolAdapter {
  switch (profileId) {
    case 'qmk-rawhid':
      return new QmkRawHidAdapter();
    case 'via':
      return new ViaAdapter();
    case 'vial':
      return new VialAdapter();
    case 'zmk-studio':
      return new ZmkStudioAdapter();
    case 'akp-extension':
      return new AkpExtensionAdapter();
    case 'simulator':
      return new SimulatorAdapter();
    default:
      // imported VIA-definition profiles route to the VIA adapter
      if (profileId.startsWith('via:')) return new ViaAdapter();
      throw new Error(`no adapter registered for profile "${profileId}"`);
  }
}
