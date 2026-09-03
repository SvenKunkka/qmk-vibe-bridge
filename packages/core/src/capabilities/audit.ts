/**
 * Write Audit (round-15). Every write attempt — allowed or blocked — is
 * recorded here, append-only. Tests assert on write counts; the UI renders the
 * recent entries. The audit is the source of truth for "zero writes" on
 * unknown devices.
 */

export interface AuditEntry {
  id: number;
  ts: number;
  deviceId: string;
  interfaceLabel: string;
  transport: string;
  adapter: string | null | undefined;
  profileId: string | null | undefined;
  capability: string | null | undefined;
  opLabel: string | null | undefined;
  /** true when the write reached the transport */
  wrote: boolean;
  allowed: boolean;
  /** gate reasons when blocked */
  reasons: string[];
  error?: string;
  /** round-17 §9.3: explicit outcome (blocked/needs-confirmation/…/applied) */
  outcome?: string;
}

export class WriteAudit {
  private entries: AuditEntry[] = [];
  private nextId = 1;
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  record(partial: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
    const entry: AuditEntry = { ...partial, id: this.nextId++, ts: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return entry;
  }

  /** Writes that actually reached a transport. */
  countWrites(deviceId?: string): number {
    return this.entries.filter(
      (e) => e.wrote && (!deviceId || e.deviceId === deviceId),
    ).length;
  }

  /** Any write attempt (allowed or blocked). */
  countAttempts(deviceId?: string): number {
    return this.entries.filter(
      (e) => (!e.wrote) && (!deviceId || e.deviceId === deviceId),
    ).length;
  }

  recent(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
