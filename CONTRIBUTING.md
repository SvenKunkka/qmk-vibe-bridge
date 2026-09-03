# Contributing

1. Never claim a capability the protocol does not define. Add every command
   with evidence in `docs/PROTOCOL_EVIDENCE.md` first.
2. Every write path goes through the Capability Gate; tests must prove
   zero-write on unknown devices.
3. Run `npm run typecheck`, `npm test`, and `scripts/acceptance.sh` before
   opening a PR. Do not delete or weaken tests to make them pass.
4. Simulator results never substitute for real hardware verification; mark
   hardware status honestly in `docs/HARDWARE_VALIDATION.md`.
5. The project is not a public GitHub repo yet — nothing is pushed without
   the owner's explicit authorization.
