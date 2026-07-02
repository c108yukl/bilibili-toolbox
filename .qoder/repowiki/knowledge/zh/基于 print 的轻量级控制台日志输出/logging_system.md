本仓库未引入任何专用日志框架（如 logging、loguru、structlog），所有运行期信息输出均通过 Python 内置 `print()` 直接写入标准输出，属于最轻量的“控制台打印式”日志方案。具体表现如下：

1. **使用方式**
   - 业务模块（`bilibili/comments.py`、`bilibili/danmaku.py`、`bilibili/auth.py`）在关键路径上直接调用 `print(...)`，例如 `[评论] 缓存命中`、`[弹幕] 共 N 条`、`[登录] 已加载Cookie凭证`。
   - CLI 入口 `cli.py` 仅做参数解析与调度，自身不产生业务日志；Streamlit 前端 `app.py` 通过自定义 `CaptureIO` + `redirect_stdout` 把底层 `print` 重定向到 Streamlit 的 `st.code` 区域展示。

2. **日志级别与结构化字段**
   - 无级别划分，全部为同一级别的文本行；通过前缀标签（如 `[评论]`、`[弹幕]`、`[视频]`、`[登录]`、`[!]`）区分来源。
   - 未采用结构化格式（JSON/键值对），字段以 f-string 拼接，可读性尚可但不可被机器解析。

3. **输出目标**
   - 默认 stdout；CLI 场景下经 `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")` 保证中文输出。
   - Streamlit 场景下通过 `redirect_stdout` 捕获后渲染到网页，错误信息则走 `st.error` / `status_text.error` 等 UI 组件。

4. **缺失能力**
   - 无日志轮转、无文件落盘、无异步安全（`print` 非协程安全）、无集中配置开关、无性能开销控制。

**开发者约定**：若需新增运行时信息，应沿用现有 `print(f"[{模块}] ...")` 风格，保持前缀标签一致，避免混入 `st.*` 或第三方 logger 调用，以免破坏 Streamlit 的重定向捕获逻辑。