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
| 🛠️ 设置页 | 设置 →「图邮（识图）」 | 在 DSH 设置里直接管理识图后端（主/备）、上游包装名单，保存即生效，不用改文件也不用重启 |

图片都存成 durable attachment，并通过同源的 `/dsh-img2/<sha256>` 路由回显。

## 🛠️ 设置页

装好并重启 DSH 后，**设置 → 图邮（识图）** 里可以直接管理：

- **主视觉后端**：预设下拉（默认预选 DeepSeek 官方视觉 `deepseek-v4-flash-vision-exp`）、`baseURL`、模型、接口风格（openai / anthropic）、apiKey
- **备用后端**：勾选启用，主后端失败时自动回退
- **上游包装**：`upstreams`（要包装的 provider id）与 `noWrap`（不要包装的）
- **保存 / 重新载入**：保存后立刻清缓存并重扫包装通道，**改完即生效，不需要重启 DSH**；旧配置自动备份成 `vision-sender.json.bak-<时间戳>`

几条设计上的事实，写清楚免得踩坑：

- **apiKey 永不回传浏览器**：接口只回 `hasKey: true/false`；表单里的 apiKey 留空 = 保留已存的那个，只有填了新值才会覆盖。
- **默认预选 DeepSeek 官方模型**：DSH 官方模型对每个 DSH 用户都存在，所以拿它当表单的默认预选是合理的。这**不是**运行时兜底 —— 运行时如果没配，`imgpost_read_image` 依然会明确报错，不会偷偷打到别家端点。
- **接口自带门禁**：插件注册的路由在宿主 token 鉴权之外，所以这个能改配置的接口自己做了三层校验 —— 仅回环来源、必须带 `x-imgpost-config: 1` 自定义头、`Origin` 必须与请求 Host 或 `publicBaseUrl` 域名同源。反向代理/内网穿透通常在本机终结连接后从 127.0.0.1 转发（Host 头保留对外域名），所以**经代理从别的设备打开设置页照样能用**；直连局域网 IP 会被拒。
- 也可以完全不用设置页，直接编辑 `~/.dsh/vision-sender.json`，两者是同一个文件。

## ✅ 兼容性（实测）

- 已在 **DSH 0.2.0-rc.2**（桌面版，内含 cordis 4.0.4）实测通过：四个工具全部注册、发图落盘成功、`/dsh-img2` 路由在回环地址下返回 200（配置 `publicBaseUrl` 时，Host 命中该域名的请求同样 200，已用探针覆盖）、profile 里的 `publicBaseUrl` 覆盖生效。
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
| 临时文件泄漏 / 取消失效 | 下载或识图中途失败时 `%TEMP%` 残留；响应体读取阶段没有取消与超时保护 | 暂存脚本内部 `catch` 清理 + 外层 `finally` 兜底；abort 与 120s 超时覆盖到响应体解析 |

### 第二轮审计（安全向）修掉的

| 问题 | 后果 | 现状 |
|---|---|---|
| `imgpost_read_image` 不校验文件类型 | 随便给一个路径（例如含凭据的 JSON）都会被 base64 发给外部视觉服务 | 只按**魔数**放行 png/jpeg/webp/gif，data URI 声明的 MIME 不作数，另有 20MB 上限；不合格直接报错且不发任何请求 |
| `http://` 的 baseURL | `Authorization: Bearer <key>` 明文出网 | `https://` 一律放行；`http://` 仅限回环（`127.0.0.1` / `::1` / `localhost`），其余拒绝 |
| 上游错误原文回显 | 供应商回显 key 时会一路进到工具结果甚至上游对话 | 所有会带出响应体的错误出口都过 `redactSecrets`（遮蔽已知凭据形状 + 当前真实 key）并截断 300 字符 |
| 缓存不校验后端身份 | 换后端后仍命中旧后端答案；fallback 答的题写在 primary 的键下 | 记录里写入应答后端身份，读取时双向核对；无身份的旧记录一律视为未命中 |
| 配置与缓存经过子进程 | key 经 stdout 回传、缓存正文拼进命令行 | 配置改**本进程** `fs` 直读（已核实 `LocalFileSystem` 不是 containment boundary），缓存写盘优先 `fs.writeText` |
| 缓存/配置文件无大小上限 | `fs.readText` 会整文件读进内存 | 先 `stat` 检查（配置 256KB、缓存 1MB），超限当未命中 |

