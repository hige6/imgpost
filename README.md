# imgpost（图邮）

让你的 **DeepSeek Harness（DSH / Cordis）** 能在对话里配图 —— 发本地图、网页图、AI 生图，还能**看图（识图）**。零依赖，一个插件全搞定。

DSH 的 agent 原本只能发文字；装上 imgpost 之后，它就能把图片直接送进聊天里给你看，也能"睁眼"读懂图片里的内容。

## ✨ 它能做什么（三大能力 + 一只眼睛）

| 能力 | 工具名 | 说明 |
|---|---|---|
| 🖼️ 发图 | `send_image` | 把本地文件 / 网页 URL / base64 图片发进对话，作为持久附件展示 |
| 🎨 生图 | `generate_image` | 调用任意 OpenAI 兼容的 `/images/generations` 接口生图并直接发给你 |
| 👁️ **识图（看图/眼睛）** | `imgpost_read_image` | 用外部视觉 API **读懂**图片里的内容 —— 文字 OCR、场景、排版、任意指定问题都能答，结果按图片指纹磁盘缓存，重启不重读 |
| 🔗 透明通道 | vision provider wrap | 自动给不带视觉的文本模型包一层 `imgpost-<上游>` 通道，粘贴的图片会自动转换成描述文本，让任何模型都能"看见" |

图片都存成 durable attachment，并通过同源的 `/dsh-img2/<sha256>` 路由回显。

## 🚀 安装

### 方式一：从 npm 装（发布到 npm 后）

```bash
npm install imgpost
```

### 方式二：从 GitHub 拉（推荐）

```bash
git clone https://github.com/hige6/imgpost.git
```

把 `src/host.js` 所在目录放到 DSH 的插件目录（如 `~/.dsh/plugins/imgpost`），并在配置里加载它（见下方"加载到 DSH"）。

### 加载到 DSH

DSH 通过 Cordis 插件机制加载（本插件是一个宿主端 host 插件）。在你的 DSH 配置（`cordis.patch.yml` / profiles 的补丁文件）里加一行即可，例如：

```yaml
- id: imgpost
  name: '../../plugins/imgpost/src/host.js'
```

启动 DSH 后，agent 会自动获得 `send_image` / `generate_image` / `imgpost_read_image` 三个工具。

> DSH 是什么？[DeepSeek Harness](https://github.com/deepseek-ai/dsh) —— 一个基于 Cordis 的可编程 AI 智能体工作台。imgpost 就是为它写的一个能力插件。

## ⚙️ 配置（全部可选，**默认不绑定任何具体厂商**）

不配也能用 `send_image`（发本地图/网页图）；生图和识图需要凭据，但不限厂商、逢我们只读你显式给的配置。

### 生图：任一
```
环境变量：DSH_IMAGE_API_KEY / DSH_IMAGE_API_BASE / DSH_IMAGE_API_MODEL
或文件：   ~/.dsh/image-sender.json  { "apiKey", "baseURL", "model" }
```

### 识图：任一
```
文件：     ~/.dsh/vision-sender.json
样式：
{
  "primary":  { "baseURL": "...", "apiKey": "...", "model": "...", "format": "openai|anthropic" },
  "fallback": { "baseURL": "...", "apiKey": "...", "model": "...", "format": "openai|anthropic" }
}
环境变量：DSH_VISION_API_KEY / DSH_VISION_API_BASE / DSH_VISION_API_MODEL
```

> `format` 支持 `openai`（OpenAI 兼容 `/chat/completions`）和 `anthropic`（`/messages`）两种风格，兼容大多数视觉服务。

### （可选）对外图片基址
想在 LAN / Tailscale 等让手机或别的设备也看到图片，配置 `publicBaseUrl`（插件加载时传入），否则自动探测 GUI 端口。

## 🧩 技术要点
- **零依赖**：核心逻辑直接用宿主端 Service（`attachments` / `fs` / `subprocess` / `webServer` / `tools` / `llm`），不引入第三方包。
- **磁盘证据缓存**：识图结果按图片 SHA-256 缓存在 `~/.dsh/imgpost-vision-cache/`，同一张图只描述一次，跨重启不重读。
- **跨电脑通用**：没有写死的本机路径 / 盘符 / 端口 / 厂商模型名，克隆即用。

## 📄 License
MIT

---
*imgpost —— 让你的 DSH 会发图、更会看图。*
