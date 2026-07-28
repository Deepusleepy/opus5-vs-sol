//! Stream builder shared by the integration tests.
//!
//! It can produce both valid streams and deliberately invalid ones: field
//! lengths are written exactly as given, so a test can declare a length that
//! does not match the payload it appends.

// This module is compiled into each test binary separately, and each one uses
// only part of it.
#![allow(dead_code)]

/// Builds a byte stream in the `recparse` wire format.
#[derive(Default)]
pub struct Builder {
    bytes: Vec<u8>,
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a well-formed record with the given fields.
    pub fn record<I, F>(mut self, fields: I) -> Self
    where
        I: IntoIterator<Item = F>,
        F: AsRef<[u8]>,
    {
        let fields: Vec<F> = fields.into_iter().collect();
        self.bytes.extend_from_slice(
            &u16::try_from(fields.len())
                .expect("field count fits in u16")
                .to_be_bytes(),
        );
        for field in &fields {
            let bytes = field.as_ref();
            self.bytes.extend_from_slice(
                &u32::try_from(bytes.len())
                    .expect("field fits in u32")
                    .to_be_bytes(),
            );
            self.bytes.extend_from_slice(bytes);
        }
        self
    }

    /// Appends a heartbeat: a record header declaring zero fields.
    pub fn heartbeat(self) -> Self {
        self.raw_record_header(0)
    }

    /// Appends a bare record header declaring `count` fields, with no fields.
    pub fn raw_record_header(mut self, count: u16) -> Self {
        self.bytes.extend_from_slice(&count.to_be_bytes());
        self
    }

    /// Appends a field header declaring `len` bytes, followed by `payload`.
    ///
    /// `len` and `payload.len()` need not agree — that is the point.
    pub fn raw_field(mut self, len: u32, payload: &[u8]) -> Self {
        self.bytes.extend_from_slice(&len.to_be_bytes());
        self.bytes.extend_from_slice(payload);
        self
    }

    /// Appends arbitrary bytes.
    pub fn raw(mut self, bytes: &[u8]) -> Self {
        self.bytes.extend_from_slice(bytes);
        self
    }

    pub fn build(self) -> Vec<u8> {
        self.bytes
    }
}

/// Collects a whole stream, asserting that every record parses.
pub fn parse_all(input: &[u8]) -> Vec<Vec<Vec<u8>>> {
    recparse::parse(input)
        .map(|record| {
            record
                .expect("stream parses cleanly")
                .fields()
                .map(<[u8]>::to_vec)
                .collect()
        })
        .collect()
}
