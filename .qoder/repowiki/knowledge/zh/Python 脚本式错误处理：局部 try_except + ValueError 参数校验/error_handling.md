本仓库未建立统一的错误处理框架或自定义异常体系，错误处理以脚本式的局部 try/except 与标准库异常为主，贯穿 CLI、Streamlit Web 和浏览器扩展三个运行形态。

1. 使用的系统与模式
- 参数校验：通过 ValueError 表达输入不合法（如 BV 号无法解析），由调用方捕获并转为 UI 提示。
- 网络/IO 容错：对可能失败的子请求使用 try/except Exception as e 包裹，打印 [!] ... 日志后返回空结果，保证主流程继续执行。
- 顶层兜底：在 Streamlit 入口用 try/except Exception 捕获异步任务异常，显示错误信息后重新抛出，交由 Streamlit 自身处理。
- 无全局中间件、无 panic/recover、无结构化错误码；错误传播依赖 Python 异常冒泡。

2. 关键位置
- 参数解析与校验
  - bilibili/utils.py::extract_bvid / bilibili_demo.py::extract_bvid：BV 号解析失败时 raise ValueError(...)
  - app.py：两处 try: extract_bvid(...) except ValueError，将错误通过 st.error() 展示给用户
- 网络请求容错
  - bilibili_demo.py::_fetch_replies：抓取楼中楼回复时 try/except Exception，失败则打印警告并返回空列表，避免中断全量爬取
- 顶层异常兜底
  - app.py：asyncio.run(run()) 外层 try/except Exception，捕获后 status_text.error(...) 再 raise，让 Streamlit 渲染错误页

3. 架构与约定
- 分层职责清晰：CLI/Web 层只做用户交互与参数转发，核心抓取逻辑位于 bilibili_demo.py 等模块；错误在边界处被捕获并转为用户可读消息
- 健壮性优先于精确分类：对第三方 API 调用采用宽 catch + 降级返回空数据的策略，确保批量任务不因单条失败而中止
- 无统一错误类型：所有业务错误均以内置异常或字符串形式传递，没有集中定义的错误枚举或响应体结构

4. 开发者应遵循的规则
- 输入校验一律抛 ValueError，并在 CLI/Web 入口处捕获并提示，不要吞掉异常
- 对外部不可控调用（评论回复、字幕接口）使用 try/except Exception 包裹，记录简要日志后返回安全默认值（空列表/None）
- 不要在工具函数内部直接 print 错误信息后再向上抛出，保持纯函数只抛异常、UI 层负责展示的分层原则
- 如需新增可区分错误场景，建议引入自定义异常类（如 BilibiliAPIError、ParseError），并在上层按类型分别处理，逐步替代当前一 Exception 到底的做法