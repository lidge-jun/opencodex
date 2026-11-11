use std::collections::HashSet;
use std::io::{self, BufRead, Write};

pub const HUB_RELAY_HEADER_MAX_BYTES: usize = 64 * 1024;
pub const LINK_RELAY_BODY_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const HUB_RELAY_RESPONSE_BODY_MAX_BYTES: u64 = 16 * 1024 * 1024;

pub const CALLER_CREDENTIAL_HEADERS: &[&str] = &[
    "authorization",
    "api-key",
    "x-api-key",
    "x-goog-api-key",
    "x-opencodex-api-key",
    "chatgpt-account-id",
    "cookie",
];

pub const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

const REQUEST_OMITTED_HEADERS: &[&str] = &["content-length", "host"];
const RESPONSE_OMITTED_HEADERS: &[&str] = &["content-encoding", "content-length"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramingError {
    Invalid,
    Smuggling,
    HeadersTooLarge,
    Eof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyFraming {
    None,
    ContentLength(u64),
    Chunked,
}

#[derive(Debug, Clone)]
pub struct HttpRequestHead {
    pub method: String,
    pub target: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct HttpResponseHead {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
}

impl HttpRequestHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

impl HttpResponseHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn read_crlf_line_bounded<R: BufRead>(
    reader: &mut R,
    remaining: &mut usize,
) -> Result<Option<String>, FramingError> {
    let mut buf = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| FramingError::Invalid)?;
        if available.is_empty() {
            if buf.is_empty() {
                return Ok(None);
            }
            return Err(FramingError::Invalid);
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if take > *remaining {
                return Err(FramingError::HeadersTooLarge);
            }
            buf.extend_from_slice(&available[..take]);
            reader.consume(take);
            *remaining -= take;
            break;
        }
        let len = available.len();
        if len > *remaining {
            return Err(FramingError::HeadersTooLarge);
        }
        buf.extend_from_slice(available);
        reader.consume(len);
        *remaining -= len;
    }
    if buf.ends_with(b"\r\n") {
        buf.truncate(buf.len() - 2);
    } else if buf.ends_with(b"\n") {
        buf.truncate(buf.len() - 1);
    }
    if buf.contains(&b'\r') || buf.contains(&b'\n') {
        return Err(FramingError::Invalid);
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| FramingError::Invalid)
}

pub fn read_request_head<R: BufRead>(reader: &mut R) -> Result<HttpRequestHead, FramingError> {
    let mut budget = HUB_RELAY_HEADER_MAX_BYTES;
    let Some(req_line) = read_crlf_line_bounded(reader, &mut budget)? else {
        return Err(FramingError::Eof);
    };
    let mut parts = req_line.split(' ');
    let method = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or(FramingError::Invalid)?;
    let target = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or(FramingError::Invalid)?;
    let version = parts.next().ok_or(FramingError::Invalid)?;
    if parts.next().is_some()
        || (!version.eq_ignore_ascii_case("HTTP/1.1") && !version.eq_ignore_ascii_case("HTTP/1.0"))
    {
        return Err(FramingError::Invalid);
    }
    if !target.starts_with('/') {
        return Err(FramingError::Invalid);
    }
    let (path, query) = match target.find('?') {
        Some(idx) => (target[..idx].to_owned(), target[idx..].to_owned()),
        None => (target.to_owned(), String::new()),
    };
    let mut headers = Vec::new();
    let mut measured_header_bytes = 0usize;
    loop {
        let line = read_crlf_line_bounded(reader, &mut budget)?.ok_or(FramingError::Invalid)?;
        if line.is_empty() {
            break;
        }
        // Reject obs-fold leading whitespace
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(FramingError::Smuggling);
        }
        let (raw_name, raw_val) = line.split_once(':').ok_or(FramingError::Invalid)?;
        if raw_name.is_empty()
            || raw_name
                .bytes()
                .any(|b| b.is_ascii_whitespace() || !(0x21..0x7f).contains(&b))
        {
            return Err(FramingError::Invalid);
        }
        let value = raw_val.trim().to_owned();
        measured_header_bytes =
            measured_header_bytes.saturating_add(raw_name.len() + value.len() + 4);
        if measured_header_bytes > HUB_RELAY_HEADER_MAX_BYTES {
            return Err(FramingError::HeadersTooLarge);
        }
        headers.push((raw_name.to_owned(), value));
    }
    Ok(HttpRequestHead {
        method: method.to_owned(),
        target: target.to_owned(),
        path,
        query,
        headers,
    })
}

