//! A zero-copy parser for a simple length-prefixed record format.
//!
//! # Wire format
//!
//! The input is a stream of records laid out back to back:
//!
//! ```text
//! record := u16be field_count, field * field_count
//! field  := u32be length, length raw bytes
//! ```
//!
//! A record whose field count is `0` is a heartbeat: it is well formed, but
//! [`Records`] skips it rather than yielding it.
//!
//! The stream may end cleanly on a record boundary. Ending anywhere else is
//! [`Error::Truncated`].
//!
//! # Zero copy
//!
//! [`parse`] never copies field bytes and never allocates. A [`Record`] borrows
//! the input slice, and its fields are handed out as `&[u8]` views into that
//! same slice.
//!
//! ```
//! # fn main() -> Result<(), recparse::Error> {
//! let input = b"\x00\x02\x00\x00\x00\x05hello\x00\x00\x00\x00";
//! let mut records = recparse::parse(input);
//!
//! let record = records.next().unwrap()?;
//! assert_eq!(record.len(), 2);
//! assert_eq!(record.get(0), Some(&b"hello"[..]));
//! assert_eq!(record.get(1), Some(&b""[..]));
//! assert!(records.next().is_none());
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]

use std::fmt;

/// Bytes in a record header (the `u16` field count).
const RECORD_HEADER: usize = 2;
/// Bytes in a field header (the `u32` length).
const FIELD_HEADER: usize = 4;

/// A parse failure. Every variant carries the byte offset in the original input
/// at which the problem was detected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The input ended in the middle of a record.
    ///
    /// `at` is the offset of the item that could not be completed: the start of
    /// a record header, the start of a field header, or the start of a field
    /// payload. This also covers a declared field length that is larger than
    /// the number of bytes left in the input.
    Truncated { at: usize },
    /// A declared field length does not fit in `usize` on this target.
    ///
    /// Only reachable where `usize` is narrower than `u32` (e.g. 16-bit
    /// targets); on 32- and 64-bit targets an over-large length is reported as
    /// [`Error::Truncated`] instead, because it necessarily exceeds the input.
    LengthOverflow { at: usize, declared: u32 },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Error::Truncated { at } => {
                write!(f, "truncated input: incomplete record at byte offset {at}")
            }
            Error::LengthOverflow { at, declared } => write!(
                f,
                "field length {declared} at byte offset {at} does not fit in usize"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Parses `input` into an iterator of records.
///
/// See the [crate docs](crate) for the format. The iterator borrows `input`;
/// no field bytes are copied.
pub fn parse(input: &[u8]) -> Records<'_> {
    Records {
        input,
        pos: 0,
        done: false,
    }
}

/// Iterator over the records of a stream, produced by [`parse`].
///
/// Heartbeat records (field count `0`) are skipped. The iterator is fused: once
/// it yields `Err` or `None`, every later call returns `None`.
#[derive(Clone, Debug)]
pub struct Records<'a> {
    input: &'a [u8],
    pos: usize,
    done: bool,
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.done {
                return None;
            }
            if self.pos == self.input.len() {
                // Clean end of stream, on a record boundary.
                self.done = true;
                return None;
            }
            match self.next_record() {
                Ok(Some(record)) => return Some(Ok(record)),
                // A heartbeat: `self.pos` has advanced past it, keep going.
                Ok(None) => continue,
                Err(err) => {
                    self.done = true;
                    return Some(Err(err));
                }
            }
        }
    }
}

impl std::iter::FusedIterator for Records<'_> {}

impl<'a> Records<'a> {
    /// Consumes one record starting at `self.pos`, advancing `self.pos` past it.
    ///
    /// Returns `Ok(None)` for a heartbeat. On error `self.pos` is left alone;
    /// the caller stops iterating anyway.
    fn next_record(&mut self) -> Result<Option<Record<'a>>, Error> {
        let start = self.pos;
        let count = read_u16(self.input, start).ok_or(Error::Truncated { at: start })?;

        let body_start = start + RECORD_HEADER;
        let mut pos = body_start;
        for _ in 0..count {
            let declared = read_u32(self.input, pos).ok_or(Error::Truncated { at: pos })?;
            let payload_start = pos + FIELD_HEADER;
            let remaining = self.input.len() - payload_start;

            // Compare in u64 so the check itself cannot overflow or wrap on any
            // target width, then convert only a length already known to fit.
            if u64::from(declared) > remaining as u64 {
                return Err(Error::Truncated { at: payload_start });
            }
            let declared = usize::try_from(declared)
                .map_err(|_| Error::LengthOverflow { at: pos, declared })?;

            pos = payload_start + declared;
        }

        self.pos = pos;
        if count == 0 {
            return Ok(None);
        }
        Ok(Some(Record {
            body: &self.input[body_start..pos],
            count: usize::from(count),
        }))
    }
}

