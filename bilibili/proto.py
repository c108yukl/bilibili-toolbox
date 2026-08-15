"""
最小 protobuf 解析器 - B站弹幕分段接口 seg.so (DmSegMobileReply)

无需 protobuf 依赖，仅实现弹幕消息所需字段的 wire format 解码：
    message DmSegMobileReply { repeated DanmakuElem elems = 1; }
    message DanmakuElem {
        int64 id = 1;        int32 progress = 2;    // 视频内时间（毫秒）
        int32 mode = 3;      int32 fontsize = 4;    int32 color = 5;
        string mid = 6;      string content = 7;    int64 ctime = 8;
        ...
    }
"""

import logging
from typing import List

from bilibili.models import Danmaku

logger = logging.getLogger(__name__)


class _Reader:
    """varint 游标读取器"""

    __slots__ = ("data", "pos")

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def read_varint(self) -> int:
        result = 0
        shift = 0
        while self.pos < len(self.data):
            b = self.data[self.pos]
            self.pos += 1
            result |= (b & 0x7F) << shift
            if not (b & 0x80):
                return result
            shift += 7
        return result

    def skip(self, wire: int) -> None:
        if wire == 0:
            self.read_varint()
        elif wire == 1:
            self.pos += 8
        elif wire == 2:
            length = self.read_varint()
            self.pos += length
        elif wire == 5:
            self.pos += 4
        else:  # 未知 wire type，放弃本消息
            self.pos = len(self.data)

    def sub(self, length: int) -> bytes:
        chunk = self.data[self.pos:self.pos + length]
        self.pos += length
        return chunk


def parse_dm_seg(data: bytes) -> List[Danmaku]:
    """
    解析 seg.so 返回的 protobuf 二进制 → Danmaku 列表

    Args:
        data: seg.so 响应体（DmSegMobileReply 序列化字节）

    Returns:
        弹幕列表（按出现顺序，未排序）

    Notes:
        对截断/损坏数据保持健壮：任何一次字段读取没有推进游标即终止解析。
    """
    reader = _Reader(data)
    dms: List[Danmaku] = []
    while reader.pos < len(reader.data):
        start = reader.pos
        tag = reader.read_varint()
        if reader.pos == start:  # 游标未前进（数据耗尽）→ 终止
            break
        field, wire = tag >> 3, tag & 7
        if field == 1 and wire == 2:  # elems
            length = reader.read_varint()
            end = min(reader.pos + length, len(reader.data))
            dm = Danmaku(dm_time=0.0, text="")
            while reader.pos < end:
                fstart = reader.pos
                ftag = reader.read_varint()
                if reader.pos == fstart:
                    break
                f, w = ftag >> 3, ftag & 7
                if w == 2:
                    l = reader.read_varint()
                    raw = reader.sub(l)
                    if f == 6:
                        dm.uid = raw.decode("utf-8", "replace")
                    elif f == 7:
                        dm.text = raw.decode("utf-8", "replace")
                elif w == 0:
                    v = reader.read_varint()
                    if f == 2:
                        dm.dm_time = v / 1000  # progress: 毫秒 → 秒
                    elif f == 3:
                        dm.mode = v
                    elif f == 4:
                        dm.font_size = v
                    elif f == 5:
                        dm.color = v
                    elif f == 8:
                        dm.ctime = v
                elif w in (1, 5):
                    reader.pos += 8 if w == 1 else 4
                else:
                    break
            if dm.text:
                dms.append(dm)
        elif wire == 0:
            reader.read_varint()
        elif wire in (1, 5):
            reader.pos += 8 if wire == 1 else 4
        else:
            break
    return dms