### 第三轮审计修掉的

| 问题 | 后果 | 现状 |
|---|---|---|
| 魔数可伪造 | 16 字节 PNG 头接在含凭据的 JSON 前就能整体外发 | 三道门：魔数 → **结构完整性**（PNG 必 IEND 收尾、JPEG 必 FFD9、GIF 必 `;`、WebP 的 RIFF size 必须自洽）→ 宿主 `attachments.validateImage()` 真实解码。解码类失败码拒绝、宿主存储侧限额码放行（不让正常大截图变成回归）、拿不到判定时退回结构检查并告警 |
| 生图返回的 URL 交给 `curl -L` | `curl` 支持 `file:`，且 `-L` 跟随重定向 → 恶意/被攻陷的生图服务可驱使插件读本地或内网资源 | 下载改**本进程 `fetch`**：只放行 `https`，拒 `file:`/`http:`/其它协议，拒回环与内网/链路本地/ULA 目标与数字型主机名，**逐跳**校验重定向（最多 3 跳），40MB 上限；PowerShell 只负责发那条生成请求并回吐 JSON，不下载不落盘 |
| 代际比对两个方向都错 | 拿包装器自己的 `inputModalities` 比上游原始值 → 配置没变也每次误报；而真正的预算字段 `defaultMaxTokens` 没比 | 两边都改成比**原始上游**元数据（`id`/`contextWindow`/`maxTokens`/`defaultMaxTokens`），去掉 `inputModalities` |
| 缓存写失败回落到命令行 | 整段识图正文进子进程命令行（同机进程可见） | 删掉回落：只走 `fs.writeText`，写失败放弃本次缓存并 warn |
| 缓存身份只认"任一后端" | primary 坏掉时 fallback 作答、之后换掉 primary 仍直hit旧答案 | 记录并存校验**整组** `(primary, fallback)` 身份，完全一致才命中 |
| 图片下载无体积上限、curl 协议没收紧 | 异常 URL 可往 `%TEMP%` 灌超大文件；重定向可绕开协议限制 | `send_image` 的 curl 加 `--proto "=https,http"`、`--proto-redir "=https,http"`、`--max-filesize 41943040`（自查加固） |

**这一轮带来的行为变更**（升级时会撞到，写清楚）：

- **生图服务返回的下载地址必须是公网 `https`**。返回 `http://`、内网地址或 `file:` 的一律拒绝（明确报错，不会静默失败）。这是第二轮「不让 URL 随便被跟随」的代价。
- **生图结果的下载走本进程 `fetch`，不读系统代理**（识图请求一直是这样）。如果你的生图服务必须经代理才能访问，请把 `baseURL` 配成走代理也能直连的地址，或期待后续版本改用宿主代理能力。

### 第四轮审计修掉的

