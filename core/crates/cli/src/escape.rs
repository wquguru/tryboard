//! Byte escapes for serial text in `--uart-in` and script actions `uart=` / `usbcdc=` (F-07a).

/// `\n` -> newline, `\xNN` (two hex digits) -> that byte; anything else stays literal.
/// Only these two forms so input logs written before F-07a decode exactly as before.
pub fn unescape(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'n') {
            out.push(b'\n');
            i += 2;
            continue;
        }
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'x') {
            // Strict two hex digits: from_str_radix alone would also take "+1"
            let hex = b
                .get(i + 2..i + 4)
                .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
                .and_then(|h| std::str::from_utf8(h).ok());
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::unescape;

    #[test]
    fn newline_and_hex() {
        assert_eq!(unescape("ping\\n"), b"ping\n");
        assert_eq!(unescape("\\x01\\x05A\\x01"), [1, 5, b'A', 1]);
        assert_eq!(unescape("a\\x3bb\\xff"), [b'a', b';', b'b', 0xff]);
        assert_eq!(unescape("x\\x0d\\x0A"), b"x\r\n");
    }

    #[test]
    fn malformed_stays_literal() {
        assert_eq!(unescape("\\x"), b"\\x");
        assert_eq!(unescape("\\xg1\\x4"), b"\\xg1\\x4");
        assert_eq!(unescape("\\x+1"), b"\\x+1");
        assert_eq!(unescape("C:\\temp \\t"), b"C:\\temp \\t");
        assert_eq!(unescape("温度\\n"), "温度\n".as_bytes());
    }
}