pub fn read_response_head<R: BufRead>(reader: &mut R) -> Result<HttpResponseHead, FramingError> {
    let mut budget = HUB_RELAY_HEADER_MAX_BYTES;
    let Some(status_line) = read_crlf_line_bounded(reader, &mut budget)? else {
        return Err(FramingError::Eof);
    };
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().ok_or(FramingError::Invalid)?;
    if !version.starts_with("HTTP/1.") {
        return Err(FramingError::Invalid);
    }
    let status_str = parts.next().ok_or(FramingError::Invalid)?;
    let status: u16 = status_str.parse().map_err(|_| FramingError::Invalid)?;
    let reason = parts.next().unwrap_or("").to_owned();
    let mut headers = Vec::new();
    let mut measured_header_bytes = 0usize;
    loop {
        let line = read_crlf_line_bounded(reader, &mut budget)?.ok_or(FramingError::Invalid)?;
        if line.is_empty() {
            break;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(FramingError::Smuggling);
        }
        let (raw_name, raw_val) = line.split_once(':').ok_or(FramingError::Invalid)?;
        if raw_name.is_empty() {
            return Err(FramingError::Invalid);
        }
        let value = raw_val.trim().to_owned();
        measured_header_bytes =
            measured_header_bytes.saturating_add(raw_name.len() + value.len() + 4);
        if measured_header_bytes > HUB_RELAY_HEADER_MAX_BYTES {
            return Err(FramingError::HeadersTooLarge);
        }
        headers.push((raw_name.to_owned(), value));
    }
    Ok(HttpResponseHead {
        status,
        reason,
        headers,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRequestHeaders {
    pub framing: BodyFraming,
    pub sanitized: Vec<(String, String)>,
}

/// Validates framing (`linkFramingHeaders` + `validateHubRelayRequestHeaders`) and strips
/// hop-by-hop, `Connection`-nominated, `host`/`content-length`, and `CALLER_CREDENTIAL_HEADERS`.
pub fn validate_and_sanitize_request_headers(
    raw_headers: &[(String, String)],
) -> Result<ValidatedRequestHeaders, FramingError> {
    let mut measured_bytes = 0usize;
    for (name, value) in raw_headers {
        if name.is_empty()
            || name.contains('\r')
            || name.contains('\n')
            || value.contains('\r')
            || value.contains('\n')
        {
            return Err(FramingError::Invalid);
        }
        measured_bytes = measured_bytes.saturating_add(name.len() + value.len() + 4);
        if measured_bytes > HUB_RELAY_HEADER_MAX_BYTES {
            return Err(FramingError::HeadersTooLarge);
        }
    }

    let mut content_lengths: Vec<&str> = Vec::new();
    let mut transfer_encodings: Vec<&str> = Vec::new();
    let mut connection_named: HashSet<String> = HashSet::new();

    for (name, value) in raw_headers {
        let lower = name.to_ascii_lowercase();
        match lower.as_str() {
            "upgrade" => return Err(FramingError::Smuggling),
            "content-length" => {
                let trimmed = value.trim();
                if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(FramingError::Smuggling);
                }
                content_lengths.push(trimmed);
            }
            "transfer-encoding" => {
                transfer_encodings.push(value.trim());
            }
            "connection" => {
                for token in value.split(',') {
                    let t = token.trim().to_ascii_lowercase();
                    if !t.is_empty() {
                        connection_named.insert(t);
                    }
                }
            }
            _ => {}
        }
    }

    if content_lengths.len() > 1 {
        return Err(FramingError::Smuggling);
    }
    let framing = if !transfer_encodings.is_empty() {
        if !content_lengths.is_empty()
            || transfer_encodings.len() != 1
            || !transfer_encodings[0].eq_ignore_ascii_case("chunked")
        {
            return Err(FramingError::Smuggling);
        }
        BodyFraming::Chunked
    } else if let Some(cl_str) = content_lengths.first() {
        let len: u64 = cl_str.parse().map_err(|_| FramingError::Smuggling)?;
        BodyFraming::ContentLength(len)
    } else {
        BodyFraming::None
    };

    let mut sanitized = Vec::new();
    for (name, value) in raw_headers {
        let lower = name.to_ascii_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&lower.as_str())
            || REQUEST_OMITTED_HEADERS.contains(&lower.as_str())
            || CALLER_CREDENTIAL_HEADERS.contains(&lower.as_str())
            || connection_named.contains(&lower)
        {
            continue;
        }
        sanitized.push((lower, value.clone()));
    }

    Ok(ValidatedRequestHeaders { framing, sanitized })
}

pub fn sanitize_response_headers(raw_headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut connection_named: HashSet<String> = HashSet::new();
    for (name, value) in raw_headers {
        if name.eq_ignore_ascii_case("connection") {
            for token in value.split(',') {
                let t = token.trim().to_ascii_lowercase();
                if !t.is_empty() {
                    connection_named.insert(t);
                }
            }
        }
    }
    let mut out = Vec::new();
    for (name, value) in raw_headers {
        let lower = name.to_ascii_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&lower.as_str())
            || RESPONSE_OMITTED_HEADERS.contains(&lower.as_str())
            || connection_named.contains(&lower)
        {
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    out
}

pub fn is_sse_headers(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .and_then(|(_, v)| v.split(';').next())
        .is_some_and(|ct| ct.trim().eq_ignore_ascii_case("text/event-stream"))
}

pub fn response_framing(
    status: u16,
    method: &str,
    headers: &[(String, String)],
) -> Result<BodyFraming, FramingError> {
    if method.eq_ignore_ascii_case("HEAD")
        || (100..200).contains(&status)
        || status == 204
        || status == 304
    {
        return Ok(BodyFraming::None);
    }
    let mut cl: Option<u64> = None;
    let mut chunked = false;
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("transfer-encoding") {
            if value.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            } else {
                return Err(FramingError::Smuggling);
            }
        } else if name.eq_ignore_ascii_case("content-length") {
            let trimmed = value.trim();
            if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
                return Err(FramingError::Smuggling);
            }
            let parsed: u64 = trimmed.parse().map_err(|_| FramingError::Smuggling)?;
            if cl.is_some() {
                return Err(FramingError::Smuggling);
            }
            cl = Some(parsed);
        }
    }
    if chunked {
        Ok(BodyFraming::Chunked)
    } else if let Some(len) = cl {
        Ok(BodyFraming::ContentLength(len))
    } else {
        Ok(BodyFraming::None)
    }
}

