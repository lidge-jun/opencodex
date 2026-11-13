//! Whether this Child's Home advertises the Responses WebSocket over the link (as the TypeScript Child's
//! link-ws-advertisement.ts does), and ocx-child's own release gate.
//!
//! Every relay-auth preflight of the serving process takes a number from one process counter before it
//! is written. A verified answer applies only to the entry of the link id its preflight used, and only
//! when its number is higher than the last one applied for that link, so a late answer to an earlier
//! preflight never overwrites a newer one, and an answer for an old link id never touches the current
//! link's entry. An answer is on only with exactly one x-opencodex-link-ws-state header equal to "on" and
//! exactly one x-opencodex-link-ws-proof header whose HMAC (key: the 32 bytes of the hex fingerprint)
//! verifies for that nonce and both identities; anything else is off. At most 8 links are kept, with a
//! watermark per evicted link (at most 1,024) so an evicted link's late answer cannot land as the newest;
//! only a dropped watermark raises a shared floor. Memory only: a restart starts from off.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::platform::{hex_decode_lower, hex_encode};
use crate::relay_auth::{is_valid_hex64, is_valid_key_id, is_valid_link_id, relay_proof_matches};

pub const LINK_RELAY_WS_STATE_HEADER: &str = "x-opencodex-link-ws-state";
pub const LINK_RELAY_WS_STATE_PROOF_HEADER: &str = "x-opencodex-link-ws-proof";

const MAX_LINKS: usize = 8;
const MAX_WATERMARKS: usize = 1_024;

/// ocx-child's release gate. Closed in every build without the `link-ws-test-gate` feature, whatever
/// its profile or environment; only a build with that feature (the integration tests) opens it, and
/// only when OCX_CHILD_TEST_LINK_WS_READY is "1".
pub fn gate_open() -> bool {
    #[cfg(feature = "link-ws-test-gate")]
    {
        std::env::var("OCX_CHILD_TEST_LINK_WS_READY").as_deref() == Ok("1")
    }
    #[cfg(not(feature = "link-ws-test-gate"))]
    {
        false
    }
}

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The number a preflight takes before it is written.
pub fn next_preflight() -> u64 {
    SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1
}

/// HMAC-SHA256 under the 32 bytes decoded from the hex fingerprint, over
/// "opencodex-link-ws-v1" NUL keyId NUL linkId NUL nonce NUL "on" (src/link/relay-auth.ts).
pub fn ws_state_proof(
    fingerprint_hex: &str,
    key_id: &str,
    link_id: &str,
    nonce: &str,
) -> Option<String> {
    if !is_valid_hex64(fingerprint_hex)
        || !is_valid_key_id(key_id)
        || !is_valid_link_id(link_id)
        || !is_valid_hex64(nonce)
    {
        return None;
    }
    let key = hex_decode_lower(fingerprint_hex)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(b"opencodex-link-ws-v1\0");
    mac.update(key_id.as_bytes());
    mac.update(b"\0");
    mac.update(link_id.as_bytes());
    mac.update(b"\0");
    mac.update(nonce.as_bytes());
    mac.update(b"\0on");
    Some(hex_encode(&mac.finalize().into_bytes()))
}

fn only<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let mut found = headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(name));
    let first = found.next()?;
    if found.next().is_some() {
        return None;
    }
    Some(first.1.as_str())
}

/// Whether one verified relay-auth answer names the link WebSocket as on.
pub fn answer_is_on(
    headers: &[(String, String)],
    fingerprint_hex: &str,
    key_id: &str,
    link_id: &str,
    nonce: &str,
) -> bool {
    if only(headers, LINK_RELAY_WS_STATE_HEADER) != Some("on") {
        return false;
    }
    let expected = ws_state_proof(fingerprint_hex, key_id, link_id, nonce);
    relay_proof_matches(
        only(headers, LINK_RELAY_WS_STATE_PROOF_HEADER),
        expected.as_deref(),
    )
}

