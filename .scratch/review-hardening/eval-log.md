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

| Date | Version | Set | Recall (runs) | Important | Findings | Cost/run | Notes |
|---|---|---|---|---|---|---|---|
| 10-21 | 3 passes, staging rules | tuning | 18 | 5/5 | 39 | $11.47 | 35/39 verified real |
| 10-21 | 3 passes, merge-base rules | tuning | 16 | 4/5 | 30 | $10.38 | 26/30 real, 1 wrong |
| 10-21 | **1 pass (v1, c7fea7a)** | tuning | **18, 16** | 5/5, 4/5 | 25, 23 | ~$5 | 23/25 real, 0 wrong → default |
| 10-21 | 1 pass (v1) | held-out | 14/24 | 3/3 | 40 | $8.76 | 27 real + 6 plausible, 2 wrong (5%); 0 findings on 5 clean PRs |
| 10-21 | v2: blind-spot checklist + commit messages | tuning | 14, 14 | 5/5, 5/5 | 30, 25 | ~$5.5 | lower → reverted |
| 10-21 | v4: short tracing + commits + per-pass list | tuning | 13, 15 | 3/5, 4/5 | 21, 27 | ~$5.2 | lower → reverted |
| 10-21 | v1 at `xhigh` effort | tuning | 17, 17 | 5/5, 5/5 | 31, 33 | ~$10.3 | same recall, 2× cost |

Comparison on the same commits (9 tuning PRs): Private Investigator matched 3/23 labels (14
findings: 5 real, 1 plausible, 5 trivial, 3 wrong); ours 17/23 (1 pass).

Findings so far:
- Every Important label was found by every 1-pass v1 run except one (4/5); all misses are Nits,
  mostly Compliance on the held-out set.
- Prompt additions, extra passes and more effort all left recall at ~17/26; the ceiling appears to be
  elsewhere (see the label audit).