pub fn read_bounded_body<R: BufRead>(
    reader: &mut R,
    framing: BodyFraming,
    max_bytes: u64,
) -> Result<Vec<u8>, io::Error> {
    match framing {
        BodyFraming::None => Ok(Vec::new()),
        BodyFraming::ContentLength(len) => {
            if len > max_bytes {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "body_too_large"));
            }
            let mut out = vec![0u8; len as usize];
            reader.read_exact(&mut out)?;
            Ok(out)
        }
        BodyFraming::Chunked => {
            let mut out = Vec::new();
            let mut meta_budget = HUB_RELAY_HEADER_MAX_BYTES;
            loop {
                let size_line = read_crlf_line_bounded(reader, &mut meta_budget)
                    .map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "chunk metadata overflow or invalid",
                        )
                    })?
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::UnexpectedEof, "unexpected chunk eof")
                    })?;
                let hex_part = size_line.trim().split(';').next().unwrap_or("").trim();
                let chunk_len = u64::from_str_radix(hex_part, 16).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size")
                })?;
                if chunk_len == 0 {
                    // Consume trailing headers up to blank CRLF within bounded metadata budget
                    loop {
                        let trailer = read_crlf_line_bounded(reader, &mut meta_budget)
                            .map_err(|_| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "chunk trailer overflow or invalid",
                                )
                            })?
                            .ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "unexpected trailer eof",
                                )
                            })?;
                        if trailer.is_empty() {
                            break;
                        }
                    }
                    break;
                }
                if (out.len() as u64).saturating_add(chunk_len) > max_bytes {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "body_too_large"));
                }
                let prev = out.len();
                out.resize(prev + chunk_len as usize, 0);
                reader.read_exact(&mut out[prev..])?;
                let mut crlf = [0u8; 2];
                reader.read_exact(&mut crlf)?;
                if &crlf != b"\r\n" {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "missing chunk crlf",
                    ));
                }
            }
            Ok(out)
        }
    }
}

