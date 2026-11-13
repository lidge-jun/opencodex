//! RFC 6455 framing for the Responses WebSocket over a Remote Link (design T4 3.3).
//!
//! ocx-child is both ends of the relay: a server toward Codex (frames Codex sends are masked, frames it
//! receives must not be) and a client toward the Home (the reverse). One reader handles both roles and
//! enforces the same rules the TypeScript Child's framer does:
//!
//! - RSV bits zero; opcodes 0, 1, 2, 8, 9 and 10 only;
//! - control frames of at most 125 bytes and never fragmented;
//! - continuation frames only inside a message, and a new data frame only outside one;
//! - minimal length encoding, with the top bit of a 64-bit length zero;
//! - masking as the role requires: frames from a client masked, frames from a server unmasked;
//! - UTF-8 validation of complete text messages and close reasons (a leading U+FEFF is kept);
//! - close codes 1000-1003, 1007-1014 and 3000-4999 only;
//! - a message limit checked before a payload is held, and at most a bounded number of fragments;
//! - at most the limit plus a 14-byte header held: an unfragmented message gets a buffer of its exact
//!   size, a fragmented one is written into one buffer reserved once at the limit (no growth), and a
//!   control frame between fragments uses its own buffer of at most 125 bytes.
//!
//! A violation returns the fault whose close code to send; events completed earlier in the same input
//! are already in the caller's vector. The reader never interprets a message.

/// Largest control-frame payload.
pub const MAX_CONTROL_PAYLOAD: usize = 125;

