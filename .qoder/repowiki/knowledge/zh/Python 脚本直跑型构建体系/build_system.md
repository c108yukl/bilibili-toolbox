本仓库采用极简的「纯脚本 + requirements.txt」运行方式，不存在 Makefile、Dockerfile、setup.py/pyproject.toml、CI 流水线或打包发布流程。所有三种运行形态（Python SDK、CLI、Streamlit Web、浏览器扩展）均以源码形式直接分发，依赖通过 `pip install -r requirements.txt` 安装。

- **依赖声明**：仅根目录 `requirements.txt` 列出运行时依赖（bilibili-api-python、aiohttp、streamlit），无版本锁定，无子包/多环境区分。
- **入口点**：`cli.py` 作为命令行入口（argparse 解析参数），`app.py` 作为 Streamlit Web 入口（`streamlit run app.py`），`bilibili_demo.py` 为单文件演示脚本；三者均直接 import `bilibli/` 包调用核心抓取函数。
- **浏览器扩展**：`bilibili-extension--main/` 下为 Manifest V3 扩展源码，附带已打包的 `.crx` 与私钥 `.pem`，但无构建脚本，需手动在 Chrome 中「加载已解压的扩展程序」。
- **缓存与产物**：`.bili_cache/` 存放 bilibili-api 的本地缓存 JSON；`bak/` 为人工备份目录，非构建产物。
- **缺失环节**：无单元测试、无 lint/format 配置、无 CI/CD、无 PyPI 发布、无 Docker 镜像、无跨平台编译步骤，也不存在版本化 release 流程。

开发者约定：新增功能后直接在对应入口（`cli.py` / `app.py` / 扩展 JS）修改并本地运行，无需执行任何构建命令。