/// Streams chunked or fixed-length upstream body to `client` as HTTP/1.1 chunked transfer.
pub fn stream_upstream_to_chunked_client<R: BufRead, W: Write>(
    reader: &mut R,
    client: &mut W,
    framing: BodyFraming,
    max_bytes: Option<u64>,
) -> io::Result<()> {
    let mut total: u64 = 0;
    match framing {
        BodyFraming::None => {
            // Read until EOF (connection-delimited stream)
            let mut buf = [0u8; 16 * 1024];
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                total = total.saturating_add(n as u64);
                if let Some(cap) = max_bytes
                    && total > cap
                {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "body_too_large"));
                }
                write!(client, "{n:x}\r\n")?;
                client.write_all(&buf[..n])?;
                client.write_all(b"\r\n")?;
                client.flush()?;
            }
        }
        BodyFraming::ContentLength(mut remaining) => {
            if let Some(cap) = max_bytes
                && remaining > cap
            {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "body_too_large"));
            }
            let mut buf = [0u8; 16 * 1024];
            while remaining > 0 {
                let want = (remaining as usize).min(buf.len());
                let n = reader.read(&mut buf[..want])?;
                if n == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "upstream truncated",
                    ));
                }
                remaining -= n as u64;
                write!(client, "{n:x}\r\n")?;
                client.write_all(&buf[..n])?;
                client.write_all(b"\r\n")?;
                client.flush()?;
            }
        }
        BodyFraming::Chunked => {
            let mut buf = [0u8; 16 * 1024];
            let mut meta_budget = HUB_RELAY_HEADER_MAX_BYTES;
            loop {
                let size_line = read_crlf_line_bounded(reader, &mut meta_budget)
                    .map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "upstream chunk metadata overflow or invalid",
                        )
                    })?
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "upstream eof before terminating chunk",
                        )
                    })?;
                let hex_part = size_line.trim().split(';').next().unwrap_or("").trim();
                let mut chunk_rem = u64::from_str_radix(hex_part, 16).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid upstream chunk")
                })?;
                if chunk_rem == 0 {
                    loop {
                        let trailer = read_crlf_line_bounded(reader, &mut meta_budget)
                            .map_err(|_| {
                                io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "upstream trailer overflow or invalid",
                                )
                            })?
                            .ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "upstream eof in trailers",
                                )
                            })?;
                        if trailer.is_empty() {
                            break;
                        }
                    }
                    break;
                }
                total = total.saturating_add(chunk_rem);
                if let Some(cap) = max_bytes
                    && total > cap
                {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "body_too_large"));
                }
                while chunk_rem > 0 {
                    let want = (chunk_rem as usize).min(buf.len());
                    let got = reader.read(&mut buf[..want])?;
                    if got == 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "truncated chunk",
                        ));
                    }
                    chunk_rem -= got as u64;
                    write!(client, "{got:x}\r\n")?;
                    client.write_all(&buf[..got])?;
                    client.write_all(b"\r\n")?;
                    client.flush()?;
                }
                let mut crlf = [0u8; 2];
                reader.read_exact(&mut crlf)?;
                if &crlf != b"\r\n" {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid upstream chunk crlf",
                    ));
                }
            }
        }
    }
    client.write_all(b"0\r\n\r\n")?;
    client.flush()
}

pub fn write_json_response<W: Write>(
    writer: &mut W,
    status: u16,
    reason: &str,
    extra_headers: &[(&str, &str)],
    body: &[u8],
) -> io::Result<()> {
    write!(writer, "HTTP/1.1 {status} {reason}\r\n")?;
    write!(writer, "Content-Type: application/json;charset=utf-8\r\n")?;
    write!(writer, "Content-Length: {}\r\n", body.len())?;
    write!(writer, "Connection: close\r\n")?;
    for (k, v) in extra_headers {
        write!(writer, "{k}: {v}\r\n")?;
    }
    writer.write_all(b"\r\n")?;
    writer.write_all(body)?;
    writer.flush()
}
