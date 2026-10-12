//! Who owns the running proxy, as the shared service install state records it.
//!
//! The rule is not this lane's to invent. `src/service/state.ts` defines the claim — an owner, an
//! opaque install id naming the owning installation, and a consent generation — and
//! `ownershipGrantedTo` defines the comparison an installation applies to its own locally stored
//! install id. This is that comparison, and the three-valued reading it is applied to, so the shell
//! reaches the same verdict the CLI does instead of a weaker one of its own.
//!
//! What the shell deliberately does not do is read the record itself. Resolving a claim means
//! reading every state path and failing closed on an unreadable one, on a corrupt anchor record and
//! on paths that name different owners; absence is the only thing that means nobody owns the
//! runtime. Reimplementing that here is how `discovery.rs` ended up asking a weaker liveness
//! question than the one core already answered. The bundled CLI answers it: see [`resolve`].
//!
//! The types below are the CLI's own answer as it will arrive on the wire, field for field, so the
//! contract that lands fills a hole rather than reshaping this file.

use serde::Deserialize;

/// Who a claim names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Cli,
    Desktop,
}

/// A recorded ownership claim.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub owner: Owner,
    pub install_id: String,
    /// Moves once per grant, and never back: the recorded ceiling survives a release so a later
    /// grant cannot reuse a number an app-local record may still be holding.
    ///
    /// The record accepts any non-negative integer, and this accepts the ones it can represent. A
    /// generation outside that range fails to parse, which makes the whole answer unreadable and
    /// so refuses a takeover — the safe direction, and unreachable in practice by a counter that
    /// moves by one per grant.
    pub consent_generation: u64,
}

/// What the recorded state says, in the CLI's own three answers.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Recorded {
    /// No claim. The CLI install that registered the service owns the runtime, which is also what
    /// every record written before the field existed says. The revision is the record's own
    /// sequence, and a later `service claim` carries it as `expect-revision`.
    None { revision: u64 },
    /// A claim, whoever it names.
    Owned { ownership: Claim, revision: u64 },
    /// The claim could not be read for a decision. This is not "nobody owns it": an unreadable
    /// path, a corrupt anchor record and paths naming different owners all land here.
    Unknown { reason: String },
}

impl Default for Recorded {
    /// A resolve document that carries no ownership field at all did not answer the question —
    /// the older bundled CLI predates it — and an unanswered question is not a claim.
    fn default() -> Self {
        Self::Unknown {
            reason: "the bundled CLI did not report ownership".to_owned(),
        }
    }
}

/// The comparison `ownershipGrantedTo` defines: same owner, same install id.
///
/// True means this installation already holds consent. False against a recorded claim means a
/// different installation owns the runtime and consent has to be asked again. No claim means the
/// CLI install still owns it. The generation is not part of the comparison.
pub fn granted_to(claim: Option<&Claim>, owner: Owner, install_id: &str) -> bool {
    matches!(claim, Some(claim) if claim.owner == owner && claim.install_id == install_id)
}

/// What this installation should do about consent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consent {
    /// This installation already holds consent. Asked once, owned permanently — so a second launch
    /// does not ask again.
    Held,
    /// Nothing is recorded, so the CLI install still owns the runtime. This is the first discovery
    /// of an existing installation, and the one time the user is asked.
    AskFirstTime,
    /// A claim exists and it is not ours: another installation, or the CLI explicitly.
    AskAgain,
    /// The record could not be read for a decision, so nothing is taken over on a guess.
    Refuse,
}

pub fn consent(recorded: &Recorded, install_id: &str) -> Consent {
    match recorded {
        Recorded::Unknown { .. } => Consent::Refuse,
        Recorded::None { .. } => Consent::AskFirstTime,
        Recorded::Owned { ownership, .. } => {
            if granted_to(Some(ownership), Owner::Desktop, install_id) {
                Consent::Held
            } else {
                Consent::AskAgain
            }
        }
    }
}

/// One line for the startup state and for the diagnostic.
pub fn describe(recorded: &Recorded, install_id: Option<&str>) -> String {
    let installation = match install_id {
        Some(id) => format!("installation {id}"),
        None => "installation id unavailable".to_owned(),
    };
    let verdict = match (recorded, install_id) {
        (Recorded::Unknown { reason }, _) => {
            format!("recorded owner could not be read ({reason}), so nothing is claimed")
        }
        (_, None) => "recorded owner read, but this installation has no id to compare".to_owned(),
        (_, Some(id)) => match (consent(recorded, id), recorded) {
            (Consent::Held, Recorded::Owned { ownership, .. }) => format!(
                "this installation owns the runtime (consent generation {})",
                ownership.consent_generation
            ),
            (Consent::AskFirstTime, _) => "the CLI install owns the runtime".to_owned(),
            (Consent::AskAgain, _) => "another installation owns the runtime".to_owned(),
            _ => "recorded owner could not be read, so nothing is claimed".to_owned(),
        },
    };
    format!("{installation}; {verdict}")
}

/// Who the recorded claim names, for the consent panel.
pub fn owner_label(recorded: &Recorded) -> String {
    match recorded {
        Recorded::None { .. } => "no recorded owner (an npm or standalone ocx install)".to_owned(),
        Recorded::Owned { ownership, .. } => match ownership.owner {
            Owner::Cli => format!(
                "the OpenCodex CLI install (installation {})",
                ownership.install_id
            ),
            Owner::Desktop => format!(
                "another OpenCodex desktop installation (installation {})",
                ownership.install_id
            ),
        },
        Recorded::Unknown { reason } => format!("unknown ({reason})"),
    }
}

