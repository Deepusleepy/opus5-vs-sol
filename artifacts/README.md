# Opus 5 vs. Sol eval artifacts

This is the compact public artifact set behind the 28 July 2026 comparison. It contains the authored task prompts, inputs, model outputs, timing records, blind mappings, and four pairwise judge reports.

The package is intentionally not a runnable snapshot of the original machine. Installed dependencies, Rust build output, generated large fixtures, duplicated blind trees, and orchestrator completion files were removed. Package manifests and lockfiles remain so individual submissions can be installed and checked independently.

## Experiment shape

- Nine tasks received one medium-effort output from Opus 5 and one from Sol: 18 outputs.
- Five code tasks, T1/T4/T5/T6/T7, were rerun at high effort: 10 outputs.
- Total: 28 model outputs.
- Seven code tasks at medium plus five at high produced 24 code submissions. Those are the submissions described as compiling and passing their own test suites.
- T1–T8 received four blind task judgments each: two medium/final passes from Sol-family judges and two from Opus-family judges, for 32 judgments.
- T9 was adjudicated separately by Fable against a seeded 17-defect answer key and is not included in the 32 blind judgments.

Fable orchestrated the run and adjudicated the combined evidence. The four blind passes came from two model families, not four unrelated judge families.

## Layout

- `tasks/`: the nine prompts sent to both model profiles.
- `inputs/`: source material used by the planning and review tasks.
- `runs/`: the 28 model output directories plus `progress.log`.
- `review-R1.md`, `review-R2.md`: medium-round blind reviews.
- `final-judge-J1.md`, `final-judge-J2.md`: fresh final blind reviews.
- `medium-blind-mapping.txt`, `final-blind-mapping.txt`: A/B identities used to unblind the reviews.

Run-directory suffixes:

- `-opus`, `-sol`: medium-effort outputs.
- `-opushi`, `-solhi`: high-effort outputs.

## Headline result

Both Sol-family judging passes scored the eight blind tasks Opus 5–3. The Opus-family passes scored Opus 7–1 and 8–0. Because the latter judges share a family with one contestant, the public report uses the two 5–3 passes as the load-bearing comparison and treats the Opus-family reports primarily as sources of reproducible probes.

## Timing correction

Across the 14 task-effort comparisons, Sol was faster in 11. Restricting the comparison to code tasks gives Sol 10 wins in 12 comparisons. Aggregate wall-clock totals were:

| Round | Sol | Opus 5 | Opus / Sol |
|---|---:|---:|---:|
| Medium, nine tasks | 3,061s | 4,334s | 1.42× |
| High, five tasks | 3,390s | 9,206s | 2.72× |

Wall clock is not token usage or API cost.

## Reproducing checks

Each run directory is independent. Use the ecosystem command implied by its manifest:

- Go: `go test -race ./...`
- Rust: `cargo test`
- TypeScript/React: install from the included lockfile, then run the package's `test` and typecheck scripts.
- Node streaming tasks: run `node test.mjs`; large benchmark fixtures are generated locally and are not included here.

Some tests depend on the exact runtime versions used by the original judges. The final J2 report records Go 1.26.5, Rust 1.97.1, Node 24.18.0, and TypeScript 5 for its checks.

## Privacy and exclusions

The public package was scanned for absolute user paths and common credential patterns. Strings such as `Bearer alpha.Token-1`, `debug.Secret`, and React's `__SECRET_INTERNALS...` identifier are intentional test fixtures or upstream API names, not credentials.

