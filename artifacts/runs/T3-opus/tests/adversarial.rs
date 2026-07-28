//! Adversarial tests: malformed input must produce a structured error with a
//! byte offset, never a panic, a wraparound, or a hang.

mod common;

use common::Builder;
use recparse::{parse, Error};

/// Drains an iterator and returns the first error, if any.
fn drain(input: &[u8]) -> Option<Error> {
    parse(input).find_map(Result::err)
}

/// Drains an iterator, asserting no error, and returns the record count.
fn count_ok(input: &[u8]) -> usize {
    let mut count = 0;
    for result in parse(input) {
        result.expect("no error expected");
        count += 1;
    }
    count
}

// ---------------------------------------------------------------------------
// 1-4: truncated record headers.
// ---------------------------------------------------------------------------

#[test]
fn case01_one_stray_byte() {
    assert_eq!(drain(&[0x00]), Some(Error::Truncated { at: 0 }));
}

#[test]
fn case02_stray_byte_after_a_valid_record() {
    let stream = Builder::new().record([&b"ok"[..]]).raw(&[0x00]).build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 8 }));
}

#[test]
fn case03_stray_byte_after_a_heartbeat() {
    let stream = Builder::new().heartbeat().raw(&[0xff]).build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 2 }));
}

#[test]
fn case04_record_header_declares_fields_that_are_absent() {
    let stream = Builder::new().raw_record_header(1).build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 2 }));
}

// ---------------------------------------------------------------------------
// 5-8: truncated field headers.
// ---------------------------------------------------------------------------

#[test]
fn case05_field_header_cut_in_half() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw(&[0x00, 0x00])
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 2 }));
}

#[test]
fn case06_second_field_header_missing() {
    let stream = Builder::new()
        .raw_record_header(2)
        .raw_field(1, b"a")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 7 }));
}

#[test]
fn case07_field_header_missing_its_last_byte() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw(&[0x00, 0x00, 0x00])
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 2 }));
}

#[test]
fn case08_field_count_far_exceeds_available_fields() {
    let stream = Builder::new()
        .raw_record_header(u16::MAX)
        .raw_field(0, b"")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

// ---------------------------------------------------------------------------
// 9-12: truncated field payloads.
// ---------------------------------------------------------------------------

#[test]
fn case09_payload_one_byte_short() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw_field(4, b"abc")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

#[test]
fn case10_payload_entirely_absent() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw_field(10, b"")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

#[test]
fn case11_truncation_inside_a_later_record() {
    let stream = Builder::new()
        .record([&b"first"[..]])
        .raw_record_header(1)
        .raw_field(9, b"short")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 17 }));
}

#[test]
fn case12_zero_length_field_then_truncation() {
    let stream = Builder::new()
        .raw_record_header(2)
        .raw_field(0, b"")
        .raw_field(3, b"xy")
        .build();
    // 2 header + 4 empty-field header + 4 second field header = payload at 10.
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 10 }));
}

// ---------------------------------------------------------------------------
// 13-17: huge and boundary-valued declared lengths.
// ---------------------------------------------------------------------------

#[test]
fn case13_declared_length_u32_max() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw_field(u32::MAX, b"a few bytes")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

#[test]
fn case14_declared_length_u32_max_with_no_payload_at_all() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw_field(u32::MAX, b"")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

#[test]
fn case15_declared_length_just_past_the_end() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw_field(6, b"12345")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

#[test]
fn case16_declared_length_exactly_reaching_the_end_is_valid() {
    let stream = Builder::new()
        .raw_record_header(1)
        .raw_field(5, b"12345")
        .build();
    let record = parse(&stream).next().unwrap().unwrap();
    assert_eq!(record.get(0), Some(&b"12345"[..]));
}

#[test]
fn case17_many_huge_lengths_do_not_wrap_around_to_a_valid_offset() {
    // Two fields each declaring 2^31 bytes: a naive `sum` in usize would still
    // be large, but a naive 32-bit accumulator would wrap to 0.
    let stream = Builder::new()
        .raw_record_header(2)
        .raw_field(0x8000_0000, b"")
        .raw_field(0x8000_0000, b"")
        .build();
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 6 }));
}

// ---------------------------------------------------------------------------
// 18-21: fusing and error stability.
// ---------------------------------------------------------------------------

#[test]
fn case18_iterator_is_fused_after_an_error() {
    let stream = Builder::new()
        .record([&b"good"[..]])
        .raw(&[0x00, 0x01])
        .build();
    let mut records = parse(&stream);

    assert!(records.next().unwrap().is_ok());
    assert!(records.next().unwrap().is_err());
    for _ in 0..5 {
        assert!(records.next().is_none());
    }
}

#[test]
fn case19_error_is_yielded_at_most_once() {
    let stream = [0x00, 0x01];
    let results: Vec<_> = parse(&stream).collect();
    assert_eq!(results.len(), 1);
    assert!(results[0].is_err());
}

