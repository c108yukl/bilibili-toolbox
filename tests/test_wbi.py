"""WBI 签名与服务器时间校准测试"""

import hashlib
import time

import pytest
from fake_client import FakeClient, heartbeat_handler, nav_handler

from bilibili import wbi
from bilibili.wbi import (
    MIXIN_KEY_ENC_TAB,
    build_query,
    get_mixin_key,
    get_signed_params,
    get_wbi_keys,
    now_server,
    sign_params,
    sync_server_time,
)

IMG = "7cd084941338484aae1ad9425b84077c"
SUB = "4932caff0ff746eab6f01bf08b70ac45"


@pytest.fixture(autouse=True)
def _reset_wbi():
    wbi.reset_for_tests()
    yield
    wbi.reset_for_tests()


class TestMixinKey:
    def test_independent_implementation(self):
        # 独立实现（直接按查找表拼接）验证 get_mixin_key
        raw = IMG + SUB
        expected = "".join(raw[i] for i in MIXIN_KEY_ENC_TAB[:32])
        assert get_mixin_key(IMG, SUB) == expected

    def test_key_length(self):
        assert len(get_mixin_key(IMG, SUB)) == 32

    def test_empty_keys(self):
        assert get_mixin_key("", "") == ""


class TestSignParams:
    def test_deterministic(self):
        params = {"type": 1, "oid": 12345, "mode": 3}
        a = sign_params(params, IMG, SUB, wts=1700000000)
        b = sign_params(params, IMG, SUB, wts=1700000000)
        assert a == b

    def test_wts_and_wrid_present(self):
        out = sign_params({"oid": 1}, IMG, SUB, wts=1700000000)
        assert out["wts"] == "1700000000"
        assert len(out["w_rid"]) == 32
        assert set(out["w_rid"]) <= set("0123456789abcdef")

    def test_signature_matches_manual_md5(self):
        # 手工复算：排序 → urlencode → +mixin_key → md5
        params = {"type": 1, "oid": 12345, "mode": 3, "wts": "1700000000"}
        mixin = get_mixin_key(IMG, SUB)
        query = "&".join(f"{k}={params[k]}" for k in sorted(params))
        expected = hashlib.md5((query + mixin).encode()).hexdigest()
        out = sign_params({"type": 1, "oid": 12345, "mode": 3}, IMG, SUB, wts=1700000000)
        assert out["w_rid"] == expected

    def test_values_stringified(self):
        out = sign_params({"oid": 123}, IMG, SUB, wts=1)
        assert out["oid"] == "123"


class TestBuildQuery:
    def test_sorted_by_urlencode_key(self):
        q = build_query({"b": 2, "a": 1})
        assert q == "a=1&b=2"

    def test_special_chars(self):
        # 空格按 %20 编码（与 aiohttp/官方实现一致，不是 +）
        assert build_query({"k": "a b"}) == "k=a%20b"


class TestServerTime:
    async def test_sync_applies_offset(self):
        client = FakeClient()
        client.on_raw("https://api.bilibili.com/x/report/web/heartbeat",
                      heartbeat_handler(timestamp=1_700_000_000))
        await sync_server_time(client)
        # 校准后 now_server 应接近 1700000000 秒（允许 RTT 波动）
        assert abs(now_server() / 1000 - 1_700_000_000) < 5

    async def test_sync_failure_silent(self):
        client = FakeClient()  # 未注册 heartbeat → 断言失败？FakeClient 未注册会抛 AssertionError
        # 用注册抛异常的 handler 模拟网络失败
        def boom(params, cookie):
            raise OSError("network down")

        client.on_raw("https://api.bilibili.com/x/report/web/heartbeat", boom)
        await sync_server_time(client)  # 不应抛出
        assert abs(now_server() / 1000 - time.time()) < 5


class TestGetWbiKeys:
    async def test_parse_and_cache(self):
        client = FakeClient()
        client.on_raw("https://api.bilibili.com/x/report/web/heartbeat", heartbeat_handler())
        client.on_json("https://api.bilibili.com/x/web-interface/nav", nav_handler(IMG, SUB))
        keys = await get_wbi_keys(client)
        assert keys["img"] == IMG
        assert keys["sub"] == SUB
        # 第二次调用命中缓存，不再请求 nav
        await get_wbi_keys(client)
        assert len(client.json_calls("https://api.bilibili.com/x/web-interface/nav")) == 1

    async def test_missing_wbi_img_raises(self):
        client = FakeClient()
        client.on_json("https://api.bilibili.com/x/web-interface/nav",
                       lambda params, ws, ck: {})
        with pytest.raises(RuntimeError, match="wbi_img"):
            await get_wbi_keys(client)


class TestGetSignedParams:
    async def test_end_to_end(self):
        client = FakeClient()
        setup(client)
        signed = await get_signed_params(client, {"oid": 42})
        assert "wts" in signed
        assert "w_rid" in signed
        assert signed["oid"] == "42"


def setup(client):
    client.on_raw("https://api.bilibili.com/x/report/web/heartbeat", heartbeat_handler())
    client.on_json("https://api.bilibili.com/x/web-interface/nav", nav_handler(IMG, SUB))