| 问题 | 后果 | 现状 |
|---|---|---|
| 图片校验在降级路径失败后**放行** | 缺解码器或抛未分类异常时，伪造文件头的文件仍会被外发 | 改成**失败即拒**：唯一放行条件是宿主 `attachments.validateImage` 调用成功；解码类码拒、超限码默认也拒（已核实宿主的超限检查只用头部元数据、发生在完整解码之前，伪造 IHDR 就能触发）、未分类异常拒、宿主没有该方法也拒。逃生口 `allowHostRejectedVisionUpload` 默认关闭，打开后**只有超限码**放行 |
| 公网 URL 过滤可被地址族绕过 | `[::ffff:127.0.0.1]`、`0.0.0.0`、CGNAT、NAT64、组播等整类地址都能溜过去 | 改成**按地址族数值判定**（IPv4 比 14 个网段、IPv6 展开成 16 字节比前缀），并递归检查 v4-mapped / NAT64 / 6to4 内嵌的 IPv4；主机名先拒 localhost/*.local，再用 `dns.lookup` 真解析，任一结果命中黑名单或解析失败一律拒 |
| 40MB 上限在整份响应进内存**之后**才执行 | 无 `Content-Length` 时可以先吃掉任意内存 | 改流式：`getReader()` 分块累加，超限立刻 `cancel()` 并释放 reader；`Content-Length` 预检失败时连 body 都不碰 |
| 复制后双向校验在 `try/catch` 之外 | 枚举/哈希失败时会留下"已替换但没通过校验"的插件目录且不回滚 | 整段复核包进 `try/catch`，异常必先回滚再以退出码 1 结束；回滚自身的文件操作改终止性错误，条目失败不中断其余条目但会显著打印并汇总 |

- `~/.dsh` 根目录遵循宿主 `dsh-home-paths` 的优先级：插件配置 `dshHome` > `$DSH_HOME` > `~/.dsh`，支持 `~` 展开。

## 🚀 安装

### 方式一：一键脚本（推荐，Windows / PowerShell）

仓库里带了一个一键安装脚本 `scripts/install.ps1`。执行顺序是**先只读后写入**：

1. 只读探测插件来源、定位 profile（DSH 根目录按 `-DshHome` > `$DSH_HOME` > `~/.dsh` 解析，与插件运行时一致）、解析 JSON，先打印一份「将要改什么」的计划
2. 交互确认（`-Yes` 可跳过）
3. 备份 profile 的 `package.json`、要改的 `cordis.patch.yml`（如果走 legacy）与插件目录（就近存成 `<名字>.bak-<时间戳>`）
4. **事务式重建插件目录**（先清空再按源复制，含 `.gitignore` 这类隐藏文件），然后是写 `link:` 依赖与 `dsh.profile.bundles` 名单，或写 legacy 的 `cordis.patch.yml`
5. 写完全部重新解析校验，插件目录还要做**双向逐文件比对**（目标多出来的旧文件也算失败）；legacy 模式会核对 patch 里那条 `imgpost` 的 `name` 解析后是否真的指向入口文件 —— 指错就只改那一行（保留其它条目与注释），最后还要确认入口真实存在；没有 `ConvertFrom-Yaml` 时做结构校验（引号与括号配平、顶格行必须是数组项、追加块前恰好一个空行）
6. 目录枚举一律 `-ErrorAction Stop`，枚举失败在**任何写入之前**就带原因失败（静默漏文件会让双向校验形同虚设）
7. 任一步失败按相反顺序回滚：还原备份，本次新建的文件/目录直接删除；最后跑 `pnpm install` 并检查它的退出码

退出码：`0` 成功 ｜ `1` 失败已回滚 ｜ `2` 配置已写但 `pnpm install` 未完成（脚本会给出可复制的补救命令）｜ `3` 用户取消。
选 No、备份、写入或校验阶段失败时，插件目录与 profile 都保持原样；校验期抛异常也会先回滚再退出（回归矩阵 31 个用例 / 134 项检查覆盖）。
注意 `exit 2` 是**有意保留现场**的：配置已经写好了，只差一次 `pnpm install`，不会回滚。

```powershell
# 方式 A：本地 clone 后安装（自动探测 profile）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 方式 B：指定 profile
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop

# 方式 C：直接通过 npm 安装到 ~/.dsh/plugins 并配置
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -FromNpm

# 方式 D：DSH 根目录不在默认位置（也认 $DSH_HOME）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DshHome '<你的 DSH 根目录>'

# 完全没有 dsh 块的老版本 profile：脚本自动改用 legacy 的 cordis.patch.yml 方式，插件照样会被复制到位
# 注意：profile 里只要有 dsh 块（哪怕是空的 {}）就走 bundle 方式，脚本会把 dsh.profile / bundles 建出来
```

### 方式二：手动 bundle 安装（DSH 0.2.x，推荐做法）

1. 把本仓库放到 `~/.dsh/plugins/imgpost`
2. 在 profile 的 `package.json`（如 `~/.dsh/profiles/desktop/package.json`）加依赖：

   ```json
   "dependencies": { "imgpost": "link:<插件目录的绝对路径，正斜杠>" }
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

想让**别的设备**（手机、平板、另一台电脑）也能看到图片，配置 `publicBaseUrl`，否则自动用本机探测到的 GUI 端口：

```yaml
- id: imgpost
  config:
    publicBaseUrl: 'https://your-public-domain'
```

> **这个插件不依赖任何内网穿透/第三方服务。** 仓库里没有任何相关依赖，也没有写死任何域名或 IP：`publicBaseUrl` 只是一个可选的显式配置项，**不配就走本机回环地址**（`http://127.0.0.1:<DSH 端口>`）。想让别的设备访问，把 `publicBaseUrl` 填成你实际用的那个地址即可 —— 反向代理、内网穿透、局域网 IP 都一样，只要它在**本机**终结连接（那样来源检查与 Host 检查都对得上）。

### （可选）从别的设备访问图片

**先说结论：只有"别的设备"才需要配置；同一台机器上什么都不用配。** 不配 `publicBaseUrl` 时，插件用本机探测到的 `http://127.0.0.1:<端口>` 生成图片 URL，本机浏览器正常显示。

想让**第二台设备**（手机、平板、另一台电脑）看到图片，需要满足两条，插件只负责其中一条：

1. **把 `publicBaseUrl` 设成那台设备实际访问用的地址**（带协议与端口，例如 `http://192.168.1.9:19387`，或你的反向代理/内网穿透域名）。这条不做的话，图片 URL 里的 `127.0.0.1` 在对方设备上指向它自己 —— 无论怎么配都显示不出来。
2. 插件会检查请求来源：**回环来源**，或 **Host 与你配置的 `publicBaseUrl` 一致**。所以只要第 1 条填对了，第二台设备（含局域网 IP 直连）就能取图；填错或从别的名字访问会被 403。

```yaml
- id: imgpost
  config:
    publicBaseUrl: 'http://192.168.1.9:19387'   # 换成你实际访问用的地址
```

如果你会用**多个地址**访问同一个 DSH（例如同时用域名和 IP），Host 就对不上 `publicBaseUrl` 了，这时可以放宽来源判断：

```yaml
- id: imgpost
  config:
    allowRemoteImages: true
```

打开后 `/dsh-img2` **不再做来源判断**（等价于回到旧行为）。代价是：谁能连到这个端口、拿到图片 URL，谁就能取图 —— 请自己确保这个端口只在可信网络里可达。

> 另有一层不在本插件职责内：DSH 宿主的浏览器信任围栏（profile 补丁里的 `trustedHosts`）。要让非回环 Host 的请求通过，那一层也要把它加进去，否则在宿主层就被挡；只在本机用则完全不用管它。具体值以你 profile 的 `cordis.patch.yml` 为准。

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
    dshHome: '<你的 DSH 根目录>'
```

## 🧩 技术要点

- **零依赖**：核心逻辑直接用宿主端 Service（`attachments` / `fs` / `subprocess` / `webServer` / `tools` / `llm`），不引入第三方包。
- **磁盘证据缓存**：识图结果按「图片 SHA-256 + 问题 + 后端身份组合」缓存在 `<dsh home>/imgpost-vision-cache/`。同一张图同一个问题只描述一次、跨重启不重读；换问题会重新问一次；**只要 primary/fallback 组合变了就整体失效**（宁可重问一次，也不拿旧后端的答案糊弄）。内容策略拒绝按负缓存存 1 小时，过期自动重试。
- **跨电脑通用**：没有写死的本机路径 / 盘符 / 端口 / 厂商模型名，克隆即用。
- **URL 稳定**：图片以内容寻址（sha256）落盘，同一张图重复发送得到同一个 URL。

## ⚠️ 已知限制（如实列出，不是免责声明）

- **`/dsh-img2` 是 capability URL，没有额外的鉴权**。URL 里的 64 位 sha256 就是凭证：宿主没有给插件可用的会话鉴权接口，所以**谁能拿到这个 URL，谁就能取到这张图**。插件能做的是两件半事：不让中间缓存/代理留存（`Cache-Control: private` + `X-Content-Type-Options: nosniff`）、**限制可达来源**（只接受回环来源，或 Host 命中 `publicBaseUrl` 的域名），以及文档披露。**默认行为**：没配 `publicBaseUrl` 时只有本机回环能取图，从别的机器直连 `http://<局域网 IP>:<端口>` 会被 403。要更严就在网络层做：只监听回环、限制可达成员、别把 GUI 端口暴露到公网。
- **设置接口的暴露面**：`/plugins/imgpost/vision-config` 能读配置（不含 key）与改配置。它自带三层门禁（仅回环来源 + `x-imgpost-config: 1` 头 + Origin 校验），但**它和 `/dsh-img2` 一样在宿主的 token 鉴权之外** —— 这是插件路由的固有限制。所以：不要把这个端口暴露到公网；改了 `publicBaseUrl` 之后记得确认可达域名仍然正确。
- **写 `<dsh home>` 下的文件走 `node:fs`，不走宿主 fs 服务**：宿主 fs 服务受会话文件策略约束（`workspace-write` 只允许写 workspace 根与平台临时区），实测 `fs.writeText` 写 `~/.dsh/vision-sender.json` 直接抛 `file access denied under workspace-write mode`。所以插件的**配置写**与**识图缓存写**改用 `node:fs`（同机另一个插件 y-voice 也这样写它自己的音频目录），并用「同目录临时文件 + rename」保证不出现半个 JSON。读仍走 fs 服务（读不受该策略限制）。要留意的含义：**插件对自己配置/缓存的写入不受会话文件策略约束** —— 会话设成 `read-only` 时插件仍能写它自己的配置与缓存，工具级的写操作才会被拦。
- **图片外发校验是 fail-closed**：唯一放行条件是宿主 `attachments.validateImage` 真实解码成功。如果某个部署的附件服务没提供这个方法，识图会**直接拒绝并说明原因**（宁可不识图，也不把没验过的字节发给外部服务）。需要 OCR 超大整页截图（超过宿主 8192px/64MP 准入限额）时，可以显式打开 `allowHostRejectedVisionUpload`（默认关闭）：打开后**只有**"超出宿主存储限额"这一类码放行，解码失败照样拒。这是有意接受的取舍，代价写在名字里。
- **目标地址的 DNS 预解析有 TOCTOU 窗口**：下载生图结果前会 `dns.lookup` 并把解析出的所有地址过一遍黑名单，但随后 `fetch` 会自己再解析一次（插件无法把已解析的 IP 钉给 undici）。DNS rebinding 的窗口因此没有被完全关闭，只是从"任意地址"收窄到"必须能把公网名字解析到私网的攻击者"。
- **包装通道的配置代际**：`imgpost-<上游>` 适配器的 `prepareCall` 绑定的是「模型元数据 + 一个 stream 函数」，而真正派发时会按 provider id 重新解析上游适配器。真实语义是：**token 预算按 prepare 时的元数据算，请求按 dispatch 时的适配器发**。插件会在派发时用同一口径重解析**原始上游**元数据（含 `defaultMaxTokens`）并比对，不一致就写 `logger.warn`，但不改变行为：改成冻结上游需要绕过宿主 `llm.stream` 的 waterfall 与图片投影，代价更大。
- **生图的 API key 仍会进 PowerShell 子进程的环境**（不在命令行里）。子进程只用于发 `/images/generations` 请求；同一用户下的其它进程理论上可以读到该环境块。若在意这一点，把生成请求改成本进程 `fetch`（与识图路径一致）是下一步的清理方向，代价是 `fetch` 默认不读系统代理。
- **识图缓存以明文 JSON 落盘**在 `<dsh home>/imgpost-vision-cache/`，内容是模型对图片的文字描述。它是本机用户数据，没有做额外加密或保留期策略。
- **附件字节的读取**：路径由**宿主**解析（`attachments.imageHostPath({ attachmentId })` —— 已核实它只要求 ref 里的 sha 合法，不需要 mediaType/bytes/width/height），插件不再硬编码存储布局；包装通道（粘贴图片转文字）手上有**完整 ref**，走 `attachments.readImage(ref)`，任何附件后端都能用，宿主还会顺带校验摘要与元数据。唯一残留：`/dsh-img2` 的 URL 只带哈希，若某个部署的附件后端**不是宿主文件后端**（`imageHostPath` 返回 undefined），这条路由会退回拼路径；而那种部署下浏览器要加载明文图片 URL，本来也需要宿主另提供机制。

## 📄 License

MIT

---

*imgpost —— 让你的 DSH 会发图、更会看图。*
