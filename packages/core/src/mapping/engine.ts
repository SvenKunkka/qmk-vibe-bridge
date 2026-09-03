/**
 * Mapping Engine (round-15): converts an AiEvent into the capability
 * operations a device could perform, based on the device's DECLARED
 * capabilities. Feasibility here is only about the declared capability state;
 * the Capability Gate is the final authority before any write.
 */

import type { AiEvent, AiEventType } from '../ai/types';
import type { CapabilityMap, CapabilityOp, CapabilityState } from '../capabilities/model';

export interface DeviceCapabilityView {
  deviceId: string;
  caps: CapabilityMap;
}

export interface MappedOp {
  op: CapabilityOp;
  /** whether the capability is declared usable on this device right now */
  feasible: boolean;
  reason: string;
}

export interface StateVisual {
  label: string;
  color: { r: number; g: number; b: number };
}

/** AI state -> desired indicator color (the classic status palette). */
export const STATE_VISUALS: Record<AiEventType, StateVisual> = {
  idle: { label: 'idle', color: { r: 255, g: 255, b: 255 } },
  thinking: { label: 'thinking', color: { r: 0, g: 120, b: 255 } },
  'tool-running': { label: 'tool-running', color: { r: 150, g: 60, b: 220 } },
  'waiting-for-approval': { label: 'waiting-for-approval', color: { r: 255, g: 140, b: 0 } },
  'waiting-for-user': { label: 'waiting-for-user', color: { r: 0, g: 220, b: 220 } },
  done: { label: 'done', color: { r: 0, g: 220, b: 80 } },
  error: { label: 'error', color: { r: 255, g: 40, b: 40 } },
  disconnected: { label: 'disconnected', color: { r: 0, g: 0, b: 0 } },
};

const FEASIBLE_STATES: CapabilityState[] = ['supported'];

/** Resolve the visual for a state with optional per-source color overrides. */
export function stateVisualFor(state: AiEventType, colors?: Partial<Record<string, { r: number; g: number; b: number }>>): StateVisual {
  const base = STATE_VISUALS[state] ?? STATE_VISUALS.idle;
  const override = colors?.[state];
  return override ? { label: base.label, color: override } : base;
}

export class MappingEngine {
  /** Which capability ops each AI state wants (in priority order). */
  desiredOps(state: AiEventType, deviceId: string, text?: string, colors?: Partial<Record<string, { r: number; g: number; b: number }>>): CapabilityOp[] {
    const visual = stateVisualFor(state, colors);
    const ops: CapabilityOp[] = [];
    const ind: CapabilityOp = {
      kind: 'set-indicator',
      deviceId,
      label: `indicator ${visual.label} (#${toHex(visual.color)})`,
      payload: { color: visual.color },
    };
    ops.push(ind);
    if (text) {
      ops.push({
        kind: 'display-text',
        deviceId,
        label: `display "${text.slice(0, 32)}"`,
        payload: { text: text.slice(0, 256), title: visual.label },
      });
    }
    // RGB follows the indicator when the device supports it
    const rgb: CapabilityOp = {
      kind: 'set-rgb',
      deviceId,
      label: `rgb ${visual.label}`,
      payload: { mode: 'solid', color: visual.color, brightness: 60 },
    };
    ops.push(rgb);
    if (state === 'waiting-for-approval') {
      ops.push({
        kind: 'approval-input',
        deviceId,
        label: 'enable approval input (approve/reject keys)',
        payload: { enabled: true },
      });
    }
    return ops;
  }

  /**
   * Map an AiEvent to feasible ops for a device. Ops whose capability is not
   * declared `supported` are reported as infeasible with a reason (the gate
   * would reject them anyway — this is the UI's "pending operations" view).
   */
  map(ev: AiEvent, view: DeviceCapabilityView, colors?: Partial<Record<string, { r: number; g: number; b: number }>>): MappedOp[] {
    const candidates = this.desiredOps(ev.type, view.deviceId, ev.text, colors);
    return candidates.map((op) => {
      const state: CapabilityState = view.caps[op.kind] ?? 'unknown';
      const feasible = FEASIBLE_STATES.includes(state);
      return {
        op,
        feasible,
        reason: feasible
          ? 'capability declared supported'
          : `capability "${op.kind}" is ${state} on this device`,
      };
    });
  }
}

function toHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `${h(c.r)}${h(c.g)}${h(c.b)}`;
}
