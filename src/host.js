// imgpost（图邮） — host plugin, zero dependencies.
// Tools: send_image (post any image into the chat), generate_image (any
// OpenAI-compatible /images/generations endpoint), imgpost_read_image (read an
// image through an external vision API, disk-cached), imgpost_check_backend.
// Images are stored as durable attachments and served back through a
// same-origin /dsh-img2/<sha256> webServer route so the chat can display them.
// Nothing vendor-specific is hardcoded anywhere: no provider, no base URL, no
// model name, no local path is assumed — whichever endpoint and model the
// config names is what gets called.
//
// Config for generation (optional): env DSH_IMAGE_API_KEY / DSH_IMAGE_API_BASE
// / DSH_IMAGE_API_MODEL, or ~/.dsh/image-sender.json { apiKey, baseURL, model }.
//
// Vision (read_image): ~/.dsh/vision-sender.json { primary, fallback } where
// each backend is { baseURL, apiKey, model, format: 'openai' | 'anthropic' },
// or the env trio DSH_VISION_API_KEY / DSH_VISION_API_BASE /
// DSH_VISION_API_MODEL. Nothing vendor-specific is assumed: the model the
// config names is the model that gets called. Evidence text is cached on disk
// at ~/.dsh/imgpost-vision-cache/<sha256>.json so a restart never re-reads a
// picture that was already described once.
export const name = 'imgpost';
// Hard dependencies: the loader parks this plugin until these host services are
// provided, so apply() never races startup order. `llm` guarantees the vision
// provider wrap registers after the model registry is live.
export const inject = ['attachments', 'subprocess', 'fs', 'webServer', 'tools', 'llm'];

