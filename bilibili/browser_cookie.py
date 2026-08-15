"""
浏览器 Cookie 提取 - Chrome / Edge / Firefox

从本机浏览器中提取 B 站登录 Cookie，免去手动复制步骤。

- Chrome / Edge (Chromium)：读取 Cookies SQLite，Windows 下用 DPAPI 解密 AES 密钥，
  再 AES-256-GCM 解密 Cookie 值（需要 pycryptodomex / pycryptodome）。
- Firefox：cookies.sqlite 中 Cookie 值为明文存储，无需额外依赖。

用法:
    from bilibili.browser_cookie import get_browser_cookie
    cookie = get_browser_cookie("edge")
"""

import base64
import ctypes
import json
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

try:  # pycryptodomex
    from Cryptodome.Cipher import AES
except ImportError:  # pycryptodome
    try:
        from Crypto.Cipher import AES
    except ImportError:
        AES = None

BROWSERS = ("chrome", "edge", "firefox")

# 仅提取 B 站主站相关域名的 Cookie
_BILIBILI_HOSTS = ("bilibili.com", "b23.tv")

# Cookie 在拼接字符串时的重要程度排序
_COOKIE_PRIORITY = (
    "SESSDATA", "bili_jct", "DedeUserID", "buvid3", "buvid4",
    "b_nut", "b_lsid", "bili_ticket", "bili_ticket_expires",
)


class BrowserCookieError(RuntimeError):
    """浏览器 Cookie 提取失败"""


def _is_bilibili_host(host: str) -> bool:
    host = host.strip().lower()
    return any(host == d or host.endswith("." + d) for d in _BILIBILI_HOSTS)


def _dpapi_unprotect(data: bytes) -> bytes:
    """Windows DPAPI 解密（CryptUnprotectData）"""
    if sys.platform != "win32":
        raise BrowserCookieError("DPAPI 解密仅在 Windows 上支持")
    if not data:
        raise BrowserCookieError("DPAPI 数据为空")
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    if not ok:
        raise BrowserCookieError("DPAPI 解密失败（当前 Windows 用户无法访问该密钥）")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _aes_gcm_decrypt(key: bytes, nonce: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    if AES is None:
        raise BrowserCookieError("缺少 AES 解密库，请先安装: pip install pycryptodomex")
    try:
        return AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ciphertext, tag)
    except ValueError as e:
        raise BrowserCookieError(f"Cookie 解密失败: {e}")


def _chromium_user_data(browser: str) -> Path:
    if browser == "chrome":
        windows_rel = Path("Google") / "Chrome" / "User Data"
        linux_dir = Path.home() / ".config" / "google-chrome"
    elif browser == "edge":
        windows_rel = Path("Microsoft") / "Edge" / "User Data"
        linux_dir = Path.home() / ".config" / "microsoft-edge"
    else:
        raise BrowserCookieError(f"不支持的浏览器: {browser}")
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or (
            Path(os.environ.get("USERPROFILE") or str(Path.home())) / "AppData" / "Local")
        return Path(local) / windows_rel
    return linux_dir


def _find_chromium_cookies_db(user_data: Path) -> Path | None:
    candidates = []
    profiles = [user_data / "Default"] + sorted(user_data.glob("Profile *"))
    for profile in profiles:
        for db in (profile / "Network" / "Cookies", profile / "Cookies"):
            if db.is_file():
                candidates.append((db.stat().st_mtime, db))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]


