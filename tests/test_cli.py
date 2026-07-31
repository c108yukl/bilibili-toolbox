"""cli.py 字幕格式映射测试"""

from cli import _subtitle_fmt


class TestSubtitleFmt:
    def test_valid_formats(self):
        assert _subtitle_fmt("srt") == "srt"
        assert _subtitle_fmt("ass") == "ass"
        assert _subtitle_fmt("lrc") == "lrc"
        assert _subtitle_fmt("json") == "json"

    def test_invalid_fallback(self):
        # txt/csv 对字幕不适用，兜底为 srt（修复旧版 bug）
        assert _subtitle_fmt("txt") == "srt"
        assert _subtitle_fmt("csv") == "srt"

    def test_none(self):
        assert _subtitle_fmt(None) == "srt"