/// Which peer the bytes come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Frames a client sent (Codex): each must be masked.
    FromClient,
    /// Frames a server sent (the Home): none may be masked.
    FromServer,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameEvent {
    Text(String),
    /// A binary message, by size only.
    Binary(usize),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    /// A close frame: its code (None when it carried none) and reason.
    Close(Option<u16>, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolFault {
    Protocol,
    Utf8,
    TooLarge,
}

impl ProtocolFault {
    /// The close code to send for this fault.
    pub fn close_code(self) -> u16 {
        match self {
            ProtocolFault::Protocol => 1002,
            ProtocolFault::Utf8 => 1007,
            ProtocolFault::TooLarge => 1009,
        }
    }
}

/// A close code that may appear in a close frame on the wire (1004, 1005, 1006 and 1015 never may).
pub fn is_wire_close_code(code: u16) -> bool {
    (1000..=1003).contains(&code) || (1007..=1014).contains(&code) || (3000..=4999).contains(&code)
}

struct Frame {
    fin: bool,
    opcode: u8,
    mask: Option<[u8; 4]>,
    len: usize,
    filled: usize,
    /// True when the payload goes into the reassembly buffer.
    fragment: bool,
    own: Vec<u8>,
}

pub struct FrameReader {
    role: Role,
    max_message: usize,
    max_fragments: usize,
    header: [u8; 14],
    header_len: usize,
    header_needed: usize,
    frame: Option<Frame>,
    assembly: Option<Vec<u8>>,
    fragment_count: usize,
    /// Opcode of the message in progress (1 or 2), or 0 outside a message.
    message_opcode: u8,
    done: bool,
}

impl FrameReader {
    pub fn new(role: Role, max_message: usize, max_fragments: usize) -> Self {
        Self {
            role,
            max_message,
            max_fragments,
            header: [0; 14],
            header_len: 0,
            header_needed: 2,
            frame: None,
            assembly: None,
            fragment_count: 0,
            message_opcode: 0,
            done: false,
        }
    }

    /// True once a close frame was read or a fault was returned; later bytes are ignored.
    pub fn closed(&self) -> bool {
        self.done
    }

    /// Payload and header bytes this reader holds right now.
    pub fn held_bytes(&self) -> usize {
        let own = self.frame.as_ref().map_or(0, |f| f.own.capacity());
        self.assembly.as_ref().map_or(0, |a| a.capacity()) + own + self.header_len
    }

    /// Feed bytes off the socket. Completed events are appended to `events` in wire order, also when a
    /// later frame in the same input is refused.
    pub fn push(&mut self, data: &[u8], events: &mut Vec<FrameEvent>) -> Result<(), ProtocolFault> {
        let result = self.push_inner(data, events);
        if result.is_err() {
            self.done = true;
            self.frame = None;
            self.assembly = None;
        }
        result
    }

    fn push_inner(
        &mut self,
        data: &[u8],
        events: &mut Vec<FrameEvent>,
    ) -> Result<(), ProtocolFault> {
        let mut offset = 0;
        while offset < data.len() && !self.done {
            if self.frame.is_none() {
                let take = (self.header_needed - self.header_len).min(data.len() - offset);
                self.header[self.header_len..self.header_len + take]
                    .copy_from_slice(&data[offset..offset + take]);
                self.header_len += take;
                offset += take;
                if self.header_len < self.header_needed {
                    continue;
                }
                if self.header_needed == 2 {
                    self.header_needed = self.first_two()?;
                    if self.header_len < self.header_needed {
                        continue;
                    }
                }
                self.start_frame(events)?;
                continue;
            }
            let frame = self.frame.as_mut().expect("frame in progress");
            let take = (frame.len - frame.filled).min(data.len() - offset);
            let chunk = &data[offset..offset + take];
            let target: &mut Vec<u8> = if frame.fragment {
                self.assembly.as_mut().expect("reassembly buffer")
            } else {
                &mut frame.own
            };
            match frame.mask {
                Some(mask) => {
                    let base = frame.filled;
                    target.extend(
                        chunk
                            .iter()
                            .enumerate()
                            .map(|(i, b)| b ^ mask[(base + i) & 3]),
                    );
                }
                None => target.extend_from_slice(chunk),
            }
            frame.filled += take;
            offset += take;
            if frame.filled == frame.len {
                let done = self.frame.take().expect("frame in progress");
                self.end_frame(done, events)?;
            }
        }
        Ok(())
    }

    /// Validate the first two header bytes; returns the full header length.
    fn first_two(&self) -> Result<usize, ProtocolFault> {
        let (b0, b1) = (self.header[0], self.header[1]);
        let fin = b0 & 0x80 != 0;
        let opcode = b0 & 0x0f;
        let masked = b1 & 0x80 != 0;
        let len7 = b1 & 0x7f;
        if b0 & 0x70 != 0 || ![0, 1, 2, 8, 9, 10].contains(&opcode) {
            return Err(ProtocolFault::Protocol);
        }
        if masked != (self.role == Role::FromClient) {
            return Err(ProtocolFault::Protocol);
        }
        if opcode >= 8 && (!fin || len7 > 125) {
            return Err(ProtocolFault::Protocol);
        }
        if opcode == 0 && self.message_opcode == 0 {
            return Err(ProtocolFault::Protocol);
        }
        if (opcode == 1 || opcode == 2) && self.message_opcode != 0 {
            return Err(ProtocolFault::Protocol);
        }
        let extended = match len7 {
            126 => 2,
            127 => 8,
            _ => 0,
        };
        Ok(2 + extended + if masked { 4 } else { 0 })
    }

    fn start_frame(&mut self, events: &mut Vec<FrameEvent>) -> Result<(), ProtocolFault> {
        let (b0, b1) = (self.header[0], self.header[1]);
        let fin = b0 & 0x80 != 0;
        let opcode = b0 & 0x0f;
        let masked = b1 & 0x80 != 0;
        let len7 = (b1 & 0x7f) as u64;
        let (len, mask_at) = match len7 {
            126 => {
                let len = u16::from_be_bytes([self.header[2], self.header[3]]) as u64;
                if len < 126 {
                    return Err(ProtocolFault::Protocol);
                }
                (len, 4)
            }
            127 => {
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&self.header[2..10]);
                let len = u64::from_be_bytes(bytes);
                if len & (1 << 63) != 0 {
                    return Err(ProtocolFault::Protocol);
                }
                if len <= 0xffff {
                    return Err(ProtocolFault::Protocol);
                }
                (len, 10)
            }
            short => (short, 2),
        };
        let mask = if masked {
            let mut m = [0u8; 4];
            m.copy_from_slice(&self.header[mask_at..mask_at + 4]);
            Some(m)
        } else {
            None
        };
        let fragment = opcode < 8 && (opcode == 0 || !fin);
        if opcode < 8 {
            if self.fragment_count + 1 > self.max_fragments {
                return Err(ProtocolFault::TooLarge);
            }
            let held = self.assembly.as_ref().map_or(0, |a| a.len()) as u64;
            if held.saturating_add(len) > self.max_message as u64 {
                return Err(ProtocolFault::TooLarge);
            }
        }
        let len = len as usize;
        if fragment && self.assembly.is_none() {
            self.assembly = Some(Vec::with_capacity(self.max_message));
        }
        self.header_len = 0;
        self.header_needed = 2;
        let frame = Frame {
            fin,
            opcode,
            mask,
            len,
            filled: 0,
            fragment,
            own: if fragment {
                Vec::new()
            } else {
                Vec::with_capacity(len)
            },
        };
        if len == 0 {
            self.end_frame(frame, events)
        } else {
            self.frame = Some(frame);
            Ok(())
        }
    }

    fn end_frame(
        &mut self,
        frame: Frame,
        events: &mut Vec<FrameEvent>,
    ) -> Result<(), ProtocolFault> {
        match frame.opcode {
            9 => {
                events.push(FrameEvent::Ping(frame.own));
                return Ok(());
            }
            10 => {
                events.push(FrameEvent::Pong(frame.own));
                return Ok(());
            }
            8 => {
                self.done = true;
                let payload = frame.own;
                if payload.is_empty() {
                    events.push(FrameEvent::Close(None, String::new()));
                    return Ok(());
                }
                if payload.len() == 1 {
                    return Err(ProtocolFault::Protocol);
                }
                let code = u16::from_be_bytes([payload[0], payload[1]]);
                if !is_wire_close_code(code) {
                    return Err(ProtocolFault::Protocol);
                }
                let reason =
                    String::from_utf8(payload[2..].to_vec()).map_err(|_| ProtocolFault::Utf8)?;
                events.push(FrameEvent::Close(Some(code), reason));
                return Ok(());
            }
            _ => {}
        }
        if frame.opcode != 0 {
            self.message_opcode = frame.opcode;
        }
        self.fragment_count += 1;
        if !frame.fin {
            return Ok(());
        }
        let message = if frame.fragment {
            self.assembly.take().unwrap_or_default()
        } else {
            frame.own
        };
        let opcode = self.message_opcode;
        self.fragment_count = 0;
        self.message_opcode = 0;
        if opcode == 1 {
            let text = String::from_utf8(message).map_err(|_| ProtocolFault::Utf8)?;
            events.push(FrameEvent::Text(text));
        } else {
            events.push(FrameEvent::Binary(message.len()));
        }
        Ok(())
    }
}

/// The header of one final frame of `len` payload bytes; with a mask, the caller masks the payload
/// (mask_in_place) before writing it after this header.
pub fn frame_header(opcode: u8, len: usize, mask: Option<[u8; 4]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(14);
    out.push(0x80 | opcode);
    let mask_bit = if mask.is_some() { 0x80 } else { 0 };
    if len < 126 {
        out.push(mask_bit | len as u8);
    } else if len <= 0xffff {
        out.push(mask_bit | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(mask_bit | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    if let Some(m) = mask {
        out.extend_from_slice(&m);
    }
    out
}

pub fn mask_in_place(payload: &mut [u8], mask: [u8; 4]) {
    for (i, b) in payload.iter_mut().enumerate() {
        *b ^= mask[i & 3];
    }
}

/// A whole control frame (at most 125 bytes of payload), masked when a mask is given.
pub fn control_frame(opcode: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let payload = &payload[..payload.len().min(MAX_CONTROL_PAYLOAD)];
    let mut out = frame_header(opcode, payload.len(), mask);
    let start = out.len();
    out.extend_from_slice(payload);
    if let Some(m) = mask {
        mask_in_place(&mut out[start..], m);
    }
    out
}

/// A close payload: a code that may not appear on the wire gives an empty payload; the reason is cut
/// to 123 bytes on a character boundary.
pub fn close_payload(code: Option<u16>, reason: &str) -> Vec<u8> {
    let Some(code) = code.filter(|c| is_wire_close_code(*c)) else {
        return Vec::new();
    };
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = Vec::with_capacity(2 + end);
    out.extend_from_slice(&code.to_be_bytes());
    out.extend_from_slice(&reason.as_bytes()[..end]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASK: [u8; 4] = [1, 2, 3, 4];

    fn frame(opcode: u8, payload: &[u8], fin: bool, masked: bool) -> Vec<u8> {
        let mut out = vec![(if fin { 0x80 } else { 0 }) | opcode];
        let bit = if masked { 0x80 } else { 0 };
        let len = payload.len();
        if len < 126 {
            out.push(bit | len as u8);
        } else if len <= 0xffff {
            out.push(bit | 126);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            out.push(bit | 127);
            out.extend_from_slice(&(len as u64).to_be_bytes());
        }
        if masked {
            out.extend_from_slice(&MASK);
            out.extend(payload.iter().enumerate().map(|(i, b)| b ^ MASK[i & 3]));
        } else {
            out.extend_from_slice(payload);
        }
        out
    }

    fn server(opcode: u8, payload: &[u8]) -> Vec<u8> {
        frame(opcode, payload, true, false)
    }
    fn client(opcode: u8, payload: &[u8]) -> Vec<u8> {
        frame(opcode, payload, true, true)
    }

    fn read(role: Role, max: usize, chunks: &[&[u8]]) -> Result<Vec<FrameEvent>, ProtocolFault> {
        let mut reader = FrameReader::new(role, max, 4);
        let mut events = Vec::new();
        for chunk in chunks {
            reader.push(chunk, &mut events)?;
        }
        Ok(events)
    }

    fn close(code: u16, reason: &str) -> Vec<u8> {
        let mut p = code.to_be_bytes().to_vec();
        p.extend_from_slice(reason.as_bytes());
        p
    }

    #[test]
    fn text_from_either_role_whatever_the_chunking() {
        let f = server(1, "h\u{e9}llo".as_bytes());
        let whole = read(Role::FromServer, 1024, &[&f]).unwrap();
        assert_eq!(whole, vec![FrameEvent::Text("h\u{e9}llo".into())]);
        let bytes: Vec<&[u8]> = f.chunks(1).collect();
        assert_eq!(read(Role::FromServer, 1024, &bytes).unwrap(), whole);
        let c = client(1, b"masked");
        assert_eq!(
            read(Role::FromClient, 1024, &[&c]).unwrap(),
            vec![FrameEvent::Text("masked".into())]
        );
    }

    #[test]
    fn masking_must_match_the_role() {
        assert_eq!(
            read(Role::FromServer, 1024, &[&client(1, b"a")]),
            Err(ProtocolFault::Protocol)
        );
        assert_eq!(
            read(Role::FromClient, 1024, &[&server(1, b"a")]),
            Err(ProtocolFault::Protocol)
        );
    }

    #[test]
    fn rsv_opcodes_and_control_rules() {
        let mut rsv = server(1, b"a");
        rsv[0] |= 0x40;
        assert_eq!(
            read(Role::FromServer, 1024, &[&rsv]),
            Err(ProtocolFault::Protocol)
        );
        for op in [3u8, 7, 11, 15] {
            assert_eq!(
                read(Role::FromServer, 1024, &[&server(op, b"a")]),
                Err(ProtocolFault::Protocol)
            );
        }
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(9, &[0; 126])]),
            Err(ProtocolFault::Protocol)
        );
        assert_eq!(
            read(Role::FromServer, 1024, &[&frame(9, b"x", false, false)]),
            Err(ProtocolFault::Protocol)
        );
    }

    #[test]
    fn continuation_order() {
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(0, b"a")]),
            Err(ProtocolFault::Protocol)
        );
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[&frame(1, b"a", false, false), &server(1, b"b")]
            ),
            Err(ProtocolFault::Protocol)
        );
        let events = read(
            Role::FromServer,
            1024,
            &[
                &frame(1, b"he", false, false),
                &server(9, b"p"),
                &frame(0, b"ll", false, false),
                &server(0, b"o"),
            ],
        )
        .unwrap();
        assert_eq!(
            events,
            vec![
                FrameEvent::Ping(b"p".to_vec()),
                FrameEvent::Text("hello".into())
            ]
        );
    }

    #[test]
    fn length_encodings() {
        let mut short16 = vec![0x81, 126, 0, 5];
        short16.extend_from_slice(b"short");
        assert_eq!(
            read(Role::FromServer, 1024, &[&short16]),
            Err(ProtocolFault::Protocol)
        );
        let mut short64 = vec![0x81, 127, 0, 0, 0, 0, 0, 0, 0, 5];
        short64.extend_from_slice(b"short");
        assert_eq!(
            read(Role::FromServer, 1024, &[&short64]),
            Err(ProtocolFault::Protocol)
        );
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[&[0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 1]]
            ),
            Err(ProtocolFault::Protocol)
        );
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[&[0x81, 127, 0, 0, 0, 1, 0, 0, 0, 1]]
            ),
            Err(ProtocolFault::TooLarge)
        );
        let big = vec![b'y'; 70_000];
        assert_eq!(
            read(Role::FromServer, 70_000, &[&server(1, &big)]).unwrap(),
            vec![FrameEvent::Text(String::from_utf8(big).unwrap())]
        );
    }

    #[test]
    fn limits_and_utf8() {
        assert_eq!(
            read(Role::FromServer, 1024, &[&[0x81, 126, 0x04, 0x01]]),
            Err(ProtocolFault::TooLarge)
        );
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[
                    &frame(1, &[b'x'; 600], false, false),
                    &server(0, &[b'y'; 600])
                ]
            ),
            Err(ProtocolFault::TooLarge)
        );
        let five: Vec<Vec<u8>> = (0..5)
            .map(|i| frame(if i == 0 { 1 } else { 0 }, b"a", i == 4, false))
            .collect();
        let refs: Vec<&[u8]> = five.iter().map(|v| v.as_slice()).collect();
        assert_eq!(
            read(Role::FromServer, 1024, &refs),
            Err(ProtocolFault::TooLarge)
        );
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(1, &[0xc3, 0x28])]),
            Err(ProtocolFault::Utf8)
        );
        let e = "\u{e9}".as_bytes();
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[&frame(1, &e[..1], false, false), &server(0, &e[1..])]
            )
            .unwrap(),
            vec![FrameEvent::Text("\u{e9}".into())]
        );
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[&server(1, "\u{feff}bom".as_bytes())]
            )
            .unwrap(),
            vec![FrameEvent::Text("\u{feff}bom".into())]
        );
    }

    #[test]
    fn close_frames() {
        assert_eq!(
            read(
                Role::FromServer,
                1024,
                &[&server(8, &close(4401, "link revoked"))]
            )
            .unwrap(),
            vec![FrameEvent::Close(Some(4401), "link revoked".into())]
        );
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(8, &[])]).unwrap(),
            vec![FrameEvent::Close(None, String::new())]
        );
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(8, &[3])]),
            Err(ProtocolFault::Protocol)
        );
        for code in [999u16, 1004, 1005, 1006, 1015, 2999, 5000] {
            assert_eq!(
                read(Role::FromServer, 1024, &[&server(8, &close(code, ""))]),
                Err(ProtocolFault::Protocol)
            );
        }
        for code in [1012u16, 1013, 1014] {
            assert_eq!(
                read(Role::FromServer, 1024, &[&server(8, &close(code, ""))]).unwrap(),
                vec![FrameEvent::Close(Some(code), String::new())]
            );
        }
        let mut bad = close(1000, "");
        bad.push(0xff);
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(8, &bad)]),
            Err(ProtocolFault::Utf8)
        );
    }

    #[test]
    fn events_before_a_fault_are_kept_and_nothing_is_read_after() {
        let mut reader = FrameReader::new(Role::FromServer, 1024, 4);
        let mut events = Vec::new();
        let mut input = server(1, b"done");
        input.extend_from_slice(&[0xc1, 1, b'x']);
        assert_eq!(
            reader.push(&input, &mut events),
            Err(ProtocolFault::Protocol)
        );
        assert_eq!(events, vec![FrameEvent::Text("done".into())]);
        assert!(reader.closed());
        let mut after = Vec::new();
        assert_eq!(reader.push(&server(1, b"later"), &mut after), Ok(()));
        assert!(after.is_empty());
    }

    #[test]
    fn held_bytes_stay_within_the_limit() {
        let mut reader = FrameReader::new(Role::FromServer, 1024, 8);
        let mut events = Vec::new();
        reader
            .push(&frame(1, &[b'a'; 600], false, false), &mut events)
            .unwrap();
        reader.push(&server(0, &[b'b'; 400]), &mut events).unwrap();
        assert_eq!(reader.held_bytes(), 0);
        let big = server(1, &[b'c'; 1020]);
        reader.push(&big[..big.len() - 10], &mut events).unwrap();
        assert!(reader.held_bytes() <= 1024 + 14);
        reader.push(&big[big.len() - 10..], &mut events).unwrap();
        reader
            .push(&frame(1, &[b'd'; 500], false, false), &mut events)
            .unwrap();
        assert_eq!(reader.held_bytes(), 1024);
    }

    #[test]
    fn binary_by_size() {
        assert_eq!(
            read(Role::FromServer, 1024, &[&server(2, &[1, 2, 3])]).unwrap(),
            vec![FrameEvent::Binary(3)]
        );
    }

    #[test]
    fn writing() {
        let mut payload = b"ab".to_vec();
        let header = frame_header(1, payload.len(), Some([0, 0, 0, 0]));
        mask_in_place(&mut payload, [0, 0, 0, 0]);
        assert_eq!(
            [header, payload].concat(),
            vec![0x81, 0x82, 0, 0, 0, 0, b'a', b'b']
        );
        for size in [0usize, 125, 126, 65_535, 65_536] {
            let text = vec![b'z'; size];
            let mut body = text.clone();
            let mut wire = frame_header(1, size, Some(MASK));
            mask_in_place(&mut body, MASK);
            wire.extend_from_slice(&body);
            let events = read(Role::FromClient, 70_000, &[&wire]).unwrap();
            assert_eq!(
                events,
                vec![FrameEvent::Text(String::from_utf8(text).unwrap())]
            );
        }
        let unmasked = control_frame(10, b"hi", None);
        assert_eq!(unmasked, vec![0x8a, 2, b'h', b'i']);
        assert_eq!(close_payload(Some(1006), "x"), Vec::<u8>::new());
        assert_eq!(close_payload(None, "x"), Vec::<u8>::new());
        let long = close_payload(Some(1000), &"\u{e9}".repeat(100));
        assert!(long.len() <= 125);
        assert!(std::str::from_utf8(&long[2..]).is_ok());
        assert!(
            [1000u16, 1003, 1007, 1011, 1012, 1013, 1014, 3000, 4999]
                .iter()
                .all(|c| is_wire_close_code(*c))
        );
        assert!(
            ![999u16, 1004, 1005, 1006, 1015, 2999, 5000]
                .iter()
                .any(|c| is_wire_close_code(*c))
        );
    }
}
