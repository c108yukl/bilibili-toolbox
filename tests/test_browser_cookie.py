"""browser_cookie 浏览器 Cookie 提取测试"""

import base64
import json
import sqlite3
import sys
from pathlib import Path

import pytest

from bilibili import browser_cookie as bc


def _make_v10(key: bytes, value: str) -> bytes:
    nonce = b"nonce0123456"
    cipher = bc.AES.new(key, bc.AES.MODE_GCM, nonce=nonce)
    ct, tag = cipher.encrypt_and_digest(value.encode())
    return b"v10" + nonce + ct + tag


def _make_v20(app_key: bytes, value: str) -> bytes:
    nonce = b"nonce0123456"
    cipher = bc.AES.new(app_key, bc.AES.MODE_GCM, nonce=nonce)
    ct, tag = cipher.encrypt_and_digest(b"k" * 32 + value.encode())
    return b"v20" + nonce + ct + tag


def _dpapi_protect(data: bytes) -> bytes:
    """仅测试用：Windows DPAPI 加密"""
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    assert ok, "CryptProtectData 失败"
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


class TestHostFilter:
    def test_bilibili(self):
        for host in ("bilibili.com", ".bilibili.com", "www.bilibili.com",
                     "comment.bilibili.com", "api.bilibili.com", "b23.tv", ".b23.tv"):
            assert bc._is_bilibili_host(host), host

    def test_not_bilibili(self):
        for host in ("", "example.com", "bilibili.tv", "bilibili.com.evil.com",
                     "evilbilibili.com", "b23.tv.evil.com"):
            assert not bc._is_bilibili_host(host), host


class TestFormatCookieString:
    def test_priority_order(self):
        cookies = [
            ("buvid3", "x", "www.bilibili.com"),
            ("SESSDATA", "abc", ".bilibili.com"),
            ("bili_jct", "y", ".bilibili.com"),
            ("foo", "bar", "bilibili.com"),
        ]
        assert bc._format_cookie_string(cookies) == \
            "SESSDATA=abc; bili_jct=y; buvid3=x; foo=bar"


class TestDecryptChromiumValue:
    @pytest.mark.skipif(bc.AES is None, reason="缺少 AES 库")
    def test_v10_roundtrip(self):
        key = b"k" * 32
        payload = _make_v10(key, "SESSDATA=hello")
        assert bc._decrypt_chromium_value(payload, key, None) == "SESSDATA=hello"

    @pytest.mark.skipif(bc.AES is None, reason="缺少 AES 库")
    def test_v20_roundtrip(self):
        app_key = b"a" * 32
        payload = _make_v20(app_key, "bili_jct=world")
        assert bc._decrypt_chromium_value(payload, b"x" * 32, app_key) == "bili_jct=world"

    @pytest.mark.skipif(bc.AES is None, reason="缺少 AES 库")
    def test_v20_without_app_key(self):
        payload = _make_v20(b"a" * 32, "v")
        with pytest.raises(bc.BrowserCookieError):
            bc._decrypt_chromium_value(payload, b"k" * 32, None)

    @pytest.mark.skipif(bc.AES is None, reason="缺少 AES 库")
    def test_wrong_key(self):
        payload = _make_v10(b"k" * 32, "v")
        with pytest.raises(bc.BrowserCookieError):
            bc._decrypt_chromium_value(payload, b"0" * 32, None)

    def test_unknown_prefix(self):
        assert bc._decrypt_chromium_value(b"v00xy", b"k" * 32, None) == ""

    def test_empty(self):
        assert bc._decrypt_chromium_value(b"", b"k" * 32, None) == ""


