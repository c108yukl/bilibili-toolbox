"""BV 号解析测试"""

import pytest

from bilibili.utils import extract_bvid, is_valid_bvid


class TestExtractBvid:
    def test_pure_bvid(self):
        assert extract_bvid("BV1cmofByENF") == "BV1cmofByENF"

    def test_full_url(self):
        assert extract_bvid("https://www.bilibili.com/video/BV1cmofByENF") == "BV1cmofByENF"

    def test_url_with_params(self):
        url = "https://www.bilibili.com/video/BV1cmofByENF?p=2&vd_source=abc123"
        assert extract_bvid(url) == "BV1cmofByENF"

    def test_url_with_trailing_slash(self):
        assert extract_bvid("https://www.bilibili.com/video/BV1cmofByENF/") == "BV1cmofByENF"

    def test_pure_bvid_with_query(self):
        assert extract_bvid("BV1cmofByENF?p=3") == "BV1cmofByENF"

    def test_whitespace(self):
        assert extract_bvid("  BV1cmofByENF  ") == "BV1cmofByENF"

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            extract_bvid("hello world")

    def test_short_bvid_raises(self):
        # 少于 10 位字符的 BV 号不合法
        with pytest.raises(ValueError):
            extract_bvid("BV123")


class TestIsValidBvid:
    def test_valid(self):
        assert is_valid_bvid("BV1cmofByENF")

    def test_invalid(self):
        assert not is_valid_bvid("BV1cm")
        assert not is_valid_bvid("")
        assert not is_valid_bvid("AV1234567890")
