"""
B站 弹幕/评论/字幕 抓取工具包（自研 HTTP 栈，零 bilibili-api 依赖）

快速上手:
    from bilibili import get_danmaku, get_subtitle, get_comments, parse_cookie
    import asyncio

    async def main():
        dms = await get_danmaku("BV1cmofByENF", save_fmt="json")
        print(len(dms), "条弹幕")

    asyncio.run(main())

1.2 新特性:
- WBI 签名 + 服务器时间校准（wts）
- 弹幕 seg.so 分段全量抓取（登录态），与 list.so 对比取更全的一份
- 评论 cursor 主流接口 → WBI → page 备用接口自动降级，置顶合并去重
- 字幕 Player WBI 接口三级降级
- 弹幕热词与 OpenAI 兼容 AI 分析（bilibili.analysis）

配置可通过环境变量覆盖（BILI_*），见 bilibili.config。
"""

from bilibili.auth import parse_cookie
from bilibili.browser_cookie import get_browser_cookie
from bilibili.client import BiliAPIError, BiliClient, BiliError, BiliHTTPError, BiliNetworkError
from bilibili.comments import get_all_comments, get_comments
from bilibili.danmaku import get_danmaku
from bilibili.models import CookieCredential, Danmaku, Subtitle, SubtitleLine
from bilibili.subtitle import get_subtitle
from bilibili.utils import extract_bvid, is_valid_bvid

__version__ = "1.3.0"

__all__ = [
    "parse_cookie",
    "get_browser_cookie",
    "extract_bvid",
    "is_valid_bvid",
    "get_danmaku",
    "get_comments",
    "get_all_comments",
    "get_subtitle",
    "CookieCredential",
    "Danmaku",
    "Subtitle",
    "SubtitleLine",
    "BiliClient",
    "BiliError",
    "BiliAPIError",
    "BiliHTTPError",
    "BiliNetworkError",
]
