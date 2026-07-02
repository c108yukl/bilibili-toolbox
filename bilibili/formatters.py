"""
数据格式化与文件保存模块
"""

import csv
import json
from datetime import datetime
from pathlib import Path

# 输出文件默认保存目录
OUTPUT_DIR = Path(__file__).resolve().parent.parent


def fmt_time(ts: int) -> str:
    """Unix 时间戳 → 可读时间字符串"""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


# ─── 评论格式化 ───────────────────────────────────────────

def format_comment(c: dict) -> dict:
    """将原始评论字典转为精简格式"""
    return {
        "like": c["like"],
        "uname": c["member"]["uname"],
        "time": fmt_time(c["ctime"]),
        "text": c["content"]["message"],
        "reply_count": c.get("rcount", 0),
        "rpid": c["rpid"],
    }


def format_reply(r: dict) -> dict:
    """将原始回复字典转为精简格式"""
    parent_uname = ""
    if r.get("parent") and r.get("members"):
        parent_uname = r["members"].get(r["parent"], {}).get("uname", "")
    return {
        "like": r["like"],
        "uname": r["member"]["uname"],
        "time": fmt_time(r["ctime"]),
        "text": r["content"]["message"],
        "reply_to": parent_uname,
        "rpid": r["rpid"],
    }


# ─── 评论保存 ─────────────────────────────────────────────

def save_comments(comments_with_replies: list, bvid: str, fmt: str = "txt"):
    """
    保存评论到文件
    comments_with_replies: [{"comment": {...}, "replies": [...]}, ...]
    """
    title = f"comments_{bvid}"

    if fmt == "json":
        rows = []
        for item in comments_with_replies:
            c = format_comment(item["comment"])
            c["replies"] = [format_reply(r) for r in item.get("replies", [])]
            rows.append(c)
        out = OUTPUT_DIR / f"{title}.json"
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    elif fmt == "csv":
        rows = []
        for item in comments_with_replies:
            c = format_comment(item["comment"])
            rows.append({**c, "level": "comment", "reply_to": ""})
            for r in item.get("replies", []):
                rows.append(
                    {**format_reply(r), "level": "reply", "reply_count": "", "rpid": r["rpid"]}
                )
        out = OUTPUT_DIR / f"{title}.csv"
        with out.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(
                f,
                fieldnames=["level", "like", "uname", "time", "text", "reply_count", "reply_to", "rpid"],
            )
            w.writeheader()
            w.writerows(rows)

    else:  # txt
        lines = []
        for item in comments_with_replies:
            c = item["comment"]
            lines.append(f"[+{c['like']}] {c['member']['uname']}: {c['content']['message']}")
            for r in item.get("replies", []):
                lines.append(f"  ↳[+{r['like']}] {r['member']['uname']}: {r['content']['message']}")
        out = OUTPUT_DIR / f"{title}.txt"
        out.write_text("\n".join(lines), encoding="utf-8")

    total_c = len(comments_with_replies)
    total_r = sum(len(item.get("replies", [])) for item in comments_with_replies)
    print(f"   -> 已保存 {out.name}  (评论{total_c}, 回复{total_r})")


# ─── 弹幕保存 ─────────────────────────────────────────────

def save_danmaku(dms: list, bvid: str, fmt: str = "txt"):
    """保存弹幕到文件"""
    title = f"danmaku_{bvid}"
    out = OUTPUT_DIR / f"{title}.{fmt}"

    if fmt == "json":
        rows = [
            {
                "time_s": round(d.dm_time, 1),
                "text": d.text,
                "mode": d.mode,
                "font_size": d.font_size,
                "color": d.color,
                "uid": d.uid,
            }
            for d in dms
        ]
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    elif fmt == "csv":
        with out.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["time_s", "text", "mode", "font_size", "color", "uid"])
            w.writeheader()
            w.writerows(
                [
                    {
                        "time_s": round(d.dm_time, 1),
                        "text": d.text,
                        "mode": d.mode,
                        "font_size": d.font_size,
                        "color": d.color,
                        "uid": d.uid,
                    }
                    for d in dms
                ]
            )

    else:  # txt
        out.write_text("\n".join(f"[{d.dm_time:7.1f}s] {d.text}" for d in dms), encoding="utf-8")

    print(f"   -> 已保存 {out.name}  ({len(dms)} 条)")


# ─── 字幕保存 ─────────────────────────────────────────────

def save_subtitle(sub_obj, bvid: str, lan_code: str, fmt: str = "srt"):
    """保存字幕到文件"""
    title = f"subtitle_{bvid}_{lan_code}"
    out = OUTPUT_DIR / f"{title}.{fmt}"

    if fmt == "ass":
        text = sub_obj.to_ass()
    elif fmt == "lrc":
        text = sub_obj.to_lrc()
    elif fmt == "json":
        data = sub_obj.to_simple_json()
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"   -> 已保存 {out.name}  ({len(data)} 条字幕)")
        return
    else:  # srt
        text = sub_obj.to_srt()

    out.write_text(text, encoding="utf-8")
    count = text.count("\n\n")
    print(f"   -> 已保存 {out.name}  ({count} 条字幕)")
