# K10 Max Codex task controller

This controller is intentionally specific to the verified keyboard interface:

- Keychron K10 Max ANSI RGB
- USB VID/PID `3434:0AA0`
- QMK Raw HID usage `FF60:0061`
- 108-key RGB matrix

It maps the 8 most recently active visible Codex tasks to F1-F8 and the 4 most
recently active top-level DeepSeek Harness tasks to F9-F12. The keyboard
firmware sends a private Raw HID slot event for those physical keys. The
controller opens the corresponding Codex task or sends a loopback-only command
to the already-open DeepSeek Harness Chrome app, which selects the matching
DeepSeek session and brings its standalone window forward. No ordinary browser
tab, global macOS shortcut, or Accessibility permission is required. The Fn
layer retains the normal media controls.

Status colors:

- blue: thinking
- purple: running a tool
- amber: waiting for input/approval
- green: completed
- red: interrupted/failed
- off: no mapped task

Every assigned status color uses QMK's firmware-native pure HSV anchors at
maximum saturation and brightness (`S=255`, `V=255`). Unassigned slots and
every non-F-row RGB position remain off.

The controller reads Codex's local SQLite databases and rollout JSONL files,
plus DSH's local Zstandard-compressed session logs. Exact DeepSeek task focus
is provided by the local `k10-dsh-focus` DSH Web client plugin and the
`k10-session` launch parameter.
Lighting writes go only to the K10 Max's existing Keychron per-key RGB RAM
command; status changes are not saved to keyboard EEPROM. A device probe
requires an exact VID/PID, usage page/id, and 108-LED response before lighting
is enabled.

## Included integration sources

- QMK keymap: `firmware/qmk/keyboards/keychron/k10_max/ansi/rgb/keymaps/codex_threads`
- DSH plugin: `tools/k10-codex-controller/dsh-plugin`
- Host controller and tests: this directory

The checked-in PWA bundle ID matches a Chrome shortcut created for
`http://127.0.0.1:3080/`. If Chrome assigns a different ID, set
`K10_DSH_APP_BUNDLE_ID` in the controller environment.

Install the DSH plugin from a repository checkout, then restart the DSH web
service:

```sh
dsh plugin --profile web add link:$PWD/tools/k10-codex-controller/dsh-plugin
```

Copy the included `codex_threads` keymap into the matching Keychron QMK fork,
compile it for `keychron/k10_max/ansi/rgb`, and flash only after confirming the
exact ANSI RGB hardware target and a working DFU recovery path.

The current Keychron QMK configuration enables `VIA_INSECURE` and the compiler
warns that this mode is susceptible to keyloggers. This integration does not
disable or suppress that warning; decide whether VIA runtime remapping is
appropriate for your threat model before flashing.

Commands:

```sh
node controller.mjs probe
node controller.mjs rgb-read
node controller.mjs slots
node controller.mjs configure-keys
node controller.mjs restore-keys
node controller.mjs bootloader
node controller.mjs run
```

`configure-keys` saves the original four-layer F-row keycodes at
`~/Library/Application Support/K10CodexController/device-backup.json` before
changing anything. `restore-keys` restores that backup.
