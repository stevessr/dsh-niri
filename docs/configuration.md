# Configuration reference

These settings belong to the `@stevessr/dsh-niri` Cordis entry. Defaults are validated by [Config](../src/config.ts). Only `readOnly` and `mode` are live settings; reload the entry after changing deployment settings.

| Field | Default | Meaning |
| --- | --- | --- |
| `readOnly` | `true` | Reject focus/layout changes and all input; observations remain available |
| `mode` | `tools` | Native tools, or `typescript` with the patched Host and Node PTC runtime |
| `niriCommand` / `grimCommand` / `wtypeCommand` / `pythonCommand` | `niri` / `grim` / `wtype` / `python3` | PATH names or absolute executable paths; never shell fragments |
| `socketPath` | `NIRI_SOCKET` | Absolute niri IPC socket path |
| `waylandDisplay` | `WAYLAND_DISPLAY` | Wayland socket name or absolute path |
| `runtimeDir` | `XDG_RUNTIME_DIR` | Absolute directory for the chosen Wayland session |
| `dbusAddress` | `DBUS_SESSION_BUS_ADDRESS` | Matching session bus for AT-SPI; not the accessibility bus itself |
| `accessibility` | `true` | Enable AT-SPI tools; `false` avoids the GI dependency but still exposes explicit unavailable-tool errors |
| `allowedAppIds` | `[]` | Exact app IDs allowed for window selection; empty means all, not a pixel/input sandbox |
| `commandTimeoutMs` | `15000` | Startup and complete queued-call deadline, including queue wait |
| `terminationGraceMs` | `1000` | Grace before the managed subprocess runtime escalates termination |
| `maxOutputBytes` | `1048576` | Per-command stdout/stderr retention; truncated stdout rejects |
| `maxImageBytes` | `16777216` | PNG file size limit before attachment normalization |
| `maxSnapshots` | `16` | In-memory observation capabilities; oldest evicted first |
| `snapshotTtlMs` | `30000` | Capability lifetime from observation completion |
| `maxPendingCalls` | `32` | Running plus queued calls; overflow rejects |
| `maxTreeNodes` | `256` | Bounded accessibility traversal; result reports truncation |
| `maxTreeDepth` | `12` | Maximum accessibility path depth |
| `maxTextLength` | `16384` | Typed text length and per-node accessible-name limit |

The plugin reserves the shared `computerUse` slot and creates an isolated **local** subprocess provider. A profile's SSH subprocess provider never receives desktop commands. Commands receive scrubbed environment variables through Harness; text and helper requests travel over stdin, not a shell command line. Startup verifies compositor socket ownership, protocol versions and niri IPC version output. Missing external executables fail when first invoked.

Screenshots use `grim -s 1`; image coordinates are remapped after attachment normalization. Output-local logical coordinates are inverse-transformed before virtual-pointer input because niri applies the output transform to absolute-device coordinates. Unknown transforms reject rather than guessing.
