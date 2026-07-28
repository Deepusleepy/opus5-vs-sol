# Verification record

## Counts

- 28 run directories exist: 18 medium outputs across T1–T9 and 10 high outputs across T1/T4/T5/T6/T7.
- 24 of those are code submissions: 14 medium and 10 high.
- The 32 blind judgments are T1–T8 across R1, R2, J1, and J2.
- T9 is separate and was checked by Fable against a seeded answer key.

## Recomputed timing

Medium totals from `.elapsed_seconds`:

- Sol: 224 + 268 + 261 + 338 + 940 + 236 + 367 + 263 + 164 = 3,061 seconds.
- Opus: 355 + 613 + 426 + 535 + 763 + 340 + 871 + 236 + 195 = 4,334 seconds.
- Ratio: 4,334 / 3,061 = 1.416, reported as 1.4×.
- Per-task averages across nine tasks: Sol 340.1s (5m 40s); Opus 481.6s (8m 02s).

High totals:

- Sol: 379 + 438 + 381 + 1,526 + 666 = 3,390 seconds.
- Opus: 941 + 2,684 + 2,069 + 1,283 + 2,229 = 9,206 seconds.
- Ratio: 9,206 / 3,390 = 2.716, reported as 2.7×.
- Per-task averages across five tasks: Sol 678.0s (11m 18s); Opus 1,841.2s (30m 41s).

Sol was faster on 11 of 14 task-effort comparisons overall, or 10 of 12 coding comparisons.

## Deliverables

- Sol supplied `SUMMARY.md` in 1/7 medium coding runs and 2/5 high coding runs: 3/12 total.
- Opus supplied it in 7/7 medium coding runs and 4/5 high coding runs: 11/12 total.

## Recurrence matrix

- Mechanical bugs fixed at high effort: T4 Sol float drift; T6 Sol non-object JSON handling. Result: 2/2.
- Design flaws still present at high effort: T5 Sol in-band `DeadlineError`; T7 Sol commit-on-throw; T7 Sol render-guard latch; T1 Opus shutdown over-wait; T5 Opus early deadline rejection. Result: 0/5 fixed.

## Public-language checks

- “All green” is explicitly limited to the 24 code submissions.
- The report calls the review structure two judge families across four passes.
- The 25–7 aggregate is disclosed but not used as the headline.
- Wall-clock time, source lines, and test counts are kept separate. No token or monetary cost claim is made.