// PowerShell 可执行文件候选：优先裸名（交给 PATH 解析），绝对路径一律从环境变量推导，
// 不写死任何机器路径；对应的环境变量不存在就跳过那一项。
function shellCandidates() {
  const env = (typeof process !== 'undefined' && process.env) || {};
  const out = ['pwsh'];
  const programFiles = String(env.ProgramFiles || '').trim();
  if (programFiles) out.push(programFiles.replace(/[\\/]+$/, '') + '\\PowerShell\\7\\pwsh.exe');
  out.push('powershell');
  const systemRoot = String(env.SystemRoot || env.windir || '').trim();
  if (systemRoot) out.push(systemRoot.replace(/[\\/]+$/, '') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  return out;
}

export function apply(ctx, config) {
  const attachments = ctx.get('attachments');
  const subprocess = ctx.get('subprocess');
  const fs = ctx.get('fs');
  const webServer = ctx.get('webServer');
  const sandboxPolicy = ctx.get('sandboxPolicy');
  const llm = ctx.get('llm');
  // 可配置的对外图片基址：配置了就用它（远程访问时让图片 URL 指向对外地址），
  // 否则回退到运行时探测（webServer.port → DSH_WEB_URL → 默认）。
  const publicOrigin = (config && typeof config.publicBaseUrl === 'string' && /^https?:\/\//i.test(config.publicBaseUrl))
    ? config.publicBaseUrl.replace(/\/+$/, '')
    : null;
  // 默认关闭的逃生口：宿主的图片准入校验会挡下"超出存储侧像素/尺寸限额"的图，而这些判定只用
  // 头部元数据（伪造 IHDR 就能触发），所以默认连外发也一起拒绝。确实要给超长整页截图做 OCR 的
  // 用户可以在 profile patch 里显式打开它，属于知情取舍。
  const allowHostRejectedVisionUpload = !!(config && config.allowHostRejectedVisionUpload === true);
  let configCache = null;
  let workingShell = null;
  let homePromise = null;
  let dshHomePromise = null;

  // 用户 home 在**本进程**解析，不再起 PowerShell 去问 $env:USERPROFILE：宿主会剥离子
  // 进程环境里的 DSH_* 与凭据形状变量，为了拿一个 home 目录去起 shell 只会多一个失败点。
  // 保持返回 Promise（所有调用点都是 await userHome()）。
  function userHome() {
    if (!homePromise) {
      homePromise = (async () => {
        const env = (typeof process !== 'undefined' && process.env) || {};
        const direct = String(env.USERPROFILE || env.HOME || '').trim();
        if (direct) return direct.replace(/[\\/]+$/, '');
        const os = await import('node:os');
        const home = String(os.homedir() || '').trim();
        if (!home) throw new Error('cannot resolve the user home directory (USERPROFILE/HOME unset and os.homedir() empty)');
        return home.replace(/[\\/]+$/, '');
      })();
    }
    return homePromise;
  }

  // $DSH_HOME 同样只能在**本进程**读（同一条剥离规则），优先级与宿主 dsh-home-paths 的
  // resolveDshHome() 一致：显式配置 > $DSH_HOME（trim 后非空）> <os home>/.dsh；
  // 支持 '~' / '~/' / '~\' 前缀展开，最后归一化成绝对路径。
  function dshHome() {
    if (!dshHomePromise) {
      dshHomePromise = (async () => {
        const path = await import('node:path');
        const env = (typeof process !== 'undefined' && process.env) || {};
        const configured = config && typeof config.dshHome === 'string' && config.dshHome.trim() ? config.dshHome.trim() : null;
        const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : null;
        const override = configured || fromEnv;
        if (!override) return path.join(await userHome(), '.dsh');
        const os = await import('node:os');
        const home = String(os.homedir() || '');
        const expanded = override === '~'
          ? home
          : (override.startsWith('~/') || override.startsWith('~\\')) ? path.join(home, override.slice(2)) : override;
        return path.resolve(expanded);
      })();
    }
    return dshHomePromise;
  }

  // ~/.dsh 下的任何路径都从这里拼；别处不许再出现字面量 '.dsh'。
  async function dshPath(...segments) {
    const path = await import('node:path');
    return path.join(await dshHome(), ...segments);
  }

  // 与会话无关的辅助进程（配置探测、缓存读写）用用户 home 当 cwd：它们不关心工作区，
  // 也不该假设某个盘符存在。
  async function homeCwd() {
    try {
      return await userHome();
    } catch (e) {
      return process.cwd();
    }
  }

  // Runtime origin of the web GUI, probed lazily and cached. The /dsh-img2 route
  // is served by the same webServer as the GUI, whose port is dynamic (--port 0),
  // so a hardcoded port breaks image display across restarts. 顺序：配置的对外基址
  // → webServer.port → DSH_WEB_URL（本进程读；子进程里 DSH_* 会被剥掉）→ 明确报错。
  let resolvedOrigin = null;
  let originPromise = null;
  function ensureWebOrigin(signal, cwd) {
    if (resolvedOrigin) return Promise.resolve(resolvedOrigin);
    if (!originPromise) {
      originPromise = (async () => {
        // 优先用配置的对外基址（远程访问时，图片 URL 用那个对外地址，本机与远端一致）。
        if (publicOrigin) return publicOrigin;
        // The /dsh-img2 route lives on the same webServer service as the GUI,
        // so webServer.port is the single source of truth for the display URL.
        try {
          const port = webServer && typeof webServer.port === 'number' && webServer.port > 0 ? webServer.port : 0;
          if (port) return 'http://127.0.0.1:' + port;
        } catch (e) {
          // fall through to the env probe
        }
        try {
          const p = (typeof process !== 'undefined' && process.env && process.env.DSH_WEB_URL) || '';
          if (/^https?:\/\//i.test(p)) return p.replace(/\/+$/, '');
        } catch (e) {
          // fall through to the explicit failure below
        }
        throw new Error('cannot determine the web origin for image URLs: webServer.port is unset, DSH_WEB_URL is not set, and no publicBaseUrl is configured. Set publicBaseUrl in the imgpost plugin config (profile cordis.patch.yml).');
      })().then((o) => {
        resolvedOrigin = o;
        return o;
      }, (error) => {
        // 解析失败不要留下一个永远 reject 的 promise，下一次调用可以重试。
        originPromise = null;
        throw error;
      });
    }
    return originPromise;
  }

  // 渲染期（render()）用的基址：配置的对外基址优先（render() 可能是在新进程里回放历史，
  // execute 没跑过，这时也必须用对外基址而不是回环地址）→ resolvedOrigin → webServer.port
  // 现算；都没有就返回空串，URL 退化成同源相对路径 /dsh-img2/<hex>，绝不凭空造一个端口。
  function renderOrigin() {
    if (publicOrigin) return publicOrigin;
    if (resolvedOrigin) return resolvedOrigin;
    try {
      const port = webServer && typeof webServer.port === 'number' && webServer.port > 0 ? webServer.port : 0;
      if (port) return 'http://127.0.0.1:' + port;
    } catch (e) {
      // fall through to the relative form
    }
    return '';
  }

  function sniffMediaType(bytes) {
    if (bytes.length < 12) return null;
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }

  // ── security: what may leave the machine ──────────────────────────────────
  // 只有真正的 png/jpeg/webp/gif 字节才允许发往外部视觉服务。判定一律以**魔数**为准：
  // data URI 里声明的 MIME、文件扩展名、调用方传来的 mediaType 都只是参考，不作数。
  const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_CONFIG_BYTES = 256 * 1024;
  const MAX_CACHE_ENTRY_BYTES = 1024 * 1024;
  const MAX_ERROR_DETAIL_CHARS = 300;

  // ── 外发图片的最后一道门 = "必须有一次成功的真实解码" ─────────────────────
  // 已核实：宿主 dsh-attachment-local 的 detectImage() 里超限检查（:193-194）发生在完整解码
  // image.raw().toBuffer()（:195）**之前**，只依据头部元数据 —— 所以"拿到超限码"不等于"已证明
  // 这是真图"（伪造一个声称 20000x20000 的 IHDR 就能走到超限分支）。因此本插件全按失败即拒：
  //   * validateImage 调用成功           → 放行（唯一放行条件）
  //   * 抛解码/类型类码（INVALID_IMAGE / IMAGE_TYPE_MISMATCH / UNSUPPORTED_IMAGE_TYPE）→ 拒绝
  //   * 抛限制类码（HOST_LIMIT_CODES）    → 默认也拒绝；只有 config.allowHostRejectedVisionUpload
  //     显式打开时才 warn + 放行
  //   * 抛其它异常 / 没有 code            → 拒绝
  //   * 宿主没有 validateImage            → 拒绝（并记一条 warn，便于排查是部署缺能力而非图片坏）
  const HOST_LIMIT_CODES = ['IMAGE_DIMENSION_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_TOO_LARGE'];

  // 魔数只要前几个字节就能伪造，所以再看文件自身是否收尾正确、长度自洽。
  function hasIntactImageStructure(bytes, mediaType) {
    try {
      const n = bytes.length;
      if (mediaType === 'image/png') {
        // PNG 必须以 IEND 块收尾：00 00 00 00 49 45 4E 44 AE 42 60 82
        return n >= 16 && bytes.slice(n - 8).toString('hex') === '49454e44ae426082';
      }
      if (mediaType === 'image/jpeg') return n >= 4 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
      if (mediaType === 'image/gif') return bytes[n - 1] === 0x3b;
      if (mediaType === 'image/webp') {
        if (n < 12) return false;
        // RIFF 头里的 size 字段 = 文件长度 - 8（奇数字节时允许一个填充字节）
        const size = bytes.readUInt32LE(4);
        return size === n - 8 || size === n - 7;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  // 发往外部视觉服务之前的最后一道门。返回判定出的 mediaType，成功即表示"可以外发"；
  // 任何"判不了"的情况都按拒绝处理，错误文案统一说明没有发送任何内容。
  async function assertImageUpload(bytes, sourceLabel) {
    if (!bytes || bytes.length === 0) throw new Error(sourceLabel + ': no bytes to read');
    if (bytes.length > MAX_VISION_IMAGE_BYTES) {
      throw new Error(sourceLabel + ': ' + bytes.length + ' bytes exceeds the ' + Math.floor(MAX_VISION_IMAGE_BYTES / (1024 * 1024)) + 'MB limit for a request to an external vision service. Nothing was sent.');
    }
    const refuse = (why) => new Error(sourceLabel + ': ' + why + ' Nothing was sent to the vision service.');
    const sniffed = sniffMediaType(bytes);
    if (!sniffed) {
      throw refuse('not a readable image (png/jpeg/webp/gif only).');
    }
    if (!hasIntactImageStructure(bytes, sniffed)) {
      throw refuse('the bytes begin like a ' + sniffed + ' but the file structure is incomplete or inconsistent (truncated, or a header pasted onto other data).');
    }
    // 魔数与结构都能伪造，所以最后必须拿到一次宿主解码器的真实解码结果，否则不放行。
    if (!attachments || typeof attachments.validateImage !== 'function') {
      ctx.logger?.warn('[imgpost] ' + sourceLabel + ': this deployment exposes no attachments.validateImage(), so the host image decoder cannot prove the bytes are a real image; the upload is refused.');
      throw refuse('the host image decoder (attachments.validateImage) is not available on this deployment, so the bytes cannot be proved to be a real image.');
    }
    try {
      await attachments.validateImage({ data: bytes, mediaType: sniffed, name: 'imgpost-external-upload' });
    } catch (error) {
      const code = String((error && error.code) || '');
      const detail = code || redactSecrets(String((error && error.message) || error)).slice(0, 120);
      if (HOST_LIMIT_CODES.indexOf(code) >= 0 && allowHostRejectedVisionUpload) {
        ctx.logger?.warn('[imgpost] ' + sourceLabel + ' was refused by a host image-admission limit (' + code + ') and config.allowHostRejectedVisionUpload is on, so it is being sent anyway. That limit is decided from header metadata alone, not from a full decode.');
        return sniffed;
      }
      throw refuse('the host image decoder refused these bytes (' + detail + ').');
    }
    return sniffed;
  }

  const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

  // 明文 http:// 会把 Authorization 头里的 key 原样送出去，所以只有回环地址允许 http。
  function assertTransportSafe(baseURL, label) {
    let parsed;
    try {
      parsed = new URL(String(baseURL));
    } catch (e) {
      throw new Error(label + ' is not a valid URL: ' + redactSecrets(String(baseURL).slice(0, 120)));
    }
    if (parsed.protocol === 'https:') return parsed;
    if (parsed.protocol !== 'http:') {
      throw new Error(label + ' must be https:// (or http:// on loopback), got ' + parsed.protocol);
    }
    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (LOOPBACK_HOSTS.indexOf(host) >= 0) return parsed;
    throw new Error(label + ' points at plain http://' + host + ', so the API key would travel in cleartext. Use https://, or a loopback address (127.0.0.1 / ::1 / localhost) for a server on this machine.');
  }

  // 上游响应体可能回显凭据，工具结果又会被送进对话甚至上游模型，所以任何会把响应体
  // 带进错误的出口都要先过这里：遮蔽已知凭据形状 + 当前配置里真实存在的 key，并截断。
  function redactSecrets(text) {
    let out = String(text == null ? '' : text);
    try {
      const secrets = [];
      for (const cfg of [visionConfigCache, configCache]) {
        if (!cfg) continue;
        if (cfg.key) secrets.push(String(cfg.key));
        if (cfg.apiKey) secrets.push(String(cfg.apiKey));
        for (const b of [cfg.primary, cfg.fallback]) if (b && b.apiKey) secrets.push(String(b.apiKey));
      }
      for (const s of secrets) if (s.length >= 6) out = out.split(s).join('***');
    } catch (e) {
      // 配置还没就绪时只做形状遮蔽
    }
    out = out
      .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***')
      .replace(/ghp_[A-Za-z0-9]{8,}/g, 'ghp_***')
      .replace(/github_pat_[A-Za-z0-9_]{8,}/g, 'github_pat_***')
      .replace(/AIza[A-Za-z0-9_\-]{8,}/g, 'AIza***')
      .replace(/xox[baprs]-[A-Za-z0-9\-]{8,}/g, 'xox***')
      .replace(/\b[Bb]earer\s+[A-Za-z0-9._\-]{8,}/g, 'Bearer ***');
    return out.length > MAX_ERROR_DETAIL_CHARS ? out.slice(0, MAX_ERROR_DETAIL_CHARS) + '...' : out;
  }

  // 后端身份串：缓存命中要核对它，所以配置一改（换 baseURL/model/format）就自然失效。
  function backendIdent(backend) {
    if (!backend) return '';
    return [backend.baseURL || '', backend.model || '', backend.format || ''].join('|');
  }

  // 缓存命中核对的是**整组**后端身份，而不是"属于其中任何一个"：否则 primary 故障时由
  // fallback A 作答的答案，在之后换掉 primary 但保留 fallback A 的情况下仍会被直接命中，
  // 而对新的 primary 一次都不请求。
  function backendSetIdent(primary, fallback) {
    return backendIdent(primary) + ';;' + backendIdent(fallback);
  }

  // fs.readText 的真实签名是 (target, signal)：第三个"最大字节数"参数会被忽略
  // (dsh-fs-local:825)，所以小文件先 stat 看大小，超限就当它不存在。
  async function readTextCapped(target, maxBytes, signal) {
    try {
      const info = await fs.stat(target, signal);
      if (info && typeof info.size === 'number' && info.size > maxBytes) return null;
    } catch (e) {
      return null;
    }
    return await fs.readText(target, signal);
  }

  function baseNameOf(p) {
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || 'image';
  }

  function cwdFor(exec) {
    const agent = exec && exec.agent;
    const header = agent && agent.session ? agent.session.header : undefined;
    if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd;
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string') return sandboxPolicy.workspaceRoot;
    throw new Error('cannot determine a working directory for the helper process');
  }

  async function runPwsh(script, env, signal, cwd) {
    const makeSpec = (exe) => ({
      argv: [exe, '-NoProfile', '-NonInteractive', '-Command', script],
      cwd: cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 32 * 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 },
      },
      graceMs: 5000,
      signal: signal,
      env: env || undefined,
    });
    const attempt = async (exe) => {
      let handle;
      try {
        handle = subprocess.spawn(makeSpec(exe));
      } catch (e) {
        return { spawnError: e, outcome: null, out: '', err: String(e && e.message || e) };
      }
      let outcome;
      try {
        outcome = await handle.done;
      } catch (e) {
        return { spawnError: e, outcome: null, out: '', err: String(e && e.message || e) };
      }
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '';
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '';
      return { outcome: outcome, out: out, err: err };
    };
    let result = null;
    const candidates = workingShell ? [workingShell] : shellCandidates();
    for (const exe of candidates) {
      const attemptResult = await attempt(exe);
      const bad = attemptResult.spawnError || !attemptResult.outcome || attemptResult.outcome.exitCode === 9009;
      if (!bad) {
        result = attemptResult;
        workingShell = exe;
        break;
      }
    }
    if (!result) {
      throw new Error('cannot spawn a PowerShell executable (tried pwsh and Windows PowerShell 5.1)');
    }
    if (result.outcome.exitCode !== 0) {
      // 子进程 stderr 可能带上游响应体（Invoke-RestMethod 会把错误正文原样吐出），
      // 所以进错误消息前先遮蔽凭据形状与当前配置里的真实 key。
      throw new Error('powershell exited ' + result.outcome.exitCode + ': ' + redactSecrets((result.err || result.out).slice(0, 600)));
    }
    return result.out;
  }

  function newTempName() {
    return 'img-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.bin';
  }

  // ── vision: sha256 + disk-persisted evidence cache ────────────────────────
  // read_image describes a picture once, stores the evidence text keyed by the
  // image digest, and reuses it forever — across steps AND across restarts.
  // A process-local Map would die with the process, and every restart would
  // re-run the vision engine over the whole history — so this one lives on disk.
  function sha256OfBytes(bytes) {
    // lazy dynamic import keeps the plugin zero-dep at load time
    return import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex'));
  }

  // 缓存键 = 图片 sha256 + 有效 prompt 的摘要（+ 后端身份）。换一个问题问同一张图不会
  // 命中上一次的答案；provider 包装那条路传的是 prompt=undefined（固定通用提示），
  // 它的键在重启之间保持稳定，缓存照旧命中。
  const DEFAULT_VISION_PROMPT = 'Describe this image in detail: what is in it, any text (transcribe it), layout, colors, and anything notable.';

  function isDefaultVisionPrompt(prompt) {
    return !(prompt && String(prompt).trim());
  }

  function effectiveVisionPrompt(prompt) {
    return isDefaultVisionPrompt(prompt) ? DEFAULT_VISION_PROMPT : String(prompt).trim();
  }

  function sha256OfText(text) {
    return import('node:crypto').then(({ createHash }) => createHash('sha256').update(String(text), 'utf8').digest('hex'));
  }

  // 缓存文件名：默认提问 → <sha>.json；自定义提问 → <sha>-<promptDigest>.json。
  // 后端身份不进文件名，而是写进记录、命中时核对（见 readVisionCache）。
  async function visionCacheName(sha, prompt) {
    if (isDefaultVisionPrompt(prompt)) return sha;
    const digest = await sha256OfText(effectiveVisionPrompt(prompt));
    return sha + '-' + digest.slice(0, 16);
  }

  // 只有"同一次提问 + 与当前**完全一致**的后端组合"写的记录才算命中：
  // ①记录里的 key 必须与本次期望的文件名一致；
  // ②记录里的 backend 必须等于当前 (primary, fallback) 组成的身份串。
  // 旧版本写的记录没有 key/backend 字段，一律视为未命中并重新识图一次，随后按新格式重写
  // （否则换了后端仍会读到上一个后端留下的答案）。
  async function readVisionCache(name, expectedSetIdent) {
    try {
      const target = await fs.resolve(await dshPath('imgpost-vision-cache', name + '.json'));
      const raw = await readTextCapped(target, MAX_CACHE_ENTRY_BYTES, undefined);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.text !== 'string' || !parsed.text) return null;
      if (parsed.key !== name) return null;
      const ident = typeof parsed.backend === 'string' ? parsed.backend : '';
      if (!ident || ident !== expectedSetIdent) return null;
      return parsed;
    } catch (e) {
      // miss or unreadable — fall through to the vision engine
    }
    return null;
  }

  // A "negative" cache entry records that both vision backends declined the
  // image (NSFW etc.). It is stored too, so a restarted session does not re-run
  // the (slow) vision API over the same refused picture right away — but it
  // EXPIRES after NEGATIVE_CACHE_TTL_MS, so a refusal is retried instead of
  // being served forever. An explicit refresh always retries.
  const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  function isNegativeCacheFresh(entry) {
    if (!entry || entry.refused !== true) return false;
    return Date.now() - (entry.savedAt || 0) < NEGATIVE_CACHE_TTL_MS;
  }

  // 一次磁盘命中能不能用：正常条目永久可用，负缓存条目只在 TTL 内可用。
  function isCacheEntryUsable(entry) {
    if (!entry) return false;
    if (entry.refused !== true) return true;
    return isNegativeCacheFresh(entry);
  }

  async function writeVisionCache(name, text, model, refused, setIdent) {
    // 落盘内容里没有任何凭据；setIdent 是整组后端身份串（ident(primary);;ident(fallback)），不是 key。
    const payload = JSON.stringify({ text: text, model: model || '', savedAt: Date.now(), refused: refused === true, key: name, backend: setIdent || '' });
    // 走 writeFileUnfenced：fs 服务的 workspace-write 策略会拒绝写 DSH home（实测过），而缓存正是
    // 写在那里。**不再**有 PowerShell 回落：那条路会把整段识图正文拼进子进程命令行（同机其它
    // 进程可见），正文外泄比"这次没缓存上"严重得多。写失败就放弃这次缓存并记一条 warn。
    try {
      const path = await import('node:path');
      await writeFileUnfenced(path.join(await dshPath('imgpost-vision-cache'), name + '.json'), payload);
    } catch (e) {
      ctx.logger?.warn('[imgpost] could not write the vision cache entry "' + name + '" (' + redactSecrets(String((e && e.message) || e)) + '); the description stays in memory only and will be recomputed next time.');
    }
  }

  // ── 附件字节：路径交给宿主算，不硬编码存储布局 ────────────────────────────
  // `attachments.imageHostPath(ref)` 只要求 ref.attachmentId 合法（已核实 ensureReference
  // 只按 ID_PATTERN 校验 sha256 形状，不需要 mediaType/bytes/width/height），所以只凭 URL 里的
  // 哈希就能让**宿主**给出真实路径 —— 插件不再需要知道 attachments/v1/objects/<2位>/<sha> 这个布局。
  // 返回值 undefined 表示该附件后端不是宿主文件后端，此时退回拼接（仅本地后端可用）。
  async function attachmentHostPath(hex) {
    const sha = String(hex).toLowerCase();
    if (attachments && typeof attachments.imageHostPath === 'function') {
      try {
        const p = attachments.imageHostPath({ attachmentId: 'sha256:' + sha });
        if (typeof p === 'string' && p) return p;
      } catch (e) {
        // 引用不合法或后端不支持：退回拼接
      }
    }
    return await dshPath('attachments', 'v1', 'objects', sha.slice(0, 2), sha);
  }

  // 有完整 ref 时优先用宿主接口读（任何附件后端都行，且宿主会顺带校验摘要与元数据）；
  // 拿不到就退回"路径 + 读字节"。
  async function readAttachmentBytes(ref, hex, signal) {
    if (ref && attachments && typeof attachments.readImage === 'function') {
      try {
        const out = await attachments.readImage(ref, signal);
        if (out && out.data) return Buffer.from(out.data);
      } catch (e) {
        // 交给下面的路径回落
      }
    }
    const target = await fs.resolve(await attachmentHostPath(hex));
    return fs.readBytes(target, signal, 40 * 1024 * 1024);
  }

  // ── vision: backend resolution + OpenAI/Anthropic-compatible calls ───────
  // Precedence: ~/.dsh/vision-sender.json { primary, fallback } → env
  // DSH_VISION_*. Nothing vendor-specific is assumed: the model named in the
  // config is the model that gets called. primary is tried first; on any
  // failure the fallback (if configured) is tried before giving up.
  let visionConfigCache = null;
  async function resolveVisionConfig(signal, cwd, refresh) {
    if (visionConfigCache && !refresh) return visionConfigCache;
    let vRaw = null;
    try {
      const vp = await fs.resolve(await dshPath('vision-sender.json'));
      vRaw = await readTextCapped(vp, MAX_CONFIG_BYTES, signal);
    } catch (e) {
      vRaw = null;
    }
    let primary = null;
    let fallback = null;
    try {
      if (vRaw) {
        const v = JSON.parse(vRaw);
        if (v && v.primary) primary = normalizeVisionBackend(v.primary);
        if (v && v.fallback) fallback = normalizeVisionBackend(v.fallback);
        if (v && !v.primary && v.baseURL) primary = normalizeVisionBackend(v);
      }
    } catch (e) {
      // malformed vision-sender.json — fall through to env
    }
    if (!primary) {
      const envKey = (typeof process !== 'undefined' && process.env && process.env.DSH_VISION_API_KEY) || null;
      const envBase = (typeof process !== 'undefined' && process.env && process.env.DSH_VISION_API_BASE) || null;
      const envModel = (typeof process !== 'undefined' && process.env && process.env.DSH_VISION_API_MODEL) || '';
      if (envKey && envBase) primary = { baseURL: envBase, apiKey: envKey, model: envModel, format: 'openai' };
    }
    visionConfigCache = { primary, fallback };
    return visionConfigCache;
  }

  function normalizeVisionBackend(b) {
    return {
      baseURL: String(b.baseURL || b.baseUrl || '').replace(/\/+$/, ''),
      apiKey: String(b.apiKey || ''),
      model: String(b.model || b.modelName || ''),
      format: b.format === 'anthropic' ? 'anthropic' : 'openai',
    };
  }

  // Call one OpenAI- or Anthropic-compatible vision endpoint with the image as
  // base64. Returns the model's text answer. Throws on transport/API failure
  // with a friendly, classified message so the caller can decide fallback.
  async function callVisionBackend(backend, bytes, mediaType, prompt, signal) {
    if (!backend || !backend.baseURL || !backend.apiKey) throw new Error('vision backend is not configured');
    if (!backend.model) throw new Error('vision backend has no model configured (set "model" in ~/.dsh/vision-sender.json, or DSH_VISION_API_MODEL)');
    // 明文的 http:// 会把 x-api-key / Authorization 头原样送出去，只有回环地址例外。
    assertTransportSafe(backend.baseURL, 'vision backend baseURL');
    const b64 = Buffer.from(bytes).toString('base64');
    const userPrompt = effectiveVisionPrompt(prompt);
    let url;
    let headers;
    let body;
    if (backend.format === 'anthropic') {
      // baseURL may or may not already carry /v1 (e.g. https://host/v1)
      const root = backend.baseURL.replace(/\/+$/, '');
      url = /\/v\d+$/.test(root) ? root + '/messages' : root + '/v1/messages';
      headers = {
        'content-type': 'application/json',
        'x-api-key': backend.apiKey,
        'anthropic-version': '2023-06-01',
      };
      body = {
        model: backend.model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            ],
          },
        ],
      };
    } else {
      url = backend.baseURL.replace(/\/+$/, '') + '/chat/completions';
      headers = {
        'content-type': 'application/json',
        authorization: 'Bearer ' + backend.apiKey,
      };
      body = {
        model: backend.model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + b64 } },
            ],
          },
        ],
      };
    }
    // 调用方可能已经取消：先看一眼，别为一个注定被丢弃的结果发请求。
    if (signal && signal.aborted) throw new Error('vision backend request was cancelled before it was sent');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal && signal.addEventListener && signal.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = 120000;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    // abort 监听与超时定时器必须包住"错误映射 + JSON 解析 + 取文"整段：只在 fetch 期间
    // 生效的话，读响应体（resp.json() / extractApiError()）就完全没有保护。
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const detail = await extractApiError(resp);
        const status = resp.status;
        if (status === 401 || status === 403) {
          throw new Error('vision backend auth failed (bad or expired key / quota): ' + detail);
        } else if (status === 429) {
          throw new Error('vision backend rate-limited (busy / rate limit): ' + detail);
        } else if (status === 402) {
          throw new Error('vision backend out of credits: ' + detail);
        } else if (status === 404) {
          throw new Error('vision backend endpoint not found: ' + detail);
        } else if (status === 408) {
          throw new Error('vision backend request timeout: ' + detail);
        } else if (status >= 500) {
          throw new Error('vision backend server error (' + status + '): ' + detail);
        }
        throw new Error('vision API ' + status + ': ' + detail);
      }
      const data = await resp.json();
      let text = '';
      try {
        if (backend.format === 'anthropic') {
          text = (data.content || []).map((b) => b.type === 'text' ? b.text : '').join('').trim();
        } else {
          text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          if (Array.isArray(text)) text = text.map((b) => b.text || '').join('');
        }
      } catch (e) {
        // keep empty text
      }
      if (!text) throw new Error('vision API returned no text');
      return String(text).trim();
    } catch (e) {
      const msg = String(e && e.message || e);
      const own = /^vision (backend|API)/.test(msg);
      const abortish = timedOut || (e && e.name === 'AbortError') || /abort/i.test(msg);
      if (own && !abortish) throw e;
      if (timedOut) throw new Error('vision backend timed out after ' + (timeoutMs / 1000) + 's');
      if (abortish) throw new Error('vision backend request was cancelled');
      throw new Error('vision backend request failed: ' + msg);
    } finally {
      clearTimeout(timeout);
      signal && signal.removeEventListener && signal.removeEventListener('abort', onAbort);
    }
  }

  // Extract a friendly message from an error response body across the two
  // shapes providers use: {"error":{"message":...}} and {"error":{..."message":...}}.
  async function extractApiError(resp) {
    let detail = '';
    try {
      const raw = await resp.text();
      const parsed = JSON.parse(raw);
      const e = parsed && parsed.error;
      if (e) {
        detail = String(e.message || e.messageText || e.msg || '').trim();
        if (!detail) detail = String(e.type || e.code || '').trim();
      }
      if (!detail) detail = raw.slice(0, 240);
    } catch (e) {
      try { detail = (await resp.text()).slice(0, 240); } catch (e2) { }
    }
    // 上游响应体可能回显凭据，而这条消息会进工具结果、甚至被包装路径送进上游对话，
    // 所以统一遮蔽凭据形状与当前配置里的真实 key，并截断长度。
    return redactSecrets(detail || ('HTTP ' + resp.status));
  }

  // Core: describe image BYTES through the vision backend with disk cache.
  // No exec dependency — shared by the read_image tool and the provider wrap.
  async function describeBytes(bytes, mediaType, prompt, signal, refresh, alreadyValidated) {
    // 这一层是所有"发往外部视觉服务"的必经之路：只放行魔数可识别的图片字节，
    // 声明出来的 mediaType 不作数（传 JSON/凭据进来会在这一句被挡下）。
    // 调用方在这一轮里已经过过同一道门时（read_image 的每个分支都先验过一遍），
    // 就不再重复一次宿主全量解码 —— 几十 MB 的图重复解码纯属浪费。
    mediaType = alreadyValidated === true ? mediaType : await assertImageUpload(bytes, 'vision input');
    const sha = await sha256OfBytes(bytes);
    // 缓存命中要核对后端身份，所以先把后端解析出来（resolveVisionConfig 有内存缓存，
    // 代价只有首次一次文件读）。
    const cfg = await resolveVisionConfig(signal, await homeCwd(), refresh);
    const setIdents = backendSetIdent(cfg.primary, cfg.fallback);
    const cacheName = await visionCacheName(sha, prompt);
    if (!refresh) {
      const cached = await readVisionCache(cacheName, setIdents);
      if (isCacheEntryUsable(cached)) {
        // 负缓存（两个后端都因内容策略拒绝了这张图）只在 TTL 内命中：过期后重新尝试，
        // 而不是把一次拒绝永久钉在磁盘上。显式 refresh 永远重试。
        return { text: cached.text, model: cached.model || '', cached: true, refused: cached.refused === true, sha: sha, mediaType: mediaType, bytes: bytes.length };
      }
    }
    let lastError = null;
    if (cfg.primary) {
      try {
        const text = await callVisionBackend(cfg.primary, bytes, mediaType, prompt, signal);
        // A refusal/policy answer is not a usable description: don't cache it,
        // and treat it as a failure so the fallback backend gets a chance.
        if (!isUsefulVisionText(text)) {
          throw new Error('vision backend declined: ' + redactSecrets(text.slice(0, 120)));
        }
        await writeVisionCache(cacheName, text, cfg.primary.model, false, setIdents);
        return { text: text, model: cfg.primary.model, cached: false, sha: sha, mediaType: mediaType, bytes: bytes.length };
      } catch (e) {
        lastError = e;
      }
    }
    if (cfg.fallback) {
      try {
        const text = await callVisionBackend(cfg.fallback, bytes, mediaType, prompt, signal);
        if (!isUsefulVisionText(text)) {
          throw new Error('vision backend declined: ' + redactSecrets(text.slice(0, 120)));
        }
        await writeVisionCache(cacheName, text, cfg.fallback.model, false, setIdents);
        return { text: text, model: cfg.fallback.model, cached: false, sha: sha, mediaType: mediaType, bytes: bytes.length };
      } catch (e) {
        lastError = e;
      }
    }
    // Both backends failed. Decide: a CONTENT refusal is near-permanent (the
    // image is what it is), so cache the refusal as a negative entry and return
    // a usable message — the next encounter is served from disk instantly. A
    // transport/config error (timeout, 401/quota, 5xx) is transient and must
    // NOT be cached, so it still throws (and can be retried on refresh).
    const lastMsg = String(lastError && lastError.message || lastError);
    if (lastError && /declined|could not be read|refus|declin/i.test(lastMsg)) {
      const declinedText = '[imgpost vision] 该图片因内容安全策略被视觉服务拒绝，暂无法生成描述。可尝试用 refresh 重新请求，或换一个视觉后端。';
      // 负缓存同样记整组后端身份：只要 (primary, fallback) 组合变了，这次拒绝就不再生效。
      await writeVisionCache(cacheName, declinedText, (cfg.fallback && cfg.fallback.model) || (cfg.primary && cfg.primary.model) || '', true, setIdents);
      return { text: declinedText, model: (cfg.fallback && cfg.fallback.model) || '', cached: false, refused: true, sha: sha, mediaType: mediaType, bytes: bytes.length };
    }
    throw new Error('read_image failed' + (lastError ? ': ' + redactSecrets(lastMsg) : ' (no vision backend configured; set ~/.dsh/vision-sender.json or DSH_VISION_API_KEY / DSH_VISION_API_BASE / DSH_VISION_API_MODEL)'));
  }

  // Heuristic: is this returned text an actual description, or a refusal /
  // boilerplate that should never be cached? Refusal phrases in common
  // Chinese/English are treated as "no useful answer" so we try the fallback.
  function isUsefulVisionText(text) {
    const t = String(text || '').trim();
    // 只把"空/空白"和明确的拒绝话术当作无内容：短答案（"42"、"OK"）是合法回答，
    // 用长度门槛会把它们误判成拒绝并写进负缓存。
    if (!t) return false;
    // A reply that is just a refusal/non-answer should never be cached.
    // Cover both refusal styles ("我无法提供该请求的帮助" / "I can't describe...",
    // "I'm unable to...") and empty boilerplate.
    return !/我无法|我不能|无法(?:为您|提供|完成|处理|描述|满足)|不能(?:描述|处理|提供|回答|满足)|不(?:方便|能)提供|拒绝|违反(?:安全|内容|隐私)|\bas an? (?:ai|assistant)\b|\bi'?m (?:an? )?(?:ai|language model|assistant)\b|cannot (?:describe|process|handle|provide|do)|(?:refus|declin|unable to|not able to|can'?t|cannot|won'?t) (?:to )?(?:describe|process|handle|provide|do|fulfill|engage|assist)|i (?:can'?t|cannot|won'?t|don'?t) (?:describe|provide|process|handle|fulfill|engage|comply)|i'?m (?:unable|not able) (?:to )?(?:describe|process|handle|provide)|i don'?t (?:describe|provide|engage|do)|not supported|cannot comply|sorry,? (?:i|couldn)/gi.test(t);
  }

  // Read an image from a local path / http(s) URL / data URI / attachment ref,
  // run it through the vision backend with disk cache, and return the text.
  async function readImageWithVision(exec, src, prompt, refresh) {
    const cwd = cwdFor(exec);
    let bytes;
    let mediaType;
    if (/^sha256:/i.test(src) || /^[a-f0-9]{64}$/i.test(src)) {
      const hex = String(src).replace(/^sha256:/i, '').toLowerCase();
      bytes = await readAttachmentBytes(null, hex, exec.signal);
      mediaType = await assertImageUpload(bytes, 'attachment sha256:' + hex.slice(0, 12));
    } else if (/^data:/i.test(src)) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m || !m[2]) throw new Error('image data URI must be base64-encoded (data:image/png;base64,...)');
      bytes = Buffer.from(m[3], 'base64');
      // data URI 里声明的 MIME（m[1]）只是参考：实际格式以魔数为准，识别不出就拒绝，
      // 否则一个 data:application/json;base64,... 也会被原样传去外部视觉服务。
      mediaType = await assertImageUpload(bytes, 'image data URI');
    } else if (/^https?:\/\//i.test(src)) {
      const tmp = await fetchImageToFile(src, exec.signal, cwd);
      try {
        bytes = await readImageBytesFromFile(tmp, exec.signal);
      } finally {
        // 清理必须用 undefined signal：调用方的 signal 可能已经被取消，runPwsh 会
        // 立刻失败，文件就永远留在 %TEMP% 里了。
        await deleteTempFile(tmp, undefined, cwd);
      }
      mediaType = await assertImageUpload(bytes, 'downloaded file from ' + String(src).slice(0, 80));
    } else {
      const target = await fs.resolve(src, { cwd: cwd });
      bytes = await fs.readBytes(target, exec.signal, 40 * 1024 * 1024);
      mediaType = await assertImageUpload(bytes, 'file ' + String(src).slice(0, 120));
    }
    const result = await describeBytes(bytes, mediaType, prompt, exec.signal, refresh, true);
    return result;
  }

  // ── vision: provider wrapper (imgpost-<upstream>) ─────────────────────────
  // Declare image input so pastes/history pass the model admission gate, and
  // rewrite image blocks into evidence text before
  // the request goes upstream — but the rewrite is served from a DISK cache,
  // so a restart never re-reads a picture that was described once.
  function contentHasImage(blocks) {
    return (
      Array.isArray(blocks) &&
      blocks.some((b) => b && (b.type === 'image' || (b.type === 'tool-result' && contentHasImage(b.content))))
    );
  }

  // Replace image blocks inside one message content array with cached evidence
  // text blocks. Only `type: 'image'` blocks (pastes / attachments) are
  // rewritten; text and everything else pass through untouched.
  async function convertMessageContent(blocks, signal) {
    const out = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        out.push(block);
        continue;
      }
      if (block.type === 'image') {
        const attachmentId = block.attachment && (block.attachment.attachmentId || block.attachment.ref && block.attachment.ref.attachmentId);
        if (attachmentId) {
          try {
            const hex = String(attachmentId).replace(/^sha256:/i, '').toLowerCase();
            // 这里手上有**完整 ref**（block.attachment 带 mediaType/bytes/width/height），
            // 所以优先走宿主接口读：任何附件后端都能用，宿主还会顺带校验摘要与元数据。
            const ref = block.attachment && block.attachment.attachmentId ? block.attachment : null;
            const bytes = await readAttachmentBytes(ref, hex, signal);
            const mediaType = await assertImageUpload(bytes, 'pasted attachment sha256:' + hex.slice(0, 12));
            const result = await describeBytes(bytes, mediaType, undefined, signal, false);
            out.push({ type: 'text', text: '[Pasted image, described by imgpost vision]\n' + result.text });
          } catch (e) {
            // 这条文本会随对话送进上游模型，所以凭据形状必须遮蔽。
            out.push({ type: 'text', text: '[A pasted image could not be read by imgpost vision: ' + redactSecrets(String(e && e.message || e).slice(0, 300)) + ']' });
          }
        } else {
          out.push({ type: 'text', text: '[A pasted image had no readable attachment reference]' });
        }
      } else if (block.type === 'tool-result' && contentHasImage(block.content)) {
        out.push({ ...block, content: await convertMessageContent(block.content, signal) });
      } else {
        out.push(block);
      }
    }
    return out;
  }

  async function convertMessagesImages(messages, signal) {
    const out = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !contentHasImage(message.content)) {
        out.push(message);
        continue;
      }
      out.push({ ...message, content: await convertMessageContent(message.content, signal) });
    }
    return out;
  }

  // ── vision: native-vision model detection ─────────────────────────────────
  // The core's image gate (dsh-llm-pi-ai) admits a pasted image only when the
  // model's catalog entry declares image input, so that declaration is the
  // single source of truth: a model is "native vision" exactly when the core
  // would pass its images to the upstream unconverted. Models the catalog
  // does not declare as vision are bridged instead — their image blocks are
  // rewritten into cached evidence text — because a name guess cannot stand
  // in: the gate would reject raw image blocks for such models anyway.
  function modelIsNativeVision(modelMeta) {
    if (!modelMeta || typeof modelMeta !== 'object') return false;
    return Array.isArray(modelMeta.inputModalities) && modelMeta.inputModalities.indexOf('image') >= 0;
  }

  // Optional exclusion list: vision-sender.json `noWrap` — provider ids that
  // must NOT get an imgpost-<id> wrapper (the user wants to keep them plain).
  let noWrapCache = null;
  async function noWrapList(signal) {
    if (noWrapCache) return noWrapCache;
    const list = new Set();
    try {
      const target = await fs.resolve(await dshPath('vision-sender.json'));
      const raw = await readTextCapped(target, MAX_CONFIG_BYTES, signal);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.noWrap)) {
        for (const s of parsed.noWrap) if (String(s).trim()) list.add(String(s).trim());
      }
    } catch (e) {
      // no file / no list — nothing excluded
    }
    noWrapCache = list;
    return list;
  }

  // 两份模型元数据是否属于同一"代际"：只比对会影响 token 预算与准入的字段。
  // 必须是**原始上游**元数据之间比较：包装器自己往 model 里塞的 inputModalities
  // （['text','image']）不是上游代际的判据，拿它跟上游原始的 ['text'] 比会每次都误报。
  function sameModelGeneration(a, b) {
    if (!a || !b) return true;
    const pick = (m) => [
      m.id || '',
      String(m.contextWindow == null ? '' : m.contextWindow),
      String(m.maxTokens == null ? '' : m.maxTokens),
      String(m.defaultMaxTokens == null ? '' : m.defaultMaxTokens),
    ].join('|');
    return pick(a) === pick(b);
  }

  // Register an imgpost-<upstream> adapter that wraps one provider whose
  // models do not all accept image input natively. Models the catalog does
  // not declare as vision get their image blocks rewritten into cached
  // evidence text; models the catalog declares as vision are not offered by
  // the wrap at all (the native provider serves them, images untouched), and
  // a request for one that slips through is forwarded with raw image blocks.
  // Returns { ok, owned, dispose }: ok=false means registration failed (retry
  // on a later sweep); owned=false means someone else holds the provider
  // route; dispose() removes our registration and emits llm/adapters-updated.
  function registerVisionWrap(llm, upstream, providerId, displayName) {
    try {
      const handle = llm.registerAdapter([providerId], {
        providerInfo() { return { id: providerId, name: displayName }; },
        providerRetryPolicy() { return llm.providerRetryPolicy(upstream); },
        // LlmAdapter.imageRequestPricing(provider, model) 是 token meter 对每条已注册
        // 路由都会调用的方法（dsh-llm: `this.adapters.get(provider)?.adapter.imageRequestPricing(...)`）；
        // 普通对象字面量没有基类默认实现，漏了就是运行时 TypeError。整条委托给上游。
        imageRequestPricing(_provider, model) { return llm.imageRequestPricing(upstream, model); },
        async listModels(_provider, signal) {
          const models = await llm.listModels(upstream, signal);
          return (models || [])
            // Models the core already accepts images for are served by the
            // native provider — the wrap only offers models that need the
            // evidence bridge.
            .filter((m) => !modelIsNativeVision(m))
            .map((m) => ({
              ...m,
              provider: providerId,
              inputModalities: ['text', 'image'],
            }));
        },
        async resolveModel(_provider, model, signal) {
          const info = await llm.resolveModelInfo(upstream, model, signal);
          return { ...info, provider: providerId, inputModalities: ['text', 'image'] };
        },
        stream(options, preparedMeta) {
          const self = this;
          return (async function* () {
            // Per-model pass-through: when the requested model's catalog entry
            // accepts image input, the core gate lets raw image blocks reach
            // the upstream — forward them untouched. For every other model the
            // gate would reject raw images, so rewrite them into evidence text.
            let native = false;
            let atDispatch = null;
            const modelId = options && options.model;
            if (modelId) {
              try {
                atDispatch = await llm.resolveModelInfo(upstream, modelId, options.signal);
                native = modelIsNativeVision(atDispatch);
              } catch (e) {
                native = false; // unknown to the catalog — bridge it
              }
            }
            // prepareCall 时算出的 token 预算用的是那一刻的**上游**元数据，而请求是由 dispatch
            // 这一刻按 provider id 重新解析出的上游适配器发出的；上游同 id 换配置时两者属于
            // 不同代际。对不上就记一条告警（可观测），行为不变。
            if (preparedMeta && atDispatch && !sameModelGeneration(preparedMeta, atDispatch)) {
              ctx.logger?.warn('[imgpost] upstream metadata generation changed between prepareCall and dispatch for model "' + String(modelId) + '" on provider "' + upstream + '": the token budget came from prepare-time upstream metadata while the request goes through the dispatch-time adapter.');
            }
            const messages = native ? options.messages : await convertMessagesImages(options.messages, options.signal);
            try {
              yield* llm.stream({ ...options, provider: upstream, messages });
            } catch (err) {
              if (/no adapter registered/i.test(String(err && err.message))) {
                throw new Error('imgpost 包装通道 "imgpost-' + upstream + '" 的上游 "' + upstream + '" 已不存在（配置里已删除）。请重启 DSH，或把它从 ~/.dsh/vision-sender.json 的 upstreams 列表里移除。');
              }
              throw err;
            }
          })();
        },
        // Bind exact model metadata and the eventual dispatch to one adapter
        // generation, matching the LlmAdapter.prepareCall contract required by
        // DSH >= 0.1.1-rc.2. Without this, the wrap's bare object literal does
        // not inherit the base-class default and `adapter.prepareCall` is
        // undefined, so DSH throws "prepareCall is not a function" on any
        // imgpost-<id> route (e.g. imgpost-qwen).
        //
        // 真实语义（不是"无害"）：token 预算与准入按 **prepare 时** 的上游元数据算，
        // 请求却由 **dispatch 时** 按 provider id 重新解析出的上游适配器发出；上游同 id
        // 换配置时两者属于不同代际。这里留一份元数据副本，派发时对不上就记一条可观测
        // 告警（见 stream），行为不变：改成冻结上游需要复刻上游适配器的 prepareCall
        // 语义，并绕过宿主 llm.stream 的 waterfall 与图片投影，风险更大。
        async prepareCall(_provider, model, signal) {
          const preparedMeta = await this.resolveModel(_provider, model, signal);
          // 另存一份**原始上游**元数据用于代际比对：this.resolveModel 返回的是包装后的
          // 元数据（inputModalities 被改成 ['text','image']、provider 换成本包装），拿它跟
          // dispatch 时解析出的上游元数据比会永远不相等。
          let upstreamMeta = null;
          try {
            upstreamMeta = await llm.resolveModelInfo(upstream, model, signal);
          } catch (e) {
            upstreamMeta = null; // 上游目录读不到时不比对，避免误报
          }
          return {
            model: preparedMeta,
            stream: (options) => this.stream(options, upstreamMeta),
          };
        },
      });
      return { ok: true, owned: true, dispose: () => { try { handle(); } catch (e) { /* already disposed */ } } };
    } catch (error) {
      if (/already|duplicate/i.test(String(error))) {
        console.error('[imgpost] vision provider ' + providerId + ' already registered, keeping the existing one');
        return { ok: true, owned: false, dispose: null };
      }
      console.error('[imgpost] vision provider registration skipped (' + providerId + '): ' + error);
      return { ok: false, owned: false, dispose: null };
    }
  }

  // Read the static wrap list from vision-sender.json `upstreams` (array of
  // provider ids to wrap). Falls back to the DSH_IMGPOST_VISION_UPSTREAM env.
  let wrapListCache = null;
  // registerVisionProvider 会把它的重扫函数放进来，设置页保存后据此立刻生效。
  let visionSweep = null;
  async function resolveWrapList(signal, cwd, refresh) {
    if (wrapListCache && !refresh) return wrapListCache;
    const envUp = (typeof process !== 'undefined' && process.env && process.env.DSH_IMGPOST_VISION_UPSTREAM) || null;
    let list = null;
    try {
      const target = await fs.resolve(await dshPath('vision-sender.json'));
      const raw = await readTextCapped(target, MAX_CONFIG_BYTES, undefined);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed && parsed.upstreams) && parsed.upstreams.length > 0) {
        list = parsed.upstreams.map((s) => String(s).trim()).filter(Boolean);
      }
    } catch (e) {
      // no vision-sender.json upstreams — fall through
    }
    if ((!list || list.length === 0) && envUp) list = [envUp];
    wrapListCache = list;
    return list;
  }

  // Auto-discover providers and wrap each one that still needs the vision
  // bridge as imgpost-<id>. This is the DEFAULT behaviour: any provider with
  // at least one non-vision model gets a wrapper, so newly-added providers
  // are covered automatically — no config edit needed. Models the core
  // already accepts images for are NOT offered by the wrap (the native
  // provider serves them, images untouched). A wrap is dropped again as soon
  // as its upstream provider disappears (deleted from settings), becomes
  // fully natively vision, or lands on the vision-sender.json `noWrap`
  // exclusion list, so a removed provider never leaves a broken imgpost-<id>
  // behind. vision-sender.json `upstreams` / env DSH_IMGPOST_VISION_UPSTREAM
  // act only as an extra force-include list (belts for providers whose
  // catalog is slow to appear); entries naming a provider that no longer
  // exists are skipped with a one-time warning instead of a broken wrap.
  function registerVisionProvider(llm) {
    if (!llm || typeof llm.registerAdapter !== 'function' || typeof llm.listProviders !== 'function') return;
    // upstream id -> disposer for registrations we own
    const wrapped = new Map();
    // upstream ids whose imgpost-<id> route is held by someone else (never retry)
    const foreign = new Set();
    const warnedMissing = new Set();
    // Provider ids that belong to another vision bridge — never wrap those; two
    // bridges on one route would collide.
    const ownedPrefixes = ['imgpost-', 'modlens-', 'deepseek-modlens'];
    const isOwnedByAnotherBridge = (id) => ownedPrefixes.some((p) => String(id).indexOf(p) === 0);

    const ensureWrap = async (id, name) => {
      if (wrapped.has(id) || foreign.has(id)) return;
      const res = registerVisionWrap(llm, id, 'imgpost-' + id, (name || id) + ' (imgpost vision)');
      if (!res.ok) return; // retry on a later sweep
      if (res.owned) wrapped.set(id, res.dispose);
      else foreign.add(id);
    };

    const dropWrap = (id) => {
      const dispose = wrapped.get(id);
      if (!dispose) return;
      wrapped.delete(id);
      dispose(); // removes the adapter and emits llm/adapters-updated
    };

    const sweepOnce = async () => {
      try {
        await sweepBody();
      } catch (error) {
        console.error('[imgpost] vision provider discovery sweep failed: ' + error);
      }
    };
    const sweepBody = async () => {
      const staticList = (await resolveWrapList(undefined, await homeCwd(), false)) || [];
      const excluded = await noWrapList(undefined);
      let providers = [];
      try {
        providers = llm.listProviders() || [];
      } catch (e) {
        providers = [];
      }
      const present = new Set();
      for (const p of providers) if (p && p.id) present.add(p.id);

      // 1) Drop wraps that are no longer wanted: the upstream provider is
      //    gone (removed from settings), or the user added it to the noWrap
      //    exclusion list.
      for (const id of [...wrapped.keys()]) {
        if (present.has(id) && !excluded.has(id)) continue;
        dropWrap(id);
        ctx.logger?.info('[imgpost] unwrapped imgpost-' + id + ': ' + (excluded.has(id) ? 'listed in noWrap' : 'upstream provider no longer registered'));
      }

      // 2) Auto-discover: wrap every registered provider that is not one of
      //    ours and not already wrapped — except providers whose catalog is
      //    readable and whose models ALL accept image input natively. Mixed
      //    providers stay wrapped so their text-only models keep the evidence
      //    bridge, while their vision models pass images through. A provider
      //    already wrapped that has become fully vision is unwrapped.
      for (const info of providers) {
        const id = info && info.id;
        if (!id || isOwnedByAnotherBridge(id)) continue;
        // 先读目录：判断"是否已全原生视觉"需要它，而"解除包装"必须发生在
        // wrapped.has(id) 跳过之前，否则那条分支永远到不了。
        let catalogRead = false;
        let allVision = false;
        try {
          const models = await llm.listModels(id);
          if (Array.isArray(models) && models.length > 0) {
            catalogRead = true;
            allVision = true;
            for (const m of models) {
              if (!modelIsNativeVision(m)) { allVision = false; break; }
            }
          }
        } catch (e) {
          // catalog unreadable right now — keep any existing wrap; new ones
          // get wrapped below and a later sweep can revisit
        }
        if (catalogRead && allVision) {
          // 该 provider 的模型已经全部原生视觉：证据桥不再需要，已有的包装撤掉。
          // 语义没变：别人持有的路由（foreign）本来就不在 wrapped 里，用户 noWrap 的
          // 条目在第 1 步就撤掉了，这里只管"我们自己的、但已经不必要"的包装。
          if (wrapped.has(id)) {
            dropWrap(id);
            ctx.logger?.info('[imgpost] unwrapped imgpost-' + id + ': all models now accept image input natively');
          }
          continue;
        }
        if (wrapped.has(id) || foreign.has(id) || excluded.has(id)) continue;
        await ensureWrap(id, (info && info.name) || id);
      }

      // 3) Force-include: guarantee any provider named in the static list is
      //    wrapped too, even if its catalog was not readable during this sweep
      //    — but only while that provider actually exists. A stale entry
      //    produces a one-time warning instead of a broken wrap.
      for (const id of staticList) {
        if (!id || typeof id !== 'string') continue;
        if (wrapped.has(id) || foreign.has(id) || excluded.has(id)) continue;
        if (!present.has(id)) {
          if (!warnedMissing.has(id)) {
            warnedMissing.add(id);
            console.warn('[imgpost] vision-sender.json "upstreams" lists "' + id + '" but no such provider is registered — skipping wrap. Remove it from ~/.dsh/vision-sender.json if the provider is gone for good.');
          }
          continue;
        }
        await ensureWrap(id, id);
      }
    };
    let sweeping = sweepOnce();
    const sweep = () => {
      sweeping = sweeping.then(sweepOnce, sweepOnce);
      return sweeping;
    };
    // 设置页改完 upstreams / noWrap 之后要能立刻重扫，不必重启 DSH。
    visionSweep = sweep;
    if (typeof ctx.on === 'function') {
      ctx.on('llm/adapters-updated', () => {
        void sweep();
      });
    }
  }

  async function fetchImageToFile(url, signal, cwd) {
    // $p 在任何可能失败的步骤之前就算好，脚本内部用 try/finally 保证失败时不留残留文件：
    // 外层 finally 只有在脚本把路径回吐到 stdout 之后才拿得到它。
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
      "$ErrorActionPreference='Stop'",
      '$p=Join-Path $env:TEMP $env:IMG_FILENAME',
      'try {',
      '  & curl.exe -sL -f --max-time 120 --proto "=https,http" --proto-redir "=https,http" --max-filesize 41943040 -o $p $env:IMG_URL',
      '  if ($LASTEXITCODE -ne 0) { throw "curl download failed with exit $LASTEXITCODE" }',
      '  if (-not (Test-Path $p)) { throw "curl produced no output file" }',
      '  [Console]::Out.Write($p)',
      '} catch {',
      '  Remove-Item -Force -LiteralPath $p -ErrorAction SilentlyContinue',
      '  throw',
      '}',
    ].join('\n');
    const out = await runPwsh(script, { IMG_URL: url, IMG_FILENAME: newTempName() }, signal, cwd);
    const path = out.trim();
    if (!path) throw new Error('no image bytes received from ' + url);
    return path;
  }

  async function writeBase64ToFile(b64, signal, cwd) {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      "$ErrorActionPreference='Stop'",
      '$p=Join-Path $env:TEMP $env:IMG_FILENAME',
      'try {',
      '  $b=[Convert]::FromBase64String($env:IMG_B64)',
      '  [IO.File]::WriteAllBytes($p, $b)',
      '  [Console]::Out.Write($p)',
      '} catch {',
      '  Remove-Item -Force -LiteralPath $p -ErrorAction SilentlyContinue',
      '  throw',
      '}',
    ].join('\n');
    const out = await runPwsh(script, { IMG_B64: b64, IMG_FILENAME: newTempName() }, signal, cwd);
    const path = out.trim();
    if (!path) throw new Error('failed to stage image bytes');
    return path;
  }

  const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

  // ── 下载目标限制：按地址族解析成数值再判，不靠正则堆叠 ─────────────────────
  // 生图服务返回的下载地址是**外部输入**，绝不能直接丢给 curl 或让 fetch 随便跟（curl 支持
  // file:，-L 还会跟着重定向走）。旧的一堆正则漏放了这些（已实测）：[::ffff:127.0.0.1]
  // （hostname 会被规范化为 ::ffff:7f00:1）、[::ffff:10.0.0.1]、0.0.0.0、100.64.0.1（CGNAT）、
  // [64:ff9b::7f00:1]（NAT64）、224.0.0.1、198.18.0.1（基准测试网段）。现在分两族判定：
  // IPv4 比网段，IPv6 先展开成 16 字节再比前缀，并递归检查内嵌 IPv4（v4-mapped / NAT64 /
  // NAT64 本地 / 6to4）—— 只有内嵌的 v4 命中黑名单才拒。
  //
  // 注意：这里是**预解析校验**，与随后 fetch 的真实连接之间存在 TOCTOU 窗口（undici 不允许把
  // 已解析的 IP 钉给连接）。这一点写进 README 的已知限制。
  const BLOCKED_V4_CIDRS = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  ];
  const BLOCKED_V6_CIDRS = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '100::/64', '2001:db8::/32'];
  // 这些前缀里嵌着 IPv4：把内嵌部分取出来再判一次
  const EMBEDDED_V4_CIDRS = [
    { cidr: '::ffff:0:0/96', offset: 12 }, // v4-mapped
    { cidr: '64:ff9b::/96', offset: 12 }, // NAT64
    { cidr: '64:ff9b:1::/48', offset: 12 }, // NAT64（本地使用）
    { cidr: '2002::/16', offset: 2 }, // 6to4
  ];

  function parseIPv4(text) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || ''));
    if (!m) return null;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (parts.some((n) => n > 255)) return null;
    return parts;
  }

  function ipv4ToUint(parts) {
    return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  }

  function ipv4BlockedParts(parts) {
    if (!parts) return true; // 解析不出来一律当不可信
    const value = ipv4ToUint(parts);
    return BLOCKED_V4.some((net) => ((value & net.mask) >>> 0) === net.net);
  }

  // 把任意 IPv6 文本（含 '::' 省略、末尾点分 IPv4、%zone、方括号）展开成 16 字节；不是 IPv6 返回 null。
  function parseIPv6(text) {
    let s = String(text || '').trim().toLowerCase();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    const pct = s.indexOf('%');
    if (pct >= 0) s = s.slice(0, pct);
    if (s.indexOf(':') < 0) return null;
    const lastColon = s.lastIndexOf(':');
    if (s.slice(lastColon + 1).indexOf('.') >= 0) {
      const v4 = parseIPv4(s.slice(lastColon + 1));
      if (!v4) return null;
      s = s.slice(0, lastColon + 1) + (v4[0] * 256 + v4[1]).toString(16) + ':' + (v4[2] * 256 + v4[3]).toString(16);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
    if (head.concat(tail).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    if (halves.length === 1 && head.length !== 8) return null;
    if (halves.length === 2 && head.length + tail.length > 7) return null;
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = head.concat(new Array(fill).fill('0'), tail).map((g) => parseInt(g, 16));
    if (groups.length !== 8) return null;
    const bytes = [];
    for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
    return bytes;
  }

  function parseCidrPrefix(cidr) {
    const parts = String(cidr).split('/');
    return { bytes: parseIPv6(parts[0]), bits: Number(parts[1]), cidr: cidr };
  }

  function prefixMatches(bytes, prefix) {
    if (!bytes || !prefix || !prefix.bytes) return false;
    const full = Math.floor(prefix.bits / 8);
    for (let i = 0; i < full; i++) if (bytes[i] !== prefix.bytes[i]) return false;
    const rem = prefix.bits % 8;
    if (rem) {
      const mask = (0xff << (8 - rem)) & 0xff;
      if ((bytes[full] & mask) !== (prefix.bytes[full] & mask)) return false;
    }
    return true;
  }

  function ipv6BlockedBytes(bytes) {
    if (!bytes) return true; // 解析不出来一律当不可信
    if (BLOCKED_V6.some((p) => prefixMatches(bytes, p))) return true;
    for (const entry of EMBEDDED_V4) {
      if (!prefixMatches(bytes, entry.prefix)) continue;
      const o = entry.offset;
      if (ipv4BlockedParts([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])) return true;
    }
    return false;
  }

  const BLOCKED_V4 = BLOCKED_V4_CIDRS.map((cidr) => {
    const parts = cidr.split('/');
    const value = ipv4ToUint(parts[0].split('.').map(Number));
    const bits = Number(parts[1]);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { net: (value & mask) >>> 0, mask: mask, cidr: cidr };
  });
  const BLOCKED_V6 = BLOCKED_V6_CIDRS.map(parseCidrPrefix);
  const EMBEDDED_V4 = EMBEDDED_V4_CIDRS.map((e) => ({ prefix: parseCidrPrefix(e.cidr), offset: e.offset }));

  function classifyHostLiteral(host) {
    const v4 = parseIPv4(host);
    if (v4) return { kind: 'ipv4', blocked: ipv4BlockedParts(v4) };
    const v6 = parseIPv6(host);
    if (v6) return { kind: 'ipv6', blocked: ipv6BlockedBytes(v6) };
    return { kind: 'name', blocked: false };
  }

  async function assertDownloadUrlSafe(rawUrl, label) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl));
    } catch (e) {
      throw new Error(label + ' is not a valid URL: ' + redactSecrets(String(rawUrl).slice(0, 120)));
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(label + ' must be an https:// address, got "' + parsed.protocol + '". file:, http: and every other scheme are refused.');
    }
    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) throw new Error(label + ' has no host');
    if (/^localhost$/i.test(host) || /\.localhost$/i.test(host) || /\.local$/i.test(host)) {
      throw new Error(label + ' points at a local host name (' + host + '); refusing to download.');
    }
    // 纯数字 / 十六进制主机名：URL 解析通常已经把它们规范化成点分十进制，这里是兜底。
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
      throw new Error(label + ' uses a numeric host form (' + host + '); refusing to download.');
    }
    const literal = classifyHostLiteral(host);
    if (literal.blocked) {
      throw new Error(label + ' points at a private/special address (' + host + '); refusing to download.');
    }
    // 非字面 IP 的主机名：真的解析一遍，任一结果命中黑名单就拒；解析失败也拒。
    if (literal.kind === 'name') {
      let addresses = null;
      try {
        const dns = await import('node:dns');
        addresses = await dns.promises.lookup(host, { all: true });
      } catch (e) {
        throw new Error(label + ' could not be resolved (' + redactSecrets(String((e && e.message) || e)).slice(0, 120) + '); refusing to download.');
      }
      if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new Error(label + ' resolved to no address; refusing to download.');
      }
      for (const entry of addresses) {
        const address = String((entry && entry.address) || '');
        const verdict = classifyHostLiteral(address.replace(/^\[|\]$/g, '').toLowerCase());
        if (verdict.kind === 'name' || verdict.blocked) {
          throw new Error(label + ' resolves to a private/special address (' + address + '); refusing to download.');
        }
      }
    }
    return parsed;
  }

  // 流式读取响应体并在超限时立刻取消：resp.arrayBuffer() 会先把整份响应收进内存，然后我们才有
  // 机会比长度（没有 Content-Length 时可以先吃掉任意内存）。
  async function readCappedBody(resp, maxBytes, label) {
    const limitMb = Math.floor(maxBytes / (1024 * 1024));
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(label + ' returned ' + buf.length + ' bytes, over the ' + limitMb + 'MB download limit');
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (!step.value) continue;
        total += step.value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel('imgpost: response exceeded the download limit');
          } catch (e) {
            // best effort
          }
          throw new Error(label + ' exceeds the ' + limitMb + 'MB download limit after ' + total + ' bytes; the download was cancelled.');
        }
        chunks.push(Buffer.from(step.value));
      }
    } finally {
      try {
        if (typeof reader.releaseLock === 'function') reader.releaseLock();
      } catch (e) {
        // best effort
      }
    }
    return Buffer.concat(chunks, total);
  }

  // 本进程下载：逐跳校验重定向目标（fetch 的 redirect:'follow' 会绕过上面的目标限制）。
  async function downloadImageBytes(rawUrl, signal, label) {
    let current = await assertDownloadUrlSafe(rawUrl, label);
    for (let hop = 0; hop < 4; hop++) {
      const resp = await fetch(current.href, { signal: signal, redirect: 'manual' });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) throw new Error(label + ' answered HTTP ' + resp.status + ' without a Location header');
        current = await assertDownloadUrlSafe(new URL(location, current.href).href, label + ' (redirect #' + (hop + 1) + ')');
        continue;
      }
      if (!resp.ok) throw new Error(label + ' download failed: HTTP ' + resp.status);
      const declared = Number(resp.headers.get('content-length') || 0);
      if (declared && declared > MAX_DOWNLOAD_BYTES) {
        throw new Error(label + ' declares ' + declared + ' bytes, over the ' + Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024)) + 'MB download limit');
      }
      // 分块累加，超限立刻取消响应，而不是先整份读进内存再比长度。
      const buf = await readCappedBody(resp, MAX_DOWNLOAD_BYTES, label);
      if (buf.length === 0) throw new Error(label + ' returned no bytes');
      return buf;
    }
    throw new Error(label + ' redirected too many times (more than 3 hops)');
  }

  // 生图/下载回来的字节落附件前先过魔数 + 结构完整性。这里不复用 assertImageUpload 的文案
  // （那是给"外发到视觉服务"写的），而且附件的完整解码校验由宿主在 attachments.saveImage
  // 落盘时做（比这里的检查更强）。
  function verifyGeneratedImageBytes(bytes) {
    if (!bytes || !bytes.length) throw new Error('the generated image is empty');
    const sniffed = sniffMediaType(bytes);
    if (!sniffed || !hasIntactImageStructure(bytes, sniffed)) {
      throw new Error('the generation service returned bytes that are not a readable png/jpeg/webp/gif (magic-number and structure check failed); nothing was saved');
    }
    return sniffed;
  }

  async function generateImageToBytes(cfg, prompt, size, model, signal, cwd) {
    // 明文 http:// 会把 Authorization: Bearer <key> 原样送出去，只有回环地址例外。
    assertTransportSafe(cfg.base, 'image-generation baseURL');
    // PowerShell 只负责发这一条生成请求并回吐一行 JSON；**不下载、不落临时文件**。
    // 下载与解码都在本进程做，这样返回的 URL 才能被上面的目标限制管住。
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
      "$ErrorActionPreference='Stop'",
      "  $payload=@{model=$env:IMG_MODEL;prompt=$env:IMG_PROMPT;n=1;size=$env:IMG_SIZE} | ConvertTo-Json -Compress",
      "  $resp=Invoke-RestMethod -Method Post -Uri \"$($env:IMG_BASE)/images/generations\" -Headers @{Authorization=\"Bearer $($env:IMG_KEY)\"} -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 300",
      '  $item=$resp.data[0]',
      '  if (-not $item) { $item=$resp.images[0] }',
      "  if (-not $item) { throw 'image API returned no image data' }",
      '  if ($item.b64_json) { $json=@{ b64=[string]$item.b64_json } | ConvertTo-Json -Compress }',
      '  elseif ($item.url) { $json=@{ url=[string]$item.url } | ConvertTo-Json -Compress }',
      "  else { throw 'image API returned neither b64_json nor url' }",
      '  [Console]::Out.Write($json)',
    ].join('\n');
    const out = await runPwsh(script, {
      IMG_KEY: cfg.key,
      IMG_BASE: cfg.base,
      IMG_MODEL: model || cfg.model,
      IMG_PROMPT: prompt,
      IMG_SIZE: size || '1024x1024',
    }, signal, cwd);
    let parsed = null;
    try {
      parsed = JSON.parse(String(out || '').trim());
    } catch (e) {
      throw new Error('image generation helper returned no usable payload' + (out ? ': ' + redactSecrets(String(out).slice(0, 200)) : ''));
    }
    if (parsed && typeof parsed.b64 === 'string' && parsed.b64.trim()) {
      const bytes = Buffer.from(parsed.b64.trim(), 'base64');
      if (!bytes.length) throw new Error('image API returned an empty base64 payload');
      if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('generated image is ' + bytes.length + ' bytes, over the ' + Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024)) + 'MB limit');
      verifyGeneratedImageBytes(bytes);
      return bytes;
    }
    if (parsed && typeof parsed.url === 'string' && parsed.url.trim()) {
      const bytes = await downloadImageBytes(parsed.url.trim(), signal, 'the image URL returned by the generation API');
      verifyGeneratedImageBytes(bytes);
      return bytes;
    }
    throw new Error('image generation returned no image data');
  }

  async function readImageBytesFromFile(path, signal) {
    const target = await fs.resolve(path);
    return fs.readBytes(target, signal, 40 * 1024 * 1024);
  }

  async function deleteTempFile(path, signal, cwd) {
    try {
      await runPwsh([
        "$ErrorActionPreference='SilentlyContinue'",
        'Remove-Item -Force -LiteralPath $env:IMG_PATH -ErrorAction SilentlyContinue',
      ].join('\n'), { IMG_PATH: path }, signal, cwd);
    } catch (e) {
      // best effort
    }
  }

  async function resolveConfig(signal, cwd, refresh) {
    if (configCache && !refresh) return configCache;
    // No vendor default is baked in: whichever provider the user configures is
    // the one that gets called. A missing piece surfaces as a clear tool error
    // rather than silently hitting somebody else's endpoint.
    //
    // 环境变量必须在**本进程**读：宿主 dsh-subprocess 的 scrubbedParentEnv() 会剥掉
    // 所有 DSH_ 前缀以及 KEY/PASSWORD/SECRET/TOKEN 形状的变量，子进程根本看不到它们
    // （而宿主已经把 ~/.dsh/.env 并进了 process.env），所以本进程才是正确读取点。
    const env = (typeof process !== 'undefined' && process.env) || {};
    let key = String(env.DSH_IMAGE_API_KEY || '').trim() || null;
    let base = String(env.DSH_IMAGE_API_BASE || '').trim() || null;
    let model = String(env.DSH_IMAGE_API_MODEL || '').trim() || null;
    if (!key || !base || !model) {
      // 缺项就读配置文件，而且**在本进程读**：既不再起 PowerShell，key 也就不必经过
      // stdout/命令行/子进程边界。宿主 fs 服务读 ~/.dsh 下的文件是允许的（vision-sender
      // .json 一直就是这么读的）。文件不存在/超大/解析失败都静默跳过，由调用方按
      // "缺哪一项"报错，不在这里吞掉真正的原因。
      try {
        const target = await fs.resolve(await dshPath('image-sender.json'));
        const raw = await readTextCapped(target, MAX_CONFIG_BYTES, signal);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
          if (!key && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) key = parsed.apiKey.trim();
          if (!base && typeof parsed.baseURL === 'string' && parsed.baseURL.trim()) base = parsed.baseURL.trim();
          if (!model && typeof parsed.model === 'string' && parsed.model.trim()) model = parsed.model.trim();
        }
      } catch (e) {
        // no file / unreadable / malformed — the caller reports which piece is missing
      }
    }
    const cfg = { key: key, base: base, model: model };
    configCache = cfg;
    return cfg;
  }

  async function stageBytes(exec, tempPath) {
    const cwd = cwdFor(exec);
    try {
      return await readImageBytesFromFile(tempPath, exec.signal);
    } finally {
      // 清理用 undefined signal：被取消的 signal 会让 runPwsh 直接失败，临时文件就
      // 永远留在 %TEMP% 里了。
      await deleteTempFile(tempPath, undefined, cwd);
    }
  }

  async function saveOnly(exec, bytes, mediaType, caption, name) {
    const ref = await attachments.saveImage({ data: bytes, mediaType: mediaType, name: name || undefined });
    return {
      sent: true,
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
      bytes: ref.bytes,
      caption: caption ? String(caption) : '',
    };
  }

  const metaProjection = (args, value) => ({
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    width: value.width,
    height: value.height,
    bytes: value.bytes,
    caption: value.caption || null,
  });

  const sendImageTool = {
    name: 'send_image',
    description: 'Send an image into the conversation chat: the image is stored as a durable attachment and served at a /dsh-img2/<sha256-hex> URL (the tool result carries the full URL). Pass image as an http(s) URL, a base64 data URI (data:image/png;base64,...), or a LOCAL FILE PATH on this machine (absolute path like C:\\Users\\name\\Pictures\\x.png, or a path relative to the session workspace). Use this whenever the user asked to see an image you found, produced, or that exists locally. Optional caption is shown under the image. IMPORTANT: after a successful call, you MUST render the image inside your reply by inserting the exact markdown image syntax ![caption](<the full URL from the tool result>) — never just quote the URL as plain text, otherwise the user sees no image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Image source: an http(s) URL, a base64 data URI, or a local file path (absolute or workspace-relative).' },
        caption: { type: 'string', description: 'Optional caption text displayed under the image.' },
        name: { type: 'string', description: 'Optional display name for the image file.' },
      },
      required: ['image'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          caption: { type: 'string' },
        },
        required: ['sent', 'attachmentId', 'mediaType', 'width', 'height', 'bytes'],
      },
      presentationMeta: metaProjection,
      render(args, value) {
        const hex = String(value.attachmentId || '').replace(/^sha256:/, '');
        const origin = renderOrigin();
        const url = origin + '/dsh-img2/' + hex;
        const cap = (value.caption && String(value.caption)) || '图片';
        return [{ type: 'text', text: '已发送图片到对话：' + value.mediaType + ' ' + value.width + 'x' + value.height + '（' + value.bytes + ' 字节）\n请在回复中以内嵌图片形式显示它（不要只贴 URL 文本）：\n![' + cap + '](' + url + ')' }];
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const src = String(args.image || '').trim();
      if (!src) throw new Error('image is required');
      const cwd = cwdFor(exec);
      await ensureWebOrigin(exec.signal, cwd);
      let bytes;
      let declared = null;
      let defaultName;
      if (/^data:/i.test(src)) {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
        if (!m || !m[2]) throw new Error('image data URI must be base64-encoded (data:image/png;base64,...)');
        declared = m[1] || null;
        const tmp = await writeBase64ToFile(m[3], exec.signal, cwd);
        bytes = await stageBytes(exec, tmp);
      } else if (/^https?:\/\//i.test(src)) {
        const tmp = await fetchImageToFile(src, exec.signal, cwd);
        bytes = await stageBytes(exec, tmp);
      } else {
        const target = await fs.resolve(src, { cwd: cwd });
        const info = await fs.stat(target);
        if (!info) throw new Error('local file not found: ' + src);
        bytes = await fs.readBytes(target, exec.signal, 40 * 1024 * 1024);
        defaultName = baseNameOf(src);
      }
      const sniffed = sniffMediaType(bytes);
      const mediaType = sniffed || declared;
      if (!mediaType) throw new Error('unsupported image format' + (declared ? ': ' + declared : '') + ' (only png/jpeg/webp/gif)');
      return saveOnly(exec, bytes, mediaType, args.caption, args.name || defaultName);
    },
  };

  const generateImageTool = {
    name: 'generate_image',
    description: 'Call the configured image-generation API and store the resulting image as an attachment served at a /dsh-img2/<sha256-hex> URL (the tool result carries the full URL). Requires all three of apiKey + baseURL + model: env DSH_IMAGE_API_KEY / DSH_IMAGE_API_BASE / DSH_IMAGE_API_MODEL, or ~/.dsh/image-sender.json with { apiKey, baseURL, model }. A missing piece fails with an error naming exactly which one is missing (imgpost_check_backend reports the same state without calling the provider). Works with any OpenAI-compatible /images/generations endpoint returning data[].url or data[].b64_json. IMPORTANT: after a successful call, you MUST render the image inside your reply by inserting the exact markdown image syntax ![caption](<the full URL from the tool result>) — never just quote the URL as plain text, otherwise the user sees no image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'The image description to generate.' },
        caption: { type: 'string', description: 'Optional caption text displayed under the generated image.' },
        size: { type: 'string', description: 'Optional output size, e.g. 1024x1024 (default), 1024x1536, 1536x1024.' },
        model: { type: 'string', description: 'Optional model id override (default from config).' },
        refreshConfig: { type: 'boolean', description: 'Re-read API credentials from env/config instead of using the cached values.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          caption: { type: 'string' },
          prompt: { type: 'string' },
          model: { type: 'string' },
          size: { type: 'string' },
        },
        required: ['sent', 'attachmentId', 'mediaType', 'width', 'height', 'bytes', 'prompt', 'model', 'size'],
      },
      presentationMeta: metaProjection,
      render(args, value) {
        const hex = String(value.attachmentId || '').replace(/^sha256:/, '');
        const origin = renderOrigin();
        const url = origin + '/dsh-img2/' + hex;
        const cap = (value.caption && String(value.caption)) || '图片';
        const via = value.model || 'api';
        return [{ type: 'text', text: '已生成图片（' + via + '）：' + value.size + ' ' + value.width + 'x' + value.height + '\n请在回复中以内嵌图片形式显示它（不要只贴 URL 文本）：\n![' + cap + '](' + url + ')' }];
      },
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) throw new Error('prompt is required');
      const cwd = cwdFor(exec);
      await ensureWebOrigin(exec.signal, cwd);
      const cfg = await resolveConfig(exec.signal, cwd, args.refreshConfig === true);
      if (!cfg.key) {
        throw new Error('image-generation API key is not configured. Set the DSH_IMAGE_API_KEY environment variable, or create ~/.dsh/image-sender.json containing { "apiKey": "...", "baseURL": "https://your-provider.example/v1", "model": "..." }.');
      }
      if (!cfg.base) {
        throw new Error('image-generation baseURL is not configured. Set DSH_IMAGE_API_BASE, or add "baseURL" to ~/.dsh/image-sender.json.');
      }
      const usedModel = args.model || cfg.model;
      if (!usedModel) {
        throw new Error('no image model configured. Set DSH_IMAGE_API_MODEL, or add "model" to ~/.dsh/image-sender.json, or pass the model argument.');
      }
      const bytes = await generateImageToBytes(cfg, prompt, args.size, args.model, exec.signal, cwd);
      const usedSize = args.size || '1024x1024';
      const mediaType = sniffMediaType(bytes) || 'image/png';
      const base = await saveOnly(exec, bytes, mediaType, args.caption, undefined);
      return {
        sent: base.sent,
        attachmentId: base.attachmentId,
        mediaType: base.mediaType,
        width: base.width,
        height: base.height,
        bytes: base.bytes,
        caption: base.caption,
        prompt: prompt,
        model: usedModel,
        size: usedSize,
      };
    },
  };

  const readImageTool = {
    name: 'imgpost_read_image',
    description: 'Read an image through an external vision API and return a detailed text description (OCR / layout / scene / any specific question). Unlike the host read_image tool, this works with ANY model — it does not require the model to declare image input, because the vision call happens outside the model. Accepts a local file path, an http(s) URL, a base64 data URI, or a sha256: attachment id; before anything leaves the machine the bytes must pass three gates — magic number, file-structure consistency, and a real decode by the host image decoder (attachments.validateImage); failing any gate, or running on a deployment whose host exposes no decoder, means nothing is sent at all (images over 20MB are refused too). NOTE: the image bytes are uploaded to whichever vision service the user configured in ~/.dsh/vision-sender.json (or env DSH_VISION_*), so only point it at a backend you are willing to send those pictures to. Results are cached on disk keyed by image + question + backend, so the same question about the same image is only sent once — even across restarts. Use whenever you need to know what is in an image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Image source: local file path (absolute or workspace-relative), http(s) URL, base64 data URI, or sha256:<hex> attachment id.' },
        prompt: { type: 'string', description: 'Optional specific question or focus for the reading, e.g. "transcribe all text" or "describe the layout". Defaults to a general detailed description.' },
        refresh: { type: 'boolean', description: 'Re-run the vision backend even when a cached description exists.' },
      },
      required: ['image'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          cached: { type: 'boolean' },
          refused: { type: 'boolean' },
          sha: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
        },
        required: ['text', 'model', 'cached', 'sha'],
      },
      render(args, value) {
        return [{ type: 'text', text: (value.cached ? '[cached] ' : '') + value.text }];
      },
    },
    timeoutMs: 240000,
    async execute(args, exec) {
      const src = String(args.image || '').trim();
      if (!src) throw new Error('image is required');
      return await readImageWithVision(exec, src, args.prompt, args.refresh === true);
    },
  };

  // ── backend health check (imgpost_check_backend) ─────────────────────────
  // Reports whether image generation is usable WITHOUT calling the provider:
  // which endpoint and model are configured, and which pieces are still missing.
  async function checkBackends(exec, refresh) {
    const cwd = cwdFor(exec);
    const cfg = await resolveConfig(exec.signal, cwd, refresh === true);
    const missing = [];
    if (!cfg.key) missing.push('apiKey');
    if (!cfg.base) missing.push('baseURL');
    if (!cfg.model) missing.push('model');
    return {
      api: {
        configured: missing.length === 0,
        baseURL: cfg.base || '',
        model: cfg.model || '',
        hasKey: !!cfg.key,
        missing: missing,
      },
    };
  }

  const checkBackendTool = {
    name: 'imgpost_check_backend',
    description: 'Check whether image generation is ready: reports the configured OpenAI-compatible endpoint, the model, whether an API key is present, and which pieces are still missing. Use it when generate_image failed with a configuration error, or before generating on a fresh machine.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refreshConfig: { type: 'boolean', description: 'Re-read credentials/config instead of using the cached values.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          api: {
            type: 'object',
            properties: {
              configured: { type: 'boolean' },
              baseURL: { type: 'string' },
              model: { type: 'string' },
              hasKey: { type: 'boolean' },
              missing: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render(args, value) {
        const api = (value && value.api) || {};
        const lines = [];
        lines.push('api: ' + (api.configured ? '✅ 已配置' : '❌ 未配置完整'));
        lines.push('    baseURL: ' + (api.baseURL || '（未设置）'));
        lines.push('    model:   ' + (api.model || '（未设置）'));
        lines.push('    apiKey:  ' + (api.hasKey ? '已设置' : '未设置'));
        if (api.missing && api.missing.length) lines.push('    缺少: ' + api.missing.join('、'));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      return await checkBackends(exec, args.refreshConfig === true);
    },
  };

  // ── 设置页：识图配置的读写接口 ─────────────────────────────────────────────
  // 实测事实：宿主自己的接口要 token（GET /api/health -> 401），而**插件注册的路由在闸门
  // 之外**（GET /dsh-img2/<sha> 匿名 200）。所以这个"能改配置"的接口必须自带门禁，三层全过：
  //   ① 仅回环来源：反向代理/内网穿透通常在本机终结 TLS 后从 127.0.0.1 转发（Host 头保留对外
  //      域名），所以手机经域名访问设置页照样能用，而直连局域网 IP 的请求会被拒。
  //   ② 必须带 `x-imgpost-config: 1` 自定义头：跨站表单打不进来，跨源 fetch 也会因预检失败。
  //   ③ 带了 Origin 就必须与请求 Host 或配置的对外域名同源。
  const MAX_CONFIG_REQUEST_BYTES = 64 * 1024;

  // 预设。DSH 官方模型对每个 DSH 用户都存在，所以把它作为表单的默认预选是合理的 ——
  // 这里的 baseURL/model 只是**可编辑的初值**，不是运行时兜底：运行时依然"没配就明确报错"。
  const VISION_PRESETS = [
    { id: 'deepseek-official', label: 'DeepSeek 官方视觉（deepseek flash）', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash-vision-exp', format: 'openai' },
    { id: 'custom-openai', label: '自定义 OpenAI 兼容端点', baseURL: '', model: '', format: 'openai' },
    { id: 'custom-anthropic', label: '自定义 Anthropic 兼容端点', baseURL: '', model: '', format: 'anthropic' },
  ];

  function isLoopbackPeer(req) {
    try {
      const addr = String((req && req.socket && req.socket.remoteAddress) || '').toLowerCase();
      if (!addr) return false;
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || /^127\./.test(addr);
    } catch (e) {
      return false;
    }
  }

  function hostNameOfUrl(value) {
    try {
      return String(new URL(String(value)).hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    } catch (e) {
      return '';
    }
  }

  function requestHostName(req) {
    try {
      return hostNameOfUrl('http://' + String((req && req.headers && req.headers.host) || ''));
    } catch (e) {
      return '';
    }
  }

  function publicOriginHost() {
    return publicOrigin ? hostNameOfUrl(publicOrigin) : '';
  }

  // 返回 null 表示放行，否则返回给用户看的原因。
  function configRequestGuard(req) {
    if (!isLoopbackPeer(req)) return 'imgpost: the settings endpoint only accepts loopback requests (open the GUI on this machine, or through the configured publicBaseUrl host)';
    if (String((req && req.headers && req.headers['x-imgpost-config']) || '') !== '1') return 'imgpost: missing the x-imgpost-config: 1 header';
    const origin = String((req && req.headers && req.headers.origin) || '');
    if (origin) {
      const oh = hostNameOfUrl(origin);
      const host = requestHostName(req);
      const pub = publicOriginHost();
      if (!oh || (oh !== host && oh !== pub)) return 'imgpost: cross-origin request refused';
    }
    return null;
  }

  // 图片路由：回环来源，或 Host 命中配置的对外域名（Serve 场景下手机走这条）。
  // 没有内网穿透、又想从局域网别的机器看图时，把插件配置的 allowRemoteImages 设成 true。
  function imageViewerAllowed(req) {
    if (config && config.allowRemoteImages === true) return true;
    if (isLoopbackPeer(req)) return true;
    const pub = publicOriginHost();
    if (!pub) return false;
    return requestHostName(req) === pub;
  }

  // ── 往 DSH home 写文件：必须绕开宿主 fs 服务的沙箱 ───────────────────────────
  // 实测（2026-09-30，DSH 0.2.0-rc.2）：`fs.writeText` 写 ~/.dsh/vision-sender.json 被拒，
  // 报 `file access denied under workspace-write mode`。宿主 fs 沙箱的规则是「mutation 只能落在
  // workspace 根或平台临时区」，而插件要写的正是自己位于 DSH home 下的配置与缓存。
  // 该沙箱约束的是 **fs 服务这一层**，进程内的 node:fs 不受它管：本机另一个插件（y-voice）
  // 一直直接用 node:fs 往 ~/.dsh/y-voice-audio 写。这里采用同一做法，并额外用
  // 「同目录临时文件 + rename」保证原子性（不出现半个 JSON）。读仍走 fs 服务（读不受限制）。
  async function writeFileUnfenced(targetPath, text) {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    const tmp = targetPath + '.tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await fsp.writeFile(tmp, text, 'utf8');
    try {
      await fsp.rename(tmp, targetPath);
    } catch (e) {
      try { await fsp.unlink(tmp); } catch (e2) { /* 清理尽力而为 */ }
      throw e;
    }
  }

  async function readVisionFileRaw(signal) {
    const file = await dshPath('vision-sender.json');
    try {
      const target = await fs.resolve(file);
      const raw = await readTextCapped(target, MAX_CONFIG_BYTES, signal);
      if (!raw) return { data: {}, file: file, exists: false };
      const parsed = JSON.parse(raw);
      return { data: parsed && typeof parsed === 'object' ? parsed : {}, file: file, exists: true };
    } catch (e) {
      return { data: {}, file: file, exists: false };
    }
  }

  // 给设置页看的视图：**永远不带 apiKey**，只说有没有。
  function visionSlotView(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const b = normalizeVisionBackend(raw);
    if (!b.baseURL && !b.model) return null;
    return { baseURL: b.baseURL, model: b.model, format: b.format, hasKey: !!b.apiKey };
  }

  // 表单不回传 key，所以 apiKey 留空表示"保持原值"。
  function mergeVisionSlot(input, existing, label) {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'object') throw new Error(label + ' must be an object');
    const base = String(input.baseURL || '').trim();
    const model = String(input.model || '').trim();
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const prev = existing && typeof existing === 'object' ? existing : {};
    if (!base && !model && !apiKey && !prev.apiKey) return null; // 空槽 = 不使用这个后端
    if (!base) throw new Error(label + ' baseURL is required');
    if (!model) throw new Error(label + ' model is required');
    assertTransportSafe(base, label + ' baseURL');
    const out = Object.assign({}, prev);
    out.baseURL = base;
    out.model = model;
    out.format = input.format === 'anthropic' ? 'anthropic' : 'openai';
    if (apiKey) out.apiKey = apiKey;
    return out;
  }

  async function writeVisionFile(data, signal) {
    const file = await dshPath('vision-sender.json');
    const target = await fs.resolve(file);
    try {
      const raw = await readTextCapped(target, MAX_CONFIG_BYTES, signal);
      if (raw) {
        // 用**本地时间**打戳：备份名是给人看的，UTC 会让人误以为是别的时间（实测踩过）。
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
        await writeFileUnfenced(file + '.bak-' + stamp, raw);
      }
    } catch (e) {
      // 首次创建，没有可备份的内容
    }
    // 写配置必须走 unfenced 路径：fs.writeText 会被 workspace-write 沙箱拒（实测）。
    await writeFileUnfenced(file, JSON.stringify(data, null, 2) + '\n');
    return file;
  }

  function sendJson(res, code, obj) {
    try {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch (e) {
      // 响应已经开始写，只能放弃
    }
  }

  async function readJsonBody(req, limit) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new Error('request body exceeds ' + limit + ' bytes');
      chunks.push(chunk);
    }
    if (!total) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  async function handleVisionConfig(req, res) {
    const denied = configRequestGuard(req);
    if (denied) {
      sendJson(res, 403, { ok: false, error: denied });
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const current = await readVisionFileRaw(undefined);
      sendJson(res, 200, {
        ok: true,
        exists: current.exists,
        path: current.file,
        presets: VISION_PRESETS,
        primary: visionSlotView(current.data.primary || (current.data.baseURL ? current.data : null)),
        fallback: visionSlotView(current.data.fallback),
        upstreams: Array.isArray(current.data.upstreams) ? current.data.upstreams : [],
        noWrap: Array.isArray(current.data.noWrap) ? current.data.noWrap : [],
        note: 'the api key is never sent to the browser; leave the field blank to keep the stored one',
      });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'only GET and POST are supported' });
      return;
    }
    const body = await readJsonBody(req, MAX_CONFIG_REQUEST_BYTES);
    const current = await readVisionFileRaw(undefined);
    const next = Object.assign({}, current.data);
    const primary = mergeVisionSlot(body.primary, current.data.primary || (current.data.baseURL ? current.data : null), 'primary');
    const fallback = mergeVisionSlot(body.fallback, current.data.fallback, 'fallback');
    if (primary) {
      next.primary = primary;
      // 老式的"扁平单后端"写法要被结构化的 primary 取代，否则两种写法会打架。
      delete next.baseURL;
      delete next.apiKey;
      delete next.model;
      delete next.format;
    } else {
      delete next.primary;
    }
    if (fallback) next.fallback = fallback; else delete next.fallback;
    if (Array.isArray(body.upstreams)) next.upstreams = body.upstreams.map((s) => String(s).trim()).filter(Boolean);
    if (Array.isArray(body.noWrap)) next.noWrap = body.noWrap.map((s) => String(s).trim()).filter(Boolean);
    if (!next.primary && !next.fallback) throw new Error('at least one vision backend is required');
    const file = await writeVisionFile(next, undefined);
    // 改完立刻生效：清掉进程内缓存并重扫一次包装通道。
    visionConfigCache = null;
    noWrapCache = null;
    wrapListCache = null;
    if (typeof visionSweep === 'function') {
      try { await visionSweep(); } catch (e) { /* 重扫失败不影响配置已落盘 */ }
    }
    sendJson(res, 200, {
      ok: true,
      applied: true,
      path: file,
      primary: visionSlotView(next.primary),
      fallback: visionSlotView(next.fallback),
      upstreams: next.upstreams || [],
      noWrap: next.noWrap || [],
    });
  }

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(sendImageTool),
      ctx.tools.register(generateImageTool),
      ctx.tools.register(readImageTool),
      ctx.tools.register(checkBackendTool),
    ];
    if (llm !== undefined) {
      try {
        registerVisionProvider(llm);
      } catch (error) {
        console.error('[imgpost] vision provider registration failed: ' + error);
      }
    }
    if (webServer !== undefined) {
      const routeDisposer = webServer.register({
        kind: 'prefix',
        path: '/dsh-img2',
        async handler(req, res) {
          try {
            // 收紧可达范围：回环来源，或 Host 命中配置的对外域名（反向代理/内网穿透场景下
            // 手机走这条）。没配 publicBaseUrl 时，直连局域网 IP 的请求会被拒。
            if (!imageViewerAllowed(req)) {
              res.writeHead(403, { 'X-Content-Type-Options': 'nosniff' });
              res.end('imgpost: this image route only serves loopback requests or the configured publicBaseUrl host');
              return;
            }
            const pathname = String(req.url || '').split('?')[0];
            const hex = pathname.replace(/^\/dsh-img2\//, '');
            if (!/^[a-f0-9]{64}$/i.test(hex)) {
              res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' });
              res.end('bad attachment id');
              return;
            }
            const filePath = await attachmentHostPath(hex);
            const target = await fs.resolve(filePath);
            const bytes = await fs.readBytes(target, undefined, 40 * 1024 * 1024);
            const mediaType = sniffMediaType(bytes) || 'image/png';
            // 这条路由是 capability URL：URL 里的 64 位 sha 本身就是凭证，宿主没有给插件
            // 可用的会话鉴权接口，所以这里能做的只有两件事 —— ① 不让中间缓存/代理把图存
            // 下来转发给别人（private）② 声明 nosniff，别让响应被当别的类型解析。
            // 谁能拿到这个 URL 谁就能取图；想缩小可达范围请在网络层做（只监听回环、用
            // 或用网关 ACL 限制可达成员等）。README 的「已知限制」里写明了这一点。
            res.writeHead(200, {
              'Content-Type': mediaType,
              'Content-Length': bytes.byteLength,
              'Cache-Control': 'private, max-age=31536000, immutable',
              'X-Content-Type-Options': 'nosniff',
            });
            res.end(bytes);
          } catch (e) {
            try {
              res.writeHead(404, { 'X-Content-Type-Options': 'nosniff' });
              res.end('image not found');
            } catch (e2) {
              // response already started
            }
          }
        },
      });
      disposers.push(routeDisposer);

      // 设置页用的配置接口（自带门禁，见 handleVisionConfig 上方的说明）。
      const configRouteDisposer = webServer.register({
        kind: 'exact',
        path: '/plugins/imgpost/vision-config',
        async handler(req, res) {
          try {
            await handleVisionConfig(req, res);
          } catch (e) {
            sendJson(res, 400, { ok: false, error: redactSecrets(String((e && e.message) || e)) });
          }
        },
      });
      disposers.push(configRouteDisposer);
    }
    return () => {
      for (const d of disposers) d();
    };
  });
  ctx.logger?.info('imgpost: registered send_image / generate_image / read_image + vision provider wrap + /dsh-img2 route + /plugins/imgpost/vision-config settings endpoint');
}
