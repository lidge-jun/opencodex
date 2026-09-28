"""Loopback-only mock transport proof. NEVER connects to ChatGPT/OpenAI.

This is a test fixture, not a production proxy. Native Codex is not executed.
The mock backend validates a hard-coded, non-secret fixture token.
"""
from __future__ import annotations
import asyncio
import contextlib
import unittest
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from remote_list_probe import Policy, decode, encode, make_envelope, extract_message, rewrite_backend_frame

BASE = "/backend-api"
WS_PATH = BASE + "/wham/remote/control/server"
MOCK_AUTH = "Bearer NOT-A-REAL-TOKEN-MOCK-ONLY"


def assert_loopback_only(base: str) -> None:
    url = urlsplit(base)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.username or url.password:
        raise ValueError("this research fixture permits only HTTP at literal 127.0.0.1")
    if url.query or url.fragment or url.path:
        raise ValueError("mock base must contain only origin")


def selected_headers(headers) -> dict[str, str]:
    return {key: value for key, value in headers.items()
            if key.lower() in ("authorization", "chatgpt-account-id", "content-type")
            or key.lower().startswith("x-codex-")}


class LoopbackFixtureRelay:
    def __init__(self, mock_backend: str, session: aiohttp.ClientSession, policy: Policy):
        assert_loopback_only(mock_backend)
        self.backend = mock_backend
        self.session = session
        self.policy = policy

    async def handle(self, request: web.Request) -> web.StreamResponse:
        # Test-only origin/host guard. No remote bind and no arbitrary upstream selection.
        if request.headers.get("Origin"):
            return web.Response(status=403, text="browser-origin-blocked")
        if not request.host.startswith("127.0.0.1:"):
            return web.Response(status=403, text="unexpected-host")
        if request.path == WS_PATH and request.headers.get("Upgrade", "").lower() == "websocket":
            return await self.handle_websocket(request)
        target = self.backend + request.raw_path
        async with self.session.request(request.method, target,
                                        data=await request.read(),
                                        headers=selected_headers(request.headers),
                                        allow_redirects=False) as response:
            body = await response.read()
            headers = {key: value for key, value in response.headers.items()
                       if key.lower() in ("content-type", "x-request-id", "retry-after")}
            return web.Response(status=response.status, body=body, headers=headers)

    async def handle_websocket(self, request: web.Request) -> web.StreamResponse:
        target = self.backend + request.raw_path
        try:
            upstream = await self.session.ws_connect(target,
                headers=selected_headers(request.headers), autoping=False)
        except aiohttp.WSServerHandshakeError as exc:
            return web.Response(status=exc.status, text="mock-upstream-rejected")
        downstream = web.WebSocketResponse(autoping=False)
        await downstream.prepare(request)

        async def pump(source, destination, transform: bool):
            async for message in source:
                if message.type == aiohttp.WSMsgType.TEXT:
                    text = rewrite_backend_frame(message.data, self.policy).text if transform else message.data
                    await destination.send_str(text)
                elif message.type == aiohttp.WSMsgType.BINARY:
                    await destination.send_bytes(message.data)
                elif message.type == aiohttp.WSMsgType.PING:
                    await destination.ping(message.data)
                elif message.type == aiohttp.WSMsgType.PONG:
                    await destination.pong(message.data)
                else:
                    break
            # Forward the peer's close so the other side sees the same code
            # instead of hanging on a connection that already ended.
            close_code = getattr(source, "close_code", None) or 1000
            if not destination.closed:
                await destination.close(code=close_code)

        tasks = [asyncio.create_task(pump(upstream, downstream, True)),
                 asyncio.create_task(pump(downstream, upstream, False))]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await upstream.close()
            await downstream.close()
        return downstream


async def start_loopback_app(app: web.Application):
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    return runner, f"http://127.0.0.1:{port}"


class LoopbackBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.frames = []
        self.received = asyncio.Queue()
        self.handshake_headers = {}
        self.http_received = []
        self.backend_app = web.Application()
        self.backend_app.router.add_route("*", "/backend-api/{tail:.*}", self.mock_backend)
        self.backend_runner, self.backend_base = await start_loopback_app(self.backend_app)
        self.relay_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))
        self.relay = LoopbackFixtureRelay(self.backend_base, self.relay_session, Policy(enabled=True))
        relay_app = web.Application()
        relay_app.router.add_route("*", "/backend-api/{tail:.*}", self.relay.handle)
        self.relay_runner, self.relay_base = await start_loopback_app(relay_app)
        self.host = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))

    async def asyncTearDown(self):
        await self.host.close()
        await self.relay_runner.cleanup()
        await self.relay_session.close()
        await self.backend_runner.cleanup()

    async def mock_backend(self, request: web.Request):
        if request.headers.get("Authorization") != MOCK_AUTH:
            return web.Response(status=401, text="mock-auth-required")
        if request.path == WS_PATH and request.headers.get("Upgrade", "").lower() == "websocket":
            self.handshake_headers = dict(request.headers)
            websocket = web.WebSocketResponse(autoping=False)
            await websocket.prepare(request)
            for frame in self.frames:
                await websocket.send_str(frame)
            async for message in websocket:
                if message.type == aiohttp.WSMsgType.TEXT:
                    await self.received.put(message.data)
                elif message.type == aiohttp.WSMsgType.PING:
                    await websocket.pong(message.data)
            return websocket
        body = await request.read()
        self.http_received.append((request.path, body, selected_headers(request.headers)))
        if request.path.endswith("/enroll"):
            return web.json_response({"server_id": "mock-server", "environment_id": "mock-env",
                                      "remote_control_token": "MOCK-ONLY", "expires_at": "2099-01-01T00:00:00Z"},
                                      status=201, headers={"x-request-id": "mock-http-request"})
        return web.Response(status=200, body=b"mock-unrelated-backend-endpoint")

    def add_request(self, params=None, *, chunk=False):
        request = {"id": 42, "method": "thread/list", "params": params or {"limit": 20}}
        self.frames.append(encode(make_envelope(request, chunk=chunk)))

    async def receive_host_frame(self, headers=None):
        async with self.host.ws_connect(self.relay_base + WS_PATH,
                                       headers=headers or {"Authorization": MOCK_AUTH}) as host:
            message = await asyncio.wait_for(host.receive(), 2)
            self.assertEqual(message.type, aiohttp.WSMsgType.TEXT)
            return message.data

    async def test_backend_to_host_rewrite_and_host_reply_passthrough(self):
        self.add_request()
        async with self.host.ws_connect(self.relay_base + WS_PATH,
                                       headers={"Authorization": MOCK_AUTH}) as host:
            incoming = await asyncio.wait_for(host.receive(), 2)
            envelope = decode(incoming.data)
            self.assertEqual(extract_message(envelope)["params"]["modelProviders"], ["openai", "opencodex"])
            response = '{ "type":"server_message", "client_id":"mock-client", "stream_id":"mock-stream", "seq_id":9, "message":{"id":42,"result":{"data":[]}} }'
            await host.send_str(response)
            self.assertEqual(await asyncio.wait_for(self.received.get(), 2), response)

    async def test_auth_and_protocol_handshake_headers_preserved(self):
        self.add_request()
        headers = {"Authorization": MOCK_AUTH, "chatgpt-account-id": "mock-account",
                   "x-codex-protocol-version": "3", "x-codex-server-id": "mock-server",
                   "x-codex-installation-id": "mock-installation", "x-codex-subscribe-cursor": "mock-resume-cursor"}
        await self.receive_host_frame(headers)
        actual = {k.lower(): v for k, v in self.handshake_headers.items()}
        for name, value in headers.items():
            self.assertEqual(actual[name.lower()], value)

    async def test_invalid_auth_stays_denied(self):
        with self.assertRaises(aiohttp.WSServerHandshakeError) as ctx:
            await self.host.ws_connect(self.relay_base + WS_PATH,
                                      headers={"Authorization": "Bearer WRONG-MOCK"})
        self.assertEqual(ctx.exception.status, 401)

    async def test_explicit_filter_frame_is_byte_identical(self):
        self.add_request({"modelProviders": ["other"], "limit": 20})
        self.assertEqual(await self.receive_host_frame(), self.frames[0])

    async def test_single_chunk_transport(self):
        self.add_request(chunk=True)
        incoming = decode(await self.receive_host_frame())
        self.assertEqual(extract_message(incoming)["params"]["modelProviders"], ["openai", "opencodex"])
        self.assertEqual(incoming["seq_id"], 7)
        self.assertEqual(incoming["cursor"], "mock-backend-cursor")

    async def test_enrollment_http_forwarding_with_fake_credentials(self):
        body = b'{"name":"mock-host","installation_id":"mock-installation"}'
        async with self.host.post(self.relay_base + WS_PATH + "/enroll", data=body,
                                  headers={"Authorization": MOCK_AUTH, "chatgpt-account-id": "mock-account"}) as response:
            self.assertEqual(response.status, 201)
            self.assertEqual(response.headers["x-request-id"], "mock-http-request")
            self.assertEqual((await response.json())["server_id"], "mock-server")
        self.assertEqual(self.http_received[0][1], body)

    async def test_unrelated_http_backend_endpoint_forwarded(self):
        async with self.host.get(self.relay_base + BASE + "/mock/account", headers={"Authorization": MOCK_AUTH}) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), b"mock-unrelated-backend-endpoint")

    async def test_cross_origin_browser_request_denied(self):
        async with self.host.get(self.relay_base + BASE + "/mock/account", headers={"Authorization": MOCK_AUTH, "Origin": "https://example.invalid"}) as response:
            self.assertEqual(response.status, 403)
        self.assertFalse(self.http_received)

    async def test_fixture_rejects_real_service_upstream(self):
        for base in ("https://chatgpt.com", "http://example.invalid", "http://0.0.0.0:1234"):
            with self.subTest(base=base):
                with self.assertRaises(ValueError):
                    LoopbackFixtureRelay(base, self.relay_session, Policy(enabled=True))

if __name__ == "__main__":
    unittest.main(verbosity=2)
