本项目采用极简的 Python 依赖管理策略，仅通过根目录 `requirements.txt` 声明第三方包，未使用 pipenv、poetry、pyproject.toml 等现代工具，也未生成 lockfile。浏览器扩展部分则完全内联实现，不依赖 npm/webpack 等前端构建系统。

**Python 端依赖**
- 声明文件：`requirements.txt`，仅包含三个顶层依赖：
  - `bilibili-api-python>=0.17.0`：B站公开 API 的异步 Python SDK，是本项目核心外部依赖；`bilibili/auth.py` 通过 `from bilibili_api import Credential` 使用其认证能力。
  - `aiohttp>=3.8.0`：底层 HTTP 客户端，被 `bilibili-api-python` 间接依赖，demo 脚本注释中也显式提示安装。
  - `streamlit>=1.20.0`：Web 演示界面框架，由 `app.py` 直接 `import streamlit as st` 使用。
- 版本约束全部为 `>=X.Y.Z` 宽松下限，无上限锁定，也不存在 `requirements.in` / `pip-tools` / `Pipfile.lock` 等锁定机制，意味着每次 `pip install` 都会拉取满足条件的最新大版本，可复现性较弱。
- 项目结构为扁平单仓库，不存在子包 `setup.py` / `pyproject.toml`，因此没有发布到 PyPI 的打包配置。

**浏览器扩展端依赖**
- 位于 `bilibili-extension--main/`，基于 Manifest V3，所有逻辑以原生 JS 编写，`manifest.json` 中未引用任何外部库或 CDN。
- 唯一与外部生态相关的点是 `utils.js` 中的注释提到 "WBI 64-element shuffle table (from bilibili-api-python)"，表明扩展端的 WBI 签名表是从 Python SDK 复制而来，属于代码复用而非运行时依赖。
- 扩展以 `.crx` 和私钥 `.pem` 随仓库分发，无需 Chrome Web Store 或私有仓库。

**约定与风险**
- 开发者只需执行 `pip install -r requirements.txt` 即可安装全部运行期依赖，CLI (`cli.py`)、Streamlit (`app.py`)、Demo (`bilibili_demo.py`) 共享同一份依赖集。
- 缺少 lockfile 导致环境不可复现，升级时可能引入破坏性变更（尤其是 `bilibili-api-python` 作为逆向 B 站 API 的 SDK，上游变动频繁）。
- 未使用虚拟环境隔离，建议在本地开发时配合 `venv` / `conda` 使用。