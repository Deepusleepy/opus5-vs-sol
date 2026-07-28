# recparse — zero-copy record parser

## What this is

A `std`-only Rust library crate (no dependencies, `#![forbid(unsafe_code)]`) that
parses a length-prefixed wire format without copying or allocating.

Format:

```text
record := u16be field_count, field * field_count
field  := u32be length, length raw bytes
```

A record with field count `0` is a heartbeat and is skipped by the iterator. The
stream may end cleanly on a record boundary; ending anywhere else is an error.

## API

- `parse(input: &[u8]) -> Records<'_>` — an iterator of `Result<Record<'_>, Error>`.
- `Record<'a>` — `len()`, `get(i) -> Option<&'a [u8]>`, `fields() -> Fields<'a>`.
  It is `Copy` and borrows the input, so records stay usable after the iterator
  is dropped or has errored.
- `Fields<'a>` — an `ExactSizeIterator<Item = &'a [u8]>`.
- `Error` — `Truncated { at }` and `LengthOverflow { at, declared }`, both
  `Display` + `std::error::Error`, both carrying the byte offset in the original
  input at which the problem was detected.

## Design notes

**Zero copy.** A `Record` holds one `&'a [u8]` spanning its field headers and
payloads plus a field count; `fields()` walks that slice re-reading each `u32`
length and handing out subslices. Nothing is copied and nothing is allocated for
either a record or a field. A unit test compares field pointers against the input
buffer's base address to assert the slices really do point into the caller's
buffer, and an integration test asserts the same for every field of every record.

**Validation up front.** A record's whole body is bounds-checked when the record
is produced, so `Record::get` and `Fields::next` are infallible. That keeps the
error type out of the accessor signatures without any unchecked indexing.

**Overflow.** Every header read goes through `read_u16` / `read_u32`, which use
`slice::get` with a `checked_add` range and return `Option` — no indexing that
could panic, and no offset arithmetic that could wrap. The declared field length
is compared against the remaining input in `u64` before any conversion to
`usize`, so the comparison itself cannot wrap on any target width, and
`usize::try_from` runs only on a value already known to be small. `pos` therefore
only ever advances by an amount that fits within the input, so it can never wrap
past the end. On 32- and 64-bit targets `LengthOverflow` is unreachable (an
over-large `u32` necessarily exceeds the input and is reported as `Truncated`);
it exists so narrower targets get a distinct, accurate error rather than a
misleading one.

**Fusing.** `Records` carries a `done` flag set on both the clean end of stream
and the first error, and implements `FusedIterator`. An error is yielded exactly
once; every later `next()` returns `None`.

**Heartbeats.** Skipping happens inside `next()`'s loop rather than recursively,
so a stream of many consecutive heartbeats uses constant stack. Tested with
10,000 of them.

## Tests

- 8 unit tests in `src/lib.rs` (header readers, short-read handling, borrowing,
  `Display` output, `std::error::Error` conformance).
- 10 integration tests in `tests/parse.rs` (well-formed streams, zero-length
  fields, heartbeat skipping, a 300 KB field, a record with `u16::MAX` fields,
  records outliving the iterator).
- 26 adversarial cases in `tests/adversarial.rs`: truncation at record headers,
  field headers, and payloads; declared lengths of `u32::MAX` and `2^31` that
  would wrap a naive accumulator; off-by-one lengths in both directions; fusing
  and error-offset invariants. Four of them are bulk sweeps: every prefix of a
  valid stream, every single-byte mutation of a valid stream across six byte
  values, 4096 pseudorandom inputs from a deterministic LCG, and every input of
  length 0..=3 over an alphabet of interesting header bytes. The sweeps assert
  only that parsing terminates without panicking and that any reported offset
  lies within the input — the properties that must hold for arbitrary bytes.
- 1 doc test.

`tests/common/mod.rs` holds the shared builder. `record()` emits well-formed
records; `raw_record_header()`, `raw_field()`, and `raw()` write headers and
payloads exactly as given, which is how the invalid streams are constructed (for
example, a field declaring 99 bytes followed by 1).

## How to verify

```sh
cargo test
cargo clippy --all-targets   # clean
```

Output tail of `cargo test`:

```
running 10 tests
test a_stream_of_only_heartbeats_yields_nothing ... ok
test empty_stream_has_no_records ... ok
test iteration_ends_cleanly_and_stays_ended ... ok
test heartbeats_are_skipped ... ok
test fields_are_slices_of_the_input_not_copies ... ok
test records_can_outlive_the_iterator ... ok
test zero_length_fields_are_preserved ... ok
test parses_multiple_records_in_order ... ok
test handles_a_large_record_and_a_large_field ... ok
test record_holds_the_maximum_field_count ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

   Doc-tests recparse

running 1 test
test src/lib.rs - (line 24) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s
```

All four test binaries pass: 8 unit + 26 adversarial + 10 integration + 1 doc = 45.

## Known limitations

- **Slice in, not stream in.** `parse` takes a `&[u8]` that must hold the whole
  input. That is what makes the zero-copy guarantee possible — borrowed fields
  cannot outlive a buffer that a reader recycles — but it means an incremental
  `Read`-based decoder would need a different API. `Error::Truncated` gives the
  offset a caller would need to resume from if they buffer and retry.
- **Errors are terminal.** After an error the iterator stops rather than trying
  to resynchronize. There is no framing marker in this format, so any resync
  would be guesswork.
- **No length cap.** A single record can declare up to 65,535 fields and each up
  to 4 GB. Since nothing is allocated, an over-large declaration costs only the
  scan, and one that exceeds the input is rejected immediately. A caller that
  wants a stricter policy can check `Record::len()` or field sizes itself.
- **`Record::is_empty` always returns `false`** for records the iterator yields,
  since heartbeats are skipped. It exists only to satisfy the usual `len` /
  `is_empty` pairing.
- **`Fields` re-reads each length header** as it walks, rather than caching
  offsets. Iterating a record's fields twice does the work twice. For records of
  this size that is cheaper than any index that would have to be allocated.
