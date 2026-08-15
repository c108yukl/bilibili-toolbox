"""BV 号解析测试"""

import asyncio
import urllib.request

import pytest

from bilibili import utils
from bilibili.utils import extract_bvid, is_valid_bvid


class _FakeResp:
    def __init__(self, url, body=b""):
        self._url = url
        self._body = body

    def geturl(self):
        return self._url

    def read(self, n=0):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestExtractBvid:
    def test_pure_bvid(self):
        assert extract_bvid("BV1cmofByENF") == "BV1cmofByENF"

    def test_full_url(self):
        assert extract_bvid("https://www.bilibili.com/video/BV1cmofByENF") == "BV1cmofByENF"

    def test_url_with_params(self):
        url = "https://www.bilibili.com/video/BV1cmofByENF?p=2&vd_source=abc123"
        assert extract_bvid(url) == "BV1cmofByENF"

    def test_url_with_trailing_slash(self):
        assert extract_bvid("https://www.bilibili.com/video/BV1cmofByENF/") == "BV1cmofByENF"

    def test_pure_bvid_with_query(self):
        assert extract_bvid("BV1cmofByENF?p=3") == "BV1cmofByENF"

    def test_whitespace(self):
        assert extract_bvid("  BV1cmofByENF  ") == "BV1cmofByENF"

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            extract_bvid("hello world")

    def test_short_bvid_raises(self):
        # 少于 10 位字符的 BV 号不合法
        with pytest.raises(ValueError):
            extract_bvid("BV123")


class TestShortLink:
    def test_resolve_from_redirect_url(self, monkeypatch):
        def fake_urlopen(req, timeout=None):
            return _FakeResp("https://www.bilibili.com/video/BV1cmofByENF?share=1")

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        assert extract_bvid("https://b23.tv/abcde") == "BV1cmofByENF"

    def test_resolve_from_body(self, monkeypatch):
        html = b'<html><a href="https://www.bilibili.com/video/BV1abcdef123">link</a></html>'

        def fake_urlopen(req, timeout=None):
            return _FakeResp("https://b23.tv/abcde", html)

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        assert extract_bvid("https://b23.tv/abcde") == "BV1abcdef123"

    def test_resolve_inside_running_event_loop(self, monkeypatch):
        # 回归测试：extract_bvid 在运行中的事件循环（CLI async main）内不得抛
        # "asyncio.run() cannot be called from a running event loop"
        def fake_urlopen(req, timeout=None):
            return _FakeResp("https://www.bilibili.com/video/BV1cmofByENF")

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        result = asyncio.run(_async_extract("https://b23.tv/abcde"))
        assert result == "BV1cmofByENF"

    def test_resolve_failure_raises(self, monkeypatch):
        def fake_urlopen(req, timeout=None):
            raise OSError("network down")

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        with pytest.raises(ValueError):
            extract_bvid("https://b23.tv/abcde")

    def test_resolve_returns_none_raises(self, monkeypatch):
        def fake_urlopen(req, timeout=None):
            return _FakeResp("https://www.baidu.com/", b"no bv here")

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        with pytest.raises(ValueError):
            extract_bvid("https://b23.tv/abcde")


async def _async_extract(raw: str) -> str:
    return utils.extract_bvid(raw)


class TestIsValidBvid:
    def test_valid(self):
        assert is_valid_bvid("BV1cmofByENF")

    def test_invalid(self):
        assert not is_valid_bvid("BV1cm")
        assert not is_valid_bvid("")
        assert not is_valid_bvid("AV1234567890")
