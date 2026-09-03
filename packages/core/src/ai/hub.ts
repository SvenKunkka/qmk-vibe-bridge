/**
 * AiEventHub (round-15): collects normalized AiEvents from all providers,
 * tracks the active source, and fans events out to listeners (UI + mapping).
 * Providers are the ONLY source of AI events; nothing here synthesizes events
 * unless a provider is marked `simulated`.
 */

import { EventEmitter } from 'node:events';
import type { AiEvent, AiEventProvider } from './types';

export type AiHubEvent =
  | { type: 'event'; ev: AiEvent }
  | { type: 'source'; source: string | null };

export class AiEventHub extends EventEmitter {
  private readonly providers = new Map<string, AiEventProvider>();
  private readonly latest = new Map<string, AiEvent>();
  private activeSource: string | null = null;

  attach(provider: AiEventProvider, opts: { start?: boolean } = {}): void {
    if (this.providers.has(provider.id)) return;
    this.providers.set(provider.id, provider);
    provider.onEvent((ev) => {
      this.latest.set(provider.id, ev);
      this.emit('event', { type: 'event', ev });
    });
    if (opts.start !== false) provider.start();
  }

  detach(id: string): void {
    const p = this.providers.get(id);
    if (p) {
      p.stop();
      this.providers.delete(id);
      this.latest.delete(id);
    }
  }

  setActiveSource(id: string | null): void {
    this.activeSource = id;
    this.emit('source', { type: 'source', source: id });
  }

  getActiveSource(): string | null {
    return this.activeSource;
  }

  getLatest(sourceId?: string): AiEvent | undefined {
    const id = sourceId ?? this.activeSource;
    if (id) return this.latest.get(id);
    // most recent across providers
    let best: AiEvent | undefined;
    for (const ev of this.latest.values()) {
      if (!best || ev.ts > best.ts) best = ev;
    }
    return best;
  }

  allLatest(): Map<string, AiEvent> {
    return new Map(this.latest);
  }

  providersList(): AiEventProvider[] {
    return [...this.providers.values()];
  }
}
