"""
弹幕抓取模块

统一返回 dict 列表（缓存命中与否结构一致）:
    [{"time": float, "text": str, "mode": int, "font_size": int,
      "color": int, "uid": int}, ...]
"""

import logging
from typing import Optional

from bilibili_api import Credential, video

from bilibili.cache import cache_get, cache_key, cache_set
from bilibili.formatters import save_danmaku

logger = logging.getLogger(__name__)


def _dm_to_dict(dm) -> dict:
    return {
        "time": dm.dm_time,
        "text": dm.text,
        "mode": dm.mode,
        "font_size": dm.font_size,
        "color": dm.color,
        "uid": dm.uid,
    }


async def get_danmaku(
    bvid: str,
    page_index: int = 0,
    max_age: int = 30,
    credential: Optional[Credential] = None,
    save_fmt: Optional[str] = None,
) -> list:
    """
    获取视频弹幕（全量）

    Args:
        bvid: 视频BV号
        page_index: 分P索引
        max_age: 缓存有效期（秒），0 = 禁用缓存
        credential: 登录凭证
        save_fmt: 保存格式 (txt/json/csv)，None = 不保存

    Returns:
        dict 列表，字段见模块 docstring
    """
    key = cache_key(bvid, "danmaku", page_index)
    cached = cache_get(key, max_age)
    if cached is not None:
        logger.info("[弹幕] 缓存命中 (%d 条)", len(cached))
        return cached

    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    title = info["title"]
    cid = info["pages"][page_index]["cid"]
    logger.info("[视频] %s (cid=%s)", title, cid)

    dms = await v.get_danmakus(page_index=page_index)
    data = [_dm_to_dict(d) for d in dms]
    logger.info("[弹幕] 共 %d 条", len(data))
    for dm in data[:10]:
        logger.info("   [%7.1fs] %s", dm["time"], dm["text"])

    cache_set(key, data, max_age)

    if save_fmt:
        save_danmaku(data, bvid, save_fmt)

    return data
