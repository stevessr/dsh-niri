# Optional TypeScript-only integration

Native `mode: tools` uses stock Harness `0.2.0-rc.2`. Only `mode: typescript` needs this patch and `@deepseek-ai/dsh-ptc-runtime-node`. The patch is shared with [dsh-cua-driver](https://github.com/stevessr/dsh-cua-driver), adds generic per-tool programmatic-only execution to the Host, and includes its MCP forwarding support; this niri plugin itself does not use MCP.

Prepare a separate checkout so the user's working Harness tree remains unchanged:

```sh
git clone https://github.com/stevessr/deepseek-harness.git .harness
git -C .harness checkout "$(cat integration/harness-revision.txt)"
git -C .harness apply --check ../integration/harness-programmatic-tools.patch
git -C .harness apply ../integration/harness-programmatic-tools.patch
pnpm --dir .harness install --frozen-lockfile
DSH_HARNESS_ROOT="$PWD/.harness" pnpm test:ptc
```

`vitest.ptc.config.ts` explicitly resolves this checkout's source; source tests do not validate a built application. Build the prepared Host before launching its named `dsh` profiles. Apply the patch to the Host tool registry, not a second npm copy under this plugin. Do not apply it blindly to a different revision; `harness-revision.txt` pins the supported base.

With `mode: typescript`, the model sees `run_code` and generated declarations for the niri tools. For example:

```typescript
return (await tools.niri_observe({})).data;
```

Images are forwarded as durable attachment context by Harness. Direct calls to the native niri names are denied by the patched executor. The live getter takes effect at prompt assembly and dispatch without changing global `tools.mode`. The plugin fails explicitly when the Host lacks `supportsProgrammaticOnly` or a TypeScript runtime is unavailable.