/// A single record, borrowed from the parsed input.
///
/// The record's bytes are validated when it is produced, so field access is
/// infallible and allocation free.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Record<'a> {
    /// The record's fields, headers included, with nothing before or after.
    body: &'a [u8],
    count: usize,
}

impl<'a> Record<'a> {
    /// Number of fields in this record. Always at least 1 (heartbeats are
    /// skipped by the iterator).
    pub fn len(&self) -> usize {
        self.count
    }

    /// Always `false`; present because clippy asks for it alongside `len`.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Iterator over the field bytes, in order.
    pub fn fields(&self) -> Fields<'a> {
        Fields {
            rest: self.body,
            remaining: self.count,
        }
    }

    /// The `index`th field, or `None` if the record has fewer fields.
    pub fn get(&self, index: usize) -> Option<&'a [u8]> {
        self.fields().nth(index)
    }
}

impl fmt::Debug for Record<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.fields()).finish()
    }
}

/// Iterator over a [`Record`]'s fields, produced by [`Record::fields`].
#[derive(Clone, Debug)]
pub struct Fields<'a> {
    rest: &'a [u8],
    remaining: usize,
}

impl<'a> Iterator for Fields<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        if self.remaining == 0 {
            return None;
        }
        // The body was validated when the record was built, so these lengths
        // and splits are known to be in bounds.
        let len = read_u32(self.rest, 0).expect("validated field header") as usize;
        let (field, rest) = self.rest[FIELD_HEADER..].split_at(len);
        self.rest = rest;
        self.remaining -= 1;
        Some(field)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.remaining, Some(self.remaining))
    }
}

impl ExactSizeIterator for Fields<'_> {}
impl std::iter::FusedIterator for Fields<'_> {}

fn read_u16(input: &[u8], at: usize) -> Option<u16> {
    let bytes = input.get(at..at.checked_add(RECORD_HEADER)?)?;
    Some(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_u32(input: &[u8], at: usize) -> Option<u32> {
    let bytes = input.get(at..at.checked_add(FIELD_HEADER)?)?;
    Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_big_endian_integers() {
        assert_eq!(read_u16(&[0x01, 0x02], 0), Some(0x0102));
        assert_eq!(
            read_u32(&[0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef], 4),
            Some(0xdead_beef)
        );
    }

    #[test]
    fn short_reads_return_none_instead_of_panicking() {
        assert_eq!(read_u16(&[0x01], 0), None);
        assert_eq!(read_u16(&[0x01, 0x02], 1), None);
        assert_eq!(read_u32(&[0, 1, 2], 0), None);
        // Offsets past the end, including ones that would overflow on add.
        assert_eq!(read_u16(&[], usize::MAX), None);
        assert_eq!(read_u32(&[], usize::MAX), None);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert_eq!(parse(b"").count(), 0);
    }

    #[test]
    fn single_record_borrows_the_input() {
        let input = b"\x00\x01\x00\x00\x00\x03abc".to_vec();
        let record = parse(&input).next().unwrap().unwrap();
        let field = record.get(0).unwrap();
        assert_eq!(field, b"abc");
        // The field points into `input` rather than into a copy.
        let base = input.as_ptr() as usize;
        let field_ptr = field.as_ptr() as usize;
        assert_eq!(field_ptr - base, 6);
    }

    #[test]
    fn fields_reports_an_exact_size() {
        let input = b"\x00\x02\x00\x00\x00\x01a\x00\x00\x00\x01b";
        let record = parse(input).next().unwrap().unwrap();
        let mut fields = record.fields();
        assert_eq!(fields.len(), 2);
        fields.next();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields.size_hint(), (1, Some(1)));
    }

    #[test]
    fn record_debug_lists_fields() {
        let input = b"\x00\x01\x00\x00\x00\x02hi";
        let record = parse(input).next().unwrap().unwrap();
        assert_eq!(format!("{record:?}"), "[[104, 105]]");
    }

    #[test]
    fn errors_display_with_offsets() {
        assert_eq!(
            Error::Truncated { at: 7 }.to_string(),
            "truncated input: incomplete record at byte offset 7"
        );
        assert_eq!(
            Error::LengthOverflow {
                at: 3,
                declared: 70_000
            }
            .to_string(),
            "field length 70000 at byte offset 3 does not fit in usize"
        );
    }

    #[test]
    fn error_is_a_std_error() {
        fn assert_error<E: std::error::Error>(_: &E) {}
        assert_error(&Error::Truncated { at: 0 });
        let boxed: Box<dyn std::error::Error> = Box::new(Error::Truncated { at: 1 });
        assert_eq!(
            boxed.to_string(),
            "truncated input: incomplete record at byte offset 1"
        );
    }
}
