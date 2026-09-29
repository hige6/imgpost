# imgpost（图邮）

让你的 **DeepSeek Harness（DSH / Cordis）** 能在对话里配图 —— 发本地图、网页图、AI 生图，还能**看图（识图）**。零第三方依赖，一个插件全搞定。

DSH 的 agent 原本只能发文字；装上 imgpost 之后，它就能把图片直接送进聊天里给你看，也能"睁眼"读懂图片里的内容。

## ✨ 它能做什么（四个工具 + 一只眼睛）

| 能力 | 工具名 | 说明 |
|---|---|---|
| 🖼️ 发图 | `send_image` | 把本地文件 / 网页 URL / base64 图片发进对话，作为持久附件展示 |
| 🎨 生图 | `generate_image` | 调用任意 OpenAI 兼容的 `/images/generations` 接口生图并直接发给你 |
| 👁️ 识图（看图/眼睛） | `imgpost_read_image` | 用外部视觉 API **读懂**图片 —— 文字 OCR、场景、排版、任意指定问题都能答，结果按图片指纹磁盘缓存，重启不重读 |
| 🩺 生图体检 | `imgpost_check_backend` | 报告生图端点的 baseURL / 模型 / key 是否齐备，缺哪一项说得清清楚楚（不发任何请求） |
| 🔗 透明通道 | vision provider wrap | 自动给不带视觉的文本模型包一层 `imgpost-<上游>` 通道，粘贴的图片会自动转换成描述文本，让任何模型都能"看见" |

图片都存成 durable attachment，并通过同源的 `/dsh-img2/<sha256>` 路由回显。

## ✅ 兼容性（实测）

- 已在 **DSH 0.2.0-rc.2**（桌面版，内含 cordis 4.0.4）实测通过：四个工具全部注册、发图落盘成功、`/dsh-img2` 路由在回环地址与 Tailscale HTTPS 域名下均返回 200、profile 里的 `publicBaseUrl` 覆盖生效。
- 只使用宿主 Service（`attachments` / `fs` / `subprocess` / `webServer` / `tools` / `llm`），不引入任何第三方包，不受依赖树变化影响。
- peer 只声明范围 `@deepseek-ai/cordis: ^4.0.1`（**不是**精确版本），因此不会被新版 DSH 判成不兼容而拒载。
- 没有写死的本机路径 / 盘符 / 端口 / 厂商模型名 —— 换台电脑克隆即用。

## 🚀 安装

### 方式一：一键脚本（推荐，Windows / PowerShell）

仓库里带了一个一键安装脚本 `scripts/install.ps1`：把插件放进 `~/.dsh/plugins/imgpost` → **备份** profile 的 `package.json` → 写入 `link:` 依赖与 `dsh.profile.bundles` 名单 → 校验 JSON，失败自动回滚 → 提示重启 DSH。

```powershell
# 方式 A：本地 clone 后安装（自动探测 profile）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 方式 B：指定 profile
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop

# 方式 C：直接通过 npm 安装到 ~/.dsh/plugins 并配置
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -FromNpm
```

### 方式二：手动 bundle 安装（DSH 0.2.x，推荐做法）

1. 把本仓库放到 `~/.dsh/plugins/imgpost`
2. 在 profile 的 `package.json`（如 `~/.dsh/profiles/desktop/package.json`）加依赖：

   ```json
   "dependencies": { "imgpost": "link:C:/Users/<you>/.dsh/plugins/imgpost" }
   ```

3. 在同一个文件的 `dsh.profile.bundles` 数组里加一行 `"imgpost"`
4. 在 profile 目录执行 `pnpm install`，然后重启 DSH

### 方式三：老版本 DSH（insert 注册）

在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: imgpost
      name: '../../plugins/imgpost/src/host.js'
```

> 两种注册方式的 `name` 含义不同：**bundle 方式必须写包名**（`imgpost`），**insert 方式必须写入口文件**（`src/host.js`，不能写目录）。bundle 方式的好处是它会出现在 DSH GUI 的「内置插件」面板里，可以随时开关。

## ⚙️ 配置（全部可选，**默认不绑定任何具体厂商**）

不配也能用 `send_image`（发本地图/网页图）；生图和识图需要凭据，但不限厂商，插件只读你显式给的配置。

### 生图：任一

```
环境变量：DSH_IMAGE_API_KEY / DSH_IMAGE_API_BASE / DSH_IMAGE_API_MODEL
或文件：   ~/.dsh/image-sender.json  { "apiKey", "baseURL", "model" }
```

```json
{
  "apiKey": "sk-xxxx",
  "baseURL": "https://api.siliconflow.cn/v1",
  "model": "black-forest-labs/FLUX.1-schnell"
}
```

端点要求：`POST {baseURL}/images/generations`，返回 `data[].url` 或 `data[].b64_json` 即可。常见的 OpenAI 兼容服务商（下列只是例子，不是默认值）：

| 服务商 | baseURL | 模型示例 |
|---|---|---|
| Agnes AI | `https://api.agnes-ai.cn/v1` | `agnes-image-2.1-flash` |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `cogview-4` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `wanx-v1` |
| OpenAI | `https://api.openai.com/v1` | `gpt-image-1` |

没有配置时不会静默去请求某家默认端点，而是报错告诉你缺 `apiKey` / `baseURL` / `model` 中的哪一项（也可以先用 `imgpost_check_backend` 查）。

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

> `format` 支持 `openai`（OpenAI 兼容 `/chat/completions`）和 `anthropic`（`/messages`）两种风格，兼容大多数视觉服务。`model` **必须显式写**，插件不预设任何厂商模型名。

### （可选）对外图片基址

想在 LAN / Tailscale 等让手机或别的设备也看到图片，配置 `publicBaseUrl`（加载时传入），否则自动探测 GUI 端口：

```yaml
- id: imgpost
  config:
    publicBaseUrl: 'https://your-tailnet-domain'
```

### （可选）不想被包装的上游

`~/.dsh/vision-sender.json` 里的 `upstreams` 列出要包装的 provider id；`noWrap` 列出**不要**包装的：

```json
{ "upstreams": ["provider-a"], "noWrap": ["provider-b"] }
```

## 🧩 技术要点

- **零依赖**：核心逻辑直接用宿主端 Service（`attachments` / `fs` / `subprocess` / `webServer` / `tools` / `llm`），不引入第三方包。
- **磁盘证据缓存**：识图结果按图片 SHA-256 缓存在 `~/.dsh/imgpost-vision-cache/`，同一张图只描述一次，跨重启不重读。
- **跨电脑通用**：没有写死的本机路径 / 盘符 / 端口 / 厂商模型名，克隆即用。
- **URL 稳定**：图片以内容寻址（sha256）落盘，同一张图重复发送得到同一个 URL。

## 📄 License

MIT

---

*imgpost —— 让你的 DSH 会发图、更会看图。*
