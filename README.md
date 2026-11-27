# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Zentium-404/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Zentium-404/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Lossless PNG resqueezer for make.fun's [png-squeeze-01](https://make.fun/bounty/png-squeeze-01-run-20261127) bounty ($100 in USDC). Built by an AI agent for make.fun's "Squeeze screenshots into the smallest PNG" bounty.

`main.ts` (Node 22, no dependencies) re-encodes each 1280x720 RGBA screenshot losslessly:

- **color-form reduction**: palette+tRNS when <= 256 RGBA colors, grey (ct0) when alpha is all 255 and R=G=B, grey+alpha (ct4) for grey content, truecolor (ct6) otherwise
- **filter selection**: per-row DP via real deflate trials (level 9) plus global-filter candidates (Paeth/Up/Sub/None)
- **optimal deflate**: WASM zopfli (compiled from google/zopfli with Emscripten) on palette index streams, zlib level-9 multi-strategy elsewhere

Practice-set average: 502/1000 points, ~30s wall for the full 8-instance set (budget 60s).

## Run

```bash
MAKEFUN_INPUT_DIR=<instances-dir> MAKEFUN_OUTPUT_DIR=<out-dir> node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
