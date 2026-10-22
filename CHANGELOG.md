# Changelog

## 0.3.1 — 2026-10-22

- Implement `imageRequestTarget` on the vision adapter, with delegation to modern hosts and a source-size fallback for older hosts.
- Preserve host attachment read failures instead of bypassing integrity checks through raw file reads.
- Resolve model metadata once during preparation and derive both wrapper metadata and the generation snapshot from it.
- Document native DSH image capabilities and the plugin's remaining uses.
- Add a dependency-free simulated-host regression suite with `npm test`.

Validation: host/client syntax checks, simulated-host regressions and npm package inspection. Desktop GUI and external generation/vision backends have not been tested for this release.