def _load_local_state(user_data: Path) -> dict:
    path = user_data / "Local State"
    if not path.is_file():
        raise BrowserCookieError(f"未找到浏览器密钥文件: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        raise BrowserCookieError(f"解析 Local State 失败: {e}")


def _get_aes_key(local_state: dict) -> bytes:
    try:
        raw = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
    except (KeyError, ValueError) as e:
        raise BrowserCookieError(f"读取加密密钥失败: {e}")
    if raw.startswith(b"DPAPI"):
        raw = _dpapi_unprotect(raw[5:])
    if len(raw) != 32:
        raise BrowserCookieError("解密后的 AES 密钥长度异常")
    return raw


def _get_app_bound_key(local_state: dict) -> bytes | None:
    """Chrome 127+ 应用绑定加密的备用密钥（DPAPI 影子密钥），失败返回 None"""
    try:
        raw = base64.b64decode(local_state["os_crypt"]["app_bound_encrypted_key"])
    except (KeyError, ValueError):
        return None
    if raw.startswith(b"DPAPI"):
        raw = _dpapi_unprotect(raw[5:])
    return raw[-32:] if len(raw) >= 32 else None


def _decrypt_chromium_value(encrypted: bytes, key: bytes, app_key: bytes | None) -> str:
    """解密单个 Chromium Cookie 值，返回明文（失败抛 BrowserCookieError）"""
    if encrypted.startswith(b"v10"):
        return _aes_gcm_decrypt(
            key, encrypted[3:15], encrypted[15:-16], encrypted[-16:]).decode("utf-8", "replace")
    if encrypted.startswith(b"v20"):
        # Chrome 127+ 应用绑定加密：明文 = key_id[32] + 值
        if not app_key:
            raise BrowserCookieError("v20 加密 Cookie 缺少 app-bound key")
        plain = _aes_gcm_decrypt(
            app_key, encrypted[3:15], encrypted[15:-16], encrypted[-16:])
        return plain[32:].decode("utf-8", "replace")
    return ""


def _read_sqlite_copy(db_path: Path, query: str, browser: str = "") -> list:
    """复制 SQLite 到临时文件再读取，避免浏览器占用导致的锁问题"""
    fd, tmp = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    try:
        shutil.copy2(db_path, tmp)
        with sqlite3.connect(tmp) as conn:
            return conn.execute(query).fetchall()
    except PermissionError:
        raise BrowserCookieError(
            f"{browser} 正在运行，Cookie 数据库被锁定，请先关闭 {browser} 再重试"
            f"（或改用 --cookie 手动传入）")
    except (sqlite3.Error, OSError) as e:
        raise BrowserCookieError(f"读取 Cookie 数据库失败: {e}")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _read_chromium_cookies(browser: str) -> list:
    user_data = _chromium_user_data(browser)
    if not user_data.is_dir():
        raise BrowserCookieError(f"未找到 {browser} 用户数据目录: {user_data}")
    cookies_db = _find_chromium_cookies_db(user_data)
    if cookies_db is None:
        raise BrowserCookieError(f"未找到 {browser} 的 Cookies 数据库（是否安装并登录过？）")
    local_state = _load_local_state(user_data)
    key = _get_aes_key(local_state)
    app_key = _get_app_bound_key(local_state)

    rows = _read_sqlite_copy(
        cookies_db,
        "SELECT host_key, name, encrypted_value, value FROM cookies ORDER BY host_key, name",
        browser=browser)
    seen, cookies = set(), []
    for host, name, enc, value in rows:
        if not _is_bilibili_host(host) or (host, name) in seen:
            continue
        seen.add((host, name))
        plain = None
        if enc:
            try:
                plain = _decrypt_chromium_value(enc, key, app_key)
            except BrowserCookieError as e:
                logger.warning("[Cookie] 跳过 %s=%s: %s", host, name, e)
        elif value:
            plain = value
        if plain:
            cookies.append((name, plain, host))
    return cookies


def _firefox_profile_dirs() -> list:
    dirs = []
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or (
            Path(os.environ.get("USERPROFILE") or str(Path.home())) / "AppData" / "Roaming")
        dirs.append(Path(appdata) / "Mozilla" / "Firefox" / "Profiles")
    dirs.append(Path.home() / ".mozilla" / "firefox")
    return [d for d in dirs if d.is_dir()]


def _find_firefox_cookies_db() -> Path | None:
    best = None
    for root in _firefox_profile_dirs():
        for db in root.glob("*/cookies.sqlite"):
            if not db.is_file():
                continue
            score = (0 if "default" in db.parent.name else 1, db.stat().st_mtime)
            if best is None or score > best[0]:
                best = (score, db)
    return best[1] if best else None


def _read_firefox_cookies() -> list:
    cookies_db = _find_firefox_cookies_db()
    if cookies_db is None:
        raise BrowserCookieError("未找到 Firefox 的 cookies.sqlite（是否安装并登录过？）")
    rows = _read_sqlite_copy(
        cookies_db, "SELECT host, name, value FROM moz_cookies ORDER BY creationTime DESC",
        browser="firefox")
    seen, cookies = set(), []
    for host, name, value in rows:
        if not _is_bilibili_host(host) or (host, name) in seen:
            continue
        seen.add((host, name))
        if value:
            cookies.append((name, value, host))
    return cookies


def _format_cookie_string(cookies: list) -> str:
    def sort_key(item):
        name = item[0]
        return (name not in _COOKIE_PRIORITY,
                _COOKIE_PRIORITY.index(name) if name in _COOKIE_PRIORITY else 0,
                item[2], name)

    return "; ".join(f"{name}={value}" for name, value, _ in sorted(cookies, key=sort_key))


def get_browser_cookie(browser: str) -> str:
    """从本机浏览器提取 B 站 Cookie 字符串，可直接传给 --cookie 或 parse_cookie"""
    browser = browser.strip().lower()
    if browser not in BROWSERS:
        raise BrowserCookieError(f"不支持的浏览器: {browser}（可用: {'/'.join(BROWSERS)}）")
    cookies = _read_firefox_cookies() if browser == "firefox" else _read_chromium_cookies(browser)
    if not cookies:
        raise BrowserCookieError(f"未在 {browser} 中找到 B 站 Cookie，请先在浏览器中登录 bilibili.com")
    names = sorted({c[0] for c in cookies})
    logger.info("已从 %s 提取 %d 个 B 站 Cookie (%s)", browser, len(cookies), ", ".join(names))
    return _format_cookie_string(cookies)
