"""Offline contract tests. This does NOT run Rust, native Codex, or a mobile app."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import unittest
from dataclasses import FrozenInstanceError
from native_policy import ConnectionOrigin as Origin, RemoteListPolicy, resolve_provider_filter


class NativePolicyTests(unittest.TestCase):
    def resolve(self, **kwargs):
        defaults = {"origin": Origin.REMOTE_CONTROL, "default_provider": "opencodex"}
        defaults.update(kwargs)
        return resolve_provider_filter(**defaults)

    def test_opt_out_keeps_existing_default_for_every_origin(self):
        for origin in Origin:
            with self.subTest(origin=origin):
                self.assertEqual(self.resolve(origin=origin), ("opencodex",))

    def test_only_native_remote_origin_uses_opt_in(self):
        policy = RemoteListPolicy(("openai", "opencodex"))
        for origin in Origin:
            with self.subTest(origin=origin):
                expected = policy.providers if origin is Origin.REMOTE_CONTROL else ("opencodex",)
                self.assertEqual(self.resolve(origin=origin, policy=policy), expected)

    def test_explicit_nonempty_filter_wins_over_every_policy(self):
        for policy in (RemoteListPolicy(), RemoteListPolicy(()), RemoteListPolicy(("openai",))):
            for origin in Origin:
                with self.subTest(policy=policy, origin=origin):
                    for requested in (("other",), ("other", "other"), ("",), (" other ",)):
                        self.assertEqual(self.resolve(origin=origin, requested=requested, policy=policy), requested)

    def test_explicit_empty_filter_is_all_for_every_origin(self):
        for origin in Origin:
            with self.subTest(origin=origin):
                self.assertIsNone(self.resolve(origin=origin, requested=(), policy=RemoteListPolicy(("openai",))))

    def test_opt_in_all_is_not_the_default(self):
        self.assertIsNone(self.resolve(policy=RemoteListPolicy(())))
        self.assertEqual(self.resolve(), ("opencodex",))

    def test_parent_query_keeps_native_no_default_filter(self):
        for policy in (RemoteListPolicy(), RemoteListPolicy(("opencodex",))):
            self.assertIsNone(self.resolve(parent_thread_id="00000000-0000-4000-8000-0000000000aa", policy=policy))

    def test_ancestor_query_keeps_native_no_default_filter(self):
        for policy in (RemoteListPolicy(), RemoteListPolicy(("opencodex",))):
            self.assertIsNone(self.resolve(ancestor_thread_id="00000000-0000-4000-8000-0000000000bb", policy=policy))

    def test_related_thread_ids_follow_native_validation(self):
        # Upstream thread_list_response_inner rejects malformed ids and rejects
        # parent+ancestor together; a malformed id must not silently widen the list.
        for relation in (
            {"parent_thread_id": ""},
            {"ancestor_thread_id": "  "},
            {"parent_thread_id": "fixture-parent"},
            {"ancestor_thread_id": "fixture-ancestor"},
            {"parent_thread_id": "p"},
        ):
            with self.subTest(relation=relation), self.assertRaises(ValueError):
                self.resolve(**relation)
        with self.assertRaises(ValueError):
            self.resolve(
                parent_thread_id="00000000-0000-4000-8000-0000000000aa",
                ancestor_thread_id="00000000-0000-4000-8000-0000000000bb",
            )

    def test_explicit_filter_still_wins_for_related_queries(self):
        for relation in (
            {"parent_thread_id": "00000000-0000-4000-8000-0000000000aa"},
            {"ancestor_thread_id": "00000000-0000-4000-8000-0000000000bb"},
        ):
            self.assertEqual(self.resolve(requested=("other",), policy=RemoteListPolicy(()), **relation), ("other",))

    def test_null_and_omitted_match_typed_native_option_semantics(self):
        for wire in ('{}', '{"modelProviders": null}'):
            requested = json.loads(wire).get("modelProviders")
            self.assertIsNone(requested)
            self.assertEqual(self.resolve(requested=requested, policy=RemoteListPolicy(("openai",))), ("openai",))

    def test_provider_names_are_not_hardcoded(self):
        self.assertEqual(self.resolve(default_provider="custom"), ("custom",))
        self.assertEqual(self.resolve(policy=RemoteListPolicy(("azure-team", "local"))), ("azure-team", "local"))

    def test_provider_ids_are_exact_not_aliases(self):
        self.assertEqual(self.resolve(policy=RemoteListPolicy(("OpenAI", " openai "))), ("OpenAI", " openai "))

    def test_policy_cannot_be_mutated_during_pagination(self):
        policy = RemoteListPolicy(("openai",))
        with self.assertRaises(FrozenInstanceError):
            policy.providers = ()

    def test_rejects_invalid_policy(self):
        for value in (["openai"], "openai", ("",), ("  ",), (1,), ("openai", "openai")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                RemoteListPolicy(value)

    def test_rejects_untrusted_origin_string(self):
        with self.assertRaises(ValueError):
            self.resolve(origin="remote_control")

    def test_rejects_invalid_default_provider(self):
        for value in ("", "  ", None, 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.resolve(default_provider=value)

    def test_rejects_invalid_requested_filter(self):
        for value in (["other"], "other", (1,), (None,)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.resolve(requested=value)


class SyntheticPaginationTests(unittest.TestCase):
    """Fixture SQL illustrates the contract, not the native Codex store schema."""
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE threads (id INTEGER PRIMARY KEY, provider TEXT NOT NULL)")
        self.db.executemany("INSERT INTO threads VALUES (?, ?)",
            [(i, "openai") for i in range(1, 5201)] + [(5201, "opencodex"), (5202, "other")])
        self.before = self.digest()

    def digest(self):
        return hashlib.sha256("\n".join(self.db.iterdump()).encode()).hexdigest()

    def list_all(self, policy, limit=37, requested=None):
        providers = resolve_provider_filter(origin=Origin.REMOTE_CONTROL,
            default_provider="opencodex", requested=requested, policy=policy)
        rows, last_id = [], 0
        while True:
            values = [last_id]
            sql = "SELECT id, provider FROM threads WHERE id > ?"
            if providers is not None:
                sql += " AND provider IN (" + ",".join("?" for _ in providers) + ")"
                values.extend(providers)
            sql += " ORDER BY id LIMIT ?"
            values.append(limit)
            page = self.db.execute(sql, values).fetchall()
            if not page:
                break
            rows.extend(page)
            last_id = page[-1][0]
        self.assertEqual(self.digest(), self.before, "read must not retag fixture rows")
        self.assertEqual(len({row[0] for row in rows}), len(rows))
        return rows

    def test_default_remains_one_thread(self):
        self.assertEqual(self.list_all(RemoteListPolicy()), [(5201, "opencodex")])

    def test_opt_in_two_provider_list_returns_5201_rows(self):
        rows = self.list_all(RemoteListPolicy(("openai", "opencodex")))
        self.assertEqual(len(rows), 5201)
        self.assertNotIn("other", {row[1] for row in rows})

    def test_explicit_all_returns_5202_rows(self):
        self.assertEqual(len(self.list_all(RemoteListPolicy(()))), 5202)

    def test_explicit_client_filter_not_broadened(self):
        self.assertEqual(self.list_all(RemoteListPolicy(()), requested=("other",)), [(5202, "other")])

    def test_unlisted_provider_returns_empty_without_fallback(self):
        self.assertEqual(self.list_all(RemoteListPolicy(("not-in-fixture",))), [])

    def test_every_page_uses_same_policy_without_duplicates(self):
        policy = RemoteListPolicy(("openai", "opencodex"))
        self.assertEqual(self.list_all(policy, limit=1), self.list_all(policy, limit=1000))


if __name__ == "__main__":
    unittest.main(verbosity=2)
