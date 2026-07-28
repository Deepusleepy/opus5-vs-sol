# T3 — Rust: zero-copy record parser

Implement a zero-copy parser for a simple wire format, as a Rust library crate `recparse` (no external dependencies; std only).

Format (byte-oriented):
- A stream of records. Each record: `u16 big-endian field count`, then per field: `u32 big-endian length` + that many raw bytes.
- A record with field count 0 is a heartbeat and must be skipped by the iterator.
- The stream may end cleanly between records; ending inside a record is `Error::Truncated { at: usize }`.

Requirements:
- `parse(input: &[u8]) -> Records<'_>` returning an iterator of `Result<Record<'_>, Error>`; `Record` exposes fields as `&[u8]` slices borrowed from the input — NO copying of field bytes, no `Vec<u8>` per field.
- Malformed input must never panic (fuzz-ish test with adversarial inputs required: truncations at every boundary, huge declared lengths, zero-length fields).
- A declared field length that would overflow usize or exceed remaining input must produce a structured error with byte offset, not a panic or wraparound. Be careful with integer conversion/overflow on 32- vs 64-bit.
- `Error` implements `std::error::Error` + `Display` with useful offsets.
- Iterator must be fused after the first error.

Deliverables in this directory only:
- `cargo init`-style crate (Cargo.toml, src/lib.rs, tests/), unit + integration tests including a builder helper that constructs valid/invalid streams, and at least 20 adversarial cases.
- `cargo test` green; include output tail in SUMMARY.md. `#![forbid(unsafe_code)]`.
- `SUMMARY.md` as in T1. No AI model names anywhere. Simplicity counts; unnecessary generics/traits count against you.
