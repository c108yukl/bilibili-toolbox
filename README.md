# B站工具箱：弹幕 / 评论 / 字幕 抓取

一键抓取 B站 视频的**弹幕、评论（含楼中楼）、字幕**，提供三种使用方式：Python SDK、命令行 CLI、Streamlit 网页版，另有 Edge/Chrome 浏览器扩展（主包）。

```
├── bilibili/            # Python SDK（可 pip install，自研 HTTP 栈，v1.2.0）
│   ├── client.py        #   异步请求客户端（超时/重试/Cookie/错误归一）
│   ├── wbi.py           #   WBI 签名 + 服务器时间校准
│   ├── proto.py         #   seg.so protobuf 弹幕解析（零依赖）
│   ├── models.py        #   Danmaku / Subtitle / CookieCredential 数据模型
│   ├── danmaku.py       #   弹幕：seg.so 分段全量 + list.so 对比取多
│   ├── comments.py      #   评论：cursor → WBI → page 三级降级
│   ├── subtitle.py      #   字幕：Player WBI → view 字段 → 重拉
│   ├── analysis.py      #   弹幕热词 + OpenAI 兼容 AI 分析（流式/思考模型）
│   ├── cli.py           #   CLI 实现（包内）
│   └── webapp.py        #   Streamlit 实现（包内）
├── cli.py               # 命令行入口（薄壳，兼容 python cli.py）
├── app.py               # Streamlit 网页版入口（薄壳，streamlit run app.py）
├── bilibili-extension--main/  # Edge/Chrome 扩展 (MV3, v1.2.0, ES Module，三种界面风格 + MCP 服务)
├── mcp_server.py              # MCP 本地桥接服务（自定义端口，AI 调用扩展 + 自动 Cookie）
├── tests/               # pytest 测试（139 个，全部离线可跑）
└── bak/                 # 旧版本备份（保留，已忽略）
```

> 全面重构：移除 `bilibili-api-python` 依赖，改为自研异步 HTTP 栈，
> 并把扩展侧已验证的强能力全部移植进 Python SDK（WBI 签名、服务器时间校准、
> seg.so 全量弹幕、评论三级降级、字幕三级降级、滑动窗口、热词与 AI 分析）。

---

## 一、快速开始

### 方式 1：命令行（最简单）

```bash
pip install -r requirements.txt
python cli.py BV1cmofByENF            # 默认抓全部（弹幕+评论+字幕）
python cli.py BV1cmofByENF -d --save json    # 只抓弹幕
python cli.py BV1cmofByENF -d --cloud        # 弹幕 + 热词 cloud_<bvid>.json
python cli.py BV1cmofByENF -c --all --replies --save csv   # 全量评论+楼中楼
python cli.py BV1cmofByENF -s --sub-lan en --save srt      # 英文字幕
python cli.py BV1cmofByENF --output-dir ./output           # 指定输出目录
python cli.py BV1cmofByENF -c --all --browser-cookie edge  # 自动从 Edge 提取登录 Cookie
python cli.py BV1cmofByENF -d -c -s --ai --ai-key sk-xxx   # 抓取 + AI 分析（.md 保存）
```

参数速查：`-d` 弹幕 / `-c` 评论 / `-s` 字幕 / `-dc` 弹幕+评论 / `--all` 全量评论 / `--replies` 楼中楼 /
`--max-pages N` 限制页数 / `--max-comments N` 滑动窗口（达到即停）/ `--cloud` 弹幕热词 /
`--ai` AI 分析（弹幕/字幕/评论，流式，需 `--ai-key` 或环境变量 `BILI_AI_KEY`）/
`--save fmt` 保存格式 / `--cookie` 手动登录态 / `--browser-cookie {chrome,edge,firefox}` 自动从本机浏览器提取登录 Cookie（与 `--cookie` 二选一）/ `--no-cache` 禁用缓存。

> Chrome/Edge 提取需要 `pycryptodomex`（`pip install -e .[cookies]`）；Firefox 免额外依赖。
> 若浏览器正在运行导致数据库被锁定，请先关闭浏览器再重试。

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
    credential = parse_cookie("SESSDATA=xxx")  # 可选，填了弹幕走 seg.so 全量
    dms = await get_danmaku("BV1cmofByENF", save_fmt="json")
    subs = await get_subtitle("BV1cmofByENF", lan_code="ai-zh")
    comments = await get_comments("BV1cmofByENF", with_replies=True)

asyncio.run(main())
```

`pip install -e .` 后即可作为包导入。AI 分析与热词见 `bilibili.analysis`：

```python
from bilibili.analysis import danmaku_word_cloud, summarize_subtitle, AIConfig

words = danmaku_word_cloud(dms)                 # 弹幕热词（纯本地）
result = await summarize_subtitle(subs, cfg=AIConfig(api_key="sk-xxx"))
print(result["content"])                        # 流式：on_chunk 回调
```

### 方式 4：Edge/Chrome 浏览器扩展（主包，v1.2.0）

1. 打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`）→ 开启"开发人员模式"
2. 点"加载解压缩的扩展"→ 选择 `bilibili-extension--main/` 目录
3. 在 B 站视频页点击扩展图标 → 自动识别 BV 号 → 选择任务 → 开始爬取
4. 也可在视频链接上**右键**直接抓取，或使用页面右下角的**悬浮球**快捷抓取

