"""
认证模块 - Cookie 解析与凭证管理

parse_cookie 返回 CookieCredential（属性名与旧版 bilibili_api.Credential 对齐），
可直接传给 get_* 系列函数启用登录态抓取。
"""

import logging

from bilibili.models import CookieCredential

logger = logging.getLogger(__name__)


def parse_cookie(cookie_str: str | None) -> CookieCredential | None:
    """
    解析 Cookie 字符串为凭证对象

    Args:
        cookie_str: 包含 SESSDATA 的 Cookie 字符串（可为 None/空串）

    Returns:
        CookieCredential 对象；无 SESSDATA 时返回 None（以未登录状态访问）
    """
    if not cookie_str or not cookie_str.strip():
        return None

    parts = {}
    for item in cookie_str.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            parts[k.strip()] = v.strip()

    sess = parts.get("SESSDATA", "")
    if not sess:
        logger.warning("Cookie 中未找到 SESSDATA，将以未登录状态访问")
        return None

    logger.info(
        "已加载 Cookie 凭证 (bili_jct=%s, DedeUserID=%s)",
        "有" if parts.get("bili_jct") else "无",
        "有" if parts.get("DedeUserID") else "无",
    )
    return CookieCredential(
        sessdata=sess,
        bili_jct=parts.get("bili_jct", ""),
        buvid3=parts.get("buvid3", ""),
        dedeuserid=parts.get("DedeUserID", ""),
    )
