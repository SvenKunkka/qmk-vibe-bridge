# Adapter Development (round-15)

How to add a Protocol Adapter. An adapter is the ONLY component that speaks a
keyboard protocol; everything else (transports, gate, audit, mapping) is
protocol-agnostic.

## 1. Create a profile

Add a `ProtocolProfile` in `packages/core/src/profiles/builtin.ts`:

| field | purpose |
|---|---|
| `profileId` | stable id, e.g. `my-vendor-proto` |
| `displayName` | UI name |
| `protocol` / `protocolVersion` | wire protocol identity |
| `vendorId` / `productId` | optional, for VID/PID registry matching |
| `usagePage` / `usageId` / `interface` / `reportSize` | transport signature |
| `transport` | which transports it can run over |
| `capabilities` | ALL 12 capabilities with honest states |
| `sourceUrl` / `sourceType` | where the protocol is documented (`official-docs`, `upstream-source`, `vendor-docs`, `design`) |
| `verifiedStatus` / `verifiedPlatforms` | `not-verified` / `verified-simulator` / `verified-hardware` |
| `riskLevel` | `none` / `low` / `medium` / `high` |
| `activeProbeAllowed` | whether the protocol's OWN handshake may be sent on a matched interface |
| `notes` | caveats (e.g. "same 0xFF60/0x61 caveat as VIA") |

Register it in `BUILTIN_PROFILES`.

## 2. Implement the adapter

Implement `ProtocolAdapter` (`packages/core/src/adapters/types.ts`):

```ts
interface ProtocolAdapter {
  readonly id: string;        // e.g. 'my-vendor-proto'
  readonly profileId: string; // must match the profile
  identify(ctx: AdapterContext): Promise<IdentifyResult>;
  apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult>;
  close(): Promise<void>;
}
```

Rules:

- **`identify()` must not write before the profile is matched.** The
  DeviceManager only instantiates the adapter for a matched interface. Inside
  `identify`, only the protocol's own handshake may be sent, and only when
  `activeProbeAllowed` is true. A handshake timeout returns
  `{ status: 'unknown', … }` — never "incompatible", never a write.
- **`apply()` assumes the gate already passed**, but should still fail loudly
  (`wrote: false`) for anything it cannot encode.
- Install your inbound handlers in `identify()` (or an `attach()` helper) so
  handshake replies are not lost.
- `close()` must clean up timers/waiters.

Register the adapter in `packages/core/src/adapters/factory.ts`.

## 3. Add a virtual device mode (optional but recommended)

Add a mode to `packages/simulator/src/virtual-keyboard.ts` so the adapter can
be tested without hardware, e.g. `case 'my-vendor-proto': this.runMyProto(transport)`.

## 4. Declare capabilities honestly

A protocol that does not define `display-text` must declare it
`unsupported`. A capability that depends on firmware options must be
`requires-user-profile`. Never return `supported` for something the wire
protocol cannot do — the gate and the mapping engine trust these states.

## 5. Tests

- Unit: identification, apply, error paths (`packages/core/test/`).
- Acceptance: extend `packages/simulator/test/acceptance.test.ts` with the
  new mode.
- Document the protocol in `docs/PROTOCOLS.md` and update
  `docs/CAPABILITY_MODEL.md` and `docs/COMPATIBILITY.md`.
