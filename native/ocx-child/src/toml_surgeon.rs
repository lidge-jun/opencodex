use serde::{Deserialize, Serialize};

use crate::codex_settings::HomeCodexSettings;

pub const OCX_SECTION_MARKER: &str = "# Auto-injected by opencodex";
pub const OCX_ROUTING_MARKER_LINE: &str = "# Auto-injected by opencodex (undo: ocx restore)";
pub const MANAGED_SUBAGENT_DEFAULT_MARKER: &str = "# Managed by opencodex: native subagent default";
pub const MANAGED_AGENTS_TABLE_MARKER: &str =
    "# Managed by opencodex: native subagent defaults table";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WrittenSubagentDefaults {
    pub default_subagent_model: String,
    pub default_subagent_reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildInjectedLedger {
    pub openai_base_url: Option<String>,
    pub experimental_realtime_ws_base_url: Option<String>,
    pub model_catalog_json: Option<String>,
    pub injected_web_search: Option<String>,
    pub replaced_user_web_search_line: Option<String>,
    pub wrote_fast_mode: Option<bool>,
    #[serde(default)]
    pub prior_user_fast_mode_line: Option<String>,
    pub wrote_multi_agent_v2: Option<bool>,
    #[serde(default)]
    pub prior_user_multi_agent_v2_line: Option<String>,
    pub wrote_subagent_defaults: Option<WrittenSubagentDefaults>,
}

pub fn dominant_eol(content: &str) -> &'static str {
    let crlf = content.matches("\r\n").count();
    if crlf == 0 {
        return "\n";
    }
    let total_lf = content.matches('\n').count();
    let bare_lf = total_lf.saturating_sub(crlf);
    if crlf >= bare_lf { "\r\n" } else { "\n" }
}

pub fn apply_eol(content: &str, eol: &str) -> String {
    let lf = content.replace("\r\n", "\n");
    if eol == "\n" {
        lf
    } else {
        lf.replace('\n', "\r\n")
    }
}

pub fn is_ocx_routing_marker_line(line: &str) -> bool {
    let t = line.trim();
    t == OCX_SECTION_MARKER || t == OCX_ROUTING_MARKER_LINE
}

pub fn toml_escape_basic_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{007f}' => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn parse_toml_quoted_string(raw_val: &str) -> Option<String> {
    let trimmed = strip_inline_comment(raw_val).trim();
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        let inner = &trimmed[1..trimmed.len() - 1];
        if inner.contains('\'') {
            return None;
        }
        return Some(inner.to_owned());
    }
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                match chars.next()? {
                    '\\' => out.push('\\'),
                    '"' => out.push('"'),
                    'b' => out.push('\u{0008}'),
                    'f' => out.push('\u{000c}'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'u' => {
                        let mut hex = String::with_capacity(4);
                        for _ in 0..4 {
                            hex.push(chars.next()?);
                        }
                        let cp = u32::from_str_radix(&hex, 16).ok()?;
                        out.push(char::from_u32(cp)?);
                    }
                    'U' => {
                        let mut hex = String::with_capacity(8);
                        for _ in 0..8 {
                            hex.push(chars.next()?);
                        }
                        let cp = u32::from_str_radix(&hex, 16).ok()?;
                        out.push(char::from_u32(cp)?);
                    }
                    _ => return None,
                }
            } else if ch == '"' {
                return None;
            } else {
                out.push(ch);
            }
        }
        return Some(out);
    }
    None
}

fn strip_inline_comment(val: &str) -> &str {
    let mut in_basic = false;
    let mut in_literal = false;
    let mut escaped = false;
    for (idx, ch) in val.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if in_basic {
            if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_basic = false;
            }
        } else if in_literal {
            if ch == '\'' {
                in_literal = false;
            }
        } else {
            match ch {
                '"' => in_basic = true,
                '\'' => in_literal = true,
                '#' => return &val[..idx],
                _ => {}
            }
        }
    }
    val
}

pub fn parse_key_value_line(line: &str) -> Option<(String, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
        return None;
    }
    let (raw_key, rhs) = trimmed.split_once('=')?;
    let key_trim = raw_key.trim();
    let key = if (key_trim.starts_with('"') && key_trim.ends_with('"'))
        || (key_trim.starts_with('\'') && key_trim.ends_with('\''))
    {
        parse_toml_quoted_string(key_trim)?
    } else if !key_trim.is_empty()
        && key_trim
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        key_trim.to_owned()
    } else {
        return None;
    };
    Some((key, rhs.trim()))
}

