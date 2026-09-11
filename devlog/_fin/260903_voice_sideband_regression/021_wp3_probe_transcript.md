# 021 — wp3 probe transcript (isolated home, ephemeral port, fake upstream)

Command: `bun .tmp/voice-probe.ts` (scratch script, not committed; OPENCODEX_HOME + CODEX_HOME = mktemp,
proxy on port 0, fake ChatGPT backend + fake sideband WS server, pool of two accounts under round-robin,
`experimentalRealtimeWsBaseUrl` pointed at the fake so the relay's upstream sideband dial is observable).
Port 10100 untouched.

Exit code: 0

```
call-create status 201 location /v1/live/rtc_probe
sideband relay reply echo:ping
[
 {
  "leg": "call-create",
  "path": "/realtime/calls?intent=quicksilver&architecture=avas",
  "acct": "acct-a",
  "sid": "sess_probe",
  "tid": "thread_probe"
 },
 {
  "leg": "call-create",
  "path": "/realtime/calls?intent=quicksilver&architecture=avas",
  "acct": "acct-b",
  "sid": "s2",
  "tid": "t2"
 },
 {
  "leg": "sideband",
  "path": "/v1/live/rtc_probe",
  "acct": "acct-a",
  "sid": "sess_probe",
  "tid": "thread_probe"
 }
]
SAME_ACCOUNT_BOTH_LEGS true | other-thread account acct-b
```

Reading: call-create for (sess_probe, thread_probe) went out under `acct-a`; an unrelated thread advanced
round-robin to `acct-b`; the keyed sideband join `GET /v1/live/rtc_probe` with the same session/thread
headers was relayed to `/v1/live/rtc_probe` under `acct-a` again and echoed a frame back. This is the
exact request shape codex-rs produces with `experimental_realtime_ws_base_url = http://127.0.0.1:<port>/v1`
(realtime_websocket/methods.rs:1084/1129/1166).
