from __future__ import annotations
import base64
import hashlib
import json
import sqlite3
import unittest
from copy import deepcopy
from remote_list_probe import Policy, decode, encode, make_envelope, extract_message, rewrite_backend_frame


class RewriteTests(unittest.TestCase):
    def setUp(self):
        self.policy = Policy(enabled=True)
        self.request = {"id": 27, "method": "thread/list", "params": {"limit": 20, "cursor": "opaque"}}

    def frame(self, request=None, chunk=False):
        return encode(make_envelope(deepcopy(self.request if request is None else request), chunk=chunk))

    def result(self, request=None, chunk=False, policy=None):
        return rewrite_backend_frame(self.frame(request, chunk), policy or self.policy)

    def assert_preserved(self, raw):
        outcome = rewrite_backend_frame(raw, self.policy)
        self.assertFalse(outcome.changed)
        self.assertEqual(raw, outcome.text)

    def test_opt_in_required(self):
        raw = self.frame()
        self.assertEqual(rewrite_backend_frame(raw, Policy()).text, raw)
        self.assertFalse(rewrite_backend_frame(raw, Policy()).changed)

    def test_plain_omitted_filter(self):
        out = self.result()
        self.assertTrue(out.changed)
        self.assertEqual(extract_message(decode(out.text))["params"]["modelProviders"], ["openai", "opencodex"])

    def test_explicit_all_provider_mode(self):
        out = self.result(policy=Policy(enabled=True, providers=()))
        self.assertEqual(extract_message(decode(out.text))["params"]["modelProviders"], [])

    def test_preserves_envelope_metadata(self):
        before = decode(self.frame())
        after = decode(self.result().text)
        for key in ("client_id", "stream_id", "seq_id", "cursor"):
            self.assertEqual(before[key], after[key])

    def test_preserves_all_other_parameters(self):
        self.request["params"].update(archived=True, cwd="C:/mock", sourceKinds=["cli"],
                                      sortDirection="asc", searchTerm="mock", isPinned=False)
        after = extract_message(decode(self.result().text))
        del after["params"]["modelProviders"]
        self.assertEqual(after, self.request)

    def test_explicit_filter_preserved(self):
        self.request["params"]["modelProviders"] = ["other"]
        self.assert_preserved(self.frame())

    def test_explicit_empty_filter_preserved(self):
        self.request["params"]["modelProviders"] = []
        self.assert_preserved(self.frame())

    def test_explicit_null_filter_preserved(self):
        self.request["params"]["modelProviders"] = None
        self.assert_preserved(self.frame())

    def test_missing_params_created(self):
        del self.request["params"]
        self.assertTrue(self.result().changed)

    def test_non_object_params_preserved(self):
        for value in (None, [], "not-an-object", 1):
            with self.subTest(value=value):
                self.request["params"] = value
                self.assert_preserved(self.frame())

    def test_resume_and_other_methods_unchanged(self):
        for method in ("thread/resume", "thread/start", "turn/start", "turn/interrupt", "initialize", "thread/search"):
            with self.subTest(method=method):
                self.request["method"] = method
                self.assert_preserved(self.frame())

    def test_notification_without_id_unchanged(self):
        del self.request["id"]
        self.assert_preserved(self.frame())

    def test_request_id_preserved_exactly(self):
        for request_id in ("request-string", 9007199254740993, 0, -1):
            with self.subTest(request_id=request_id):
                self.request["id"] = request_id
                self.assertEqual(extract_message(decode(self.result().text))["id"], request_id)

    def test_response_like_object_unchanged(self):
        self.request["result"] = {"data": []}
        self.assert_preserved(self.frame())

    def test_relation_query_bypass_preserved(self):
        for key in ("parentThreadId", "ancestorThreadId"):
            with self.subTest(key=key):
                self.request["params"] = {key: "00000000-0000-4000-8000-0000000000aa"}
                self.assert_preserved(self.frame())

    def test_null_relation_does_not_block(self):
        self.request["params"]["parentThreadId"] = None
        self.assertTrue(self.result().changed)

    def test_ping_ack_close_unchanged(self):
        for kind in ("ping", "ack", "client_closed", "unknown_future_event"):
            with self.subTest(kind=kind):
                self.assert_preserved(encode({"type": kind, "client_id": "mock-client", "seq_id": 3}))

    def test_invalid_json_preserved(self):
        for raw in ("{broken", "[]", "null", '{"type":"client_message","client_id":"x","message":NaN}'):
            with self.subTest(raw=raw):
                self.assert_preserved(raw)

    def test_duplicate_members_preserved(self):
        raw = self.frame().replace('"method":"thread/list"', '"method":"thread/list","method":"thread/resume"')
        self.assert_preserved(raw)

    def test_unknown_envelope_fields_preserved(self):
        envelope = decode(self.frame())
        envelope["future_field"] = {"tag": [1, 2, 3]}
        out = rewrite_backend_frame(encode(envelope), self.policy)
        self.assertEqual(decode(out.text)["future_field"], envelope["future_field"])

    def test_single_chunk_transformed_with_correct_byte_size(self):
        self.request["params"]["searchTerm"] = "한글🙂"
        out = self.result(chunk=True)
        self.assertTrue(out.changed)
        after = decode(out.text)
        payload = base64.b64decode(after["message_chunk_base64"], validate=True)
        self.assertEqual(len(payload), after["message_size_bytes"])
        self.assertEqual(decode(payload)["params"]["modelProviders"], ["openai", "opencodex"])
        self.assertEqual(after["seq_id"], 7)

    def test_single_chunk_existing_filter_unchanged(self):
        self.request["params"]["modelProviders"] = ["other"]
        self.assert_preserved(self.frame(chunk=True))

    def test_multi_segment_deliberately_not_implemented(self):
        envelope = decode(self.frame(chunk=True))
        envelope["segment_count"] = 2
        out = rewrite_backend_frame(encode(envelope), self.policy)
        self.assertEqual(out.reason, "multi_segment_not_implemented")
        self.assertFalse(out.changed)

    def test_bad_chunk_length_unchanged(self):
        envelope = decode(self.frame(chunk=True))
        envelope["message_size_bytes"] += 1
        self.assert_preserved(encode(envelope))

    def test_bad_chunk_base64_unchanged(self):
        envelope = decode(self.frame(chunk=True))
        envelope["message_chunk_base64"] = "not@@base64"
        self.assert_preserved(encode(envelope))

    def test_oversized_input_unchanged(self):
        raw = self.frame()
        out = rewrite_backend_frame(raw, Policy(enabled=True, max_wire_bytes=64))
        self.assertFalse(out.changed)
        self.assertEqual(out.text, raw)

    def test_oversized_output_unchanged(self):
        raw = self.frame()
        out = rewrite_backend_frame(raw, Policy(enabled=True, max_wire_bytes=len(raw.encode())))
        self.assertFalse(out.changed)
        self.assertEqual(out.reason, "output_size_limit")

    def test_invalid_policy_rejected(self):
        for providers in (("",), ("a", "a"), (1,), ["a"]):
            with self.subTest(providers=providers):
                with self.assertRaises(ValueError):
                    Policy(enabled=True, providers=providers)

    def test_synthetic_sqlite_visibility_and_no_mutation(self):
        # Synthetic fixture, NOT the user's database and NOT native Codex.
        db = sqlite3.connect(":memory:")
        try:
            db.execute("CREATE TABLE threads (id INTEGER, model_provider TEXT)")
            db.executemany("INSERT INTO threads VALUES (?, ?)", [(i, "openai") for i in range(5200)])
            db.execute("INSERT INTO threads VALUES (5200, 'opencodex')")
            db.execute("INSERT INTO threads VALUES (5201, 'unrelated')")
            before = hashlib.sha256("\n".join(db.iterdump()).encode()).hexdigest()
            self.assertEqual(db.execute("SELECT count(*) FROM threads WHERE model_provider = 'opencodex'").fetchone()[0], 1)
            providers = extract_message(decode(self.result().text))["params"]["modelProviders"]
            placeholders = ",".join("?" for _ in providers)
            scoped = db.execute(f"SELECT count(*) FROM threads WHERE model_provider IN ({placeholders})", providers).fetchone()[0]
            self.assertEqual(scoped, 5201)
            self.assertEqual(db.execute("SELECT count(*) FROM threads").fetchone()[0], 5202)
            after = hashlib.sha256("\n".join(db.iterdump()).encode()).hexdigest()
            self.assertEqual(before, after)
        finally:
            db.close()

if __name__ == "__main__":
    unittest.main(verbosity=2)
