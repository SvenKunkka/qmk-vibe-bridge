/**
 * Agent Provider API types (round-17 §5): the unified inbound event model for
 * external agents/LLMs/automation connected over the local API.
 */

/** canonical inbound states (round-17: seven states + aliases) */
export type InboundAgentState =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  | 'waiting-approval'
  | 'waiting-user'
  | 'success'
  | 'done'
  | 'error'
  | 'offline';

export interface InboundAgentEvent {
  /** client-supplied unique id — used for idempotency */
  eventId: string;
  providerId: string;
  sessionId: string;
  timestamp?: number; // epoch ms; server fills when missing
  state: InboundAgentState;
  progress?: number; // 0..1
  toolName?: string;
  requiresApproval?: boolean;
  result?: unknown;
  severity?: 'info' | 'warn' | 'error';
  ttlMs?: number; // how long this event stays fresh
  metadata?: Record<string, unknown>;
}

export type ConflictPolicy = 'priority' | 'latest-active' | 'pinned-session';

/** severity of an inbound state for conflict resolution (higher wins) */
export const STATE_SEVERITY: Record<InboundAgentState, number> = {
  offline: 0,
  idle: 1,
  thinking: 2,
  'tool-running': 3,
  'waiting-user': 4,
  'waiting-approval': 5,
  success: 2,
  done: 2,
  error: 6,
};

export interface ApiServerConfig {
  host?: string; // default 127.0.0.1 (never public by default)
  port?: number; // 0 = random
  token?: string; // if omitted, generated + stored
  maxMessageBytes?: number; // default 64 KiB
  maxEventsPerMinute?: number; // default 600
  conflictPolicy?: ConflictPolicy;
  pinnedSessionId?: string;
}

export interface ApiServerStatus {
  running: boolean;
  host: string;
  port: number;
  tokenConfigured: boolean;
  tokenStorage: 'keychain' | 'file' | 'none';
  conflictPolicy: ConflictPolicy;
}
