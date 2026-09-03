/**
 * Profile registry lookup (round-17). Deterministic matching priority:
 *
 *   4. user-explicit binding with a VALID definition hash
 *   3. exact verified profile (VID/PID registry entry or official match)
 *   2. clear protocol identification (GATT service UUID, or user-assigned
 *      profile without definition requirements)
 *   1. transport-only (bare QMK Raw HID 0xFF60/0x61)
 *
 * Ambiguity (multiple matches at the same top rank) keeps the device
 * read-only and requires the user to pick explicitly.
 *
 * Profiles: built-in set + user-imported profiles (persisted by the core).
 * A bare Raw HID interface matches ONLY the transport profile unless a
 * higher-ranked match exists — never by VID/PID alone.
 */

import { BUILTIN_PROFILES, isQmkRawHidInterface } from './builtin';
import type { ProtocolProfile, ViaDefinition } from './types';

export interface InterfaceDescriptor {
  path?: string;
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usageId?: number;
  kind: string;
  serviceUuids?: string[];
  label: string;
}

export type MatchRank = 4 | 3 | 2 | 1;

export interface ProfileMatch {
  profile: ProtocolProfile;
  /** how this match was established */
  matchedBy: 'definition-bound' | 'vid-pid-registry' | 'gatt-service' | 'user-assigned' | 'usage-page';
  rank: MatchRank;
  /** definition hash when this match is definition-bound */
  definitionHash?: string;
}

export interface DefinitionBinding {
  interfacePath: string;
  profileId: string;
  definitionHash: string;
  boundAt: number;
}

const ZMK_STUDIO_GATT_SERVICE = '00000000-0196-6107-c967-c5cfb1c2482a';

/** VID/PID registry: populated from upstream sources; empty until entries are
 *  verified (honest-by-default). */
const VID_PID_REGISTRY: Array<{ vendorId: number; productId: number; profileId: string }> = [];

export class ProfileRegistry {
  private readonly profiles = new Map<string, ProtocolProfile>();
  private readonly userAssigned = new Map<string, string>(); // interfacePath -> profileId
  private readonly bindings = new Map<string, DefinitionBinding>(); // interfacePath -> binding
  private readonly imported = new Map<string, ProtocolProfile>(); // profileId -> imported profile
  private readonly definitions = new Map<string, ViaDefinition>(); // profileId -> definition

  constructor(profiles: ProtocolProfile[] = BUILTIN_PROFILES) {
    for (const p of profiles) this.profiles.set(p.profileId, p);
  }

  all(): ProtocolProfile[] {
    return [...this.profiles.values(), ...this.imported.values()];
  }

  get(profileId: string): ProtocolProfile | undefined {
    return this.profiles.get(profileId) ?? this.imported.get(profileId);
  }

  /** User explicitly assigns a profile to an exact interface (no definition). */
  assignProfile(interfacePath: string, profileId: string): void {
    this.userAssigned.set(interfacePath, profileId);
  }

  unassignProfile(interfacePath: string): void {
    this.userAssigned.delete(interfacePath);
    this.bindings.delete(interfacePath);
  }

  assignedProfileId(interfacePath: string): string | undefined {
    return this.userAssigned.get(interfacePath);
  }

  /** Import a user profile (definition included). Hash-pinned. */
  importProfile(profile: ProtocolProfile, definition?: ViaDefinition): void {
    this.imported.set(profile.profileId, profile);
    if (definition) {
      this.definitions.set(profile.profileId, definition);
    }
  }

  /** Remove an imported profile; also drops its bindings. */
  removeImportedProfile(profileId: string): void {
    this.imported.delete(profileId);
    this.definitions.delete(profileId);
    for (const [path, b] of [...this.bindings]) {
      if (b.profileId === profileId) this.bindings.delete(path);
    }
  }

  importedProfiles(): ProtocolProfile[] {
    return [...this.imported.values()];
  }

  getDefinition(profileId: string): ViaDefinition | undefined {
    return this.definitions.get(profileId);
  }

  /**
   * Bind a definition to an interface (user explicit). The binding carries
   * the definition hash; the match is rank 4 ONLY while the hash is valid
   * (i.e. the imported definition still matches).
   */
  bindDefinition(interfacePath: string, profileId: string, definitionHash: string): void {
    const def = this.definitions.get(profileId);
    if (!def || def.hash !== definitionHash) {
      throw new Error(`definition for ${profileId} is not imported or hash mismatch`);
    }
    this.userAssigned.set(interfacePath, profileId);
    this.bindings.set(interfacePath, { interfacePath, profileId, definitionHash, boundAt: Date.now() });
  }

  bindingFor(interfacePath: string): DefinitionBinding | undefined {
    return this.bindings.get(interfacePath);
  }

  /**
   * Deterministic profile matching with ranks. Returns matches sorted by
   * rank desc; `ambiguous` is true when the TOP rank has more than one match.
   */
  match(iface: InterfaceDescriptor): { matches: ProfileMatch[]; ambiguous: boolean } {
    const out: ProfileMatch[] = [];

    // rank 4: user-explicit binding with a valid definition hash
    if (iface.path) {
      const binding = this.bindings.get(iface.path);
      if (binding) {
        const def = this.definitions.get(binding.profileId);
        if (def && def.hash === binding.definitionHash) {
          const p = this.get(binding.profileId);
          if (p) {
            out.push({ profile: p, matchedBy: 'definition-bound', rank: 4, definitionHash: binding.definitionHash });
          }
        } else {
          // binding hash is stale/invalid -> downgrade to user-assigned (rank 2)
          const p = this.get(binding.profileId);
          if (p) out.push({ profile: p, matchedBy: 'user-assigned', rank: 2 });
        }
      }
    }

    // rank 3: exact verified profile via VID/PID registry
    for (const entry of VID_PID_REGISTRY) {
      if (entry.vendorId === iface.vendorId && entry.productId === iface.productId) {
        const p = this.get(entry.profileId);
        if (p) out.push({ profile: p, matchedBy: 'vid-pid-registry', rank: 3 });
      }
    }

    // rank 2: clear protocol identification
    if (iface.kind === 'ble' && iface.serviceUuids?.includes(ZMK_STUDIO_GATT_SERVICE)) {
      const p = this.get('zmk-studio');
      if (p) out.push({ profile: p, matchedBy: 'gatt-service', rank: 2 });
    }
    if (iface.path) {
      const assigned = this.userAssigned.get(iface.path);
      if (assigned && !this.bindings.has(iface.path)) {
        const p = this.get(assigned);
        if (p) out.push({ profile: p, matchedBy: 'user-assigned', rank: 2 });
      }
    }

    // rank 1: transport-only (bare QMK Raw HID)
    if (isQmkRawHidInterface(iface.usagePage, iface.usageId)) {
      const p = this.get('qmk-rawhid');
      if (p && !out.some((m) => m.profile.profileId === 'qmk-rawhid')) {
        out.push({ profile: p, matchedBy: 'usage-page', rank: 1 });
      }
    }

    out.sort((a, b) => b.rank - a.rank);
    const topRank = out[0]?.rank;
    const ambiguous = out.filter((m) => m.rank === topRank).length > 1;
    return { matches: out, ambiguous };
  }
}

export const ZMK_STUDIO_GATT_SERVICE_UUID = ZMK_STUDIO_GATT_SERVICE;
