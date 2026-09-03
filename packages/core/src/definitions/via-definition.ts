/**
 * VIA definition import (round-17). Definitions gate identity for VIA/Vial
 * devices. Import is NOT trust: every definition is size-limited, JSON-
 * schema-checked, prototype-pollution-guarded, and pinned by SHA-256.
 * First write after a definition bind always requires confirmation.
 */

import * as crypto from 'node:crypto';
import type { ViaDefinition } from '../profiles/types';

export const VIA_DEFINITION_MAX_BYTES = 1024 * 1024; // 1 MiB
export const VIA_DEFINITION_MAX_LAYOUTS = 64;
export const VIA_DEFINITION_MAX_NAME_LENGTH = 256;

export interface ViaDefinitionParseResult {
  ok: boolean;
  definition?: ViaDefinition;
  errors: string[];
  warnings: string[];
  /** human-readable preview for the UI */
  preview?: ViaDefinitionPreview;
}

export interface ViaDefinitionPreview {
  name: string;
  vendorId: string;
  productId: string;
  matrix?: string;
  layoutCount?: number;
  customKeycodeCount?: number;
  menuCount?: number;
  hash: string;
}

const HASH_PREFIX = /^0x[0-9a-fA-F]{1,6}$/;

/** Guard against prototype pollution keys at any depth. */
function hasDangerousKey(obj: unknown, path = '$'): boolean {
  if (Array.isArray(obj)) {
    return obj.some((v) => hasDangerousKey(v, `${path}[]`));
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        return true;
      }
      if (hasDangerousKey((obj as Record<string, unknown>)[k], `${path}.${k}`)) {
        return true;
      }
    }
  }
  return false;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Parse and validate a raw VIA definition JSON string.
 * Canonical hash = sha256 of the ORIGINAL string (pinned).
 */
export function parseViaDefinition(raw: string): ViaDefinitionParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, errors: ['definition is empty'], warnings };
  }
  if (Buffer.byteLength(raw, 'utf8') > VIA_DEFINITION_MAX_BYTES) {
    return { ok: false, errors: [`definition exceeds ${VIA_DEFINITION_MAX_BYTES} bytes`], warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`], warnings };
  }

  if (hasDangerousKey(parsed)) {
    return { ok: false, errors: ['definition contains dangerous keys (__proto__/constructor/prototype) — rejected'], warnings };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['definition root must be an object'], warnings };
  }
  const obj = parsed as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > VIA_DEFINITION_MAX_NAME_LENGTH) {
    errors.push(`name must be a string (1..${VIA_DEFINITION_MAX_NAME_LENGTH})`);
  }
  const vendorId = obj.vendorId;
  if (typeof vendorId !== 'string' || !HASH_PREFIX.test(vendorId)) {
    errors.push('vendorId must be a hex string like "0x5241"');
  }
  const productId = obj.productId;
  if (typeof productId !== 'string' || !HASH_PREFIX.test(productId)) {
    errors.push('productId must be a hex string like "0x1234"');
  }

  let matrix: { rows?: number; cols?: number } | undefined;
  if (obj.matrix !== undefined) {
    if (obj.matrix === null || typeof obj.matrix !== 'object') {
      errors.push('matrix must be an object {rows, cols}');
    } else {
      const m = obj.matrix as Record<string, unknown>;
      matrix = { rows: m.rows as number, cols: m.cols as number };
      if (typeof m.rows !== 'number' || typeof m.cols !== 'number' || m.rows <= 0 || m.cols <= 0) {
        errors.push('matrix rows/cols must be positive integers');
      }
    }
  }

  let layoutCount: number | undefined;
  if (obj.layouts !== undefined) {
    if (obj.layouts === null || typeof obj.layouts !== 'object') {
      errors.push('layouts must be an object');
    } else {
      const keys = Object.keys(obj.layouts as Record<string, unknown>);
      if (keys.length > VIA_DEFINITION_MAX_LAYOUTS) {
        errors.push(`too many layouts (${keys.length} > ${VIA_DEFINITION_MAX_LAYOUTS})`);
      }
      layoutCount = keys.length;
    }
  }

  let customKeycodeCount: number | undefined;
  if (Array.isArray(obj.customKeycodes)) {
    customKeycodeCount = (obj.customKeycodes as unknown[]).length;
  } else if (obj.customKeycodes !== undefined) {
    warnings.push('customKeycodes must be an array — ignored');
  }

  let menuCount: number | undefined;
  if (Array.isArray(obj.menus)) {
    menuCount = (obj.menus as unknown[]).length;
  } else if (obj.menus !== undefined) {
    warnings.push('menus must be an array — ignored');
  }

  // unknown fields are kept but never used for logic
  const known = new Set(['name', 'vendorId', 'productId', 'matrix', 'layouts', 'labels', 'customKeycodes', 'menus']);
  const extraFields = Object.keys(obj).filter((k) => !known.has(k));

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const hash = sha256Hex(raw);
  const definition: ViaDefinition = {
    name: String(name),
    vendorId: String(vendorId),
    productId: String(productId),
    matrix,
    layouts: obj.layouts as unknown,
    labels: obj.labels as unknown,
    customKeycodes: obj.customKeycodes as unknown,
    menus: obj.menus as unknown,
    extraFields,
    hash,
  };
  return {
    ok: true,
    definition,
    errors,
    warnings,
    preview: {
      name: definition.name,
      vendorId: definition.vendorId,
      productId: definition.productId,
      matrix: matrix ? `${matrix.rows}×${matrix.cols}` : undefined,
      layoutCount,
      customKeycodeCount,
      menuCount,
      hash,
    },
  };
}
