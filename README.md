
# B站工具箱：弹幕 / 评论 / 字幕 抓取

一键抓取 B站 视频的**弹幕、评论（含楼中楼）、字幕**，提供三种使用方式：Python SDK、命令行 CLI、Streamlit 网页版，另有 Edge 浏览器扩展（主包）。

```
├── bilibili/            # Python SDK（可 pip install）
├── cli.py               # 命令行入口
├── app.py               # Streamlit 网页版入口 (streamlit run app.py)
├── bilibili-extension--main/  # Edge/Chrome 扩展 (MV3, v2.4.0)
├── tests/               # pytest 测试
└── bak/                 # 旧版本备份 / 打包产物（已忽略）
```

> 已废弃：`bilibili_demo.py` 旧版单文件原型已移入 `bak/`，功能全部由 SDK 替代。

---

## 一、快速开始

### 方式 1：命令行（最简单）

```bash
pip install -r requirements.txt
python cli.py BV1cmofByENF            # 默认抓全部（弹幕+评论+字幕）
python cli.py BV1cmofByENF -d --save json    # 只抓弹幕
python cli.py BV1cmofByENF -c --all --replies --save csv   # 全量评论+楼中楼
python cli.py BV1cmofByENF -s --sub-lan en --save srt      # 英文字幕
python cli.py BV1cmofByENF --output-dir ./output           # 指定输出目录
```

参数速查：`-d` 弹幕 / `-c` 评论 / `-s` 字幕 / `-dc` 弹幕+评论 / `--all` 全量评论 / `--replies` 楼中楼 / `--max-pages N` 限制页数 / `--save fmt` 保存格式 / `--cookie` 登录态 / `--no-cache` 禁用缓存。

### 方式 2：网页版

```bash
pip install streamlit
streamlit run app.py
```

### 方式 3：Python SDK

```python
import asyncio
from bilibili import get_danmaku, get_subtitle, get_comments, parse_cookie

async def main():
    credential = parse_cookie("SESSDATA=xxx")  # 可选
    dms = await get_danmaku("BV1cmofByENF", save_fmt="json")
    subs = await get_subtitle("BV1cmofByENF", lan_code="ai-zh")
    comments = await get_comments("BV1cmofByENF", with_replies=True)

asyncio.run(main())
```

`pip install -e .` 后即可作为包导入。

### 方式 4：Edge 浏览器扩展（主包，v2.4.0）

1. 打开 `edge://extensions/` → 开启"开发人员模式"
2. 点"加载解压缩的扩展"→ 选择 `bilibili-extension--main/` 目录
3. 在 B 站视频页点击扩展图标 → 自动识别 BV 号 → 选择任务 → 开始爬取
4. 也可在视频链接上**右键**直接抓取，或使用页面右下角的**悬浮球**快捷抓取

扩展特性：弹幕/评论/字幕/热词/UP主信息/批量抓取、AI 字幕总结与弹幕分析（DeepSeek 流式输出、模型自动获取、余额查询）、悬浮球、5 套主题色、合成音效、后台运行、自动 Cookie、一键复制/下载、设置备份导入导出。

详细说明见 `bilibili-extension--main/README.md`。

---

## 二、配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `BILI_OUTPUT_DIR` | 项目根目录 | 输出文件保存目录 |
| `BILI_CACHE_DIR` | `.bili_cache/` | 缓存目录 |
| `BILI_TIMEOUT` | 15 | 请求超时（秒） |
| `BILI_RATE_DELAY` | 500 | 评论翻页间隔（毫秒） |
| `BILI_LOG_LEVEL` | INFO | 日志级别 |

缓存默认 30 秒有效，`--no-cache` 或 `max_age=0` 完全禁用（不读不写）。输出文件重名自动加 `_1` 后缀，不覆盖。

## 三、技术要点

- **WBI 签名**：B站接口鉴权核心。从 `x/web-interface/nav` 取 img_key/sub_key → 64 元素查找表混排取前 32 位 → 参数排序 urlencode + mixin_key → MD5 得 w_rid，附带 wts 时间戳（扩展侧已做服务器时间校准）。
- **API 降级策略**：字幕 Player API（WBI）→ 视频信息 API → 重新拉取；评论 cursor 版 → WBI 签名版 → page 版（最宽容）。
- **楼中楼回复**：自动翻页取全（每评论最多 20 页/400 条的保护上限）。
- **取消与超时**（扩展）：所有请求 15 秒超时，支持随时取消（AbortController 真正中止请求）。

## 四、开发

```bash
pip install -e .[dev]
pytest          # 运行测试
```

## 五、版权声明

- 本工具以 MIT 协议开源，详见 [LICENSE](LICENSE)
- 仅供学习交流，请勿用于商业用途或高频抓取
- B站 API 文档参考 [bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)
- Python 侧依赖 [bilibili-api-python](https://github.com/Nemo2011/bilibili-api)