class TestFirefox:
    @staticmethod
    def _make_db(path: Path):
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT,"
                     " name TEXT, value TEXT, creationTime INTEGER)")
        conn.executemany(
            "INSERT INTO moz_cookies (host, name, value, creationTime) VALUES (?, ?, ?, ?)",
            [
                (".bilibili.com", "SESSDATA", "sess_old", 1),
                (".bilibili.com", "SESSDATA", "sess_new", 9),
                ("www.bilibili.com", "bili_jct", "jct1", 5),
                ("example.com", "foo", "bar", 5),
            ],
        )
        conn.commit()
        conn.close()

    def test_read_firefox(self, tmp_path, monkeypatch):
        db = tmp_path / "cookies.sqlite"
        self._make_db(db)
        monkeypatch.setattr(bc, "_find_firefox_cookies_db", lambda: db)
        cookies = bc._read_firefox_cookies()
        assert len(cookies) == 2
        # 同名 Cookie 取最新值
        assert ("SESSDATA", "sess_new", ".bilibili.com") in cookies
        assert ("bili_jct", "jct1", "www.bilibili.com") in cookies

    def test_get_browser_cookie_full(self, tmp_path, monkeypatch):
        db = tmp_path / "cookies.sqlite"
        self._make_db(db)
        monkeypatch.setattr(bc, "_find_firefox_cookies_db", lambda: db)
        cookie = bc.get_browser_cookie("Firefox")
        assert cookie.startswith("SESSDATA=sess_new")


class TestChromium:
    @pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")
    @pytest.mark.skipif(bc.AES is None, reason="缺少 AES 库")
    def test_read_chromium(self, tmp_path, monkeypatch):
        key = b"k" * 32
        user_data = tmp_path / "User Data"
        (user_data / "Default").mkdir(parents=True)
        (user_data / "Local State").write_text(
            json.dumps({"os_crypt": {
                "encrypted_key": base64.b64encode(b"DPAPI" + _dpapi_protect(key)).decode(),
            }}),
            encoding="utf-8")
        conn = sqlite3.connect(user_data / "Default" / "Cookies")
        conn.execute("CREATE TABLE cookies (host_key TEXT, name TEXT,"
                     " encrypted_value BLOB, value TEXT)")
        conn.executemany("INSERT INTO cookies VALUES (?, ?, ?, ?)", [
            (".bilibili.com", "SESSDATA", _make_v10(key, "sess123"), ""),
            ("www.bilibili.com", "bili_jct", _make_v10(key, "jct456"), ""),
            ("example.com", "foo", _make_v10(key, "bar"), ""),
            (".bilibili.com", "plain_cookie", None, "plainval"),
        ])
        conn.commit()
        conn.close()
        monkeypatch.setattr(bc, "_chromium_user_data", lambda browser: user_data)
        cookies = bc._read_chromium_cookies("chrome")
        assert len(cookies) == 3
        assert ("SESSDATA", "sess123", ".bilibili.com") in cookies
        assert ("bili_jct", "jct456", "www.bilibili.com") in cookies
        assert ("plain_cookie", "plainval", ".bilibili.com") in cookies

    @pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")
    def test_prefers_newest_profile(self, tmp_path):
        import os

        user_data = tmp_path / "User Data"
        d1 = user_data / "Default"
        d1.mkdir(parents=True)
        p1 = d1 / "Cookies"
        p1.write_bytes(b"old")
        os.utime(p1, (1_600_000_000, 1_600_000_000))
        d2 = user_data / "Profile 1"
        d2.mkdir()
        p2 = d2 / "Cookies"
        p2.write_bytes(b"new")
        os.utime(p2, (1_700_000_000, 1_700_000_000))  # 显式设置更晚的修改时间，消除时序抖动
        assert bc._find_chromium_cookies_db(user_data) == p2

    @pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")
    def test_missing_user_data(self, tmp_path, monkeypatch):
        monkeypatch.setattr(bc, "_chromium_user_data", lambda b: tmp_path / "nonexist")
        with pytest.raises(bc.BrowserCookieError):
            bc._read_chromium_cookies("chrome")


class TestDpapi:
    @pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")
    def test_roundtrip(self):
        secret = b"my-secret-key"
        assert bc._dpapi_unprotect(_dpapi_protect(secret)) == secret

    @pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")
    def test_bad_blob(self):
        with pytest.raises(bc.BrowserCookieError):
            bc._dpapi_unprotect(b"garbage-data")


class TestBrowserArg:
    def test_unsupported_browser(self):
        with pytest.raises(bc.BrowserCookieError):
            bc.get_browser_cookie("safari")
