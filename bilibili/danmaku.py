"""
弹幕抓取模块
"""

import asyncio

from bilibili_api import video, Credential

from bilibili.cache import cache_key, cache_get, cache_set
from bilibili.formatters import save_danmaku


async def get_danmaku(
    bvid: str,
    page_index: int = 0,
    max_age: int = 30,
    credential: Credential = None,
    save_fmt: str = None,
):
    """
    获取视频弹幕

    Args:
        bvid: 视频BV号
        page_index: 分P索引
        max_age: 缓存有效期（秒），0 = 禁用缓存
        credential: 登录凭证
        save_fmt: 保存格式 (txt/json/csv)，None = 不保存
    """
    key = cache_key(bvid, "danmaku", page_index)
    cached = cache_get(key, max_age)
    if cached is not None:
        print(f"[弹幕] 缓存命中 (max_age={max_age}s)")
        return cached

    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    title = info["title"]
    cid = info["pages"][page_index]["cid"]
    print(f"[视频] {title}  (cid={cid})")

    dms = await v.get_danmakus(page_index=page_index)
    print(f"[弹幕] 共 {len(dms)} 条")
    for dm in dms[:10]:
        print(f"   [{dm.dm_time:7.1f}s] {dm.text}")

    data = [
        {
            "time": d.dm_time,
            "text": d.text,
            "mode": d.mode,
            "font_size": d.font_size,
            "color": d.color,
            "uid": d.uid,
        }
        for d in dms
    ]
    cache_set(key, data, max_age)

    if save_fmt:
        save_danmaku(dms, bvid, save_fmt)

    return dms