#[derive(Default)]
struct Book {
    /// Least recently applied first.
    links: VecDeque<(String, u64, bool)>,
    watermarks: HashMap<String, u64>,
    watermark_order: VecDeque<String>,
    floor: u64,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

/// Apply a verified answer under the ordering rule; returns whether it was applied.
pub fn apply(link_id: &str, preflight: u64, on: bool) -> bool {
    let mut guard = BOOK.lock().unwrap_or_else(|e| e.into_inner());
    let book = guard.get_or_insert_with(Book::default);
    let position = book.links.iter().position(|(id, _, _)| id == link_id);
    let applied = match position {
        Some(i) => book.links[i].1,
        None => book.watermarks.get(link_id).copied().unwrap_or(book.floor),
    };
    if preflight <= applied {
        return false;
    }
    if let Some(i) = position {
        book.links.remove(i);
    }
    if book.watermarks.remove(link_id).is_some() {
        book.watermark_order.retain(|id| id != link_id);
    }
    book.links.push_back((link_id.to_owned(), preflight, on));
    if book.links.len() > MAX_LINKS
        && let Some((evicted, mark, _)) = book.links.pop_front()
    {
        book.watermarks.insert(evicted.clone(), mark);
        book.watermark_order.push_back(evicted);
        if book.watermark_order.len() > MAX_WATERMARKS
            && let Some(dropped) = book.watermark_order.pop_front()
            && let Some(m) = book.watermarks.remove(&dropped)
        {
            book.floor = book.floor.max(m);
        }
    }
    true
}

/// advertisedSeen: "on" in the last answer applied for this link.
pub fn advertised(link_id: &str) -> bool {
    let guard = BOOK.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .is_some_and(|b| b.links.iter().any(|(id, _, on)| id == link_id && *on))
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    *BOOK.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NONCE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const LINK: &str = "lnk_0123456789abcdef";
    /// The ordering and eviction tests' own link: the relay tests in link_ws.rs apply answers for LINK.
    const ORDER_LINK: &str = "lnk_a1a1a1a1a1a1a1a1";

    fn hdrs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn proof_matches_the_typescript_home() {
        // One shared vector file: tests/clients/link-ocx-child-ws-gate.test.ts checks the same cases against
        // linkWebsocketStateProof in src/link/relay-auth.ts.
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/link/link-ws-state-proof.json"
        ))
        .unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 2);
        for case in cases {
            let field = |name: &str| case[name].as_str().unwrap().to_owned();
            assert_eq!(field("value"), "on");
            assert_eq!(
                ws_state_proof(
                    &field("fingerprint"),
                    &field("keyId"),
                    &field("linkId"),
                    &field("nonce")
                ),
                Some(field("proof"))
            );
        }
        assert!(cases.iter().any(|case| case["fingerprint"] == FP
            && case["linkId"] == LINK
            && case["nonce"] == NONCE));
    }

    #[test]
    fn exactly_one_verified_on() {
        let proof = ws_state_proof(FP, "key-1", LINK, NONCE).unwrap();
        assert!(answer_is_on(
            &hdrs(&[
                (LINK_RELAY_WS_STATE_HEADER, "on"),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof)
            ]),
            FP,
            "key-1",
            LINK,
            NONCE
        ));
        assert!(!answer_is_on(&hdrs(&[]), FP, "key-1", LINK, NONCE));
        assert!(!answer_is_on(
            &hdrs(&[(LINK_RELAY_WS_STATE_HEADER, "on")]),
            FP,
            "key-1",
            LINK,
            NONCE
        ));
        assert!(!answer_is_on(
            &hdrs(&[
                (LINK_RELAY_WS_STATE_HEADER, "off"),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof)
            ]),
            FP,
            "key-1",
            LINK,
            NONCE
        ));
        assert!(!answer_is_on(
            &hdrs(&[
                (LINK_RELAY_WS_STATE_HEADER, "on"),
                (LINK_RELAY_WS_STATE_HEADER, "on"),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof)
            ]),
            FP,
            "key-1",
            LINK,
            NONCE
        ));
        assert!(!answer_is_on(
            &hdrs(&[
                (LINK_RELAY_WS_STATE_HEADER, "on"),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof)
            ]),
            FP,
            "key-1",
            LINK,
            NONCE
        ));
        assert!(!answer_is_on(
            &hdrs(&[
                (LINK_RELAY_WS_STATE_HEADER, "on"),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof)
            ]),
            FP,
            "key-2",
            LINK,
            NONCE
        ));
        let other_nonce = "c".repeat(64);
        assert!(!answer_is_on(
            &hdrs(&[
                (LINK_RELAY_WS_STATE_HEADER, "on"),
                (LINK_RELAY_WS_STATE_PROOF_HEADER, &proof)
            ]),
            FP,
            "key-1",
            LINK,
            &other_nonce
        ));
    }

    #[test]
    fn ordering_per_link() {
        let _serial = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();
        let a = next_preflight();
        let b = next_preflight();
        assert!(apply(ORDER_LINK, b, false));
        assert!(!apply(ORDER_LINK, a, true));
        assert!(!advertised(ORDER_LINK));
        // An old link's late answer, numbered after the new link's, touches only its own entry.
        let new_link = "lnk_fedcba9876543210";
        let n = next_preflight();
        let old = next_preflight();
        assert!(apply(new_link, n, true));
        assert!(apply(ORDER_LINK, old, true));
        assert!(advertised(new_link));
        // More than four toggles in scrambled order end on the last one sent.
        let nums: Vec<u64> = (0..7).map(|_| next_preflight()).collect();
        for i in [1usize, 0, 3, 2, 6, 5, 4] {
            apply(new_link, nums[i], i % 2 == 0);
        }
        assert!(advertised(new_link));
        reset_for_tests();
        assert!(!advertised(new_link));
    }

    #[test]
    fn eviction_keeps_ordering_and_recovers() {
        let _serial = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();
        let stale = next_preflight();
        assert!(apply(ORDER_LINK, next_preflight(), true));
        for i in 0..8 {
            apply(&format!("lnk_{i:016x}"), next_preflight(), false);
        }
        // Evicted: reads off (conservative), and its late answer cannot land as the newest.
        assert!(!advertised(ORDER_LINK));
        assert!(!apply(ORDER_LINK, stale, true));
        // The current link's next preflight restores it.
        assert!(apply(ORDER_LINK, next_preflight(), true));
        assert!(advertised(ORDER_LINK));
        // Other links' traffic never voids an answer for a link it did not evict.
        let first = next_preflight();
        for i in 100..400 {
            apply(&format!("lnk_{i:016x}"), next_preflight(), false);
        }
        let fresh = "lnk_ffffffffffffffff";
        assert!(apply(fresh, first, true));
        reset_for_tests();
    }

    #[cfg(not(feature = "link-ws-test-gate"))]
    #[test]
    fn gate_stays_closed_without_the_test_feature() {
        // SAFETY: set_var is unsafe in edition 2024; this test only reads the variable back through gate_open.
        unsafe { std::env::set_var("OCX_CHILD_TEST_LINK_WS_READY", "1") };
        assert!(!gate_open());
        unsafe { std::env::remove_var("OCX_CHILD_TEST_LINK_WS_READY") };
    }
}
