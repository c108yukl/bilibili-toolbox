"""
B站 弹幕/评论/字幕 抓取工具包

快速上手:
    from bilibili import get_danmaku, get_subtitle, get_comments
    import asyncio

    async def main():
        dms = await get_danmaku("BV1cmofByENF", save_fmt="json")
        print(len(dms), "条弹幕")

    asyncio.run(main())

配置可通过环境变量覆盖，见 bilibili.config。
"""

from bilibili.auth import parse_cookie
from bilibili.utils import extract_bvid, is_valid_bvid
from bilibili.danmaku import get_danmaku
from bilibili.comments import get_comments, get_all_comments
from bilibili.subtitle import get_subtitle

__version__ = "1.0.0"

__all__ = [
    "parse_cookie",
    "extract_bvid",
    "is_valid_bvid",
    "get_danmaku",
    "get_comments",
    "get_all_comments",
    "get_subtitle",
]
