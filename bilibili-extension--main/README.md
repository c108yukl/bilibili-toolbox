# B站数据爬取工具 - 浏览器扩展（主包）

一键获取 B站 视频的**弹幕、评论、字幕、UP主信息、弹幕热词、AI 字幕总结**。Manifest V3、纯 JavaScript、零依赖（ES Module 架构）。

## 安装（Edge / Chrome）

1. 打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`）→ 开启"开发人员模式"
2. 点"加载解压缩的扩展"→ 选择本项目 `bilibili-extension--main/` 目录
3. 在 B站 视频页点击扩展图标即可使用

## 功能

- **弹幕 / 评论（翻页+楼中楼）/ 字幕** 抓取，多格式导出（TXT/JSON/CSV/SRT/ASS/LRC）。弹幕有登录 Cookie 时优先走 B站分段接口 `seg.so`（protobuf 全量），并与 `list.so` 对比取更多的一份——部分高密度视频（如弹幕集中在前几秒的短片）`list.so` 只返回少量抽样，`seg.so` 可拿到数倍弹幕
- **☁️ 弹幕热词**：抓完弹幕自动统计高频词并渲染词云（本地计算，可复制/导出 JSON）
- **🤖 AI 字幕总结**：接入 DeepSeek（或任意 OpenAI 兼容接口）。**流式输出**逐字显示；设置页填写 API Key 后自动获取模型列表、支持查询余额；默认**仅文本省 Token**（可开关时间戳、可限条数）；输出 **MD 总结 + 结构化 JSON**（含标题/UP主/时间）
- **👤 UP 主信息**：UP 主名/粉丝数/投稿数/等级/签名，界面展示 + 导出 JSON
- **📚 批量抓取**：粘贴多个 BV 号/链接，逐个抓取并显示进度
- **🟡 悬浮球**：B站视频页右下角可拖动的悬浮球（位置记忆），点开即抓 弹幕+字幕 / 评论 / AI 全分析，完成有桌面通知，点通知直接打开下载目录
- **🧠 AI 弹幕分析**：弹幕去重后交给 AI 分析情绪倾向/热议话题/名场面/有趣精选（流式输出 + MD/JSON 保存，条数上限可调）
- **💬 AI 评论总结 + 情感分析**：评论去重（含楼中楼）后交给 AI 分析整体评价、情感倾向（正面/负面/中性占比）、高频话题与典型观点（流式输出 + MD/JSON 保存，条数上限可调）
- **⚡ AI 并发分析**：弹幕分析 / 字幕总结 / 评论分析 三条 AI 任务并发执行，互不阻塞，整体速度提升 3 倍；弹幕与字幕的 AI 在**评论爬取期间就已开始分析**，无需等待评论
- **⏱️ 分析时间窗口**：弹幕分析与字幕总结可自定义**起止时间段**（如 2:30 ~ 10:00，mm:ss 或秒），只分析视频某一段，聚焦重点区域
- **🪄 悬浮球入场动效**：进入视频页（含站内推荐视频跳转）后悬浮球弹跳+光晕动效，气泡**一次性**展示视频信息——标题、BV、弹幕数、字幕有无 + "此视频可以分析了！"；自定义文本按行追加（可开关）
- **🧠 AI 思考过程**：兼容 deepseek-reasoner 等思考模型，reasoning_content 推理过程与正文一起流式输出，弹窗折叠面板可展开查看；设置页可一键关闭思考输出
- **🎚️ 评论抓取可控**：弹窗可设置“评论≤N 条”（滑动窗口，达到目标立即停止并保留最热评论在前，0=不限）与翻页间隔（默认 400ms），避免风控、按需取数
- **🎨 主题色**：极光/海洋/森林/糖果/落日 五套配色，弹窗、设置页、悬浮球全局同步
- **🎛️ 界面自定义**：设置页可独立开关主界面的各分区（批量模式 / 可选功能行 / 高级参数行 / Cookie 区 / 悬浮球），打造极简界面
- **🔊 提示音效**：按钮、开关、任务完成/失败均有合成音效（可关、可试听）；一键全选、BV 记忆与复制
- **💾 设置备份**：一键导出/导入全部设置（JSON）
- 自动识别当前页面 BV 号、自动读取浏览器 Cookie（设置页开启，弹窗内可手动读取）
- 字幕语言选择（所选语言优先匹配，无则回退中文）
- **后台运行**：关闭弹窗任务不中断，下载自动存入浏览器下载目录
- **右键菜单**：B站视频页右键直接抓取（弹幕+字幕 / 评论），完成或失败有桌面通知
- 请求 15 秒超时 + 随时取消（AbortController）
- 设置页可配置默认勾选、默认格式、AI 参数、TXT 时间格式等

## 文件结构

```
background.js  核心引擎（调API、WBI签名、分页、批量、AI、生成文件、MCP 桥接、UI 风格切换）[ES Module SW]
content.js     悬浮球（拖拽、快捷菜单、Toast 反馈）[classic script]
popup-preview.html/js 弹窗界面·默认「Aurora Console」（App-Shell 常驻操作栏、阶段时间线 HUD、AI LIVE 徽章+计时、批量实时解析、文件徽章列表）[ES Module]
popup-editorial.html  弹窗界面·「Editorial」编辑杂志风皮肤（衬线标题、细线排版、单色印刷块）——复用 popup-preview.js
popup-neumorphism.html 弹窗界面·「Neumorphism」新拟物皮肤（双光源阴影、凸起/凹陷交互、柔和圆角）——复用 popup-preview.js
options.html/js 设置页（默认项 + AI 配置 + 主题 + 界面风格 + 服务 + 备份）[ES Module]
utils.js       共享工具库（MD5、WBI、格式转换、热词分词、AI 调用、主题、默认设置）[ES Module]
styles/shared.css      共享样式层（设置页组件）
styles/preview.css     Aurora Console 样式（玻璃拟态 2.0：主题感知 color-mix 派生色、极光纱幕、鼠标聚光灯）
styles/editorial.css   Editorial 样式（编辑杂志风：衬线、细线、单色）
styles/neumorphism.css Neumorphism 样式（Soft UI：双光源阴影系统）
icons/         扩展图标
```

> **架构（v1.2.0）**：background / popup / options 统一为 ES Module，共享能力集中在 `utils.js`
> 通过显式 `import` 引用（manifest 声明 `"type": "module"`），消除全局变量隐式依赖；
> content.js 因内容脚本限制保持 classic script 自包含。
>
> **三种界面风格（设置页「外观 → 界面风格」切换，保存后下次打开弹窗生效）**：
> 三套皮肤共用同一套元素 ID 与 `popup-preview.js` 逻辑（批量、进度 HUD、AI 并发 LIVE 徽章、
> 文件下载全部一致），仅样式层不同——
> **Aurora Console**（默认，`preview.css`，深空玻璃拟态：App-Shell 常驻操作栏、
> 阶段时间线 HUD、极光纱幕、鼠标聚光灯、完成彩带）；
> **Editorial**（`editorial.css`，编辑杂志风：米白底+柔和黑单色、衬线标题与斜体章节号、
> 细线分隔、选中任务反白印刷块、完成阶段删除线——参考 stylekit.top/zh/styles/editorial）；
> **Neumorphism**（`neumorphism.css`，新拟物派：浅灰同色系表面、双光源阴影
> （左上高光/右下暗影）、hover 缩影遮光、active 转内凹、12–24px 柔和圆角——
> 参考 stylekit.top/zh/styles/neumorphism）。
>
> **评论进度计算**：全链路阶段进度模型（视频3% → 弹幕8-26% → 字幕28-38% →
> 评论40-92% → AI 93-99%），评论阶段按 known_total/页数实时估算，进度条实时推进；
> 滑动窗口/总数/安全上限停止条件修正。
>
> **🔌 MCP 服务**：设置页「服务」标签，自定义端口开启 MCP 本地桥接
> （`python mcp_server.py --port <端口>`），AI 客户端（Claude/Cursor/DSH 等）配置
> `http://127.0.0.1:<端口>/mcp` 即可调用 6 个工具（视频信息/弹幕/评论/字幕/热词/登录态），
> **自动携带浏览器 Cookie**，无需手动提供。

