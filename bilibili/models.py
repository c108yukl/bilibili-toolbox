"""
数据模型 - 弹幕 / 字幕 / 凭证 的数据类与格式转换

兼容性说明:
- Danmaku.to_dict() 输出与旧版 SDK 完全一致:
  {"time": float, "text": str, "mode": int, "font_size": int, "color": int, "uid": int|str}
- Subtitle 提供 to_srt/to_ass/to_lrc/to_simple_json，与旧版 bilibili_api.Subtitle 用法一致
- CookieCredential 属性名与 bilibili_api.Credential 对齐 (sessdata/bili_jct/buvid3/dedeuserid)
"""

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# ─── 弹幕 ─────────────────────────────────────────────────

@dataclass
class Danmaku:
    """单条弹幕（内部模型）"""
    dm_time: float          # 视频内时间（秒）
    text: str
    mode: int = 1           # 滚动/顶部/底部等
    font_size: int = 25
    color: int = 16777215
    uid: str = ""           # 用户标识（seg.so 为 mid，list.so 为 mid hash）
    ctime: int = 0          # 发送时间戳（秒）

    def to_dict(self) -> dict:
        """输出为旧版 SDK 兼容的 dict（字段名 time/text/mode/...）"""
        return {
            "time": self.dm_time,
            "text": self.text,
            "mode": self.mode,
            "font_size": self.font_size,
            "color": self.color,
            "uid": self.uid,
        }


# ─── 字幕 ─────────────────────────────────────────────────

@dataclass
class SubtitleLine:
    """单条字幕片段"""
    from_: float            # 开始时间（秒）
    to: float               # 结束时间（秒）
    content: str

    @classmethod
    def from_json(cls, raw: dict) -> "SubtitleLine":
        return cls(
            from_=float(raw.get("from", 0) or 0),
            to=float(raw.get("to", 0) or 0),
            content=str(raw.get("content", "") or ""),
        )

    def to_dict(self) -> dict:
        return {"from": self.from_, "to": self.to, "content": self.content}


class Subtitle:
    """视频字幕（兼容旧版 Subtitle 对象的 to_srt/to_ass/to_lrc/to_simple_json 用法）"""

    def __init__(self, lan: str, lan_doc: str = "", lines: list[SubtitleLine] | None = None):
        self.lan = lan
        self.lan_doc = lan_doc or lan
        self.lines: list[SubtitleLine] = lines or []

    def __len__(self) -> int:
        return len(self.lines)

    # ── 时间格式化（与扩展 utils.js 一致）──
    @staticmethod
    def _fmt_srt_time(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        ms = int((sec % 1) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    @staticmethod
    def _fmt_ass_time(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = (sec % 60)
        return f"{h}:{m:02d}:{s:05.2f}"

    @staticmethod
    def _fmt_lrc_time(sec: float) -> str:
        m = int(sec // 60)
        s = (sec % 60)
        return f"{m:02d}:{s:05.2f}"

    @staticmethod
    def _fmt_full_time(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        ms = int((sec % 1) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

    @staticmethod
    def _sanitize(text: str) -> str:
        return str(text or "").replace("\r\n", " ").replace("\n", " ").replace("-->", "→")

    # ── 格式输出 ──
    def to_srt(self) -> str:
        blocks = []
        for i, line in enumerate(self.lines, 1):
            blocks.append(
                f"{i}\n{self._fmt_srt_time(line.from_)} --> {self._fmt_srt_time(line.to)}\n"
                f"{self._sanitize(line.content)}"
            )
        return "\n\n".join(blocks) + ("\n" if blocks else "")

    def to_ass(self, title: str = "Bilibili Subtitle") -> str:
        header = (
            "[Script Info]\n"
            f"Title: {title}\n"
            "ScriptType: v4.00+\n"
            "WrapStyle: 0\n"
            "PlayResX: 1920\n"
            "PlayResY: 1080\n"
            "\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
            "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
            "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            "Style: Default,Microsoft YaHei,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
            "0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n"
            "\n"
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        )
        events = "\n".join(
            f"Dialogue: 0,{self._fmt_ass_time(line.from_)},{self._fmt_ass_time(line.to)},"
            f"Default,,0,0,0,,{self._sanitize(line.content)}"
            for line in self.lines
        )
        return header + events

    def to_lrc(self) -> str:
        return "\n".join(
            f"[{self._fmt_lrc_time(line.from_)}]{self._sanitize(line.content)}"
            for line in self.lines
        )

    def to_simple_json(self) -> list:
        return [line.to_dict() for line in self.lines]

    def to_dict(self) -> dict:
        return {
            "lan": self.lan,
            "lan_doc": self.lan_doc,
            "count": len(self.lines),
            "body": self.to_simple_json(),
        }


# ─── 凭证 ─────────────────────────────────────────────────

class CookieCredential:
    """
    B站登录凭证（兼容旧版 bilibili_api.Credential 的属性名）

    通过 parse_cookie 构造；传给 get_* 系列函数即可启用登录态抓取。
    """

    def __init__(
        self,
        sessdata: str = "",
        bili_jct: str = "",
        buvid3: str = "",
        dedeuserid: str = "",
    ):
        self.sessdata = sessdata
        self.bili_jct = bili_jct
        self.buvid3 = buvid3
        self.dedeuserid = dedeuserid

    @property
    def has_sessdata(self) -> bool:
        return bool(self.sessdata)

    def get_cookies(self) -> dict:
        """返回 Cookie 字典（仅含非空项）"""
        cookies = {}
        for key, value in (
            ("SESSDATA", self.sessdata),
            ("bili_jct", self.bili_jct),
            ("buvid3", self.buvid3),
            ("DedeUserID", self.dedeuserid),
        ):
            if value:
                cookies[key] = value
        return cookies

    def cookie_str(self) -> str:
        """拼接为 Cookie 请求头字符串"""
        return "; ".join(f"{k}={v}" for k, v in self.get_cookies().items())

    def __bool__(self) -> bool:
        return bool(self.sessdata)

    def __repr__(self) -> str:
        return (
            f"CookieCredential(sessdata={'有' if self.sessdata else '无'}, "
            f"bili_jct={'有' if self.bili_jct else '无'}, "
            f"buvid3={'有' if self.buvid3 else '无'}, "
            f"dedeuserid={'有' if self.dedeuserid else '无'})"
        )

    def __eq__(self, other) -> bool:
        if not isinstance(other, CookieCredential):
            return NotImplemented
        return (
            self.sessdata == other.sessdata
            and self.bili_jct == other.bili_jct
            and self.buvid3 == other.buvid3
            and self.dedeuserid == other.dedeuserid
        )