#[test]
fn case20_records_before_an_error_are_still_usable() {
    let stream = Builder::new()
        .record([&b"keep"[..]])
        .heartbeat()
        .raw(&[0xff])
        .build();
    let mut records = parse(&stream);

    let good = records.next().unwrap().unwrap();
    assert_eq!(good.get(0), Some(&b"keep"[..]));
    // 10 bytes for the record, 2 for the heartbeat, then the stray byte.
    assert!(matches!(
        records.next(),
        Some(Err(Error::Truncated { at: 12 }))
    ));
    assert_eq!(good.get(0), Some(&b"keep"[..]));
}

#[test]
fn case21_error_offsets_are_within_the_input() {
    let stream = Builder::new()
        .record([&b"pad"[..]])
        .raw_record_header(1)
        .raw_field(99, b"x")
        .build();
    match drain(&stream) {
        Some(Error::Truncated { at }) => assert!(at <= stream.len()),
        other => panic!("expected a truncation error, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 22-25: bulk sweeps over generated inputs.
// ---------------------------------------------------------------------------

#[test]
fn case22_every_prefix_of_a_valid_stream_is_handled() {
    let stream = Builder::new()
        .record([&b""[..], &b"one"[..]])
        .heartbeat()
        .record([&b"two"[..], &b""[..], &b"three"[..]])
        .build();
    // Offsets at which a prefix is itself a complete stream: the start, the end
    // of each record, and the end of the heartbeat.
    let clean_boundaries = [
        0usize,
        2 + 4 + 4 + 3,     // end of the first record
        2 + 4 + 4 + 3 + 2, // end of the heartbeat
        stream.len(),
    ];

    for cut in 0..=stream.len() {
        let prefix = &stream[..cut];
        let err = drain(prefix);
        if clean_boundaries.contains(&cut) {
            assert_eq!(err, None, "prefix of length {cut} should parse cleanly");
        } else {
            assert!(
                matches!(err, Some(Error::Truncated { at }) if at <= cut),
                "prefix of length {cut} gave {err:?}"
            );
        }
    }
}

#[test]
fn case23_every_single_byte_mutation_is_handled_without_panicking() {
    let stream = Builder::new()
        .record([&b"aa"[..], &b"bbbb"[..]])
        .heartbeat()
        .record([&b"c"[..]])
        .build();

    for i in 0..stream.len() {
        for byte in [0x00u8, 0x01, 0x7f, 0x80, 0xfe, 0xff] {
            let mut mutated = stream.clone();
            mutated[i] = byte;
            // The only requirement is: terminates, no panic, and if it errors
            // the offset is inside the input.
            for result in parse(&mutated) {
                if let Err(Error::Truncated { at }) = result {
                    assert!(at <= mutated.len(), "offset {at} out of range at byte {i}");
                }
            }
        }
    }
}

#[test]
fn case24_pseudorandom_garbage_never_panics() {
    // A tiny deterministic LCG keeps this dependency free and reproducible.
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as u8
    };

    for len in 0..64usize {
        for _ in 0..64 {
            let input: Vec<u8> = (0..len).map(|_| next()).collect();
            let mut records = 0usize;
            for result in parse(&input) {
                match result {
                    Ok(record) => {
                        records += 1;
                        // Touch every field so bad bounds would surface.
                        let total: usize = record.fields().map(<[u8]>::len).sum();
                        assert!(total <= input.len());
                    }
                    Err(Error::Truncated { at }) => assert!(at <= input.len()),
                    Err(Error::LengthOverflow { .. }) => {}
                }
            }
            assert!(records <= input.len());
        }
    }
}

#[test]
fn case25_all_short_inputs_are_handled_exhaustively() {
    // Every possible input of length 0..=3 over a byte alphabet that hits the
    // interesting header values.
    let alphabet = [0x00u8, 0x01, 0xff];
    let mut inputs: Vec<Vec<u8>> = vec![Vec::new()];
    for _ in 0..3 {
        let mut grown = Vec::new();
        for input in &inputs {
            for &byte in &alphabet {
                let mut next = input.clone();
                next.push(byte);
                grown.push(next);
            }
        }
        inputs.extend(grown);
    }

    for input in inputs {
        for result in parse(&input) {
            if let Err(Error::Truncated { at }) = result {
                assert!(at <= input.len(), "offset {at} out of range for {input:?}");
            }
        }
    }
}

#[test]
fn case26_deeply_nested_heartbeats_then_truncation_terminate() {
    let mut builder = Builder::new();
    for _ in 0..10_000 {
        builder = builder.heartbeat();
    }
    let stream = builder.raw(&[0x00]).build();

    assert_eq!(count_ok(&stream[..stream.len() - 1]), 0);
    assert_eq!(drain(&stream), Some(Error::Truncated { at: 20_000 }));
}
