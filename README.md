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

### 这一版修掉的宿主契约问题（都经过独立评审复现）

| 问题 | 后果 | 现状 |
|---|---|---|
| 包装适配器没实现 `imageRequestPricing()` | 宿主 token meter 对每条已注册路由都会调用它，字面量不继承基类默认实现 → 走 `imgpost-<上游>` 的请求直接 TypeError | 已实现，委托上游定价 |
| 生图配置靠子进程读 `DSH_IMAGE_*` | 宿主 `scrubbedParentEnv()` 会剥掉所有 `DSH_` 前缀与 `KEY/PASSWORD/SECRET/TOKEN` 形状变量，子进程根本看不到 → 环境变量配置永远失效 | 改为**本进程**读，同时显式转发给子进程 |
| 三行 `Write-Output` 传配置 | `Write-Output $null` 不产生行，中间缺值会让后续字段整体前移（缺 `apiKey` 会被读成"有 key"） | 改为一行 JSON，不再串位 |
| 识图缓存只按图片指纹 | 换一个问题问同一张图仍返回上一个答案 | 缓存键 = 图片 + 问题 + 后端身份 |
| 短答案被当拒绝 | `"42"` 这类有效答案被判成内容拒绝并写负缓存 | 只按"空/明确拒绝话术"判定 |
| 临时文件泄漏 / 取消失效 | 下载或识图中途失败时 `%TEMP%` 残留；响应体读取阶段没有取消与超时保护 | 全部改 `finally` 清理；abort 与 120s 超时覆盖到响应体解析 |

### 第二轮审计（安全向）修掉的

| 问题 | 后果 | 现状 |
|---|---|---|
| `imgpost_read_image` 不校验文件类型 | 随便给一个路径（例如含凭据的 JSON）都会被 base64 发给外部视觉服务 | 只按**魔数**放行 png/jpeg/webp/gif，data URI 声明的 MIME 不作数，另有 20MB 上限；不合格直接报错且不发任何请求 |
| `http://` 的 baseURL | `Authorization: Bearer <key>` 明文出网 | `https://` 一律放行；`http://` 仅限回环（`127.0.0.1` / `::1` / `localhost`），其余拒绝 |
| 上游错误原文回显 | 供应商回显 key 时会一路进到工具结果甚至上游对话 | 所有会带出响应体的错误出口都过 `redactSecrets`（遮蔽已知凭据形状 + 当前真实 key）并截断 300 字符 |
| 缓存不校验后端身份 | 换后端后仍命中旧后端答案；fallback 答的题写在 primary 的键下 | 记录里写入应答后端身份，读取时双向核对；无身份的旧记录一律视为未命中 |
| 配置与缓存经过子进程 | key 经 stdout 回传、缓存正文拼进命令行 | 配置改**本进程** `fs` 直读（已核实 `LocalFileSystem` 不是 containment boundary），缓存写盘优先 `fs.writeText` |
| 缓存/配置文件无大小上限 | `fs.readText` 会整文件读进内存 | 先 `stat` 检查（配置 256KB、缓存 1MB），超限当未命中 |

- `~/.dsh` 根目录遵循宿主 `dsh-home-paths` 的优先级：插件配置 `dshHome` > `$DSH_HOME` > `~/.dsh`，支持 `~` 展开。

## 🚀 安装

### 方式一：一键脚本（推荐，Windows / PowerShell）

仓库里带了一个一键安装脚本 `scripts/install.ps1`。执行顺序是**先只读后写入**：

1. 只读探测插件来源、定位 profile（DSH 根目录按 `-DshHome` > `$DSH_HOME` > `~/.dsh` 解析，与插件运行时一致）、解析 JSON，先打印一份「将要改什么」的计划
2. 交互确认（`-Yes` 可跳过）
3. 备份 profile 的 `package.json`、要改的 `cordis.patch.yml`（如果走 legacy）与插件目录（就近存成 `<名字>.bak-<时间戳>`）
4. **事务式重建插件目录**（先清空再按源复制，含 `.gitignore` 这类隐藏文件），然后是写 `link:` 依赖与 `dsh.profile.bundles` 名单，或写 legacy 的 `cordis.patch.yml`
5. 写完全部重新解析校验，插件目录还要做**双向逐文件比对**（目标多出来的旧文件也算失败）；legacy 模式另外确认 patch 里注册的入口真实存在
6. 任一步失败按相反顺序回滚：还原备份，本次新建的文件/目录直接删除；最后跑 `pnpm install` 并检查它的退出码

