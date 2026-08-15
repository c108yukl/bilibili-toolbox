"""
WBI 签名模块 - B站接口鉴权（移植自扩展 utils.js，与官方实现一致）

原理:
1. 从 x/web-interface/nav 获取 wbi_img.img_url / sub_url，取文件名主干为 img_key / sub_key
2. 用 64 元素查找表混排取前 32 位得到 mixin_key
3. 参数排序后 urlencode，拼接 mixin_key 做 MD5 得 w_rid，附带 wts 时间戳

服务器时间校准:
通过 heartbeat 接口获取服务器时间戳，计算本地时钟偏移（含 RTT 补偿），
wts 使用校准后的服务器时间，避免签名被风控拒绝。
"""

import hashlib
import logging
import time
from urllib.parse import quote

logger = logging.getLogger(__name__)

# WBI 64 元素查找表（与 bilibili-api-python v17 官方一致；
# 旧表为 2023 年前的版本，B站已更换，沿用旧表会导致签名被风控拒绝）
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

_WBI_KEYS_TTL = 3600  # 密钥缓存有效期（秒）

# 模块级缓存：密钥 + 服务器时间偏移（毫秒）
_wbi_keys_cache = None  # {"img": str, "sub": str, "time": float}
_server_time_offset = 0.0  # 服务器时间 - 本地时间（毫秒）


def get_mixin_key(img_key: str, sub_key: str) -> str:
    """img_key + sub_key 经查找表混排取前 32 位 → mixin_key"""
    raw = (img_key or "") + (sub_key or "")
    return "".join(raw[i] for i in MIXIN_KEY_ENC_TAB[:32] if i < len(raw))


def build_query(params: dict) -> str:
    """urlencode（按键排序，quote 编码，空格 → %20）"""
    return "&".join(
        f"{quote(str(k), safe='')}={quote(str(v), safe='')}"
        for k, v in sorted(params.items())
    )


def sign_params(params: dict, img_key: str, sub_key: str, wts: int | None = None) -> dict:
    """
    对参数进行 WBI 签名，返回带 wts 与 w_rid 的新参数字典

    Args:
        params: 原始参数（值会被 str() 化）
        img_key / sub_key: nav 接口取到的 WBI 密钥
        wts: 时间戳（秒），None 时使用校准后的服务器时间
    """
    all_params = {str(k): str(v) for k, v in params.items()}
    all_params["wts"] = str(int(wts) if wts is not None else int(now_server() / 1000))
    sorted_keys = sorted(all_params)
    query = "&".join(
        f"{quote(k, safe='')}={quote(all_params[k], safe='')}" for k in sorted_keys
    )
    mixin_key = get_mixin_key(img_key, sub_key)
    all_params["w_rid"] = hashlib.md5((query + mixin_key).encode()).hexdigest()
    return all_params


def now_server() -> float:
    """校准后的服务器时间（毫秒时间戳）"""
    return time.time() * 1000 + _server_time_offset


def _apply_server_time(timestamp_s: float, rtt_ms: float) -> None:
    """根据服务器时间戳与 RTT 更新时钟偏移"""
    global _server_time_offset
    _server_time_offset = (timestamp_s * 1000 - time.time() * 1000) + rtt_ms / 2
    logger.debug("服务器时间校准: offset=%+.0fms", _server_time_offset)


async def sync_server_time(client) -> None:
    """
    通过 heartbeat 接口校准服务器时间（失败静默，回退本地时间）

    Args:
        client: 具备 fetch_raw 能力的请求对象（bilibili.client.BiliClient 或测试替身）
    """
    try:
        before = time.time() * 1000
        raw = await client.fetch_raw(
            "https://api.bilibili.com/x/report/web/heartbeat",
            method="POST",
            params={"platform": "web"},
            cookie=False,
        )
        import json

        data = json.loads(raw.decode("utf-8", "replace"))
        ts = (data.get("data") or {}).get("timestamp")
        if ts:
            _apply_server_time(float(ts), time.time() * 1000 - before)
    except Exception as e:
        logger.debug("服务器时间校准失败，使用本地时间: %s", e)


async def get_wbi_keys(client) -> dict:
    """
    获取（并缓存 1 小时）WBI 密钥

    Args:
        client: 请求对象（同 sync_server_time）

    Returns:
        {"img": ..., "sub": ..., "time": 缓存时间戳}
    """
    global _wbi_keys_cache
    if _wbi_keys_cache and now_server() - _wbi_keys_cache["time"] < _WBI_KEYS_TTL:
        return _wbi_keys_cache

    data = await client.fetch_json("https://api.bilibili.com/x/web-interface/nav", cookie=False)
    wbi = (data or {}).get("wbi_img") or {}
    img_url = wbi.get("img_url") or ""
    sub_url = wbi.get("sub_url") or ""
    if not img_url or not sub_url:
        raise RuntimeError("获取WBI密钥失败: 响应缺少 wbi_img（B站接口变更或需要登录）")
    img = img_url.split("/")[-1].split(".")[0]
    sub = sub_url.split("/")[-1].split(".")[0]
    _wbi_keys_cache = {"img": img, "sub": sub, "time": now_server()}
    logger.debug("已获取 WBI 密钥 img=%s sub=%s", img, sub)
    return _wbi_keys_cache


async def get_signed_params(client, params: dict) -> dict:
    """获取 WBI 密钥并签名参数（快捷入口）"""
    keys = await get_wbi_keys(client)
    return sign_params(params, keys["img"], keys["sub"])


def reset_for_tests() -> None:
    """清空模块级缓存（测试用）"""
    global _wbi_keys_cache, _server_time_offset
    _wbi_keys_cache = None
    _server_time_offset = 0.0
