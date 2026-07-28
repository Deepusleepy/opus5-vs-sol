# T9 — Review only: find the defects

Two source files live at `<eval-root>/inputs/review-target/` (`sessionstore.go` and `budget.ts`). Read them (read-only; write nothing outside your own directory). They are excerpts from a session/budget subsystem; assume the described intent in each file's header comment is the truth.

Produce `REVIEW.md` in your directory — nothing else. For each defect you find, give:
- file:line
- severity (blocker / major / minor)
- a one-sentence claim of what is wrong
- a concrete failure scenario (inputs/state → wrong outcome)
- a minimal suggested fix (a sentence or a few lines, not a rewrite)

Rules: report REAL defects (logic, concurrency, correctness, resource, data-integrity). Style nits and speculative "could be improved" items go in a separate short section at the end and don't count. False positives count against you — only claim what you can defend from the code as written. Rank the whole list most-severe first. No AI model names anywhere.
