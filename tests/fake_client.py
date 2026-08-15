"""测试替身：FakeClient（模拟 BiliClient 的 fetch_json / fetch_raw，不触网）"""


class FakeClient:
    """按 URL 注册 handler 的假客户端；未注册的 URL 直接断言失败"""

    def __init__(self):
        self.json_handlers = {}
        self.raw_handlers = {}
        self.calls = []  # ("json"|"raw", url, params, wbi_sign, cookie)
        self.closed = False

    def on_json(self, url, handler):
        self.json_handlers[url] = handler

    def on_raw(self, url, handler):
        self.raw_handlers[url] = handler

    async def fetch_json(self, url, params=None, *, method="GET", wbi_sign=False, cookie=True):
        params = dict(params or {})
        self.calls.append(("json", url, params, wbi_sign, cookie))
        handler = self.json_handlers.get(url)
        if handler is None:
            raise AssertionError(f"未注册的 JSON 接口: {url}")
        result = handler(params, wbi_sign, cookie)
        if hasattr(result, "__await__"):
            result = await result
        return result

    async def fetch_raw(self, url, params=None, *, method="GET", cookie=True):
        params = dict(params or {})
        self.calls.append(("raw", url, params, cookie))
        handler = self.raw_handlers.get(url)
        if handler is None:
            raise AssertionError(f"未注册的 RAW 接口: {url}")
        result = handler(params, cookie)
        if hasattr(result, "__await__"):
            result = await result
        return result

    async def close(self):
        self.closed = True

    def json_calls(self, url):
        return [c for c in self.calls if c[0] == "json" and c[1] == url]


def view_handler(bvid, aid, cid, duration=60, pages=None, title="测试视频", subtitle=None):
    """x/web-interface/view 的 handler 工厂"""
    pages = pages or [{"cid": cid, "duration": duration}]

    def _handler(params, wbi_sign, cookie):
        return {
            "aid": aid,
            "bvid": bvid,
            "title": title,
            "duration": duration,
            "cid": pages[0]["cid"],
            "pages": pages,
            "subtitle": {"subtitles": subtitle or []} if subtitle is not None else {},
        }

    return _handler


def nav_handler(img="7cd084941338484aae1ad9425b84077c", sub="4932caff0ff746eab6f01bf08b70ac45"):
    """x/web-interface/nav 的 handler 工厂（WBI 密钥）"""

    def _handler(params, wbi_sign, cookie):
        return {
            "wbi_img": {
                "img_url": f"https://i0.hdslb.com/bfs/wbi/{img}.png",
                "sub_url": f"https://i0.hdslb.com/bfs/wbi/{sub}.png",
            }
        }

    return _handler


def heartbeat_handler(timestamp=1_700_000_000):
    """x/report/web/heartbeat 的 handler 工厂（服务器时间校准）"""

    def _handler(params, cookie):
        return f'{{"code":0,"data":{{"timestamp":{timestamp}}}}}'.encode()

    return _handler


def setup_wbi(client, img="7cd084941338484aae1ad9425b84077c"):
    """注册 WBI 所需接口（nav + heartbeat）"""
    client.on_raw("https://api.bilibili.com/x/report/web/heartbeat", heartbeat_handler())
    client.on_json("https://api.bilibili.com/x/web-interface/nav", nav_handler(img))


def make_comment(reply_id, text, like=1, rcount=0, rpid=None):
    """构造原始评论 dict（与 B站接口同构）"""
    return {
        "rpid": rpid if rpid is not None else reply_id,
        "like": like,
        "ctime": 1_700_000_000,
        "member": {"uname": f"用户{reply_id}"},
        "content": {"message": text},
        "rcount": rcount,
    }
