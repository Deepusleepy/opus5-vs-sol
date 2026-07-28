# Opus 5 vs Sol

I wanted to see how Opus 5 and Sol behave on the same real work, beyond whether their own test suites turn green.

Both models received the same nine tasks across Go, Rust, TypeScript, Node, React, planning, and code review. Five coding tasks were also rerun at high effort. Outputs were anonymized before cross-review.

## What happened

Both Sol-family judges independently scored the blind matchup **Opus 5, Sol 3**.

- Opus was usually more complete, more thoroughly tested, and safer on subtle failure paths.
- Sol was faster in 11 of 14 task-effort comparisons and produced much less code.
- At high effort, 2 of 2 tracked implementation bugs were fixed. None of the 5 tracked design flaws changed.
- All 24 code submissions passed their own tests. The meaningful failures appeared only when judges read against the specification or wrote new adversarial probes.

This is a small firsthand eval, not a universal model ranking.

## Read the report

The GitHub Pages site contains the result, evaluation criteria, timing and code-size comparisons, the four blind votes for every task, and expandable task-level evidence.

Open `index.html` through the repository's GitHub Pages link.

## What is in this repository

- `index.html`: the public report
- `assets/`: the share image used by the report
- `artifacts/tasks/`: the nine original task prompts
- `artifacts/runs/`: curated model-authored source, tests, manifests, summaries, plans, and reviews
- `artifacts/review-*.md` and `artifacts/final-judge-*.md`: blind judge reports
- `artifacts/*mapping.txt`: anonymous A/B mappings
- `VERIFICATION.md`: recomputed totals and publication checks
- `x-posts.md`: draft copy for sharing the experiment

Generated dependencies, build caches, Rust targets, large fixtures, duplicate blind trees, local runner configuration, and orchestration completion files are excluded.

## Important caveats

- One run per model, task, and effort level
- Systems-heavy task mix with little visual or product work
- Two judge families, not four independent judge families
- T1 through T8 produced the 32 blind judgments
- T9 was adjudicated separately against a seeded 17-defect answer key

The full artifact notes and metric definitions are in [`artifacts/README.md`](artifacts/README.md).
