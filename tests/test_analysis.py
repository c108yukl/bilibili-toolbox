"""分析模块测试：热词 + AI 文本构建（不触网）"""

import pytest

from bilibili.analysis import (
    build_comment_text,
    build_danmaku_text,
    build_subtitle_text,
    danmaku_word_cloud,
    extract_tokens,
)
from bilibili.models import Danmaku, Subtitle, SubtitleLine


class TestExtractTokens:
    def test_latin_and_cjk(self):
        tokens = extract_tokens("你好世界 abc123")
        assert "你好" in tokens
        assert "好世" in tokens
        assert "世界" in tokens
        assert "abc123" in tokens

    def test_single_char_latin_excluded(self):
        assert extract_tokens("a b c") == []

    def test_nfkc_normalized(self):
        tokens = extract_tokens("ＡＢＣ")  # 全角
        assert "abc" in tokens


class TestWordCloud:
    def test_frequency_desc(self):
        dms = [
            {"text": "哈哈 太棒了"},
            {"text": "太棒了"},
            {"text": "太棒了"},
            {"text": "无语"},
        ]
        words = danmaku_word_cloud(dms, top_n=10)
        # 太棒了 → 二元组 太棒/棒了 各 3 次；无语/哈哈 是停用词被过滤
        ranked = {w["word"]: w["count"] for w in words}
        assert ranked["太棒"] == 3
        assert ranked["棒了"] == 3
        assert "哈哈" not in ranked
        assert "无语" not in ranked
        assert words == sorted(words, key=lambda x: (-x["count"], x["word"]))

    def test_top_n(self):
        dms = [{"text": f"词{i}词{i}"} for i in range(20)]
        words = danmaku_word_cloud(dms, top_n=5)
        assert len(words) <= 5

    def test_accepts_danmaku_objects(self):
        dms = [Danmaku(dm_time=1.0, text="优秀 优秀")]
        words = danmaku_word_cloud(dms)
        assert words[0]["word"] == "优秀"
        assert words[0]["count"] == 2

    def test_repeated_char_skipped(self):
        # 叠词（哈哈/喔喔）即使不在停用表也应被过滤
        words = danmaku_word_cloud([{"text": "哇哇哇"}])
        assert all(w["word"] != "哇哇" for w in words)


class TestTextBuilders:
    def test_danmaku_dedup_and_cap(self):
        dms = [Danmaku(dm_time=i, text=f"弹幕{i % 2}") for i in range(10)]
        text = build_danmaku_text(dms, max_items=1)
        assert text == "弹幕0"

    def test_danmaku_dict_input(self):
        text = build_danmaku_text([{"text": "x"}, {"text": "x"}, {"text": "y"}])
        assert text == "x\ny"

    def test_subtitle_text_with_time(self):
        sub = Subtitle("ai-zh", lines=[
            SubtitleLine(from_=1.0, to=2.0, content="你好"),
            SubtitleLine(from_=3.0, to=4.0, content="世界"),
        ])
        text = build_subtitle_text(sub.lines, with_time=True)
        assert text == "[1.000] 你好\n[3.000] 世界"

    def test_comment_text(self):
        items = [
            {"comment": {"like": 5, "member": {"uname": "A"}, "content": {"message": "好评"}},
             "replies": [{"member": {"uname": "B"}, "content": {"message": "同意"}}]},
            {"comment": {"like": 1, "member": {"uname": "C"}, "content": {"message": "好评"}}},
        ]
        text = build_comment_text(items, max_items=10)
        assert text == "[赞5] A: 好评\n  ↳ B: 同意"
