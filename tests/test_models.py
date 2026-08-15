"""数据模型测试：Danmaku / Subtitle / CookieCredential"""

from bilibili.models import CookieCredential, Danmaku, Subtitle, SubtitleLine


class TestDanmaku:
    def test_to_dict_shape(self):
        dm = Danmaku(dm_time=1.5, text="哈哈", mode=1, font_size=25, color=16777215, uid="123")
        out = dm.to_dict()
        assert out == {
            "time": 1.5, "text": "哈哈", "mode": 1,
            "font_size": 25, "color": 16777215, "uid": "123",
        }


class TestSubtitle:
    def _sub(self):
        return Subtitle("ai-zh", "中文（AI自动生成）", lines=[
            SubtitleLine(from_=0.0, to=2.0, content="你好"),
            SubtitleLine(from_=2.0, to=3.5, content="世界"),
        ])

    def test_srt(self):
        srt = self._sub().to_srt()
        assert "1\n00:00:00,000 --> 00:00:02,000\n你好" in srt
        assert "2\n00:00:02,000 --> 00:00:03,500\n世界" in srt

    def test_srt_block_count(self):
        srt = self._sub().to_srt()
        blocks = [b for b in srt.strip().split("\n\n") if b.strip()]
        assert len(blocks) == 2

    def test_ass(self):
        ass = self._sub().to_ass("T")
        assert "[Script Info]" in ass
        assert "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,你好" in ass

    def test_lrc(self):
        lrc = self._sub().to_lrc()
        assert "[00:00.00]你好" in lrc

    def test_simple_json(self):
        data = self._sub().to_simple_json()
        assert data == [
            {"from": 0.0, "to": 2.0, "content": "你好"},
            {"from": 2.0, "to": 3.5, "content": "世界"},
        ]

    def test_line_from_json(self):
        line = SubtitleLine.from_json({"from": 1, "to": 2, "content": "x"})
        assert line.from_ == 1.0
        assert line.to == 2.0
        assert line.content == "x"

    def test_empty(self):
        sub = Subtitle("en")
        assert sub.to_srt() == ""
        assert sub.to_simple_json() == []
        assert len(sub) == 0


class TestCookieCredential:
    def test_cookie_str(self):
        cred = CookieCredential(sessdata="s", bili_jct="j", buvid3="b", dedeuserid="1")
        assert cred.cookie_str() == "SESSDATA=s; bili_jct=j; buvid3=b; DedeUserID=1"

    def test_empty_fields_skipped(self):
        cred = CookieCredential(sessdata="s")
        assert cred.cookie_str() == "SESSDATA=s"
        assert cred.has_sessdata

    def test_bool(self):
        assert bool(CookieCredential(sessdata="s"))
        assert not bool(CookieCredential())

    def test_get_cookies(self):
        cred = CookieCredential(sessdata="s", bili_jct="j")
        assert cred.get_cookies() == {"SESSDATA": "s", "bili_jct": "j"}
