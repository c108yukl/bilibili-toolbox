"""弹幕抓取测试：seg.so + list.so 合并策略（FakeClient，不触网）"""

import json

import pytest

from bilibili import config
from bilibili.danmaku import get_danmaku, parse_list_xml
from bilibili.models import CookieCredential

from fake_client import FakeClient, view_handler
from test_proto import _dm_elem

SEG_URL = "https://api.bilibili.com/x/v2/dm/web/seg.so"
LIST_URL = "https://api.bilibili.com/x/v1/dm/list.so"
VIEW_URL = "https://api.bilibili.com/x/web-interface/view"


def _xml(*entries):
    """entries: (time, text, mode, font_size, color, uid_hash)"""
    parts = []
    for e in entries:
        t, text = e[0], e[1]
        mode, fs, color, uid = (e + (1, 25, 16777215, "h"))[2:6]
        parts.append(f'<d p="{t},{mode},{fs},{color},1710000000,0,{uid},1">{text}</d>')
    return "<i>%s</i>" % "".join(parts)


def _seg_bytes(*items):
    """items: (progress_ms, text)"""
    return b"".join(_dm_elem(p, t) for p, t in items)


@pytest.fixture(autouse=True)
def _isolated_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "out")
    config.ensure_dirs()
    yield


def _make_client(duration=720, seg_items=None, list_items=None):
    """seg_items: 列表 = 每段返回相同内容；dict {segment_index: [(ms, text)]} = 按段返回"""
    client = FakeClient()
    client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001, duration=duration))
    if seg_items:
        if isinstance(seg_items, dict):
            seg_map = seg_items
        else:
            seg_map = {1: seg_items}
        client.on_raw(SEG_URL, lambda params, ck: _seg_bytes(*seg_map.get(params["segment_index"], [])))
    if list_items:
        client.on_raw(LIST_URL, lambda params, ck: _xml(*list_items).encode("utf-8"))
    return client


class TestMergeStrategy:
    async def test_seg_full_with_cookie(self):
        client = _make_client(
            duration=720,
            seg_items={1: [(1000, "a")], 2: [(2000, "b")]},
            list_items=[(500, "x")],
        )
        dms = await get_danmaku("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                                max_age=0, client=client)
        assert [d["text"] for d in dms] == ["a", "b"]  # seg 更全，采用 seg
        seg_calls = [c for c in client.calls if c[0] == "raw" and c[1] == SEG_URL]
        # duration=720 → ceil(720/360)=2 段
        assert len(seg_calls) == 2

    async def test_list_only_without_cookie(self):
        client = _make_client(duration=60, list_items=[(100, "a"), (200, "b"), (300, "c")])
        dms = await get_danmaku("BV1TESTTEST1", max_age=0, client=client)
        assert [d["text"] for d in dms] == ["a", "b", "c"]
        assert not [c for c in client.calls if c[0] == "raw" and c[1] == SEG_URL]

    async def test_list_full_used_when_more(self):
        client = _make_client(duration=60, seg_items=[(1000, "a")],
                              list_items=[(100, "x"), (200, "y"), (300, "z"), (400, "w")])
        dms = await get_danmaku("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                                max_age=0, client=client)
        assert [d["text"] for d in dms] == ["x", "y", "z", "w"]

    async def test_sorted_by_time(self):
        client = _make_client(duration=60, seg_items=[(3000, "c"), (1000, "a"), (2000, "b")],
                              list_items=[])
        dms = await get_danmaku("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                                max_age=0, client=client)
        assert [d["text"] for d in dms] == ["a", "b", "c"]
        assert [d["time"] for d in dms] == [1.0, 2.0, 3.0]

    async def test_dict_shape(self):
        client = _make_client(duration=60, seg_items=[(1500, "哈哈")], list_items=[])
        dms = await get_danmaku("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                                max_age=0, client=client)
        assert set(dms[0]) == {"time", "text", "mode", "font_size", "color", "uid"}


class TestCacheAndSave:
    async def test_cache_hit(self):
        client = _make_client(duration=60, seg_items=[(1000, "a")], list_items=[])
        cred = CookieCredential(sessdata="s")
        first = await get_danmaku("BV1TESTTEST1", max_age=60, credential=cred, client=client)
        second = await get_danmaku("BV1TESTTEST1", max_age=60, credential=cred, client=client)
        assert first == second
        # 第二次命中缓存，不再请求视频信息
        assert len(client.json_calls(VIEW_URL)) == 1

    async def test_save_json(self):
        client = _make_client(duration=60, seg_items=[(1000, "a")], list_items=[])
        await get_danmaku("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                          max_age=0, save_fmt="json", client=client)
        out = config.OUTPUT_DIR / "danmaku_BV1TESTTEST1.json"
        assert out.exists()
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data[0]["text"] == "a"
        assert data[0]["time_s"] == 1.0


class TestErrors:
    async def test_page_index_out_of_range(self):
        client = _make_client(duration=60, list_items=[])
        with pytest.raises(ValueError, match="分P索引越界"):
            await get_danmaku("BV1TESTTEST1", page_index=3, max_age=0, client=client)

    async def test_both_sources_fail_raises(self):
        client = _make_client(duration=60)  # seg/list 均未注册 → AssertionError 会传播吗？
        # FakeClient 未注册接口抛 AssertionError，这里验证异常向上传播
        with pytest.raises(AssertionError):
            await get_danmaku("BV1TESTTEST1", credential=CookieCredential(sessdata="s"),
                              max_age=0, client=client)


class TestParseListXml:
    def test_parse(self):
        xml = _xml((1.5, "哈哈", 1, 25, 16777215, "h1"), (2.0, "前排", 4, 25, 16711680, "h2"))
        dms = parse_list_xml(xml)
        assert len(dms) == 2
        assert dms[0].dm_time == 1.5
        assert dms[0].text == "哈哈"
        assert dms[1].mode == 4
        assert dms[1].color == 16711680
        assert dms[1].uid == "h2"

    def test_empty(self):
        assert parse_list_xml("") == []
        assert parse_list_xml("<i></i>") == []
