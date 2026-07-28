//! Integration tests for well-formed streams.

mod common;

use common::{parse_all, Builder};
use recparse::parse;

#[test]
fn empty_stream_has_no_records() {
    assert_eq!(parse_all(&[]), Vec::<Vec<Vec<u8>>>::new());
}

#[test]
fn parses_multiple_records_in_order() {
    let stream = Builder::new()
        .record([&b"alpha"[..], &b"beta"[..]])
        .record([&b"gamma"[..]])
        .build();

    assert_eq!(
        parse_all(&stream),
        vec![
            vec![b"alpha".to_vec(), b"beta".to_vec()],
            vec![b"gamma".to_vec()],
        ]
    );
}

#[test]
fn zero_length_fields_are_preserved() {
    let stream = Builder::new()
        .record([&b""[..], &b"x"[..], &b""[..]])
        .build();

    let record = parse(&stream).next().unwrap().unwrap();
    assert_eq!(record.len(), 3);
    assert_eq!(record.get(0), Some(&b""[..]));
    assert_eq!(record.get(1), Some(&b"x"[..]));
    assert_eq!(record.get(2), Some(&b""[..]));
    assert_eq!(record.get(3), None);
}

#[test]
fn heartbeats_are_skipped() {
    let stream = Builder::new()
        .heartbeat()
        .heartbeat()
        .record([&b"payload"[..]])
        .heartbeat()
        .build();

    assert_eq!(parse_all(&stream), vec![vec![b"payload".to_vec()]]);
}

#[test]
fn a_stream_of_only_heartbeats_yields_nothing() {
    let stream = Builder::new().heartbeat().heartbeat().heartbeat().build();
    assert_eq!(parse(&stream).count(), 0);
}

#[test]
fn fields_are_slices_of_the_input_not_copies() {
    let stream = Builder::new()
        .record([&b"first"[..], &b"second"[..]])
        .build();
    let base = stream.as_ptr() as usize;
    let end = base + stream.len();

    for record in parse(&stream) {
        for field in record.unwrap().fields() {
            let addr = field.as_ptr() as usize;
            assert!(
                (base..=end).contains(&addr),
                "field at {addr:#x} is outside the input buffer {base:#x}..{end:#x}"
            );
        }
    }
}

#[test]
fn handles_a_large_record_and_a_large_field() {
    let big = vec![b'z'; 300_000];
    let many: Vec<&[u8]> = (0..1000).map(|_| &b"f"[..]).collect();
    let stream = Builder::new().record([&big[..]]).record(many).build();

    let mut records = parse(&stream);
    let first = records.next().unwrap().unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first.get(0).unwrap().len(), 300_000);
    let second = records.next().unwrap().unwrap();
    assert_eq!(second.len(), 1000);
    assert!(second.fields().all(|f| f == b"f"));
    assert!(records.next().is_none());
}

#[test]
fn record_holds_the_maximum_field_count() {
    let fields: Vec<&[u8]> = (0..u16::MAX as usize).map(|_| &b""[..]).collect();
    let stream = Builder::new().record(fields).build();

    let record = parse(&stream).next().unwrap().unwrap();
    assert_eq!(record.len(), usize::from(u16::MAX));
    assert_eq!(record.fields().count(), usize::from(u16::MAX));
}

#[test]
fn iteration_ends_cleanly_and_stays_ended() {
    let stream = Builder::new().record([&b"one"[..]]).build();
    let mut records = parse(&stream);

    assert!(records.next().is_some());
    assert!(records.next().is_none());
    assert!(records.next().is_none());
    assert!(records.next().is_none());
}

#[test]
fn records_can_outlive_the_iterator() {
    let stream = Builder::new().record([&b"kept"[..]]).build();
    let collected: Vec<_> = parse(&stream).map(Result::unwrap).collect();
    assert_eq!(collected[0].get(0), Some(&b"kept"[..]));
}
