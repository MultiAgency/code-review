# Evaluation log

Benchmark: MultiAgency/near-agencies PRs whose `ai-review` ledger (Claude Opus 5.5, several rounds)
still had open findings at the final round. Each case replays that commit; recall is judged by an
agent (same defect?). Labels are another AI's findings, not ground truth: unmatched findings were
hand-verified separately.

- **Tuning set** (10 PRs, 26 labels, 5 Important): #129 #137 #138 #139 #145 #153 #176 #194 #200 #212
- **Held-out set** (24 PRs, 24 labels, 3 Important; 5 PRs with no labels): #133 #146 #147 #151 #152
  #154 #160 #170 #171 #177 #184 #185 #188 #197 #198 #201 #202 #208 #209 #128 #143 #163 #174 #199

Noise: the judge is stable (±1 on rescoring the same results); the reviewer varies about ±2 of 26
between runs of the same version. Compare versions on at least two runs each.

| Date  | Version                                     | Set      | Recall (runs) | Important | Findings | Cost/run | Notes                                                          |
| ----- | ------------------------------------------- | -------- | ------------- | --------- | -------- | -------- | -------------------------------------------------------------- |
| 10-21 | 3 passes, staging rules                     | tuning   | 18            | 5/5       | 39       | $11.47   | 35/39 verified real                                            |
| 10-21 | 3 passes, merge-base rules                  | tuning   | 16            | 4/5       | 30       | $10.38   | 26/30 real, 1 wrong                                            |
| 10-21 | **1 pass (v1, c7fea7a)**                    | tuning   | **18, 16**    | 5/5, 4/5  | 25, 23   | ~$5      | 23/25 real, 0 wrong → default                                  |
| 10-21 | 1 pass (v1)                                 | held-out | 14/24         | 3/3       | 40       | $8.76    | 27 real + 6 plausible, 2 wrong (5%); 0 findings on 5 clean PRs |
| 10-21 | v2: blind-spot checklist + commit messages  | tuning   | 14, 14        | 5/5, 5/5  | 30, 25   | ~$5.5    | lower → reverted                                               |
| 10-21 | v4: short tracing + commits + per-pass list | tuning   | 13, 15        | 3/5, 4/5  | 21, 27   | ~$5.2    | lower → reverted                                               |
| 10-21 | v1 at `xhigh` effort                        | tuning   | 17, 17        | 5/5, 5/5  | 31, 33   | ~$10.3   | same recall, 2× cost                                           |

Comparison on the same commits (9 tuning PRs): Private Investigator matched 3/23 labels (14
findings: 5 real, 1 plausible, 5 trivial, 3 wrong); ours 17/23 (1 pass).

Label audit (label-audit.json): of 50 labels, 35 valid, 15 trivial (e.g. `Map.groupBy` browser
support, unused bindings, docs-only PRs without a Plan), 0 wrong. Recall over valid labels:

| Version    | Tuning (19 valid) | Held-out (16 valid) |
| ---------- | ----------------- | ------------------- |
| 1 pass v1  | 15, 13 (78%, 68%) | 11 (68%)            |
| 3 passes   | 14 (73%)          |                     |
| v2 / v4    | 12, 12 / 11, 13   |                     |
| v1 `xhigh` | 15, 14            |                     |

| v1, 2 samples | 16, 15 (84%, 78%) | 11 (68%) |

Two samples: better on tuning (28/28 findings verified real), no gain on held-out at 2× cost, so the
default stays 1 sample. Held-out valid misses are systematic: 4 Compliance Nits (#130 hand-written
stubs, docs consistency) and one error-path Nit.

v1's two runs missed different valid labels (only 3 of 7 missed in both): the union of two runs
would score 16/19 (84%), which motivates review samples.

Findings so far:

- Every Important label was found by every 1-pass v1 run except one (4/5); all misses are Nits,
  mostly Compliance on the held-out set.
- Prompt additions, extra passes and more effort all left recall at ~17/26; the ceiling appears to be
  elsewhere (see the label audit).

## Tuning set 2

Earlier ledger rounds of #131 #132 #134 #135 #144 #148 #173 #180 #183 #207 (`--earlier-rounds`; 16
cases, 39 labels, 36 valid after audit). PRs that are also in the held-out set were left out.

| Version                          | Valid recall | Compliance | Important | Findings | Cost   |
| -------------------------------- | ------------ | ---------- | --------- | -------- | ------ |
| 1 pass (default)                 | 27/36 (75%)  | 3/7        | 20/22     | 59       | $10.76 |
| 1 pass + focused Compliance pass | 31/36 (86%)  | 4/7        | 22/22     | 67       | $17.27 |

One run each (the first attempt was cut off by the usage limit and resumed with `--resume`).

Held-out with the Compliance pass: valid 8/16 (50%), Compliance 7/11 (unchanged), findings on 2 of 5
clean PRs, $16.24 — worse than the 1-pass baseline (11/16), so rejected. Third tuning gain (after 2
samples and `xhigh`) that didn't generalise; held-out valid recall stays ~68% across configurations.

Fable 5.1 (`REVIEW_MODEL=claude-fable-5-1`), 1 pass, tuning set 2: valid 26/36 (72%), Important
20/22, 68 findings, $41.90 — no better than Opus 5.5 (27/36, $10.76) at ~4× cost. Not adopted.

## Where it stands (2026-10-21)

Default (1 pass, Opus 5.5, `high`) is the best measured configuration. Important labels found
every time on held-out; ≤5% wrong findings; nothing on clean PRs; ~$0.37–0.67/PR; far ahead of
Private Investigator on the same commits. Valid-label recall plateaus at ~68–75% across 1 vs 3
passes, prompt variants, `xhigh`, 2 samples, an extra Compliance pass and Fable; the remaining
held-out misses are a stable set of Compliance and error-path Nits. Next ideas, untested: a
repo-specific checklist distilled from past ai-review findings (learning from feedback), and a
larger, multi-repo eval before tuning further.
