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
  // 可配置的对外图片基址：配置了就用它（适配 Tailscale/tailnet 远程访问），
  // 否则回退到运行时探测（webServer.port → DSH_WEB_URL → 默认）。
  const publicOrigin = (config && typeof config.publicBaseUrl === 'string' && /^https?:\/\//i.test(config.publicBaseUrl))
    ? config.publicBaseUrl.replace(/\/+$/, '')
    : null;
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
        // 优先用配置的对外基址（Tailscale 远程访问时，手机/电脑共用 tailnet HTTPS）。
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

  function assertImageUpload(bytes, sourceLabel) {
    if (!bytes || bytes.length === 0) throw new Error(sourceLabel + ': no bytes to read');
    if (bytes.length > MAX_VISION_IMAGE_BYTES) {
      throw new Error(sourceLabel + ': ' + bytes.length + ' bytes exceeds the ' + Math.floor(MAX_VISION_IMAGE_BYTES / (1024 * 1024)) + 'MB limit for a request to an external vision service. Nothing was sent.');
    }
    const sniffed = sniffMediaType(bytes);
    if (!sniffed) {
      throw new Error(sourceLabel + ': not a readable image (png/jpeg/webp/gif only). Nothing was sent to the vision service.');
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

  // 只有"同一次提问 + 当前配置里真实存在的后端"写的记录才算命中：
  // ①记录里的 key 必须与本次期望的文件名一致；
  // ②记录里的 backend 必须是当前 primary/fallback 之一的身份串。
  // 旧版本写的记录没有 key/backend 字段，一律视为未命中并重新识图一次，随后按新格式重写
  // （否则换了后端仍会读到上一个后端留下的答案）。
  async function readVisionCache(name, acceptableIdents) {
    try {
      const target = await fs.resolve(await dshPath('imgpost-vision-cache', name + '.json'));
      const raw = await readTextCapped(target, MAX_CACHE_ENTRY_BYTES, undefined);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.text !== 'string' || !parsed.text) return null;
      if (parsed.key !== name) return null;
      const ident = typeof parsed.backend === 'string' ? parsed.backend : '';
      if (!ident || acceptableIdents.indexOf(ident) < 0) return null;
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

  async function writeVisionCache(name, text, model, refused, ident) {
    // 落盘内容里没有任何凭据；ident 是 后端身份串（baseURL|model|format），不是 key。
    const payload = JSON.stringify({ text: text, model: model || '', savedAt: Date.now(), refused: refused === true, key: name, backend: ident || '' });
    // 优先走宿主的 fs 服务：正文不再出现在命令行里（同机其它进程看不到），也不再经过
    // 子进程。缓存目录不存在时（首次写入）fs.writeText 会失败，此时才回落到
    // PowerShell：由它建目录并写入；此后的写入都走快路径。
    try {
      const path = await import('node:path');
      const target = await fs.resolve(path.join(await dshPath('imgpost-vision-cache'), name + '.json'));
      await fs.writeText(target, payload);
      return;
    } catch (e) {
      // fall through to the PowerShell fallback below
    }
    try {
      const dir = await dshPath('imgpost-vision-cache');
      const escaped = payload.replace(/'/g, "''");
      const script = [
        "$ErrorActionPreference='Stop'",
        '$d=' + "'" + dir.replace(/'/g, "''") + "'",
        'if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }',
        '$p=Join-Path $d $env:CACHE_NAME',
        "[IO.File]::WriteAllText($p, '" + escaped + "', [Text.UTF8Encoding]::new($false))",
      ].join('\n');
      await runPwsh(script, { CACHE_NAME: name + '.json' }, undefined, await homeCwd());
    } catch (e) {
      // cache write is best-effort; never fail the read for it
    }
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
  async function describeBytes(bytes, mediaType, prompt, signal, refresh) {
    // 这一层是所有"发往外部视觉服务"的必经之路：只放行魔数可识别的图片字节，
    // 声明出来的 mediaType 不作数（传 JSON/凭据进来会在这一句被挡下）。
    mediaType = assertImageUpload(bytes, 'vision input');
    const sha = await sha256OfBytes(bytes);
    // 缓存命中要核对后端身份，所以先把后端解析出来（resolveVisionConfig 有内存缓存，
    // 代价只有首次一次文件读）。
    const cfg = await resolveVisionConfig(signal, await homeCwd(), refresh);
    const idents = [backendIdent(cfg.primary), backendIdent(cfg.fallback)].filter(Boolean);
    const cacheName = await visionCacheName(sha, prompt);
    if (!refresh) {
      const cached = await readVisionCache(cacheName, idents);
      if (isCacheEntryUsable(cached)) {
        // 负缓存（两个后端都因内容策略拒绝了这张图）只在 TTL 内命中：过期后重新尝试，
        // 而不是把一次拒绝永久钉在磁盘上。显式 refresh 永远重试。
        return { text: cached.text, model: cached.model || '', cached: true, refused: cached.refused === true, sha: sha, mediaType: mediaType, bytes: bytes.length };
      }
    }
    let lastError = null;
    let lastRefusalIdent = null;
    if (cfg.primary) {
      try {
        const text = await callVisionBackend(cfg.primary, bytes, mediaType, prompt, signal);
        // A refusal/policy answer is not a usable description: don't cache it,
        // and treat it as a failure so the fallback backend gets a chance.
        if (!isUsefulVisionText(text)) {
          lastRefusalIdent = backendIdent(cfg.primary);
          throw new Error('vision backend declined: ' + redactSecrets(text.slice(0, 120)));
        }
        await writeVisionCache(cacheName, text, cfg.primary.model, false, backendIdent(cfg.primary));
        return { text: text, model: cfg.primary.model, cached: false, sha: sha, mediaType: mediaType, bytes: bytes.length };
      } catch (e) {
        lastError = e;
      }
    }
    if (cfg.fallback) {
      try {
        const text = await callVisionBackend(cfg.fallback, bytes, mediaType, prompt, signal);
        if (!isUsefulVisionText(text)) {
          lastRefusalIdent = backendIdent(cfg.fallback);
          throw new Error('vision backend declined: ' + redactSecrets(text.slice(0, 120)));
        }
        await writeVisionCache(cacheName, text, cfg.fallback.model, false, backendIdent(cfg.fallback));
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
      // 负缓存也要带后端身份：换掉后端之后这次拒绝不再无条件生效。
      const negIdent = lastRefusalIdent || backendIdent(cfg.fallback) || backendIdent(cfg.primary);
      await writeVisionCache(cacheName, declinedText, (cfg.fallback && cfg.fallback.model) || (cfg.primary && cfg.primary.model) || '', true, negIdent);
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
      const target = await fs.resolve(await dshPath('attachments', 'v1', 'objects', hex.slice(0, 2), hex));
      bytes = await fs.readBytes(target, exec.signal, 40 * 1024 * 1024);
      mediaType = assertImageUpload(bytes, 'attachment sha256:' + hex.slice(0, 12));
    } else if (/^data:/i.test(src)) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m || !m[2]) throw new Error('image data URI must be base64-encoded (data:image/png;base64,...)');
      bytes = Buffer.from(m[3], 'base64');
      // data URI 里声明的 MIME（m[1]）只是参考：实际格式以魔数为准，识别不出就拒绝，
      // 否则一个 data:application/json;base64,... 也会被原样传去外部视觉服务。
      mediaType = assertImageUpload(bytes, 'image data URI');
    } else if (/^https?:\/\//i.test(src)) {
      const tmp = await fetchImageToFile(src, exec.signal, cwd);
      try {
        bytes = await readImageBytesFromFile(tmp, exec.signal);
      } finally {
        // 清理必须用 undefined signal：调用方的 signal 可能已经被取消，runPwsh 会
        // 立刻失败，文件就永远留在 %TEMP% 里了。
        await deleteTempFile(tmp, undefined, cwd);
      }
      mediaType = assertImageUpload(bytes, 'downloaded file from ' + String(src).slice(0, 80));
    } else {
      const target = await fs.resolve(src, { cwd: cwd });
      bytes = await fs.readBytes(target, exec.signal, 40 * 1024 * 1024);
      mediaType = assertImageUpload(bytes, 'file ' + String(src).slice(0, 120));
    }
    const result = await describeBytes(bytes, mediaType, prompt, exec.signal, refresh);
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
            const target = await fs.resolve(await dshPath('attachments', 'v1', 'objects', hex.slice(0, 2), hex));
            const bytes = await fs.readBytes(target, signal, 40 * 1024 * 1024);
            const mediaType = assertImageUpload(bytes, 'pasted attachment sha256:' + hex.slice(0, 12));
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
  function sameModelGeneration(a, b) {
    if (!a || !b) return true;
    const pick = (m) => [
      m.id || '',
      String(m.contextWindow == null ? '' : m.contextWindow),
      String(m.maxTokens == null ? '' : m.maxTokens),
      Array.isArray(m.inputModalities) ? m.inputModalities.join(',') : '',
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
            // prepareCall 时算出的 token 预算用的是那一刻的上游元数据，而请求是由 dispatch
            // 这一刻按 provider id 重新解析出的上游适配器发出的；上游同 id 换配置时两者属于
            // 不同代际。对不上就记一条告警（可观测），行为不变。
            if (preparedMeta && atDispatch && !sameModelGeneration(preparedMeta, atDispatch)) {
              ctx.logger?.warn('[imgpost] imgpost-' + upstream + ' adapter generation changed between prepareCall and dispatch for model "' + String(modelId) + '": the token budget came from prepare-time metadata while the request goes through the dispatch-time adapter.');
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
          return {
            model: preparedMeta,
            stream: (options) => this.stream(options, preparedMeta),
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
      '  & curl.exe -sL -f --max-time 120 -o $p $env:IMG_URL',
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

  async function generateImageToFile(cfg, prompt, size, model, signal, cwd) {
    // 明文 http:// 会把 Authorization: Bearer <key> 原样送出去，只有回环地址例外。
    assertTransportSafe(cfg.base, 'image-generation baseURL');
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
      "$ErrorActionPreference='Stop'",
      '$p=Join-Path $env:TEMP $env:IMG_FILENAME',
      'try {',
      "  $payload=@{model=$env:IMG_MODEL;prompt=$env:IMG_PROMPT;n=1;size=$env:IMG_SIZE} | ConvertTo-Json -Compress",
      "  $resp=Invoke-RestMethod -Method Post -Uri \"$($env:IMG_BASE)/images/generations\" -Headers @{Authorization=\"Bearer $($env:IMG_KEY)\"} -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 300",
      '  $item=$resp.data[0]',
      '  if (-not $item) { $item=$resp.images[0] }',
      '  $b64=$item.b64_json',
      '  if (-not $b64) {',
      '    $u=$item.url',
      '    & curl.exe -sL -f --max-time 120 -o $p $u',
      '    if ($LASTEXITCODE -ne 0) { throw "image URL download failed with exit $LASTEXITCODE" }',
      '    $b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))',
      '  }',
      "  if (-not $b64) { throw 'image API returned no image data' }",
      '  $b=[Convert]::FromBase64String($b64)',
      '  [IO.File]::WriteAllBytes($p, $b)',
      '  [Console]::Out.Write($p)',
      '} catch {',
      '  Remove-Item -Force -LiteralPath $p -ErrorAction SilentlyContinue',
      '  throw',
      '}',
    ].join('\n');
    const out = await runPwsh(script, {
      IMG_KEY: cfg.key,
      IMG_BASE: cfg.base,
      IMG_MODEL: model || cfg.model,
      IMG_PROMPT: prompt,
      IMG_SIZE: size || '1024x1024',
      IMG_FILENAME: newTempName(),
    }, signal, cwd);
    const path = out.trim();
    if (!path) throw new Error('image generation returned no image data');
    return path;
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
      const tempPath = await generateImageToFile(cfg, prompt, args.size, args.model, exec.signal, cwd);
      const usedSize = args.size || '1024x1024';
      const bytes = await stageBytes(exec, tempPath);
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
    description: 'Read an image through an external vision API and return a detailed text description (OCR / layout / scene / any specific question). Unlike the host read_image tool, this works with ANY model — it does not require the model to declare image input, because the vision call happens outside the model. Accepts a local file path, an http(s) URL, a base64 data URI, or a sha256: attachment id; the bytes must be a real png/jpeg/webp/gif (checked by magic number, 20MB limit), and anything else is refused before a request is made. NOTE: the image bytes are uploaded to whichever vision service the user configured in ~/.dsh/vision-sender.json (or env DSH_VISION_*), so only point it at a backend you are willing to send those pictures to. Results are cached on disk keyed by image + question + backend, so the same question about the same image is only sent once — even across restarts. Use whenever you need to know what is in an image.',
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
            const pathname = String(req.url || '').split('?')[0];
            const hex = pathname.replace(/^\/dsh-img2\//, '');
            if (!/^[a-f0-9]{64}$/i.test(hex)) {
              res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' });
              res.end('bad attachment id');
              return;
            }
            const filePath = await dshPath('attachments', 'v1', 'objects', hex.slice(0, 2).toLowerCase(), hex.toLowerCase());
            const target = await fs.resolve(filePath);
            const bytes = await fs.readBytes(target, undefined, 40 * 1024 * 1024);
            const mediaType = sniffMediaType(bytes) || 'image/png';
            // 这条路由是 capability URL：URL 里的 64 位 sha 本身就是凭证，宿主没有给插件
            // 可用的会话鉴权接口，所以这里能做的只有两件事 —— ① 不让中间缓存/代理把图存
            // 下来转发给别人（private）② 声明 nosniff，别让响应被当别的类型解析。
            // 谁能拿到这个 URL 谁就能取图；想缩小可达范围请在网络层做（只监听回环、用
            // Tailscale ACL 限制 tailnet 成员等）。README 的「已知限制」里写明了这一点。
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
    }
    return () => {
      for (const d of disposers) d();
    };
  });
  ctx.logger?.info('imgpost: registered send_image / generate_image / read_image + vision provider wrap + /dsh-img2 route');
}
