#![forbid(unsafe_code)]

//! Zero-copy parsing for a stream of length-prefixed records.
//!
//! Each record starts with a big-endian `u16` field count. Every field then
//! starts with a big-endian `u32` byte length followed by its bytes. Records
//! with no fields are heartbeats and are omitted from iteration.

use std::error;
use std::fmt;
use std::iter::FusedIterator;

/// An error encountered while parsing a record stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// The input ended in the middle of a record.
    ///
    /// `at` is the byte offset at which the input ended.
    Truncated { at: usize },
    /// A field length could not be represented or addressed on this platform.
    ///
    /// `at` is the offset of the field's four-byte length prefix.
    LengthOverflow { at: usize, length: u32 },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Truncated { at } => {
                write!(f, "record stream is truncated at byte offset {at}")
            }
            Self::LengthOverflow { at, length } => write!(
                f,
                "field length {length} at byte offset {at} cannot be addressed on this platform"
            ),
        }
    }
}

impl error::Error for Error {}

/// Returns an iterator over the non-heartbeat records in `input`.
pub fn parse(input: &[u8]) -> Records<'_> {
    Records {
        input,
        offset: 0,
        done: false,
    }
}

/// An iterator over records borrowed from an input stream.
#[derive(Clone, Debug)]
pub struct Records<'a> {
    input: &'a [u8],
    offset: usize,
    done: bool,
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }

        loop {
            if self.offset == self.input.len() {
                self.done = true;
                return None;
            }

            match parse_record(self.input, self.offset) {
                Ok((record, next_offset)) => {
                    self.offset = next_offset;
                    if record.field_count != 0 {
                        return Some(Ok(record));
                    }
                }
                Err(error) => {
                    self.done = true;
                    return Some(Err(error));
                }
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        if self.done {
            (0, Some(0))
        } else {
            (0, None)
        }
    }
}

impl FusedIterator for Records<'_> {}

/// A parsed record whose field bytes borrow directly from the input stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Record<'a> {
    encoded_fields: &'a [u8],
    field_count: usize,
}

impl<'a> Record<'a> {
    /// Returns the number of fields in the record.
    pub fn len(&self) -> usize {
        self.field_count
    }

    /// Returns whether the record has no fields.
    ///
    /// Records produced by [`parse`] are never empty because heartbeats are
    /// skipped, but this method complements [`Record::len`].
    pub fn is_empty(&self) -> bool {
        self.field_count == 0
    }

    /// Iterates over field byte slices borrowed from the original input.
    pub fn fields(&self) -> Fields<'a> {
        Fields {
            remaining: self.encoded_fields,
            fields_left: self.field_count,
        }
    }

    /// Returns a field by index, or `None` if the index is out of bounds.
    pub fn get(&self, index: usize) -> Option<&'a [u8]> {
        self.fields().nth(index)
    }
}

impl<'a> IntoIterator for &'_ Record<'a> {
    type Item = &'a [u8];
    type IntoIter = Fields<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.fields()
    }
}

/// An iterator over the fields in a [`Record`].
#[derive(Clone, Debug)]
pub struct Fields<'a> {
    remaining: &'a [u8],
    fields_left: usize,
}

impl<'a> Iterator for Fields<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        if self.fields_left == 0 {
            return None;
        }

        // Record construction validates every boundary, so these operations
        // cannot fail. Avoid indexing regardless, keeping this iterator safe
        // even if its implementation is changed independently later.
        let length_bytes = self.remaining.get(..4)?;
        let length = u32::from_be_bytes(length_bytes.try_into().ok()?);
        let length = usize::try_from(length).ok()?;
        let field_end = 4usize.checked_add(length)?;
        let field = self.remaining.get(4..field_end)?;
        self.remaining = self.remaining.get(field_end..)?;
        self.fields_left -= 1;
        Some(field)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.fields_left, Some(self.fields_left))
    }
}

impl ExactSizeIterator for Fields<'_> {}
impl FusedIterator for Fields<'_> {}

fn parse_record(input: &[u8], start: usize) -> Result<(Record<'_>, usize), Error> {
    let count_end = start.checked_add(2).ok_or(Error::LengthOverflow {
        at: start,
        length: 2,
    })?;
    let count_bytes = input
        .get(start..count_end)
        .ok_or(Error::Truncated { at: input.len() })?;
    let field_count = match count_bytes {
        [high, low] => usize::from(u16::from_be_bytes([*high, *low])),
        _ => return Err(Error::Truncated { at: input.len() }),
    };

    let fields_start = count_end;
    let mut cursor = fields_start;

    for _ in 0..field_count {
        let length_offset = cursor;
        let length_end = cursor.checked_add(4).ok_or(Error::LengthOverflow {
            at: length_offset,
            length: 4,
        })?;
        let length_bytes = input
            .get(cursor..length_end)
            .ok_or(Error::Truncated { at: input.len() })?;
        let declared = match length_bytes {
            [a, b, c, d] => u32::from_be_bytes([*a, *b, *c, *d]),
            _ => return Err(Error::Truncated { at: input.len() }),
        };
        let length = usize::try_from(declared).map_err(|_| Error::LengthOverflow {
            at: length_offset,
            length: declared,
        })?;
        let field_end = length_end
            .checked_add(length)
            .ok_or(Error::LengthOverflow {
                at: length_offset,
                length: declared,
            })?;
        input
            .get(length_end..field_end)
            .ok_or(Error::Truncated { at: input.len() })?;
        cursor = field_end;
    }

    Ok((
        Record {
            encoded_fields: &input[fields_start..cursor],
            field_count,
        },
        cursor,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_a_clean_end() {
        assert_eq!(parse(&[]).next(), None);
    }

    #[test]
    fn record_fields_borrow_from_input() {
        let input = [0, 1, 0, 0, 0, 3, 10, 20, 30];
        let record = parse(&input).next().unwrap().unwrap();
        let field = record.get(0).unwrap();

        assert_eq!(field, &[10, 20, 30]);
        assert_eq!(field.as_ptr(), input[6..].as_ptr());
    }

    #[test]
    fn display_mentions_offsets() {
        assert_eq!(
            Error::Truncated { at: 9 }.to_string(),
            "record stream is truncated at byte offset 9"
        );
        assert!(Error::LengthOverflow {
            at: 2,
            length: u32::MAX
        }
        .to_string()
        .contains("byte offset 2"));
    }
}
