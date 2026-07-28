# X post drafts

Attach `assets/opus-vs-sol-results-v10.png` to the main post. Replace the two link placeholders after hosting.

## 1. Firsthand and balanced — 1,379 chars

<!-- draft-1-start -->
came across Opus 5 and Sol being described as strong in pretty different ways, so i wanted to see what that difference looked like on the same work.

i gave both models 9 tasks across Go, Rust, TypeScript, Node, React, planning and code review. same prompts, one medium-effort run each, then 5 coding tasks again at high effort. 28 outputs in total.

Fable orchestrated the eval, then outputs were anonymized as A/B and reviewed by both Sol- and Opus-family judges. the two Sol judges independently scored it Opus 5, Sol 3. that is the result i trust most. the Opus judges swept their own family, so i would not use the 25–7 aggregate as the headline.

Opus was usually better when the spec was dense and the failure was subtle. it also took 1.4x the aggregate wall time at medium effort, 2.7x at high, and produced 1.7–2.4x as many lines.

Sol was faster on 11/14 task-effort comparisons and consistently leaner, but its tests were thinner and it missed more secondary deliverables.

the most interesting part was what happened when effort went up: both mechanical bugs i tracked were fixed. none of the 5 design-level flaws moved.

more effort helped with arithmetic and missed input shapes. it did not make either model reconsider what a deadline, transaction or error type should mean.

small sample, systems-heavy tasks, n=1 per task/effort. full report and artifacts below.
<!-- draft-1-end -->

## 2. More conversational — 1,176 chars

<!-- draft-2-start -->
i've been trying to figure out where Opus 5 and Sol actually feel different, beyond one being “smarter” and the other being “faster.”

so i gave them the same 9 engineering tasks, reran 5 at high effort, anonymized the outputs, and had Sol/Opus-family judges review both sides. 28 outputs, 32 blind task judgments.

both Sol judges landed on the same score: Opus 5, Sol 3.

that matched the code. Opus caught more subtle spec failures and wrote much deeper tests. Sol was faster on 11/14 comparisons and way leaner. Opus used 1.4x the wall time at medium effort and 2.7x at high, with 1.7–2.4x as many lines.

raising effort produced the part i did not expect. Sol fixed a float-drift bug and a JSON input-shape crash completely. but across both models, all 5 design mistakes survived.

one Opus bug even came back with the same behavior plus a comment explaining why the behavior was correct lol.

my read: use higher effort when the model missed arithmetic, boundaries or an input shape. when the disagreement is about lifecycle or semantics, get another model to review the design.

this is a small systems-heavy eval, not a universal ranking. report + raw artifacts below.
<!-- draft-2-end -->

## 3. Green-tests angle — 1,097 chars

<!-- draft-3-start -->
wanted to get a better feel for Opus 5 vs Sol, so i put both through the same 9-task eval and had their outputs reviewed blind.

the weirdest result was that all 24 code submissions compiled and passed their own tests. every meaningful defect in the report came from reading against the spec or writing a new adversarial probe.

on the actual matchup, both Sol-family judges independently scored it Opus 5, Sol 3. Opus was generally better on subtle correctness and proof quality. Sol was faster on 11/14 task-effort comparisons and produced much less code.

i also reran 5 tasks at high effort. it fixed 2/2 mechanical bugs, things like float arithmetic and an unhandled JSON shape. it fixed 0/5 design flaws, things like transaction rollback, error semantics and shutdown behavior.

so “turn effort up” seems useful when the model overlooked a case. much less useful when it made a defensible-looking design decision and needs to rethink the frame.

n=1 per task/effort and a systems-heavy task set, so take it as one hands-on comparison, not a leaderboard. full methodology and artifacts below.
<!-- draft-3-end -->

## Pick

**#1** is the recommended post. It starts with the human reason for testing, gives enough setup to make the result meaningful, separates speed from code volume, and surfaces the judge-family caveat before anyone else has to.

## Supporting replies

### Reply 1: methodology and caveats — 222 chars

<!-- reply-1-start -->
caveats: n=1 per model/task/effort, no variance estimate, systems-heavy tasks, and only two judge families. T2/T3/T8 were re-judged on unchanged artifacts. T9 used a seeded answer key and is outside the 32 blind judgments.
<!-- reply-1-end -->

### Reply 2: links — 115 chars plus URL weighting

<!-- reply-2-start -->
full writeup: [REPORT_URL]

task prompts, model outputs, timings, blind mappings and judge reports: [ARTIFACTS_URL]
<!-- reply-2-end -->

### Optional reply 3: the portable testing lesson — 252 chars

<!-- reply-3-start -->
the most portable finding: all 24 code submissions passed. every defect came from checking the implementation against the spec or adding a probe the author did not think to write.

“tests pass” is weak evidence if a test never proves its preconditions.
<!-- reply-3-end -->
