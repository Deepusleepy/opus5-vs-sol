use recparse::{parse, Error};
use std::iter::FusedIterator;

#[derive(Default)]
struct StreamBuilder {
    bytes: Vec<u8>,
}

impl StreamBuilder {
    fn record(mut self, fields: &[&[u8]]) -> Self {
        self.bytes
            .extend_from_slice(&(fields.len() as u16).to_be_bytes());
        for field in fields {
            self.bytes
                .extend_from_slice(&(field.len() as u32).to_be_bytes());
            self.bytes.extend_from_slice(field);
        }
        self
    }

    fn heartbeat(self) -> Self {
        self.record(&[])
    }

    fn declared_field(mut self, declared_length: u32, available: &[u8]) -> Self {
        self.bytes.extend_from_slice(&1u16.to_be_bytes());
        self.bytes.extend_from_slice(&declared_length.to_be_bytes());
        self.bytes.extend_from_slice(available);
        self
    }

    fn raw(mut self, bytes: &[u8]) -> Self {
        self.bytes.extend_from_slice(bytes);
        self
    }

    fn build(self) -> Vec<u8> {
        self.bytes
    }
}

fn assert_fused<T: FusedIterator>(_iterator: &T) {}

#[test]
fn parses_multiple_records_and_zero_length_fields() {
    let input = StreamBuilder::default()
        .record(&[b"alpha", b"", &[0, 255]])
        .record(&[b"omega"])
        .build();

    let mut records = parse(&input);
    assert_fused(&records);

    let first = records.next().unwrap().unwrap();
    assert_eq!(first.len(), 3);
    assert!(!first.is_empty());
    assert_eq!(first.fields().len(), 3);
    assert_eq!(
        first.fields().collect::<Vec<_>>(),
        vec![b"alpha".as_slice(), b"".as_slice(), &[0, 255]]
    );
    assert_eq!(first.get(0), Some(b"alpha".as_slice()));
    assert_eq!(first.get(2), Some([0, 255].as_slice()));
    assert_eq!(first.get(3), None);
    assert_eq!((&first).into_iter().count(), 3);

    let second = records.next().unwrap().unwrap();
    assert_eq!(second.fields().collect::<Vec<_>>(), vec![b"omega"]);
    assert_eq!(records.next(), None);
    assert_eq!(records.next(), None);
}

#[test]
fn skips_heartbeats_before_between_and_after_records() {
    let input = StreamBuilder::default()
        .heartbeat()
        .heartbeat()
        .record(&[b"one"])
        .heartbeat()
        .record(&[b"two"])
        .heartbeat()
        .build();

    let records = parse(&input)
        .map(|record| record.unwrap().get(0).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records, vec![b"one", b"two"]);
}

#[test]
fn clean_end_after_only_heartbeats() {
    let input = StreamBuilder::default().heartbeat().heartbeat().build();
    assert_eq!(parse(&input).collect::<Vec<_>>(), Vec::new());
}

#[test]
fn every_truncation_boundary_is_an_error_and_never_panics() {
    let complete = StreamBuilder::default()
        .record(&[b"", b"abc", b"longer field"])
        .record(&[b"tail"])
        .build();

    // There are more than 20 distinct adversarial truncations here. Since the
    // complete stream contains two records, cuts at the first record boundary
    // are the only clean non-final cuts.
    let first_record_end = StreamBuilder::default()
        .record(&[b"", b"abc", b"longer field"])
        .build()
        .len();

    for cut in 0..complete.len() {
        let outcome = std::panic::catch_unwind(|| parse(&complete[..cut]).collect::<Vec<_>>());
        assert!(outcome.is_ok(), "parser panicked for truncation at {cut}");
        let results = outcome.unwrap();

        if cut == 0 || cut == first_record_end {
            assert!(results.iter().all(Result::is_ok), "cut {cut}: {results:?}");
        } else {
            assert_eq!(
                results.last(),
                Some(&Err(Error::Truncated { at: cut })),
                "cut {cut}: {results:?}"
            );
        }
    }
}

#[test]
fn huge_declared_lengths_are_structured_errors() {
    for declared in [u32::MAX, u32::MAX - 1, 0x8000_0000, 1_000_000] {
        let input = StreamBuilder::default()
            .declared_field(declared, &[1, 2, 3])
            .build();
        assert_eq!(
            parse(&input).next(),
            Some(Err(Error::Truncated { at: input.len() })),
            "declared length {declared}"
        );
    }
}

#[test]
fn incomplete_headers_report_the_end_offset() {
    let cases = [
        vec![0],
        vec![0, 1],
        vec![0, 1, 0],
        vec![0, 1, 0, 0],
        vec![0, 1, 0, 0, 0],
    ];

    for input in cases {
        assert_eq!(
            parse(&input).next(),
            Some(Err(Error::Truncated { at: input.len() }))
        );
    }
}

#[test]
fn iterator_is_fused_immediately_after_an_error() {
    let input = StreamBuilder::default()
        .record(&[b"valid"])
        .raw(&[0, 1, 0, 0])
        .build();
    let mut records = parse(&input);

    assert!(records.next().unwrap().is_ok());
    assert_eq!(
        records.next(),
        Some(Err(Error::Truncated { at: input.len() }))
    );
    for _ in 0..5 {
        assert_eq!(records.next(), None);
        assert_eq!(records.size_hint(), (0, Some(0)));
    }
}

#[test]
fn adversarial_byte_patterns_never_panic() {
    let mut cases = vec![
        vec![],
        vec![0],
        vec![255],
        vec![255, 255],
        vec![0; 3],
        vec![255; 3],
        vec![0; 4],
        vec![255; 4],
        vec![0; 5],
        vec![255; 5],
        vec![0; 6],
        vec![255; 6],
        vec![0; 7],
        vec![255; 7],
        vec![0; 8],
        vec![255; 8],
        vec![0, 1, 255, 255, 255, 255],
        vec![0, 2, 0, 0, 0, 0],
        vec![0, 2, 0, 0, 0, 0, 0, 0, 0, 0],
        vec![255, 255, 0, 0, 0, 0],
        vec![0, 1, 0, 0, 0, 1],
        vec![0, 1, 0, 0, 0, 0],
        vec![0, 0, 0],
        vec![0, 0, 255],
    ];

    // Add deterministic fuzz-like inputs without an external random crate.
    let mut state = 0x9e37_79b9u32;
    for length in 0..=64 {
        for _ in 0..8 {
            let mut input = Vec::with_capacity(length);
            for _ in 0..length {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                input.push(state as u8);
            }
            cases.push(input);
        }
    }

    for (case_index, input) in cases.iter().enumerate() {
        let outcome = std::panic::catch_unwind(|| {
            for record in parse(input).flatten() {
                for field in record.fields() {
                    std::hint::black_box(field);
                }
            }
        });
        assert!(
            outcome.is_ok(),
            "parser panicked for adversarial case {case_index}: {input:?}"
        );
    }
}