#[cfg(test)]
mod tests {
    use super::{consent, describe, granted_to, owner_label, Claim, Consent, Owner, Recorded};

    fn owned(owner: Owner, install_id: &str, generation: u64) -> Recorded {
        Recorded::Owned {
            ownership: Claim {
                owner,
                install_id: install_id.to_owned(),
                consent_generation: generation,
            },
            revision: 4,
        }
    }

    fn claim(owner: Owner, install_id: &str) -> Claim {
        Claim {
            owner,
            install_id: install_id.to_owned(),
            consent_generation: 1,
        }
    }

    #[test]
    fn the_comparison_is_the_owner_and_the_install_id_together() {
        let ours = claim(Owner::Desktop, "abc");
        assert!(granted_to(Some(&ours), Owner::Desktop, "abc"));
        assert!(!granted_to(Some(&ours), Owner::Desktop, "def"));
        assert!(!granted_to(Some(&ours), Owner::Cli, "abc"));
        assert!(!granted_to(None, Owner::Desktop, "abc"));
    }

    #[test]
    fn the_generation_is_not_part_of_the_comparison() {
        let mut later = claim(Owner::Desktop, "abc");
        later.consent_generation = 9;
        assert!(granted_to(Some(&later), Owner::Desktop, "abc"));
    }

    #[test]
    fn consent_is_asked_once_and_then_held() {
        assert_eq!(
            consent(&owned(Owner::Desktop, "abc", 1), "abc"),
            Consent::Held
        );
        assert_eq!(
            consent(&Recorded::None { revision: 0 }, "abc"),
            Consent::AskFirstTime
        );
    }

    #[test]
    fn a_claim_that_is_not_ours_asks_again() {
        assert_eq!(
            consent(&owned(Owner::Desktop, "other", 2), "abc"),
            Consent::AskAgain
        );
        assert_eq!(
            consent(&owned(Owner::Cli, "abc", 1), "abc"),
            Consent::AskAgain
        );
    }

    #[test]
    fn an_unreadable_record_refuses_instead_of_reading_as_unowned() {
        let unknown = Recorded::Unknown {
            reason: "a service state path could not be read".to_owned(),
        };
        assert_eq!(consent(&unknown, "abc"), Consent::Refuse);
        assert!(describe(&unknown, Some("abc")).contains("could not be read"));
    }

    #[test]
    fn the_wire_shape_is_the_one_the_cli_records() {
        let resolution: Recorded = serde_json::from_str(
            r#"{"kind":"owned","ownership":{"owner":"desktop","installId":"abc","consentGeneration":3},"revision":4}"#,
        )
        .expect("the recorded resolution");
        assert_eq!(resolution, owned(Owner::Desktop, "abc", 3));
        assert_eq!(consent(&resolution, "abc"), Consent::Held);
        assert!(describe(&resolution, Some("abc")).contains("consent generation 3"));
        assert_eq!(
            serde_json::from_str::<Recorded>(r#"{"kind":"none","revision":0}"#).expect("no claim"),
            Recorded::None { revision: 0 }
        );
        assert_eq!(
            serde_json::from_str::<Recorded>(r#"{"kind":"unknown","reason":"why"}"#)
                .expect("a refusal"),
            Recorded::Unknown {
                reason: "why".to_owned()
            }
        );
    }

    #[test]
    fn a_resolve_document_without_an_ownership_answer_reads_unknown() {
        assert_eq!(
            Recorded::default(),
            Recorded::Unknown {
                reason: "the bundled CLI did not report ownership".to_owned()
            }
        );
        assert!(serde_json::from_str::<Recorded>(r#"{"kind":"none"}"#).is_err());
    }

    #[test]
    fn the_description_separates_not_read_from_nobody_owns_it() {
        let unread = describe(
            &Recorded::Unknown {
                reason: "why".to_owned(),
            },
            Some("abc"),
        );
        let unowned = describe(&Recorded::None { revision: 0 }, Some("abc"));
        assert!(unread.contains("abc"));
        assert_ne!(unread, unowned);
        assert!(describe(&Recorded::None { revision: 0 }, None).contains("unavailable"));
    }

    #[test]
    fn owner_label_names_who_the_claim_is_for() {
        assert_eq!(
            owner_label(&Recorded::None { revision: 0 }),
            "no recorded owner (an npm or standalone ocx install)"
        );
        assert_eq!(
            owner_label(&owned(Owner::Cli, "npm-1", 1)),
            "the OpenCodex CLI install (installation npm-1)"
        );
        assert_eq!(
            owner_label(&owned(Owner::Desktop, "other", 2)),
            "another OpenCodex desktop installation (installation other)"
        );
        assert_eq!(
            owner_label(&Recorded::Unknown {
                reason: "why".to_owned()
            }),
            "unknown (why)"
        );
    }

    #[test]
    fn a_generation_this_cannot_represent_is_not_read_as_a_claim() {
        // Refusing beats granting on a number we cannot compare, and the claim is what a takeover
        // would be authorised against.
        assert!(serde_json::from_str::<Recorded>(
            r#"{"kind":"owned","ownership":{"owner":"desktop","installId":"abc","consentGeneration":-1}}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Recorded>(
            r#"{"kind":"owned","ownership":{"owner":"cli","installId":"abc","consentGeneration":"3"}}"#
        )
        .is_err());
    }
}
