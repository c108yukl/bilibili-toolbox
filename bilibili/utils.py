"""
工具模块 - BV号解析等通用工具
"""

import re


def extract_bvid(raw: str) -> str:
    """
    从各种输入格式中提取BV号

    支持：
    - 纯BV号: BV1cmofByENF
    - 完整链接: https://www.bilibili.com/video/BV1cmofByENF
    - 短链接: https://b23.tv/xxxxx

    Raises:
        ValueError: 无法解析BV号时抛出
    """
    raw = raw.strip().rstrip("/")
    if "bilibili.com/video/" in raw or "b23.tv" in raw:
        m = re.search(r"(BV[a-zA-Z0-9]+)", raw)
        if m:
            return m.group(1)
    if raw.startswith("BV"):
        return raw
    raise ValueError(f"无法解析BV号: {raw}")
