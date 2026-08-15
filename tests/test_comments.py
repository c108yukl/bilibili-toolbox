"""评论抓取测试：cursor → WBI → page 降级、置顶合并去重、滑动窗口（FakeClient）"""

import pytest

from bilibili import config
from bilibili.client import BiliAPIError
from bilibili.comments import get_all_comments, get_comments

from fake_client import FakeClient, make_comment, view_handler

MAIN_URL = "https://api.bilibili.com/x/v2/reply/main"
PAGE_URL = "https://api.bilibili.com/x/v2/reply"
REPLY_URL = "https://api.bilibili.com/x/v2/reply/reply"
VIEW_URL = "https://api.bilibili.com/x/web-interface/view"


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    yield


def _cursor_page(replies, top=None, next_cursor=None, is_end=False, all_count=0):
    data = {"replies": replies, "top_replies": top or [],
            "cursor": {"next": next_cursor, "all_count": all_count, "is_end": is_end}}
    return data


def _page_page(replies, top=None, acount=0):
    return {"replies": replies, "top_replies": top or [],
            "page": {"acount": acount, "count": acount}}


class TestCursorPath:
    async def test_cursor_pages_until_end(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))
        calls = {"n": 0}

        def main(params, wbi_sign, cookie):
            calls["n"] += 1
            if params.get("next") in (None, 1):
                return _cursor_page([make_comment(1, "评论1"), make_comment(2, "评论2")],
                                    top=[make_comment(9, "置顶")], next_cursor=2, all_count=5)
            return _cursor_page([], is_end=True)

        client.on_json(MAIN_URL, main)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, client=client)
        # 置顶在前，普通评论随后
        assert [i["comment"]["rpid"] for i in items] == [9, 1, 2]
        assert calls["n"] == 2
        # 两次请求均为未签名首次尝试
        assert all(c[3] is False for c in client.json_calls(MAIN_URL))

    async def test_known_total_stop(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))

        def main(params, wbi_sign, cookie):
            return _cursor_page([make_comment(1, "a"), make_comment(2, "b")],
                                next_cursor=2, all_count=2)

        client.on_json(MAIN_URL, main)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, client=client)
        assert len(items) == 2
        assert len(client.json_calls(MAIN_URL)) == 1


class TestFallback:
    async def test_wbi_retry_then_success(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))

        def main(params, wbi_sign, cookie):
            if not wbi_sign:
                raise BiliAPIError(-412, "请求被拦截")
            return _cursor_page([make_comment(1, "wbi成功")], is_end=True)

        client.on_json(MAIN_URL, main)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, client=client)
        assert items[0]["comment"]["content"]["message"] == "wbi成功"
        wbi_calls = [c for c in client.json_calls(MAIN_URL) if c[3] is True]
        assert len(wbi_calls) == 1

    async def test_full_page_api_fallback(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))
        client.on_json(MAIN_URL, lambda params, ws, ck: (_ for _ in ()).throw(
            BiliAPIError(-412, "风控")))
        pages = iter([
            _page_page([make_comment(1, "p1")], acount=10),
            _page_page([make_comment(2, "p2")], acount=10),
            _page_page([], acount=10),
        ])

        def page_handler(params, wbi_sign, cookie):
            data = next(pages)
            data["cursor"] = {"next": params["pn"] + 1, "all_count": 10,
                              "is_end": not data["replies"]}
            return data

        client.on_json(PAGE_URL, page_handler)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, client=client)
        assert [i["comment"]["content"]["message"] for i in items] == ["p1", "p2"]
        pn_used = [c[2].get("pn") for c in client.json_calls(PAGE_URL)]
        assert pn_used == [1, 2, 3]


class TestMergeAndWindow:
    async def test_top_reply_merge_and_dedup(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))

        def page(params, wbi_sign, cookie):
            # 置顶 rpid=10 与普通评论 rpid=10 重复 → 只保留置顶
            return _page_page([make_comment(1, "c1", rpid=10), make_comment(2, "c2", rpid=11)],
                              top=[make_comment(9, "置顶", rpid=10)])

        client.on_json(PAGE_URL, page)
        items = await get_comments("BV1TESTTEST1", page=1, max_age=0, client=client)
        assert [i["comment"]["rpid"] for i in items] == [10, 11]
        assert items[0]["comment"]["content"]["message"] == "置顶"

    async def test_sliding_window_truncates(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))
        replies = [make_comment(i, f"c{i}") for i in range(1, 6)]

        def main(params, wbi_sign, cookie):
            return _cursor_page(replies, is_end=True)

        client.on_json(MAIN_URL, main)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, max_comments=3,
                                       client=client)
        assert len(items) == 3
        assert len(client.json_calls(MAIN_URL)) == 1  # 单页即截断，不再翻页

    async def test_max_pages_stops(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))

        def main(params, wbi_sign, cookie):
            return _cursor_page([make_comment(1, "a")], next_cursor=2)

        client.on_json(MAIN_URL, main)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, max_pages=1,
                                       client=client)
        assert len(items) == 1
        assert len(client.json_calls(MAIN_URL)) == 1


class TestReplies:
    async def test_with_replies(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))

        def main(params, wbi_sign, cookie):
            return _cursor_page([make_comment(1, "有回复", rcount=3)], is_end=True)

        client.on_json(MAIN_URL, main)

        def reply_handler(params, wbi_sign, cookie):
            return {"replies": [make_comment(100, "楼中楼1"), make_comment(101, "楼中楼2")]}

        client.on_json(REPLY_URL, reply_handler)
        items = await get_all_comments("BV1TESTTEST1", max_age=0, with_replies=True,
                                       client=client)
        assert len(items[0]["replies"]) == 2
        assert items[0]["replies"][0]["content"]["message"] == "楼中楼1"


class TestSinglePage:
    async def test_get_comments_uses_page_api(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))

        def page(params, wbi_sign, cookie):
            assert params["pn"] == 2
            return _page_page([make_comment(1, "单页评论")], acount=50)

        client.on_json(PAGE_URL, page)
        items = await get_comments("BV1TESTTEST1", page=2, max_age=0, client=client)
        assert items[0]["comment"]["content"]["message"] == "单页评论"

    async def test_invalid_page_raises(self):
        client = FakeClient()
        client.on_json(VIEW_URL, view_handler("BV1TESTTEST1", 1001, 2001))
        with pytest.raises(ValueError, match="页码必须 >= 1"):
            await get_comments("BV1TESTTEST1", page=0, max_age=0, client=client)
