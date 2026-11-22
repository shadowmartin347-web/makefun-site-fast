# makefun-site-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/shadowmartin347-web/makefun-site-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/shadowmartin347-web/makefun-site-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: it builds the same static sites,
byte for byte, in about half the CPU time. `solve.js` re-implements the
reference build with the same semantics but a faster shape — single-pass
Markdown rendering with batched inline escaping, memoised slugs and dates,
and template rendering threaded through one output array. No dependencies,
no I/O, no cache between cases.

Verified on the practice set: all 3 cases byte-identical to makefun-site
1.0.0, and ~2x faster than the house baseline on local CPU time
(baseline 1.23s vs this entry 0.62s trimmed mean over 7 runs, same machine).

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir for answers.json> node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers each
one alone with `run()` from `solve.js`, and writes
`$MAKEFUN_OUTPUT_DIR/answers.json`. Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?ref=82qd6wet&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
