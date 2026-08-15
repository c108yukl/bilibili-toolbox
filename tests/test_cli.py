"""cli.py 格式映射测试"""

from cli import _comment_fmt, _danmaku_fmt, _subtitle_fmt


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


class TestDanmakuFmt:
    def test_valid(self):
        for fmt in ("txt", "json", "csv"):
            assert _danmaku_fmt(fmt) == fmt

    def test_fallback_to_txt(self):
        # srt/ass/lrc 对弹幕不适用，兜底 txt，避免 .srt 里存纯文本
        for fmt in ("srt", "ass", "lrc"):
            assert _danmaku_fmt(fmt) == "txt"

    def test_none(self):
        assert _danmaku_fmt(None) is None


class TestCommentFmt:
    def test_valid(self):
        for fmt in ("txt", "json", "csv"):
            assert _comment_fmt(fmt) == fmt

    def test_fallback_to_txt(self):
        assert _comment_fmt("srt") == "txt"
        assert _comment_fmt("ass") == "txt"

    def test_none(self):
        assert _comment_fmt(None) is None
