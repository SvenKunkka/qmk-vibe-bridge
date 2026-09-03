/**
 * KeymapManager — resolves keyboard events (F13..F24, knobs, custom keys) to
 * actions using the user keymap, with double-tap support.
 */

import type { ActionName, KeyEventPayload } from '@vibebridge/akp-codec';
import type { KeyMapping } from './settings';

export interface ResolvedAction {
  action: ActionName | string;
  mapping: KeyMapping;
  /** true when this is a double-tap */
  doubled: boolean;
}

export class KeymapManager {
  private mappings: KeyMapping[];
  private readonly tapWindowMs: number;
  private lastTap = new Map<string, { at: number; count: number }>();

  constructor(mappings: KeyMapping[], tapWindowMs = 600) {
    this.mappings = mappings;
    this.tapWindowMs = tapWindowMs;
  }

  setMappings(mappings: KeyMapping[]): void {
    this.mappings = mappings;
  }

  getMappings(): KeyMapping[] {
    return [...this.mappings];
  }

  /** Find a mapping for a key name (F13..F24, KNOB_CW, ...). */
  mappingFor(source: string): KeyMapping | undefined {
    return this.mappings.find((m) => m.source === source);
  }

  /**
   * Handle a key event; returns the action to run (if any). Tap semantics:
   * an 'up' event after a 'down' triggers the action; repeated taps within the
   * window are counted and reported via `doubled`.
   */
  handleKeyEvent(ev: KeyEventPayload): ResolvedAction | null {
    const mapping = this.mappingFor(ev.key);
    if (!mapping) return null;
    if (ev.state !== 'tap' && ev.state !== 'up') return null;
    const now = Date.now();
    const prev = this.lastTap.get(ev.key);
    let count = 1;
    if (prev && now - prev.at <= this.tapWindowMs) {
      count = prev.count + 1;
    }
    this.lastTap.set(ev.key, { at: now, count });
    // trim old entries
    if (this.lastTap.size > 64) {
      for (const [k, v] of this.lastTap) {
        if (now - v.at > this.tapWindowMs * 4) this.lastTap.delete(k);
      }
    }
    const wantCount = mapping.tapCount ?? 1;
    if (count < wantCount) return null;
    // reset counter once triggered
    this.lastTap.delete(ev.key);
    return { action: mapping.action, mapping, doubled: count > 1 };
  }

  /** Simpler API: resolve a single key tap. */
  resolve(source: string, tapCount = 1): ResolvedAction | null {
    const mapping = this.mappingFor(source);
    if (!mapping) return null;
    if ((mapping.tapCount ?? 1) > tapCount) return null;
    return { action: mapping.action, mapping, doubled: tapCount > 1 };
  }
}

export const F_KEYS = ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24'];
export const KNOB_KEYS = ['KNOB_CW', 'KNOB_CCW', 'KNOB_PRESS'];
