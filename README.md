# 图邮 imgpost

> **让你的 DSH 能发图给你** —— 本地图片、网页图片、AI 生图，一键发进对话里。

**imgpost** 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) / Cordis 插件，提供两个模型工具：

| 工具 | 作用 |
|---|---|
| `send_image` | 把 **http(s) URL / base64 data URI / 本地文件路径** 的图片送入对话，持久化到附件库并内联渲染 |
| `generate_image` | 调用 **任意 OpenAI 兼容的 `/images/generations` 生图接口**，生成图片后直接发进对话 |

## 为什么需要它

- Markdown 只支持渲染 **http(s) 绝对 URL** 的图片——本地文件路径（`E:\...\a.jpg`）浏览器出于安全限制无法直接显示。
- imgpost 把图片字节**落盘到 DSH 附件库**（`~/.dsh/attachments/`），再通过同源的 `/dsh-img2/<sha256>` HTTP 路由供浏览器拉取，URL 永久有效。
- 生图 API 的返回（`data[].url` 或 `data[].b64_json`）也会被自动下载、落盘、转成稳定 URL。

## 安装

把插件目录挂到 DSH 的 profile 组合层。以 web profile 为例：

```bash
# 1. 把本仓库克隆/复制到 ~/.dsh/plugins/imgpost
# 2. 在 profile 的 package.json 里加入依赖
cd ~/.dsh/profiles/web
# package.json dependencies: { "imgpost": "link:../../plugins/imgpost" }
pnpm install --ignore-scripts

# 3. 在 cordis.patch.yml 的 - insert: 列表里加入插件行
# - id: imgpost
#   name: '../../plugins/imgpost/src/host.js'
```

重启 DSH 后，`send_image` 和 `generate_image` 会出现在模型工具清单里。

> 注意：`name` 必须指向插件的**入口文件**（`src/host.js`），不能是目录——DSH 的 loader 不支持 ESM 目录导入。

## 生图配置

二选一：

**方式一：配置文件 `~/.dsh/image-sender.json`**（推荐）

```json
{
  "apiKey": "sk-xxxx",
  "baseURL": "https://api.siliconflow.cn/v1",
  "model": "black-forest-labs/FLUX.1-schnell"
}
```

**方式二：环境变量**

```
DSH_IMAGE_API_KEY=sk-xxx
DSH_IMAGE_API_BASE=https://api.xxx.com/v1
DSH_IMAGE_API_MODEL=model-name
```

优先级：环境变量 > 配置文件。生图时也可用 `model` 参数临时覆盖。

### 兼容的服务商

只要端点形如 `POST {baseURL}/images/generations` 且返回 `data[].url` 或 `data[].b64_json` 即可：

| 服务商 | baseURL | 模型示例 |
|---|---|---|
| Agnes AI | `https://api.agnes-ai.cn/v1` | `agnes-image-2.1-flash` |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `cogview-4` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `wanx-v1` |
| OpenAI | `https://api.openai.com/v1` | `gpt-image-1` |

## 使用方法

调用工具成功后，**模型必须在回复里插入 markdown 图片语法**（工具描述和返回结果里都有明确提示）：

```markdown
![描述](http://127.0.0.1:<port>/dsh-img2/<sha256-hex>)
```

DSH GUI 的 MarkdownText 组件会把它渲染成内嵌图。

## 工作原理

```
本地文件 / URL / 生图 API
        ↓ send_image / generate_image
        ↓ 读取字节 → attachments.saveImage()
        ↓ ~/.dsh/attachments/v1/objects/<2-hex>/<64-hex>  (sharp 校验并落盘)
        ↓ 返回 ImageAttachmentRef
        ↓ /dsh-img2/<sha256> 路由 (webServer.register) 提供 HTTP 服务
        ↓ 浏览器同源加载 → markdown 内嵌渲染
```

端口是**动态探测**的（`webServer.port`，即路由所在 HTTP 服务的真实监听端口），DSH 重启换端口也不会断图。

## 许可证

[MIT](./LICENSE)

## 致谢

- 生图链路支持 Agnes AI、智谱、SiliconFlow 等 OpenAI 兼容服务
- 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件体系开发
