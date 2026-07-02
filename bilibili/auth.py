"""
认证模块 - Cookie 解析与凭证管理
"""

from bilibili_api import Credential


def parse_cookie(cookie_str: str) -> Credential | None:
    """
    解析 Cookie 字符串为 Credential 对象

    Args:
        cookie_str: 包含 SESSDATA 的 Cookie 字符串

    Returns:
        Credential 对象，解析失败返回 None
    """
    if not cookie_str:
        return None

    parts = {}
    for item in cookie_str.split(";"):
        if "=" in item:
            k, v = item.strip().split("=", 1)
            parts[k] = v

    sess = parts.get("SESSDATA", "")
    if not sess:
        return None

    print("[登录] 已加载Cookie凭证")
    return Credential(
        sessdata=sess,
        bili_jct=parts.get("bili_jct", ""),
        buvid3=parts.get("buvid3", ""),
        dedeuserid=parts.get("DedeUserID", ""),
    )
