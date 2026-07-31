"""
工具模块 - BV 号解析等通用工具
"""

import logging
import re

logger = logging.getLogger(__name__)

# BV 号：BV + 10 位 [a-zA-Z0-9]（常见长度为 12 位总长）
_BV_RE = re.compile(r"BV[a-zA-Z0-9]{10}")
_URL_RE = re.compile(r"https?://[^\s]+")


def _strip_url(raw: str) -> str:
    """从含多余文本的输入中提取 URL 部分"""
    m = _URL_RE.search(raw)
    return m.group(0) if m else raw


def extract_bvid(raw: str) -> str:
    """
    从各种输入格式中提取 BV 号

    支持:
    - 纯BV号: BV1cmofByENF
    - 完整链接: https://www.bilibili.com/video/BV1cmofByENF
    - 带参数链接: https://www.bilibili.com/video/BV1cmofByENF?p=2&vd_source=...
    - 短链接: https://b23.tv/xxxxx（需联网跟随跳转）

    Raises:
        ValueError: 无法解析BV号时抛出
    """
    raw = raw.strip().rstrip("/")

    # 纯 BV 号（严格校验，可截断查询参数）
    m = _BV_RE.search(raw)
    if m:
        return m.group(0)

    # 带链接的输入：提取 URL 部分再找 BV
    url = _strip_url(raw)
    if "bilibili.com/video/" in url or "b23.tv" in url:
        m = _BV_RE.search(url)
        if m:
            return m.group(0)

    # b23.tv 短链：跟随重定向解析（仅当输入本身是短链接时联网）
    if "b23.tv" in url:
        from bilibili.config import TIMEOUT, USER_AGENT
        try:
            import aiohttp

            resolved = _resolve_short_link(url, TIMEOUT, USER_AGENT)
            if resolved:
                logger.info("短链接 %s → %s", url, resolved)
                return resolved
        except ImportError:
            logger.warning("未安装 aiohttp，无法解析短链接")
        except Exception as e:
            logger.warning("短链接解析失败 %s: %s", url, e)
        raise ValueError(f"短链接跳转后未找到BV号: {raw}")

    raise ValueError(f"无法解析BV号: {raw}")


def _resolve_short_link(url: str, timeout: int, user_agent: str) -> str | None:
    """跟随短链接重定向并返回解析出的 BV 号（同步阻塞式调用）"""
    import asyncio

    async def _fetch():
        async with aiohttp.ClientSession() as session:
            async with session.get(url, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                final_url = str(resp.url)
                m = _BV_RE.search(final_url)
                if m:
                    return m.group(0)
                text = await resp.text()
                m = _BV_RE.search(text)
                return m.group(0) if m else None

    return asyncio.run(_fetch())


def is_valid_bvid(bvid: str) -> bool:
    """严格校验 BV 号格式"""
    return bool(_BV_RE.fullmatch(bvid or ""))