pub fn parse_single_line_string_assignment(
    line: &str,
    expected_key: &str,
) -> Result<Option<String>, String> {
    let Some((key, rhs)) = parse_key_value_line(line) else {
        return Ok(None);
    };
    if key != expected_key {
        return Ok(None);
    }
    parse_toml_quoted_string(rhs)
        .map(Some)
        .ok_or_else(|| format!("corrupt or multiline string assignment for {expected_key}"))
}

fn is_table_header(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('[') && !t.starts_with('#')
}

fn parse_simple_table_name(line: &str) -> Option<String> {
    let t = strip_inline_comment(line).trim();
    if !t.starts_with('[') || t.starts_with("[") && t.starts_with("[[") || !t.ends_with(']') {
        return None;
    }
    let inner = t[1..t.len() - 1].trim();
    if (inner.starts_with('"') && inner.ends_with('"'))
        || (inner.starts_with('\'') && inner.ends_with('\''))
    {
        parse_toml_quoted_string(inner)
    } else {
        Some(inner.to_owned())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MultilineQuote {
    Basic,
    Literal,
}

fn quote_run_length(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut end = start;
    while end < bytes.len() && bytes[end] == quote && end - start < 5 {
        end += 1;
    }
    end - start
}

/// Ports `markStructuralLines` (`src/codex/toml-source-lines.ts:158-223`) so lines beginning
/// inside multiline strings (`"""`/`'''`) or multiline arrays/inline tables are never treated
/// as table headers, root keys, or ownership markers. Returns `(structural_flags, unclosed_multiline)`.
pub fn mark_structural_lines<S: AsRef<str>>(lines: &[S]) -> (Vec<bool>, bool) {
    let mut multiline: Option<MultilineQuote> = None;
    let mut square_depth: usize = 0;
    let mut curly_depth: usize = 0;
    let mut flags = Vec::with_capacity(lines.len());

    for raw in lines {
        let text = raw.as_ref();
        flags.push(multiline.is_none() && square_depth == 0 && curly_depth == 0);
        let mut single: Option<MultilineQuote> = None;
        let bytes = text.as_bytes();
        let mut idx = 0usize;
        while idx < bytes.len() {
            if let Some(MultilineQuote::Basic) = multiline {
                if bytes[idx..].starts_with(b"\"\"\"") {
                    multiline = None;
                    idx += quote_run_length(bytes, idx, b'"');
                } else if bytes[idx] == b'\\' {
                    idx = (idx + 2).min(bytes.len());
                } else {
                    idx += 1;
                }
                continue;
            }
            if let Some(MultilineQuote::Literal) = multiline {
                if bytes[idx..].starts_with(b"'''") {
                    multiline = None;
                    idx += quote_run_length(bytes, idx, b'\'');
                } else {
                    idx += 1;
                }
                continue;
            }
            if let Some(MultilineQuote::Basic) = single {
                if bytes[idx] == b'\\' {
                    idx = (idx + 2).min(bytes.len());
                } else if bytes[idx] == b'"' {
                    single = None;
                    idx += 1;
                } else {
                    idx += 1;
                }
                continue;
            }
            if let Some(MultilineQuote::Literal) = single {
                if bytes[idx] == b'\'' {
                    single = None;
                }
                idx += 1;
                continue;
            }
            if bytes[idx] == b'#' {
                break;
            }
            if bytes[idx..].starts_with(b"\"\"\"") {
                multiline = Some(MultilineQuote::Basic);
                idx += 3;
            } else if bytes[idx..].starts_with(b"'''") {
                multiline = Some(MultilineQuote::Literal);
                idx += 3;
            } else if bytes[idx] == b'"' {
                single = Some(MultilineQuote::Basic);
                idx += 1;
            } else if bytes[idx] == b'\'' {
                single = Some(MultilineQuote::Literal);
                idx += 1;
            } else if bytes[idx] == b'[' {
                square_depth += 1;
                idx += 1;
            } else if bytes[idx] == b']' {
                square_depth = square_depth.saturating_sub(1);
                idx += 1;
            } else if bytes[idx] == b'{' {
                curly_depth += 1;
                idx += 1;
            } else if bytes[idx] == b'}' {
                curly_depth = curly_depth.saturating_sub(1);
                idx += 1;
            } else {
                idx += 1;
            }
        }
    }
    (flags, multiline.is_some())
}

fn root_end_index<S: AsRef<str>>(lines: &[S], structural: &[bool]) -> usize {
    lines
        .iter()
        .enumerate()
        .position(|(i, l)| structural[i] && is_table_header(l.as_ref()))
        .unwrap_or(lines.len())
}

fn is_opencodex_catalog_path(path: &str) -> bool {
    let norm = path.replace('\\', "/");
    norm.rsplit('/').next() == Some("opencodex-catalog.json")
}

/// Mirrors `externalCodexModelProvider` (`src/codex/inject/config-toml.ts:30-45`).
pub fn external_codex_model_provider(content: &str) -> Option<String> {
    let lf = apply_eol(content, "\n");
    let lines: Vec<&str> = lf.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    let mut provider: Option<String> = None;
    for i in 0..root_end {
        if !structural[i] {
            continue;
        }
        let line = lines[i];
        if let Ok(Some(val)) = parse_single_line_string_assignment(line, "model_provider") {
            provider = Some(val);
            break;
        }
    }
    let prov = provider?;
    if prov.is_empty() || prov == "openai" || prov == "opencodex" {
        return None;
    }
    // Check `[model_providers.<prov>]`: if present without `base_url`, treat as Codex App 26.924 placeholder.
    let target_table_1 = format!("model_providers.{prov}");
    let target_table_2 = format!("model_providers.\"{prov}\"");
    let mut table_start: Option<usize> = None;
    for (idx, &line) in lines.iter().enumerate() {
        if !structural[idx] {
            continue;
        }
        if let Some(tname) = parse_simple_table_name(line) {
            let normalized = tname.replace(' ', "");
            if normalized == target_table_1 || normalized == target_table_2 {
                table_start = Some(idx);
                break;
            }
        }
    }
    if let Some(start) = table_start {
        let mut has_base_url = false;
        for idx in (start + 1)..lines.len() {
            if !structural[idx] {
                continue;
            }
            if is_table_header(lines[idx]) {
                break;
            }
            if let Ok(Some(_)) = parse_single_line_string_assignment(lines[idx], "base_url") {
                has_base_url = true;
                break;
            }
        }
        if !has_base_url {
            return None;
        }
    }
    Some(prov)
}

/// Checks for user-owned unmarked root routing keys before first attach so `ocx-child` fails closed.
pub fn detect_unowned_root_routing_conflict(content: &str) -> Result<(), String> {
    if let Some(ext) = external_codex_model_provider(content) {
        return Err(format!(
            "ocx-child-conflict:child_external_provider_conflict: attach refused: an external Codex model_provider ({ext}) owns config.toml"
        ));
    }
    let lf = apply_eol(content, "\n");
    let lines: Vec<&str> = lf.split('\n').collect();
    let (structural, unclosed) = mark_structural_lines(&lines);
    if unclosed {
        return Err("attach refused: config.toml contains an unclosed multiline string".to_owned());
    }
    let root_end = root_end_index(&lines, &structural);
    for i in 0..root_end {
        if !structural[i] {
            continue;
        }
        let line = lines[i];
        for key in ["openai_base_url", "experimental_realtime_ws_base_url"] {
            match parse_single_line_string_assignment(line, key) {
                Ok(Some(_)) => {
                    let marked =
                        i > 0 && structural[i - 1] && is_ocx_routing_marker_line(lines[i - 1]);
                    if !marked {
                        return Err(format!(
                            "ocx-child-conflict:child_external_provider_conflict: attach refused: user-owned root {key} already exists in config.toml"
                        ));
                    }
                }
                Ok(None) => {}
                Err(e) => return Err(format!("attach refused: {e}")),
            }
        }
        match parse_single_line_string_assignment(line, "model_catalog_json") {
            Ok(Some(existing_path)) => {
                if !is_opencodex_catalog_path(&existing_path) {
                    return Err(
                        "ocx-child-conflict:child_external_provider_conflict: attach refused: user-owned model_catalog_json already exists in config.toml"
                            .to_owned(),
                    );
                }
            }
            Ok(None) => {}
            Err(e) => return Err(format!("attach refused: {e}")),
        }
    }
    Ok(())
}

fn insert_root_lines(content_lf: &str, added: &[String]) -> String {
    if added.is_empty() {
        return content_lf.to_owned();
    }
    let mut lines: Vec<String> = if content_lf.is_empty() {
        Vec::new()
    } else {
        content_lf.split('\n').map(str::to_owned).collect()
    };
    // Drop trailing empty split element if content ended with \n
    let had_trailing_nl = content_lf.ends_with('\n');
    if had_trailing_nl && lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    if root_end == lines.len() {
        while !lines.is_empty()
            && structural[lines.len() - 1]
            && lines.last().is_some_and(|l| l.trim().is_empty())
        {
            lines.pop();
        }
        lines.extend(added.iter().cloned());
        let mut out = lines.join("\n");
        out.push('\n');
        return out;
    }
    let mut at = root_end;
    while at > 0 && structural[at - 1] && lines[at - 1].trim().is_empty() {
        at -= 1;
    }
    for (offset, item) in added.iter().enumerate() {
        lines.insert(at + offset, item.clone());
    }
    let mut out = lines.join("\n");
    if had_trailing_nl || !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn strip_owned_root_urls(
    content_lf: &str,
    journaled_base: Option<&str>,
    journaled_ws: Option<&str>,
) -> String {
    let lines: Vec<&str> = content_lf.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    let mut drop = vec![false; lines.len()];
    for i in 0..root_end {
        if !structural[i] {
            continue;
        }
        if let Ok(Some(val)) = parse_single_line_string_assignment(lines[i], "openai_base_url") {
            let marker_above =
                i > 0 && structural[i - 1] && is_ocx_routing_marker_line(lines[i - 1]);
            let value_match = journaled_base == Some(val.as_str());
            if marker_above || value_match {
                drop[i] = true;
                if marker_above {
                    drop[i - 1] = true;
                }
            } else if marker_above {
                drop[i - 1] = true;
            }
        } else if let Ok(Some(val)) =
            parse_single_line_string_assignment(lines[i], "experimental_realtime_ws_base_url")
        {
            let marker_above =
                i > 0 && structural[i - 1] && is_ocx_routing_marker_line(lines[i - 1]);
            let value_match = journaled_ws == Some(val.as_str());
            if marker_above || value_match {
                drop[i] = true;
                if marker_above {
                    drop[i - 1] = true;
                }
            }
        }
    }
    let kept: Vec<&str> = lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| (!drop[i]).then_some(l))
        .collect();
    kept.join("\n")
}

fn strip_owned_web_search(content_lf: &str, injected_val: Option<&str>) -> String {
    let lines: Vec<&str> = content_lf.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    let mut drop = vec![false; lines.len()];
    for i in 0..root_end {
        if !structural[i] {
            continue;
        }
        if let Ok(Some(val)) = parse_single_line_string_assignment(lines[i], "web_search") {
            let marker_above =
                i > 0 && structural[i - 1] && is_ocx_routing_marker_line(lines[i - 1]);
            let value_match = injected_val == Some(val.as_str());
            if value_match {
                drop[i] = true;
                if marker_above {
                    drop[i - 1] = true;
                }
            } else if marker_above && injected_val.is_some() {
                drop[i - 1] = true;
            }
        }
    }
    lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| (!drop[i]).then_some(l))
        .collect::<Vec<_>>()
        .join("\n")
}

fn ensure_root_web_search(
    content_lf: &str,
    disable: bool,
    prior_injected: Option<&str>,
    prior_replaced_user_line: Option<&str>,
) -> Result<(String, Option<String>, Option<String>), String> {
    let stripped = strip_owned_web_search(content_lf, prior_injected);
    let lines: Vec<&str> = stripped.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    if !disable {
        let mut has_user_ws = false;
        for i in 0..root_end {
            if !structural[i] {
                continue;
            }
            if parse_single_line_string_assignment(lines[i], "web_search")?.is_some() {
                has_user_ws = true;
                break;
            }
        }
        if let Some(restore) = prior_replaced_user_line
            && !restore.trim().is_empty()
            && !has_user_ws
        {
            let clean_restore = restore.trim_end_matches(['\r', '\n']).to_owned();
            return Ok((insert_root_lines(&stripped, &[clean_restore]), None, None));
        }
        return Ok((stripped, None, None));
    }
    let mut drop = vec![false; lines.len()];
    let mut replaced = prior_replaced_user_line.map(str::to_owned);
    let mut saw_user = false;
    for i in 0..root_end {
        if !structural[i] {
            continue;
        }
        if parse_single_line_string_assignment(lines[i], "web_search")?.is_some() {
            if !saw_user {
                replaced = Some(lines[i].to_owned());
                saw_user = true;
            }
            drop[i] = true;
        }
    }
    let filtered = lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| (!drop[i]).then_some(l))
        .collect::<Vec<_>>()
        .join("\n");
    let next = insert_root_lines(
        &filtered,
        &[
            OCX_ROUTING_MARKER_LINE.to_owned(),
            "web_search = \"disabled\"".to_owned(),
        ],
    );
    Ok((next, Some("disabled".to_owned()), replaced))
}

