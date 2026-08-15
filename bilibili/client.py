"""
统一异步 HTTP 客户端 - 替代 bilibili-api-python 的自研请求层

特性:
- aiohttp 会话复用，统一 UA/Referer/Origin 请求头
- 登录 Cookie 注入（CookieCredential）
- 单次请求超时（BILI_TIMEOUT）+ 网络错误自动重试（BILI_RETRIES，指数退避）
- WBI 签名集成：wbi=True 时自动取密钥并签名；首次 WBI 前自动校准服务器时间
- 错误归一：BiliAPIError（code != 0）/ BiliHTTPError（非 2xx）/ BiliNetworkError
"""

import asyncio
import logging
import time
from typing import Optional

import aiohttp

from bilibili import wbi
from bilibili.config import RETRIES, TIMEOUT, USER_AGENT
from bilibili.models import CookieCredential

logger = logging.getLogger(__name__)


class BiliError(Exception):
    """B站请求基础错误"""


class BiliAPIError(BiliError):
    """B站 API 返回 code != 0"""

    def __init__(self, code: int, message: str, data=None):
        super().__init__(f"API错误({code}): {message or '未知'}")
        self.code = code
        self.message = message or ""
        self.data = data


class BiliHTTPError(BiliError):
    """HTTP 状态非 2xx"""

    def __init__(self, status: int, text: str = ""):
        super().__init__(f"HTTP {status}: {text[:200] or '请求失败'}")
        self.status = status
        self.text = text


class BiliNetworkError(BiliError):
    """网络层错误（超时/连接失败/取消）"""

    def __init__(self, cause: Exception, url: str = ""):
        super().__init__(f"网络错误: {cause} ({url})")
        self.cause = cause
        self.url = url


def is_retryable(err: Exception) -> bool:
    """判断错误是否值得重试（网络层错误；API 业务错误不重试）"""
    return isinstance(err, (BiliNetworkError, aiohttp.ClientError, asyncio.TimeoutError))


class BiliClient:
    """
    B站 API 客户端（async，使用后应 close；也可用作 async with）

    用法:
        async with BiliClient(credential) as client:
            data = await client.fetch_json("https://api.bilibili.com/x/web-interface/view",
                                           {"bvid": "BV..."})
    """

    def __init__(
        self,
        credential: Optional[CookieCredential] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        user_agent: Optional[str] = None,
        session: Optional[aiohttp.ClientSession] = None,
    ):
        self.credential = credential
        self.timeout = timeout if timeout is not None else TIMEOUT
        self.retries = retries if retries is not None else RETRIES
        self.user_agent = user_agent or USER_AGENT
        self._session = session
        self._owns_session = session is None
        self._wbi_synced = False

    # ── 生命周期 ────────────────────────────────────────────

    async def __aenter__(self) -> "BiliClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def close(self) -> None:
        if self._session is not None and self._owns_session:
            await self._session.close()
        self._session = None

    def _session_get(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                headers=self._headers(),
            )
        return self._session

    def _headers(self) -> dict:
        headers = {
            "User-Agent": self.user_agent,
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        if self.credential:
            headers["Cookie"] = self.credential.cookie_str()
        return headers

    # ── 核心请求 ────────────────────────────────────────────

    async def _request(
        self,
        url: str,
        *,
        params: Optional[dict] = None,
        method: str = "GET",
        cookie: bool = True,
    ) -> aiohttp.ClientResponse:
        """发起请求并返回响应；网络错误自动重试（指数退避）"""
        full_url = url if not params else f"{url}?{wbi.build_query(params)}"
        last_err: Optional[Exception] = None
        for attempt in range(self.retries + 1):
            session = self._session_get()
            headers = dict(session.headers)
            if cookie and self.credential:
                headers["Cookie"] = self.credential.cookie_str()
            try:
                resp = await session.request(method, full_url, headers=headers)
                if resp.status < 200 or resp.status >= 300:
                    text = await resp.text()
                    await resp.release()
                    raise BiliHTTPError(resp.status, text)
                return resp
            except BiliHTTPError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                last_err = e
                if attempt < self.retries:
                    backoff = 0.5 * (2 ** attempt)
                    logger.debug("请求失败，%.1fs 后重试 (%s): %s", backoff, full_url, e)
                    await asyncio.sleep(backoff)
        raise BiliNetworkError(last_err or RuntimeError("请求失败"), full_url)

    async def fetch_json(
        self,
        url: str,
        params: Optional[dict] = None,
        *,
        method: str = "GET",
        wbi_sign: bool = False,
        cookie: bool = True,
    ) -> dict:
        """
        请求 JSON 接口，返回 data 字段（code != 0 时抛 BiliAPIError）

        Args:
            url: 接口地址
            params: 查询参数
            method: GET/POST
            wbi_sign: 是否附加 WBI 签名（自动取密钥 + 服务器时间校准）
            cookie: 是否携带登录 Cookie
        """
        if wbi_sign:
            await self._ensure_wbi_synced()
            params = dict(params or {})
            params = await wbi.get_signed_params(self, params)
        resp = await self._request(url, params=params, method=method, cookie=cookie)
        try:
            data = await resp.json(content_type=None)
        except Exception as e:
            raise BiliError(f"响应不是合法 JSON: {e}") from e
        finally:
            await resp.release()
        if not isinstance(data, dict):
            raise BiliError(f"响应结构异常: {type(data).__name__}")
        code = data.get("code", 0)
        if code != 0:
            raise BiliAPIError(code, data.get("message") or data.get("msg") or "", data)
        return data.get("data") or {}

    async def fetch_raw(
        self,
        url: str,
        params: Optional[dict] = None,
        *,
        method: str = "GET",
        cookie: bool = True,
    ) -> bytes:
        """请求原始字节（seg.so / list.so / 字幕 JSON 等）"""
        resp = await self._request(url, params=params, method=method, cookie=cookie)
        try:
            return await resp.read()
        finally:
            await resp.release()

    # ── WBI 辅助 ────────────────────────────────────────────

    async def _ensure_wbi_synced(self) -> None:
        """首次 WBI 请求前校准服务器时间（只做一次）"""
        if not self._wbi_synced:
            await wbi.sync_server_time(self)
            self._wbi_synced = True
