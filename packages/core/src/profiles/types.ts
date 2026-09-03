/**
 * Protocol Profile registry types (round-17): a Profile is a verified,
 * evidenced description of a keyboard protocol capability surface. Profiles
 * gate identity + capability declaration; they are NEVER a claim that a
 * device is "compatible" by VID/PID alone.
 */

import type { CapabilityMap } from '../capabilities/model';

export type VerifiedStatus =
  | 'not-verified'
  | 'verified-simulator'
  | 'verified-hardware';

export type SourceType =
  | 'official-docs'
  | 'upstream-source'
  | 'vendor-docs'
  | 'design';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface EvidenceSource {
  url: string;
  type: SourceType;
  /** upstream version/commit/date when known */
  version?: string;
  notes?: string;
}

export interface DefinitionSource {
  kind: 'builtin' | 'imported' | 'remote';
  /** imported definition JSON (VIA definition) pinned by hash */
  definition?: ViaDefinition;
  hash?: string;
  url?: string;
}

export interface ViaDefinition {
  name: string;
  vendorId: string;
  productId: string;
  matrix?: { rows?: number; cols?: number };
  layouts?: unknown;
  labels?: unknown;
  customKeycodes?: unknown;
  menus?: unknown;
  /** any unknown fields the importer kept (not used for logic) */
  extraFields?: string[];
  /** sha256 of the original imported JSON (canonical) */
  hash: string;
}

export interface ProtocolProfile {
  /** profile schema version */
  schemaVersion: number;
  /** stable id, e.g. "via", "vial", "zmk-studio", "akp-extension", "qmk-rawhid", "simulator" */
  profileId: string;
  displayName: string;
  protocol: string;
  protocolVersion: string;
  /** vendor/product display strings (informational) */
  vendor?: string;
  product?: string;
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usageId?: number;
  /** interface signature: 'hid-raw' | 'cdc-acm' | 'ble-gatt' | 'tcp' */
  interface?: string;
  reportSize?: number;
  transport: string[];
  capabilities: CapabilityMap;
  /** where this profile's definition came from (builtin/imported/remote) */
  definition?: DefinitionSource;
  /** firmware/version constraints when the profile requires them */
  firmwareConstraints?: {
    minProtocolVersion?: string;
    maxProtocolVersion?: string;
    requiredFirmwareFeatures?: string[];
  };
  /** read-command mapping (capability -> official read command shape) */
  readCommandMapping?: Record<string, unknown>;
  /** write-command mapping (capability -> official write command shape) */
  writeCommandMapping?: Record<string, unknown>;
  /** payload validation strategy: builtin (gate validatePayload) or definition */
  payloadValidator?: 'builtin' | 'definition';
  /** response validation strategy per capability */
  responseValidator?: 'echo' | 'readback' | 'none';
  /** safety policy */
  safetyPolicy?: {
    activeProbeAllowed: boolean;
    confirmationRequiredOnFirstWrite: boolean;
    maxWritesPerMinute?: number;
  };
  /** evidence sources for every implemented command */
  evidence?: EvidenceSource[];
  /** hardware validation status */
  hardwareValidation?: {
    status: VerifiedStatus;
    platforms: string[];
    date?: string;
  };
  sourceUrl: string;
  sourceType: SourceType;
  verifiedStatus: VerifiedStatus;
  verifiedPlatforms: string[];
  riskLevel: RiskLevel;
  /** true when the protocol's OWN identification handshake is allowed on a matched interface */
  activeProbeAllowed: boolean;
  notes: string;
}
