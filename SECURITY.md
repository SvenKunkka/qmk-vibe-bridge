# Security

- **Default is read-only.** The "Disable all writes" master switch is ON for
  fresh installs; every write passes the 9-step Capability Gate.
- **Unknown devices stay at zero writes.** No VID/PID blind-open, no probes
  to unknown Raw HID endpoints, no fallback to other interfaces.
- **Local Agent API** listens on 127.0.0.1 only, requires a bearer token
  stored in the OS keychain (0600-file fallback, explicitly degraded), and
  never logs the token.
- **Confirmation tokens** are one-time, expire, and bind to device identity,
  endpoint, adapter, profile id/hash, operation and payload hash.
- Report issues privately to the repository owner; do not file public
  disclosures before a fix exists.
