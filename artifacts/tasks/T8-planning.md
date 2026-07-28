# T8 — Planning only: migration plan for a legacy module

Read `../../inputs/legacy-uploader.js` (relative to your working directory: the file lives at `<eval-root>/inputs/legacy-uploader.js`; you may read ONLY that file outside your directory, write nothing outside your directory).

Context you must take as given:
- This module runs in production inside an Electron main process; ~40 call sites across the app import it; behavior must not change during migration (bug-for-bug compatible, including the quirks you'll notice).
- The team wants it migrated to TypeScript + async/await + testable architecture, shipped incrementally across normal releases (no big-bang), with the ability to abort mid-migration at any release boundary.

Produce `PLAN.md` in your directory — nothing else. It must contain:
1. A findings section: every behavior, quirk, hazard, and hidden contract in the current code that constrains the migration (be specific: line references, why each matters).
2. A stepwise migration plan: concrete steps, each independently shippable and revertible, with its risk, test strategy, and how behavior-compatibility is proven at that step.
3. Explicit non-goals and the traps you are deliberately NOT fixing during migration (with the ticket-worthy list for after).
4. An estimate section: relative sizing of steps (S/M/L) and the critical path.

Judged on: completeness of hazard discovery, realism, sequencing quality, and restraint (no gold-plating, no rewrite-disguised-as-migration). Concise beats long — padding counts against you. No AI model names anywhere.
