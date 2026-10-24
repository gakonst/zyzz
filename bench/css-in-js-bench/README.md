# css-in-js-bench Lane

`lane.patch` adds a Zyzz lane to [jantimon/css-in-js-bench](https://github.com/jantimon/css-in-js-bench) at commit `2447c52`. The lane renders the suite's 13 cases with grouped output, and the suite's own parity checks confirm that it renders the same DOM and pixels as every other lane.

`Run.ts` clones the suite into the ignored `bench/results/css-in-js-bench`, applies the patch, links the lane to this checkout, and measures the selected lanes on this machine over several rounds. Each round reverses the previous lane order, so no lane is always measured first or last, and timings report the median of the per-round medians:

```sh
# The lane imports zyzz from dist/, so build first
pnpm build
node bench/css-in-js-bench/Run.ts
```

| Variable             | Default                                         | Meaning                                                 |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `CSS_BENCH_CASES`    | every case                                      | Case glob, such as `'button-variants'`                  |
| `CSS_BENCH_COMMIT`   | `2447c52…`                                      | Suite commit the patch applies to                       |
| `CSS_BENCH_LANES`    | `zyzz,vanilla,yak-react,stylex-layers,plumeria` | Lanes to measure, in table order                        |
| `CSS_BENCH_MEASURES` | `microbench,payload`                            | Suite measures, such as `hydrate,inp,mount,screenshots` |
| `CSS_BENCH_ROUNDS`   | `3`                                             | Rounds of every lane, alternating lane order            |
| `CSS_BENCH_VERIFY`   | unset                                           | Runs the suite's parity checks after measuring          |
| `CSS_BENCH_ZYZZ`     | `link:` to this checkout                        | A published version instead, such as `0.0.42`           |

`payload` bytes are deterministic. `microbench` is renders per second, and `hydrate`, `inp`, and `mount` are milliseconds. Compare timings only between lanes measured in one run on one idle machine.

Pixel parity needs `screenshots` for `zyzz`, `vanilla`, and `styled-components`, the reference lane, plus `avifenc` on `PATH`. The checks skip the suite's WPD gate, since this script records no WPD profiles. Browser measures need the Chromium revision of the suite's Playwright, or a `PLAYWRIGHT_BROWSERS_PATH` that provides it.
