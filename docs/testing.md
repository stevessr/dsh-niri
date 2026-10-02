# Verification

Run from the repository root:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:helper
DSH_HARNESS_ROOT="$PWD/.harness" pnpm test:ptc
DSH_NIRI_DESKTOP_TEST=1 pnpm test:desktop
```

Prepare `.harness` with the [integration instructions](../integration/README.md) before the PTC test. Unit/stock tests substitute external commands but use real released Cordis, tool execution, subprocess management and attachment storage. Python tests cover all eight coordinate transforms, release after a failed drag, bounded tree traversal and stale-node rejection. No desktop is required for those tests.

The PTC composition loads a real `cordis.yml`, executes a real Agent with a scripted model, reconstructs its image-bearing session messages and runs actual Node TypeScript programs. It tests live Settings updates without provider replacement and direct-call denial in TypeScript-only mode. These are keyless composition tests, not a shipped-profile recorded-session snapshot suite or an LLM capability evaluation.

## Isolated desktop test

The opt-in test additionally requires `Xvfb`, `dbus-run-session`, niri, grim, wtype, system Python GI with GTK 3/AT-SPI, and the repository's `.venv` prepared as in the README. It starts niri on an atomically allocated Xvfb display with private runtime and D-Bus directories. It does not connect input to the invoking shell's compositor. The disposable GTK application publishes state files that independently verify Unicode text, pointer clicks and AT-SPI actions. The test uses the built plugin and durable image store, then joins and checks owned process exit.

Local acceptance used niri `26.04 (v26.04-160-g1f03391e)`, an llvmpipe nested output reporting `Flipped180`, and GTK 3. The test exposed and covers missing tiled-window coordinates and inverse-transform pointer mapping. Physical multi-monitor, fractional-scale, other transform orientations, XWayland and application-specific accessibility behavior remain outside that live acceptance; pure geometry tests are not substitutes for those environments. The full OSWorld benchmark is not run.

CI runs stock tests, Python helper tests and patched-Host composition tests. It does not install or launch niri. Two independent desktop test processes can run concurrently because each allocates its own display, bus and runtime directory; never point fixtures at an existing user desktop.