fn set_root_catalog_path(content_lf: &str, catalog_path: &str) -> String {
    let key_line = format!(
        "model_catalog_json = {}",
        toml_escape_basic_string(catalog_path)
    );
    let mut lines: Vec<String> = content_lf.split('\n').map(str::to_owned).collect();
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    let mut owned_indices = Vec::new();
    for (i, line) in lines[..root_end].iter().enumerate() {
        if !structural[i] {
            continue;
        }
        if let Ok(Some(existing)) = parse_single_line_string_assignment(line, "model_catalog_json")
            && is_opencodex_catalog_path(&existing)
        {
            owned_indices.push(i);
        }
    }
    if let Some(&first) = owned_indices.first() {
        lines[first] = key_line;
        let dup: std::collections::HashSet<usize> = owned_indices.into_iter().skip(1).collect();
        return lines
            .into_iter()
            .enumerate()
            .filter_map(|(i, l)| (!dup.contains(&i)).then_some(l))
            .collect::<Vec<_>>()
            .join("\n");
    }
    insert_root_lines(content_lf, &[key_line])
}

fn strip_opencodex_catalog_path(content_lf: &str) -> String {
    let lines: Vec<&str> = content_lf.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let root_end = root_end_index(&lines, &structural);
    lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| {
            if i < root_end
                && structural[i]
                && let Ok(Some(p)) = parse_single_line_string_assignment(l, "model_catalog_json")
                && is_opencodex_catalog_path(&p)
            {
                return None;
            }
            Some(l)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn upsert_table_bool(
    content_lf: &str,
    table_name: &str,
    key: &str,
    val: bool,
) -> (String, Option<String>) {
    let mut lines: Vec<String> = content_lf.split('\n').map(str::to_owned).collect();
    let had_trailing_nl = content_lf.ends_with('\n');
    if had_trailing_nl && lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let (structural, _) = mark_structural_lines(&lines);
    let table_idx = lines.iter().enumerate().position(|(i, l)| {
        structural[i] && parse_simple_table_name(l).as_deref() == Some(table_name)
    });
    let assign_line = format!("{key} = {val}");
    if let Some(start) = table_idx {
        let end = lines[start + 1..]
            .iter()
            .enumerate()
            .position(|(rel, l)| structural[start + 1 + rel] && is_table_header(l))
            .map(|rel| start + 1 + rel)
            .unwrap_or(lines.len());
        for idx in (start + 1)..end {
            if !structural[idx] {
                continue;
            }
            let line = &mut lines[idx];
            if let Some((k, _)) = parse_key_value_line(line)
                && k == key
            {
                let prior_line = line.clone();
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                *line = format!("{indent}{assign_line}");
                let mut out = lines.join("\n");
                out.push('\n');
                return (out, Some(prior_line));
            }
        }
        let mut insert_at = end;
        while insert_at > start + 1
            && structural[insert_at - 1]
            && lines[insert_at - 1].trim().is_empty()
        {
            insert_at -= 1;
        }
        lines.insert(insert_at, assign_line);
        let mut out = lines.join("\n");
        out.push('\n');
        return (out, None);
    }
    let trimmed = content_lf.trim_end_matches('\n');
    let out = if trimmed.is_empty() {
        format!("[{table_name}]\n{assign_line}\n")
    } else {
        format!("{trimmed}\n\n[{table_name}]\n{assign_line}\n")
    };
    (out, None)
}

fn apply_subagent_defaults(
    content_lf: &str,
    desired: Option<&crate::codex_settings::SubagentDefaults>,
    prior_written: Option<&WrittenSubagentDefaults>,
) -> (String, Option<WrittenSubagentDefaults>) {
    let stripped = strip_subagent_defaults(content_lf, prior_written);
    let Some(sub) = desired else {
        return (stripped, None);
    };
    let mut lines: Vec<String> = stripped.split('\n').map(str::to_owned).collect();
    if stripped.ends_with('\n') && lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let (structural, _) = mark_structural_lines(&lines);
    let ag_idx = lines.iter().enumerate().position(|(i, l)| {
        structural[i] && parse_simple_table_name(l).as_deref() == Some("agents")
    });
    let mut to_add = vec![
        MANAGED_SUBAGENT_DEFAULT_MARKER.to_owned(),
        format!(
            "default_subagent_model = {}",
            toml_escape_basic_string(&sub.model)
        ),
    ];
    if let Some(eff) = &sub.reasoning_effort {
        to_add.push(MANAGED_SUBAGENT_DEFAULT_MARKER.to_owned());
        to_add.push(format!(
            "default_subagent_reasoning_effort = {}",
            toml_escape_basic_string(eff)
        ));
    }
    let written = WrittenSubagentDefaults {
        default_subagent_model: sub.model.clone(),
        default_subagent_reasoning_effort: sub.reasoning_effort.clone(),
    };
    if let Some(start) = ag_idx {
        let end = lines[start + 1..]
            .iter()
            .enumerate()
            .position(|(rel, l)| structural[start + 1 + rel] && is_table_header(l))
            .map(|rel| start + 1 + rel)
            .unwrap_or(lines.len());
        // Respect user-owned existing keys in [agents]
        for idx in (start + 1)..end {
            if !structural[idx] {
                continue;
            }
            let line = &lines[idx];
            if let Some((k, _)) = parse_key_value_line(line)
                && (k == "default_subagent_model" || k == "default_subagent_reasoning_effort")
            {
                return (stripped, None);
            }
        }
        let mut insert_at = end;
        while insert_at > start + 1
            && structural[insert_at - 1]
            && lines[insert_at - 1].trim().is_empty()
        {
            insert_at -= 1;
        }
        for (off, item) in to_add.into_iter().enumerate() {
            lines.insert(insert_at + off, item);
        }
        let mut out = lines.join("\n");
        out.push('\n');
        return (out, Some(written));
    }
    let trimmed = stripped.trim_end_matches('\n');
    let block = format!(
        "{}\n[agents]\n{}\n",
        MANAGED_AGENTS_TABLE_MARKER,
        to_add.join("\n")
    );
    let out = if trimmed.is_empty() {
        block
    } else {
        format!("{trimmed}\n\n{block}")
    };
    (out, Some(written))
}

fn strip_subagent_defaults(content_lf: &str, written: Option<&WrittenSubagentDefaults>) -> String {
    let lines: Vec<&str> = content_lf.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let Some(ag_idx) = lines.iter().enumerate().position(|(i, l)| {
        structural[i] && parse_simple_table_name(l).as_deref() == Some("agents")
    }) else {
        return content_lf.to_owned();
    };
    let end_idx = lines[ag_idx + 1..]
        .iter()
        .enumerate()
        .position(|(rel, l)| structural[ag_idx + 1 + rel] && is_table_header(l))
        .map(|rel| ag_idx + 1 + rel)
        .unwrap_or(lines.len());
    let mut drop = vec![false; lines.len()];
    for i in (ag_idx + 1)..end_idx {
        if !structural[i] {
            continue;
        }
        let trimmed = lines[i].trim();
        if trimmed == MANAGED_SUBAGENT_DEFAULT_MARKER {
            drop[i] = true;
            continue;
        }
        if let Ok(Some(val)) =
            parse_single_line_string_assignment(lines[i], "default_subagent_model")
        {
            let marked = i > ag_idx + 1 && lines[i - 1].trim() == MANAGED_SUBAGENT_DEFAULT_MARKER;
            let matched = written.is_some_and(|w| w.default_subagent_model == val);
            if (marked && written.is_none()) || matched {
                drop[i] = true;
            }
        } else if let Ok(Some(val)) =
            parse_single_line_string_assignment(lines[i], "default_subagent_reasoning_effort")
        {
            let marked = i > ag_idx + 1 && lines[i - 1].trim() == MANAGED_SUBAGENT_DEFAULT_MARKER;
            let matched = written.and_then(|w| w.default_subagent_reasoning_effort.as_deref())
                == Some(val.as_str());
            if (marked && written.is_none()) || matched {
                drop[i] = true;
            }
        }
    }
    let remaining_body_has_content = (ag_idx + 1..end_idx)
        .filter(|&i| !drop[i])
        .any(|i| !structural[i] || !lines[i].trim().is_empty());
    if !remaining_body_has_content {
        for d in &mut drop[ag_idx..end_idx] {
            *d = true;
        }
    }
    if ag_idx > 0
        && structural[ag_idx - 1]
        && lines[ag_idx - 1].trim() == MANAGED_AGENTS_TABLE_MARKER
    {
        drop[ag_idx - 1] = true;
    }
    lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| (!drop[i]).then_some(l))
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_features_ledger(
    content_lf: &str,
    wrote_fast_mode: Option<bool>,
    prior_user_fast_mode_line: Option<&str>,
    wrote_multi_agent_v2: Option<bool>,
    prior_user_multi_agent_v2_line: Option<&str>,
) -> String {
    if wrote_fast_mode.is_none() && wrote_multi_agent_v2.is_none() {
        return content_lf.to_owned();
    }
    let mut lines: Vec<String> = content_lf.split('\n').map(str::to_owned).collect();
    let (structural, _) = mark_structural_lines(&lines);
    let Some(feat_idx) = lines.iter().enumerate().position(|(i, l)| {
        structural[i] && parse_simple_table_name(l).as_deref() == Some("features")
    }) else {
        return content_lf.to_owned();
    };
    let end_idx = lines[feat_idx + 1..]
        .iter()
        .enumerate()
        .position(|(rel, l)| structural[feat_idx + 1 + rel] && is_table_header(l))
        .map(|rel| feat_idx + 1 + rel)
        .unwrap_or(lines.len());
    let mut drop = vec![false; lines.len()];
    for i in (feat_idx + 1)..end_idx {
        if !structural[i] {
            continue;
        }
        if let Some((k, rhs)) = parse_key_value_line(&lines[i]) {
            let val_clean = strip_inline_comment(rhs).trim();
            if let Some(fm) = wrote_fast_mode
                && k == "fast_mode"
                && val_clean == (if fm { "true" } else { "false" })
            {
                if let Some(prior) = prior_user_fast_mode_line {
                    lines[i] = prior.to_owned();
                } else {
                    drop[i] = true;
                }
                continue;
            }
            if let Some(v2) = wrote_multi_agent_v2
                && k == "multi_agent_v2"
                && val_clean == (if v2 { "true" } else { "false" })
            {
                if let Some(prior) = prior_user_multi_agent_v2_line {
                    lines[i] = prior.to_owned();
                } else {
                    drop[i] = true;
                }
            }
        }
    }
    let remaining_has_keys = (feat_idx + 1..end_idx)
        .filter(|&i| !drop[i])
        .any(|i| !structural[i] || !lines[i].trim().is_empty());
    if !remaining_has_keys {
        for d in &mut drop[feat_idx..end_idx] {
            *d = true;
        }
    }
    lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| (!drop[i]).then_some(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Applies Design B loopback keys + Home Codex settings onto `raw_input`.
pub fn apply_design_b_config(
    raw_input: &str,
    listen_port: u16,
    catalog_path: &str,
    settings: &HomeCodexSettings,
    prior_ledger: Option<&ChildInjectedLedger>,
) -> Result<(String, ChildInjectedLedger), String> {
    if let Some(ext) = external_codex_model_provider(raw_input) {
        return Err(format!("external model_provider ({ext}) owns config.toml"));
    }
    let eol = if raw_input.is_empty() {
        "\n"
    } else {
        dominant_eol(raw_input)
    };
    let base_url = format!("http://127.0.0.1:{listen_port}/v1");
    let mut lf = apply_eol(raw_input, "\n");
    lf = strip_owned_root_urls(
        &lf,
        prior_ledger
            .and_then(|l| l.openai_base_url.as_deref())
            .or(Some(base_url.as_str())),
        prior_ledger
            .and_then(|l| l.experimental_realtime_ws_base_url.as_deref())
            .or(Some(base_url.as_str())),
    );
    let (ws_lf, wrote_ws, replaced_ws) = ensure_root_web_search(
        &lf,
        !settings.web_search_sidecar_enabled,
        prior_ledger.and_then(|l| l.injected_web_search.as_deref()),
        prior_ledger.and_then(|l| l.replaced_user_web_search_line.as_deref()),
    )?;
    lf = ws_lf;
    lf = set_root_catalog_path(&lf, catalog_path);
    lf = insert_root_lines(
        &lf,
        &[
            OCX_ROUTING_MARKER_LINE.to_owned(),
            format!("openai_base_url = {}", toml_escape_basic_string(&base_url)),
            OCX_ROUTING_MARKER_LINE.to_owned(),
            format!(
                "experimental_realtime_ws_base_url = {}",
                toml_escape_basic_string(&base_url)
            ),
        ],
    );
    let mut wrote_fast = prior_ledger.and_then(|l| l.wrote_fast_mode);
    let mut prior_fast_line = prior_ledger.and_then(|l| l.prior_user_fast_mode_line.clone());
    if let Some(fm) = settings.fast_mode {
        let (next_lf, overwritten) = upsert_table_bool(&lf, "features", "fast_mode", fm);
        if wrote_fast.is_none() {
            prior_fast_line = overwritten;
        }
        lf = next_lf;
        wrote_fast = Some(fm);
    }
    let mut wrote_v2 = prior_ledger.and_then(|l| l.wrote_multi_agent_v2);
    let mut prior_v2_line = prior_ledger.and_then(|l| l.prior_user_multi_agent_v2_line.clone());
    if let Some(mode) = &settings.multi_agent_mode {
        let v2_bool = mode == "v2";
        let (next_lf, overwritten) = upsert_table_bool(&lf, "features", "multi_agent_v2", v2_bool);
        if wrote_v2.is_none() {
            prior_v2_line = overwritten;
        }
        lf = next_lf;
        wrote_v2 = Some(v2_bool);
    }
    let (sub_lf, wrote_sub) = apply_subagent_defaults(
        &lf,
        settings.subagent_defaults.as_ref(),
        prior_ledger.and_then(|l| l.wrote_subagent_defaults.as_ref()),
    );
    lf = sub_lf;
    let ledger = ChildInjectedLedger {
        openai_base_url: Some(base_url.clone()),
        experimental_realtime_ws_base_url: Some(base_url),
        model_catalog_json: Some(catalog_path.to_owned()),
        injected_web_search: wrote_ws,
        replaced_user_web_search_line: replaced_ws,
        wrote_fast_mode: wrote_fast,
        prior_user_fast_mode_line: prior_fast_line,
        wrote_multi_agent_v2: wrote_v2,
        prior_user_multi_agent_v2_line: prior_v2_line,
        wrote_subagent_defaults: wrote_sub,
    };
    Ok((apply_eol(&lf, eol), ledger))
}

/// Tier-2 surgical value-matched strip surviving `#1798` comment-stripping rewrites.
pub fn surgical_detach_config(
    raw_current: &str,
    ledger: &ChildInjectedLedger,
) -> Result<Option<String>, String> {
    let eol = dominant_eol(raw_current);
    let lf = apply_eol(raw_current, "\n");
    // Validate every root managed key line parses cleanly; fail closed on corrupt spans.
    let lines: Vec<&str> = lf.split('\n').collect();
    let (structural, unclosed) = mark_structural_lines(&lines);
    if unclosed {
        return Err("config.toml contains an unclosed multiline string".to_owned());
    }
    let root_end = root_end_index(&lines, &structural);
    for i in 0..root_end {
        if !structural[i] {
            continue;
        }
        let line = lines[i];
        for managed_key in [
            "openai_base_url",
            "experimental_realtime_ws_base_url",
            "model_catalog_json",
            "web_search",
        ] {
            if let Some((k, _)) = parse_key_value_line(line)
                && k == managed_key
            {
                parse_single_line_string_assignment(line, managed_key)?;
            }
        }
    }
    // Also drop orphaned marker above user-edited openai_base_url
    let mut drop_orphan = vec![false; lines.len()];
    for i in 1..root_end {
        if structural[i]
            && structural[i - 1]
            && is_ocx_routing_marker_line(lines[i - 1])
            && let Some((k, _)) = parse_key_value_line(lines[i])
            && (k == "openai_base_url" || k == "experimental_realtime_ws_base_url")
        {
            drop_orphan[i - 1] = true;
        }
    }
    let mut work = lines
        .into_iter()
        .enumerate()
        .filter_map(|(i, l)| (!drop_orphan[i]).then_some(l))
        .collect::<Vec<_>>()
        .join("\n");
    work = strip_owned_root_urls(
        &work,
        ledger.openai_base_url.as_deref(),
        ledger.experimental_realtime_ws_base_url.as_deref(),
    );
    work = strip_opencodex_catalog_path(&work);
    let (ws_restored, _, _) = ensure_root_web_search(
        &work,
        false,
        ledger.injected_web_search.as_deref(),
        ledger.replaced_user_web_search_line.as_deref(),
    )?;
    work = ws_restored;
    work = strip_features_ledger(
        &work,
        ledger.wrote_fast_mode,
        ledger.prior_user_fast_mode_line.as_deref(),
        ledger.wrote_multi_agent_v2,
        ledger.prior_user_multi_agent_v2_line.as_deref(),
    );
    work = strip_subagent_defaults(&work, ledger.wrote_subagent_defaults.as_ref());
    work = collapse_excess_blank_lines(&work);
    if work.trim().is_empty() {
        Ok(None)
    } else {
        if !work.ends_with('\n') {
            work.push('\n');
        }
        Ok(Some(apply_eol(&work, eol)))
    }
}

fn collapse_excess_blank_lines(lf: &str) -> String {
    let lines: Vec<&str> = lf.split('\n').collect();
    let (structural, _) = mark_structural_lines(&lines);
    let mut out_lines: Vec<&str> = Vec::with_capacity(lines.len());
    let mut blank_run = 0usize;
    let mut started = false;
    for (i, &line) in lines.iter().enumerate() {
        let is_struct_blank = structural[i] && line.is_empty();
        if !started && is_struct_blank {
            continue;
        }
        started = true;
        if is_struct_blank {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out_lines.push(line);
    }
    while out_lines.len() > 1
        && out_lines.last() == Some(&"")
        && out_lines[out_lines.len() - 2].is_empty()
    {
        out_lines.pop();
    }
    out_lines.join("\n")
}