**三种界面风格**：设置页「外观 → 界面风格」可切换弹窗皮肤——**Aurora Console**（默认，深空玻璃拟态 + 阶段时间线 HUD + 极光纱幕）、**Editorial**（编辑杂志风：米白单色、衬线标题、细线排版）、**Neumorphism**（新拟物派：双光源阴影、凸起/凹陷交互）。三套皮肤共用同一逻辑，保存后下次打开弹窗生效。

**🔌 MCP 服务（AI 调用扩展）**：设置页「服务」标签启用后，运行本地桥接：

```bash
pip install aiohttp
python mcp_server.py --port 8765        # 端口与扩展设置一致
```

在 AI 客户端（Claude Desktop / Cursor / DSH 等）配置 MCP 服务器：
`http://127.0.0.1:8765/mcp`，即可调用 6 个工具（`get_video_info` / `fetch_danmaku` /
`fetch_comments` / `fetch_subtitle` / `word_cloud` / `get_cookie_status`），
**Cookie 由扩展从浏览器自动读取**，弹幕自动走 seg.so 全量接口，无需手动提供。

扩展特性：弹幕/评论/字幕/热词/UP主信息/批量抓取、AI 字幕总结与弹幕/评论分析（DeepSeek 流式输出、
模型自动获取、余额查询）、AI 思考过程流式展示、三条 AI 任务并发、时间窗口、评论滑动窗口与速率控制、
悬浮球入场动效、5 套主题色、合成音效、后台运行、自动 Cookie、一键复制/下载、设置备份导入导出。
弹幕抓取带登录 Cookie 时自动使用 B站分段接口（`seg.so` protobuf）并对比 `list.so` 取更全的一份。

详细说明见 `bilibili-extension--main/README.md`。

---

## 二、配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `BILI_OUTPUT_DIR` | 项目根目录 | 输出文件保存目录 |
| `BILI_CACHE_DIR` | `.bili_cache/` | 缓存目录 |
| `BILI_TIMEOUT` | 15 | 请求超时（秒） |
| `BILI_RETRIES` | 2 | 网络错误自动重试次数 |
| `BILI_RATE_DELAY` | 500 | 评论翻页间隔（毫秒） |
| `BILI_REPLY_DELAY` | 300 | 楼中楼请求间隔（毫秒） |
| `BILI_LOG_LEVEL` | INFO | 日志级别 |
| `BILI_AI_BASE_URL` | `https://api.deepseek.com` | AI 接口地址（OpenAI 兼容） |
| `BILI_AI_KEY` | — | AI API Key |
| `BILI_AI_MODEL` | `deepseek-chat` | AI 模型 |
| `BILI_AI_MAX_TOKENS` | 4000 | AI 单次回复 token 上限 |

缓存默认 30 秒有效，`--no-cache` 或 `max_age=0` 完全禁用（不读不写）。输出文件重名自动加 `_1` 后缀，不覆盖。

## 三、技术要点

- **WBI 签名**：B站接口鉴权核心。从 `x/web-interface/nav` 取 img_key/sub_key → 64 元素查找表混排取前 32 位 →
  参数排序 urlencode + mixin_key → MD5 得 w_rid，附带 wts 时间戳；wts 使用 heartbeat 接口校准的服务器时间（含 RTT 补偿）。
- **弹幕全量**：有登录 Cookie 时按视频时长分段拉取 `seg.so`（protobuf，弹幕远多于 list.so），
  再与 `list.so`（XML）对比取更多的一份——B站对未登录/部分高密度视频的 list.so 只返回少量抽样（如 6000 条只给 120 条）。
- **评论降级**：cursor 主流接口（`x/v2/reply/main`）→ 受限时 WBI 签名重试 → page 备用接口（`x/v2/reply`）；
  置顶评论与普通评论合并并按 rpid 去重（B站可能重复返回）。
- **字幕降级**：Player WBI 接口（`x/player/wbi/v2`）→ 视频信息字幕字段 → 重新拉取视频信息。
- **滑动窗口**：`--max-comments N` 达到目标条数立即停止并截断，保留最热评论在前；翻页速率可调，防风控。
- **请求健壮性**：统一 15 秒超时、网络错误指数退避重试（2 次）、`code != 0` 归一为 `BiliAPIError`；
  每次任务复用同一 HTTP 会话（aiohttp），WBI 密钥缓存 1 小时。
- **AI 分析**：OpenAI 兼容 `chat/completions`，默认流式输出，支持思考模型（`reasoning_content` 推理过程回传）、
  `{text}` 提示词占位符、去重与条数上限、20000 字符截断。

## 四、开发

```bash
pip install -e .[dev]
pytest          # 139 个测试全部离线可跑（FakeClient 替身，不触网）
```

## 五、版权声明

- 本工具以 MIT 协议开源，详见 [LICENSE](LICENSE)
- 仅供学习交流，请勿用于商业用途或高频抓取
- B站 API 文档参考 [bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)