## 技术要点

- **WBI 签名**：64 元素查找表混排算法，并做服务器时间校准（wts）
- **API 降级**：字幕 Player API → 视频信息 → 重拉；评论 cursor → WBI → page 版
- **大文件下载**：blob URL 方式，规避 data URL 大小限制
- **AI 总结**：OpenAI 兼容 chat/completions 接口，`{text}` 提示词占位符；Key 默认仅存 `chrome.storage.session`（本浏览器会话内，不落盘不同步，重启后需重新输入）；可在设置页勾选"永久保存"（需阅读隐私声明并等待 3 秒确认），Key 将明文存于 `chrome.storage.local`（仅本机、不同步云端），可随时关闭并删除
- **AI 并发安全**：三个 AI 任务并发时正文/思考状态按调用私有（每个任务独立累加），杜绝"字幕总结却显示弹幕内容"的串扰；回复长度由 `aiMaxTokens`（默认 4000）控制，可在设置页调大防截断
- **权限收敛**：默认仅申请 bilibili.com 与 hdslb.com（字幕 CDN）宿主权限；使用自定义 AI 服务地址时按需弹窗授权，不再申请全部网站
- **热词**：中文二元组 + 拉丁词抽取，停用词过滤，纯本地无依赖

> Python 版（SDK/CLI/Web）见仓库根目录 README.md。
