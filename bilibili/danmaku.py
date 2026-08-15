"""
弹幕抓取模块 - seg.so 全量 + list.so 对比取多（移植扩展能力）

抓取策略（与扩展一致）:
- 有登录 Cookie 时：按视频时长分段拉取 seg.so（protobuf，弹幕远多于 list.so），
  再拉 list.so（XML）对比，取更多的一份——B站对未登录/部分高密度视频的
  list.so 只返回少量抽样（如 6000 条只给 120 条）
- 无 Cookie 时：直接用 list.so
- 结果按弹幕时间排序

返回结构与旧版兼容:
    [{"time": float, "text": str, "mode": int, "font_size": int,
      "color": int, "uid": str}, ...]
"""

import logging
import math
import re
from typing import List, Optional

from bilibili.cache import cache_get, cache_key, cache_set
from bilibili.client import BiliClient, BiliError
from bilibili.formatters import save_danmaku
from bilibili.models import CookieCredential, Danmaku
from bilibili.proto import parse_dm_seg

logger = logging.getLogger(__name__)

# list.so XML 弹幕条目
_DM_XML_RE = re.compile(r'<d p="([^"]+)"[^>]*>([\s\S]*?)</d>')

# 单段 seg.so 覆盖的时长（秒）
_SEG_COVER = 360


def parse_list_xml(xml_text: str) -> List[Danmaku]:
    """
    解析 list.so 返回的 XML → Danmaku 列表

    <d p="time,mode,font_size,color,ctime,pool,mid_hash,rowid">text</d>
    """
    dms: List[Danmaku] = []
    for match in _DM_XML_RE.finditer(xml_text or ""):
        parts = match.group(1).split(",")
        try:
            dms.append(
                Danmaku(
                    dm_time=float(parts[0]) if len(parts) > 0 else 0.0,
                    mode=int(parts[1]) if len(parts) > 1 else 1,
                    font_size=int(parts[2]) if len(parts) > 2 else 25,
                    color=int(parts[3]) if len(parts) > 3 else 16777215,
                    ctime=int(parts[4]) if len(parts) > 4 else 0,
                    uid=parts[6] if len(parts) > 6 else "",
                    text=match.group(2).strip(),
                )
            )
        except (ValueError, IndexError):
            continue
    return dms


async def _fetch_seg_danmaku(client: BiliClient, cid: int, duration: float) -> List[Danmaku]:
    """按分段拉取 seg.so 全量弹幕（需登录 Cookie）"""
    seg_count = max(1, math.ceil((duration or 0) / _SEG_COVER)) if duration else 1
    dms: List[Danmaku] = []
    for i in range(1, seg_count + 1):
        try:
            raw = await client.fetch_raw(
                "https://api.bilibili.com/x/v2/dm/web/seg.so",
                {"oid": cid, "type": 1, "segment_index": i},
            )
            dms.extend(parse_dm_seg(raw))
        except Exception as e:
            logger.warning("  分段 %s 获取失败: %s", i, e)
    return dms


async def _fetch_list_danmaku(client: BiliClient, cid: int) -> List[Danmaku]:
    """拉取 list.so 弹幕（XML）"""
    raw = await client.fetch_raw(
        "https://api.bilibili.com/x/v1/dm/list.so",
        {"oid": cid},
    )
    return parse_list_xml(raw.decode("utf-8", "replace"))


async def _get_video_info(client: BiliClient, bvid: str) -> dict:
    """获取视频信息（title/pages/cid/duration）"""
    data = await client.fetch_json(
        "https://api.bilibili.com/x/web-interface/view", {"bvid": bvid}
    )
    return data


async def get_danmaku(
    bvid: str,
    page_index: int = 0,
    max_age: int = 30,
    credential: Optional[CookieCredential] = None,
    save_fmt: Optional[str] = None,
    client: Optional[BiliClient] = None,
) -> list:
    """
    获取视频弹幕（全量，seg.so + list.so 对比取多）

    Args:
        bvid: 视频BV号
        page_index: 分P索引
        max_age: 缓存有效期（秒），0 = 禁用缓存
        credential: 登录凭证（有 Cookie 时自动启用 seg.so 全量接口）
        save_fmt: 保存格式 (txt/json/csv)，None = 不保存
        client: 复用请求客户端（None 时自动创建并在结束时关闭）

    Returns:
        dict 列表，字段见模块 docstring
    """
    key = cache_key(bvid, "danmaku", page_index)
    cached = cache_get(key, max_age)
    if cached is not None:
        logger.info("[弹幕] 缓存命中 (%d 条)", len(cached))
        return cached

    own_client = client is None
    client = client or BiliClient(credential=credential)
    try:
        info = await _get_video_info(client, bvid)
        title = info.get("title", "")
        pages = info.get("pages") or []
        if not 0 <= page_index < len(pages):
            raise ValueError(f"分P索引越界: page_index={page_index}, 该视频共 {len(pages)} 个分P")
        page_info = pages[page_index]
        cid = page_info.get("cid")
        duration = float(page_info.get("duration") or info.get("duration") or 0)
        logger.info("[视频] %s (cid=%s)", title, cid)

        dms: List[Danmaku] = []
        if credential and credential.has_sessdata:
            logger.info("[弹幕] 使用登录态分段接口 seg.so 全量抓取...")
            dms = await _fetch_seg_danmaku(client, cid, duration)
        else:
            logger.info("[弹幕] 未登录，使用 list.so 接口（建议 --cookie 提升完整度）")

        try:
            list_dms = await _fetch_list_danmaku(client, cid)
            if len(list_dms) > len(dms):
                logger.info("[弹幕] list.so 更全 (%d > %d)，采用 list.so", len(list_dms), len(dms))
                dms = list_dms
        except Exception as e:
            if not dms:
                raise
            logger.warning("list.so 获取失败（已采用 seg.so 结果）: %s", e)

        dms.sort(key=lambda d: d.dm_time)
        data = [d.to_dict() for d in dms]
        logger.info("[弹幕] 共 %d 条", len(data))
        for dm in data[:10]:
            logger.info("   [%7.1fs] %s", dm["time"], dm["text"])

        cache_set(key, data, max_age)

        if save_fmt:
            save_danmaku(data, bvid, save_fmt)

        return data
    finally:
        if own_client:
            await client.close()
