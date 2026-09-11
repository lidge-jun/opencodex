# 041 — Static default verification boundary

Head `2e9006609` produced 281 passing catalog tests and one failure in both remote
and hosted verification. Its old Go fixture expected no models, but existing
registry ownership and capture-time enrichment already supplied `kimi-k2.7-code`
as that provider's effective default. The new static seed intentionally publishes it.

The production seed remains unchanged. The replacement assertion requires exactly
that one inherited default and no metadata-roster augmentation, for omitted and
empty model lists, with zero upstream requests. A distinct custom MiMo destination
checks the existing strict transport guard, no inherited default or list, and an
exactly empty authoritative result. Unregistered no-default, explicit-list,
retention, forward and OAuth no-request controls remain in place.

Independent source review confirmed this is an obsolete expectation for the
intentional new contract, not evidence of a new endpoint-ownership defect. The
initial failing result stays recorded; the amended tests require fresh verification.
