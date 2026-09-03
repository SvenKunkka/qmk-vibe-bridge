/**
 * AI Event domain (round-15 architecture).
 *
 * The AI side and the keyboard side are fully decoupled. An AiEvent is the
 * ONLY thing that crosses from an AI tool into the mapping engine. Providers
 * (simulator, Codex, DSH, Claude Code, …) normalize their own observations
 * into this canonical shape via AiEventNormalizer.
 */

export const AI_EVENT_TYPES = [
  'idle',
  'thinking',
  'tool-running',
  'waiting-for-approval',
  'waiting-for-user',
  'done',
  'error',
  'disconnected',
] as const;

export type AiEventType = (typeof AI_EVENT_TYPES)[number];

export interface AiEvent {
  type: AiEventType;
  /** provider id that produced this event */
  source: string;
  /** display name of the agent (tool), e.g. "Codex" */
  agent?: string;
  agentId?: string;
  session?: string;
  /** free text observed from the tool (step, message, tool name, …) */
  text?: string;
  step?: string;
  /** 0..1 progress when known */
  progress?: number;
  /** epoch ms */
  ts: number;
  /**
   * Confidence 0..1 of the heuristic that produced this event. Events
   * synthesized by a simulator carry simulated=true and must never be
   * presented to the user as real agent activity.
   */
  confidence: number;
  simulated: boolean;
}

/**
 * A source of AI events. Implementations are allowed to be heuristic
 * (log watchers) or exact (simulator).
 */
export interface AiEventProvider {
  readonly id: string;
  readonly label: string;
  /** true when the provider synthesizes events (simulator) rather than observing a real tool */
  readonly simulated: boolean;
  start(): void;
  stop(): void;
  /** latest event, or undefined before the first observation */
  getLatest(): AiEvent | undefined;
  onEvent(cb: (ev: AiEvent) => void): () => void;
}
