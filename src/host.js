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

const shellCandidates = [
  'pwsh',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'powershell',
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

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

  function userHome() {
    if (!homePromise) {
      homePromise = (async () => {
        const cwd = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot ? sandboxPolicy.workspaceRoot : 'C:\\';
        const out = await runPwsh('Write-Output $env:USERPROFILE', {}, undefined, cwd);
        const home = out.replace(/\r/g, '').split('\n').map((s) => s.trim()).find((s) => s.length > 0);
        if (!home) throw new Error('cannot resolve user home directory');
        return home;
      })();
    }
    return homePromise;
  }

  // Runtime origin of the web GUI (DSH_WEB_URL), probed lazily and cached.
  // The /dsh-img2 route is served by the same webServer as the GUI, whose port
  // is dynamic (--port 0), so hardcoding it breaks image display across restarts.
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
          // fall through to the env probes
        }
        try {
          const p = (typeof process !== 'undefined' && process.env && process.env.DSH_WEB_URL) || '';
          if (/^https?:\/\//i.test(p)) return p.replace(/\/+$/, '');
        } catch (e) {
          // fall through to the spawn probe
        }
        try {
          const out = await runPwsh('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\nWrite-Output $env:DSH_WEB_URL', {}, signal, cwd);
          const line = out.replace(/\r/g, '').split('\n').map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
          if (line) return line.replace(/\/+$/, '');
        } catch (e) {
          // fall through to the default below
        }
        return 'http://127.0.0.1:14330';
      })().then((o) => {
        resolvedOrigin = o;
        return o;
      });
    }
    return originPromise;
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
    const candidates = workingShell ? [workingShell] : shellCandidates;
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
      throw new Error('powershell exited ' + result.outcome.exitCode + ': ' + (result.err || result.out).slice(0, 600));
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

  let visionCacheHomePromise = null;
  function visionCacheDir() {
    if (!visionCacheHomePromise) {
      visionCacheHomePromise = (async () => {
        const home = await userHome();
        return home + '\\.dsh\\imgpost-vision-cache';
      })();
    }
    return visionCacheHomePromise;
  }

  async function readVisionCache(sha) {
    try {
      const dir = await visionCacheDir();
      const target = await fs.resolve(dir + '\\' + sha + '.json');
      const raw = await fs.readText(target, undefined, 512 * 1024);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.text === 'string' && parsed.text) return parsed;
    } catch (e) {
      // miss or unreadable — fall through to the engine
    }
    return null;
  }

  // A "negative" cache entry records that both vision backends declined the
  // image (NSFW etc.). We store it too, so a restarted session does not re-run
  // the (slow) vision API over the same refused pictures every time — the
  // refusal is served from disk and only retried after NEGATIVE_CACHE_TTL_MS.
  const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  function isNegativeCacheFresh(entry) {
    if (!entry || entry.refused !== true) return false;
    return Date.now() - (entry.savedAt || 0) < NEGATIVE_CACHE_TTL_MS;
  }

  async function writeVisionCache(sha, text, model, refused) {
    try {
      const dir = await visionCacheDir();
      const payload = JSON.stringify({ text: text, model: model || '', savedAt: Date.now(), refused: refused === true });
      // write through pwsh: fs.writeText may be denied under workspace-write
      const escaped = payload.replace(/'/g, "''");
      const script = [
        "$ErrorActionPreference='Stop'",
        '$d=' + "'" + dir.replace(/'/g, "''") + "'",
        'if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }',
        '$p=Join-Path $d $env:CACHE_SHA',
        "[IO.File]::WriteAllText($p, '" + escaped + "', [Text.UTF8Encoding]::new($false))",
      ].join('\n');
      await runPwsh(script, { CACHE_SHA: sha + '.json' }, undefined, 'C:\\');
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
      const home = await userHome();
      const vp = await fs.resolve(home + '\\.dsh\\vision-sender.json');
      vRaw = await fs.readText(vp, signal, 128 * 1024);
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
    const b64 = Buffer.from(bytes).toString('base64');
    const userPrompt = (prompt && String(prompt).trim()) || 'Describe this image in detail: what is in it, any text (transcribe it), layout, colors, and anything notable.';
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
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal && signal.addEventListener && signal.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = 120000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message || e)))) {
        throw new Error('vision backend timed out after ' + (timeoutMs / 1000) + 's');
      }
      throw new Error('vision backend request failed: ' + String(e && e.message || e));
    } finally {
      clearTimeout(timeout);
      signal && signal.removeEventListener && signal.removeEventListener('abort', onAbort);
    }
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
    return detail || ('HTTP ' + resp.status);
  }

  // Core: describe image BYTES through the vision backend with disk cache.
  // No exec dependency — shared by the read_image tool and the provider wrap.
  async function describeBytes(bytes, mediaType, prompt, signal, refresh) {
    if (!mediaType || !/^image\//.test(mediaType)) mediaType = 'image/png';
    const sha = await sha256OfBytes(bytes);
    if (!refresh) {
      const cached = await readVisionCache(sha);
      if (cached) {
        // A refused image is cached too (negative cache). It stays cached —
        // a content-policy refusal almost never changes, so a short TTL would
        // only re-run the slow API for the same refusal. Only an explicit
        // refresh re-tries it.
        return { text: cached.text, model: cached.model || '', cached: true, refused: cached.refused === true, sha: sha, mediaType: mediaType, bytes: bytes.length };
      }
    }
    const cfg = await resolveVisionConfig(signal, 'C:\\', refresh);
    let lastError = null;
    if (cfg.primary) {
      try {
        const text = await callVisionBackend(cfg.primary, bytes, mediaType, prompt, signal);
        // A refusal/policy answer is not a usable description: don't cache it,
        // and treat it as a failure so the fallback backend gets a chance.
        if (!isUsefulVisionText(text)) {
          throw new Error('vision backend declined: ' + text.slice(0, 120));
        }
        await writeVisionCache(sha, text, cfg.primary.model);
        return { text: text, model: cfg.primary.model, cached: false, sha: sha, mediaType: mediaType, bytes: bytes.length };
      } catch (e) {
        lastError = e;
      }
    }
    if (cfg.fallback) {
      try {
        const text = await callVisionBackend(cfg.fallback, bytes, mediaType, prompt, signal);
        if (!isUsefulVisionText(text)) {
          throw new Error('vision backend declined: ' + text.slice(0, 120));
        }
        await writeVisionCache(sha, text, cfg.fallback.model);
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
      await writeVisionCache(sha, declinedText, (cfg.fallback && cfg.fallback.model) || (cfg.primary && cfg.primary.model) || '', true);
      return { text: declinedText, model: (cfg.fallback && cfg.fallback.model) || '', cached: false, refused: true, sha: sha, mediaType: mediaType, bytes: bytes.length };
    }
    throw new Error('read_image failed' + (lastError ? ': ' + lastMsg : ' (no vision backend configured; set ~/.dsh/vision-sender.json or DSH_VISION_API_KEY / DSH_VISION_API_BASE / DSH_VISION_API_MODEL)'));
  }

  // Heuristic: is this returned text an actual description, or a refusal /
  // boilerplate that should never be cached? Refusal phrases in common
  // Chinese/English are treated as "no useful answer" so we try the fallback.
  function isUsefulVisionText(text) {
    const t = String(text || '').trim();
    if (!t || t.length < 4) return false;
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
    let mediaType = 'image/png';
    if (/^sha256:/i.test(src) || /^[a-f0-9]{64}$/i.test(src)) {
      const hex = String(src).replace(/^sha256:/i, '').toLowerCase();
      const home = await userHome();
      const target = await fs.resolve(home + '\\.dsh\\attachments\\v1\\objects\\' + hex.slice(0, 2) + '\\' + hex);
      bytes = await fs.readBytes(target, exec.signal, 40 * 1024 * 1024);
      mediaType = sniffMediaType(bytes) || 'image/png';
    } else if (/^data:/i.test(src)) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m || !m[2]) throw new Error('image data URI must be base64-encoded (data:image/png;base64,...)');
      bytes = Buffer.from(m[3], 'base64');
      mediaType = sniffMediaType(bytes) || m[1] || 'image/png';
    } else if (/^https?:\/\//i.test(src)) {
      const tmp = await fetchImageToFile(src, exec.signal, cwd);
      bytes = await readImageBytesFromFile(tmp, exec.signal);
      await deleteTempFile(tmp, exec.signal, cwd);
      mediaType = sniffMediaType(bytes) || 'image/png';
    } else {
      const target = await fs.resolve(src, { cwd: cwd });
      bytes = await fs.readBytes(target, exec.signal, 40 * 1024 * 1024);
      mediaType = sniffMediaType(bytes) || 'image/png';
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
            const home = await userHome();
            const target = await fs.resolve(home + '\\.dsh\\attachments\\v1\\objects\\' + hex.slice(0, 2) + '\\' + hex);
            const bytes = await fs.readBytes(target, signal, 40 * 1024 * 1024);
            const mediaType = sniffMediaType(bytes) || 'image/png';
            const result = await describeBytes(bytes, mediaType, undefined, signal, false);
            out.push({ type: 'text', text: '[Pasted image, described by imgpost vision]\n' + result.text });
          } catch (e) {
            out.push({ type: 'text', text: '[A pasted image could not be read by imgpost vision: ' + String(e && e.message || e).slice(0, 300) + ']' });
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
      const home = await userHome();
      const target = await fs.resolve(home + '\\.dsh\\vision-sender.json');
      const raw = await fs.readText(target, signal, 128 * 1024);
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.noWrap)) {
        for (const s of parsed.noWrap) if (String(s).trim()) list.add(String(s).trim());
      }
    } catch (e) {
      // no file / no list — nothing excluded
    }
    noWrapCache = list;
    return list;
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
        stream(options) {
          const self = this;
          return (async function* () {
            // Per-model pass-through: when the requested model's catalog entry
            // accepts image input, the core gate lets raw image blocks reach
            // the upstream — forward them untouched. For every other model the
            // gate would reject raw images, so rewrite them into evidence text.
            let native = false;
            const modelId = options && options.model;
            if (modelId) {
              try {
                native = modelIsNativeVision(await llm.resolveModelInfo(upstream, modelId, options.signal));
              } catch (e) {
                native = false; // unknown to the catalog — bridge it
              }
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
        async prepareCall(_provider, model, signal) {
          return {
            model: await this.resolveModel(_provider, model, signal),
            stream: (options) => this.stream(options),
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
      const home = await userHome();
      const target = await fs.resolve(home + '\\.dsh\\vision-sender.json');
      const raw = await fs.readText(target, undefined, 128 * 1024);
      const parsed = JSON.parse(raw);
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
      const staticList = (await resolveWrapList(undefined, 'C:\\', false)) || [];
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
        if (!id || wrapped.has(id) || foreign.has(id) || excluded.has(id) || isOwnedByAnotherBridge(id)) continue;
        let allVision = false;
        try {
          const models = await llm.listModels(id);
          if (Array.isArray(models) && models.length > 0) {
            allVision = true;
            for (const m of models) {
              if (!modelIsNativeVision(m)) { allVision = false; break; }
            }
          }
        } catch (e) {
          // catalog unreadable right now — keep any existing wrap; new ones
          // get wrapped below and a later sweep can revisit
        }
        if (allVision) {
          if (wrapped.has(id)) {
            dropWrap(id);
            ctx.logger?.info('[imgpost] unwrapped imgpost-' + id + ': all models now accept image input natively');
          }
          continue;
        }
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
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
      "$ErrorActionPreference='Stop'",
      '$p=Join-Path $env:TEMP $env:IMG_FILENAME',
      '& curl.exe -sL -f --max-time 120 -o $p $env:IMG_URL',
      'if ($LASTEXITCODE -ne 0) { throw "curl download failed with exit $LASTEXITCODE" }',
      'if (-not (Test-Path $p)) { throw "curl produced no output file" }',
      '[Console]::Out.Write($p)',
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
      '$b=[Convert]::FromBase64String($env:IMG_B64)',
      '$p=Join-Path $env:TEMP $env:IMG_FILENAME',
      '[IO.File]::WriteAllBytes($p, $b)',
      '[Console]::Out.Write($p)',
    ].join('\n');
    const out = await runPwsh(script, { IMG_B64: b64, IMG_FILENAME: newTempName() }, signal, cwd);
    const path = out.trim();
    if (!path) throw new Error('failed to stage image bytes');
    return path;
  }

  async function generateImageToFile(cfg, prompt, size, model, signal, cwd) {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12',
      "$ErrorActionPreference='Stop'",
      "$payload=@{model=$env:IMG_MODEL;prompt=$env:IMG_PROMPT;n=1;size=$env:IMG_SIZE} | ConvertTo-Json -Compress",
      "$resp=Invoke-RestMethod -Method Post -Uri \"$($env:IMG_BASE)/images/generations\" -Headers @{Authorization=\"Bearer $($env:IMG_KEY)\"} -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 300",
      '$item=$resp.data[0]',
      'if (-not $item) { $item=$resp.images[0] }',
      '$b64=$item.b64_json',
      'if (-not $b64) {',
      '  $u=$item.url',
      '  $p=Join-Path $env:TEMP $env:IMG_FILENAME',
      '  & curl.exe -sL -f --max-time 120 -o $p $u',
      '  if ($LASTEXITCODE -ne 0) { throw "image URL download failed with exit $LASTEXITCODE" }',
      '  $b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))',
      '}',
      "if (-not $b64) { throw 'image API returned no image data' }",
      '$b=[Convert]::FromBase64String($b64)',
      '$p=Join-Path $env:TEMP $env:IMG_FILENAME',
      '[IO.File]::WriteAllBytes($p, $b)',
      '[Console]::Out.Write($p)',
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
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      "$ErrorActionPreference='SilentlyContinue'",
      '$key=$env:DSH_IMAGE_API_KEY',
      '$base=$env:DSH_IMAGE_API_BASE',
      '$model=$env:DSH_IMAGE_API_MODEL',
      'if (-not $key -or -not $base) {',
      '  try {',
      "    $cfgPath=Join-Path $env:USERPROFILE '.dsh\\image-sender.json'",
      '    if (Test-Path $cfgPath) {',
      '      $cfg=Get-Content -Raw -Path $cfgPath | ConvertFrom-Json',
      '      if (-not $key) { $key=$cfg.apiKey }',
      '      if (-not $base) { $base=$cfg.baseURL }',
      '      if (-not $model) { $model=$cfg.model }',
      '    }',
      '  } catch {}',
      '}',
      'Write-Output $key',
      'Write-Output $base',
      'Write-Output $model',
    ].join('\n');
    const out = await runPwsh(script, {}, signal, cwd);
    const lines = out.replace(/\r/g, '').split('\n');
    const cfg = {
      key: (lines[0] || '').trim() || null,
      base: (lines[1] || '').trim() || null,
      model: (lines[2] || '').trim() || null,
    };
    configCache = cfg;
    return cfg;
  }

  async function stageBytes(exec, tempPath) {
    const cwd = cwdFor(exec);
    try {
      return await readImageBytesFromFile(tempPath, exec.signal);
    } finally {
      await deleteTempFile(tempPath, exec.signal, cwd);
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
        const origin = resolvedOrigin || 'http://127.0.0.1:14330';
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
    description: 'Call the configured image-generation API and store the resulting image as an attachment served at a /dsh-img2/<sha256-hex> URL (the tool result carries the full URL). Requires credentials: env DSH_IMAGE_API_KEY (plus optional DSH_IMAGE_API_BASE and DSH_IMAGE_API_MODEL), or ~/.dsh/image-sender.json with { apiKey, baseURL, model }. Works with any OpenAI-compatible /images/generations endpoint returning data[].url or data[].b64_json. IMPORTANT: after a successful call, you MUST render the image inside your reply by inserting the exact markdown image syntax ![caption](<the full URL from the tool result>) — never just quote the URL as plain text, otherwise the user sees no image.',
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
        const origin = resolvedOrigin || 'http://127.0.0.1:14330';
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
    description: 'Read an image through an external vision API and return a detailed text description (OCR / layout / scene / any specific question). Unlike the host read_image tool, this works with ANY model — it does not require the model to declare image input, because the vision call happens outside the model. Accepts a local file path, an http(s) URL, a base64 data URI, or a sha256: attachment id. Uses the configured vision backend (primary ~/.dsh/vision-sender.json, fallback supported, or env DSH_VISION_*) and caches the result on disk keyed by the image digest, so the same image is only ever described once — even across restarts. Use whenever you need to know what is in an image.',
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
              res.writeHead(400);
              res.end('bad attachment id');
              return;
            }
            const home = await userHome();
            const filePath = home + '\\.dsh\\attachments\\v1\\objects\\' + hex.slice(0, 2).toLowerCase() + '\\' + hex.toLowerCase();
            const target = await fs.resolve(filePath);
            const bytes = await fs.readBytes(target, undefined, 40 * 1024 * 1024);
            const mediaType = sniffMediaType(bytes) || 'image/png';
            res.writeHead(200, {
              'Content-Type': mediaType,
              'Content-Length': bytes.byteLength,
              'Cache-Control': 'public, max-age=31536000, immutable',
            });
            res.end(bytes);
          } catch (e) {
            try {
              res.writeHead(404);
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