退出码：`0` 成功 ｜ `1` 失败已回滚 ｜ `2` 配置已写但 `pnpm install` 未完成（脚本会给出可复制的补救命令）｜ `3` 用户取消。
选 No、备份或写入阶段失败时，插件目录与 profile 都保持原样（回归矩阵 27 个用例 / 111 项检查覆盖）。
注意 `exit 2` 是**有意保留现场**的：配置已经写好了，只差一次 `pnpm install`，不会回滚。

```powershell
# 方式 A：本地 clone 后安装（自动探测 profile）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 方式 B：指定 profile
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop

# 方式 C：直接通过 npm 安装到 ~/.dsh/plugins 并配置
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -FromNpm

# 方式 D：DSH 根目录不在默认位置
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DshHome 'D:\dsh-home'

# 老版本 DSH（没有 dsh.profile 块）：脚本会自动改用 legacy 的 cordis.patch.yml 方式，插件照样会被复制到位
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

### （可选）改 DSH 根目录

插件默认跟随宿主的 DSH 根目录优先级：插件配置 `dshHome` > 环境变量 `$DSH_HOME` > `~/.dsh`（支持 `~` 展开）。配置文件、识图缓存、附件对象都从同一个根推导：

```yaml
- id: imgpost
  config:
    dshHome: 'D:/dsh-home'
```

## 🧩 技术要点

- **零依赖**：核心逻辑直接用宿主端 Service（`attachments` / `fs` / `subprocess` / `webServer` / `tools` / `llm`），不引入第三方包。
- **磁盘证据缓存**：识图结果按「图片 SHA-256 + 问题 + 后端身份」缓存在 `<dsh home>/imgpost-vision-cache/`。同一张图同一个问题只描述一次、跨重启不重读；换问题会重新问一次。内容策略拒绝按负缓存存 1 小时，过期自动重试。
- **跨电脑通用**：没有写死的本机路径 / 盘符 / 端口 / 厂商模型名，克隆即用。
- **URL 稳定**：图片以内容寻址（sha256）落盘，同一张图重复发送得到同一个 URL。

## ⚠️ 已知限制（如实列出，不是免责声明）

- **`/dsh-img2` 是 capability URL，没有额外的鉴权**。URL 里的 64 位 sha256 就是凭证：宿主没有给插件可用的会话鉴权接口，所以**谁能拿到这个 URL，谁就能取到这张图**。插件能做到的是不让中间缓存/代理留存（响应头是 `Cache-Control: private` + `X-Content-Type-Options: nosniff`）。要缩小可达范围请在网络层做：只监听回环、用 Tailscale ACL 限制 tailnet 成员、别把 GUI 端口直接暴露到公网。
- **包装通道的配置代际**：`imgpost-<上游>` 适配器的 `prepareCall` 绑定的是「模型元数据 + 一个 stream 函数」，而真正派发时会按 provider id 重新解析上游适配器。真实语义是：**token 预算按 prepare 时的元数据算，请求按 dispatch 时的适配器发**。上游 provider 在两者之间被热替换（同 id 换配置）时会出现元数据与实测不一致。插件会在派发时比对两侧元数据、发现不一致就写一条 `logger.warn`，但不改变行为：改成冻结上游需要绕过宿主 `llm.stream` 的 waterfall 与图片投影，代价更大。
- **生图的 API key 仍会进 PowerShell 子进程的环境**（不在命令行里）。子进程只用于发 `/images/generations` 请求；同一用户下的其它进程理论上可以读到该环境块。若在意这一点，把生成请求改成本进程 `fetch`（与识图路径一致）是下一步的清理方向，代价是 `fetch` 默认不读系统代理。
- **识图缓存以明文 JSON 落盘**在 `<dsh home>/imgpost-vision-cache/`，内容是模型对图片的文字描述。它是本机用户数据，没有做额外加密或保留期策略。
- **附件读取走路径拼接**：`/dsh-img2/<sha256>` 与识图读附件是按 `<dsh home>/attachments/v1/objects/<2位>/<sha256>` 拼路径读字节的，没有走宿主的 `attachments.imageHostPath()`。若宿主的附件后端不是本地文件系统那一种，这条路由会 404。单机本地存储场景不受影响。

## 📄 License

MIT

---

*imgpost —— 让你的 DSH 会发图、更会看图。*
