"""字幕抓取测试：Player WBI → view 字段 → 重拉 三级降级 + 语言选择（FakeClient）"""

import json

import pytest

from bilibili import config
from bilibili.client import BiliAPIError
from bilibili.models import CookieCredential
from bilibili.subtitle import SUBTITLE_LAN_MAP, _match_lan, get_subtitle

from fake_client import FakeClient, view_handler

VIEW_URL = "https://api.bilibili.com/x/web-interface/view"
PLAYER_URL = "https://api.bilibili.com/x/player/wbi/v2"
SUB_URL = "https://aisubtitle.hdslb.com/bfs/subtitle/abc123.json"

SUB_AI = {"lan": "ai-zh", "lan_doc": "中文（AI自动生成）", "subtitle_url": SUB_URL}
SUB_EN = {"lan": "en", "lan_doc": "英语", "subtitle_url": SUB_URL}
SUB_EMPTY_URL = {"lan": "ja", "lan_doc": "日语", "subtitle_url": ""}

BODY_JSON = json.dumps({"body": [
    {"from": 0.0, "to": 2.0, "content": "你好"},
    {"from": 2.0, "to": 4.0, "content": "世界"},
]}).encode("utf-8")


def _raising(err):
    """构造一个总是抛 err 的 handler"""
    def _handler(params, wbi_sign, cookie):
        raise err

    return _handler


@pytest.fixture(autouse=True)
def _isolated_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "out")
    yield


def _make_client(subtitles=None, view_subtitle=None, player_fail=None):
    client = FakeClient()
    client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001,
                                          subtitle=view_subtitle))
    if player_fail is not None:
        client.on_json(PLAYER_URL, player_fail)
    else:
        client.on_json(PLAYER_URL, lambda params, ws, ck: {"subtitle": {"subtitles": subtitles or []}})
    client.on_raw(SUB_URL, lambda params, ck: BODY_JSON)
    return client


class TestPlayerSuccess:
    async def test_default_prefers_ai_zh(self):
        client = _make_client(subtitles=[SUB_EN, SUB_AI])
        sub = await get_subtitle("BV1TESTTEST1", client=client)
        assert sub is not None
        assert sub.lan == "ai-zh"
        assert len(sub.lines) == 2
        assert sub.lines[0].content == "你好"

    async def test_explicit_lan_wins(self):
        client = _make_client(subtitles=[SUB_AI, SUB_EN])
        sub = await get_subtitle("BV1TESTTEST1", lan_code="en", client=client)
        assert sub.lan == "en"

    async def test_save_srt(self):
        client = _make_client(subtitles=[SUB_AI])
        sub = await get_subtitle("BV1TESTTEST1", save_fmt="srt", client=client)
        assert sub is not None
        out = config.OUTPUT_DIR / f"subtitle_BV1TESTTEST1_{sub.lan}.srt"
        assert out.exists()
        assert "你好" in out.read_text(encoding="utf-8")

    async def test_empty_url_skipped(self):
        client = _make_client(subtitles=[SUB_EMPTY_URL])
        sub = await get_subtitle("BV1TESTTEST1", lan_code="ja", client=client)
        assert sub is None


class TestFallback:
    async def test_view_field_fallback(self):
        client = _make_client(player_fail=_raising(BiliAPIError(-500, "内部错误")),
                              view_subtitle=[SUB_AI])
        sub = await get_subtitle("BV1TESTTEST1", client=client)
        assert sub is not None
        assert sub.lan == "ai-zh"

    async def test_refetch_fallback(self):
        client = FakeClient()
        calls = {"n": 0}

        def view(params, ws, ck):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"aid": 1001, "bvid": "BV1TESTTEST1", "title": "t",
                        "pages": [{"cid": 2001}], "subtitle": {}}
            return {"aid": 1001, "bvid": "BV1TESTTEST1", "title": "t",
                    "pages": [{"cid": 2001}], "subtitle": {"subtitles": [SUB_AI]}}

        client.on_json(VIEW_URL, view)
        client.on_json(PLAYER_URL, lambda p, ws, ck: {"subtitle": {"subtitles": []}})
        client.on_raw(SUB_URL, lambda params, ck: BODY_JSON)
        sub = await get_subtitle("BV1TESTTEST1", client=client)
        assert sub is not None
        assert calls["n"] == 2

    async def test_no_subtitle_returns_none(self):
        client = _make_client(subtitles=[])
        sub = await get_subtitle("BV1TESTTEST1", client=client)
        assert sub is None


class TestLoginRequired:
    async def test_no_cookie_raises_friendly(self):
        client = _make_client(player_fail=_raising(BiliAPIError(-101, "账号未登录")))
        with pytest.raises(ValueError, match="需要登录 Cookie"):
            await get_subtitle("BV1TESTTEST1", client=client)

    async def test_with_cookie_falls_back(self):
        client = _make_client(player_fail=_raising(BiliAPIError(-101, "账号未登录")))
        sub = await get_subtitle("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                                 client=client)
        assert sub is None  # 有 Cookie 时走兜底，不抛异常


class TestMatchLan:
    def test_exact(self):
        assert _match_lan("en", ["ai-zh", "en"], ["中文", "英语"]) == "en"

    def test_keyword_fuzzy(self):
        assert _match_lan("中文", ["ai-zh", "en"], ["中文（AI自动生成）", "英语"]) == "ai-zh"
        assert _match_lan("AI", ["ai-zh", "en"], ["中文（AI自动生成）", "英语"]) == "ai-zh"

    def test_unknown_falls_back_first(self):
        assert _match_lan("xx", ["ai-zh", "en"], ["中文", "英语"]) == "ai-zh"

    def test_lan_map_known_codes(self):
        for code in ("ai-zh", "zh-Hans", "zh-Hant", "en", "ja", "ko"):
            assert code in SUBTITLE_LAN_MAP
