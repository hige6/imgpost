// imgpost（图邮） — host plugin, zero dependencies.
// Three image capabilities in DSH conversations:
//   1. send_image    — ship a local file / http(s) URL / data URI / attachment
//                      into the chat as a durable /dsh-img2/<sha256> image.
//   2. generate_image— call any OpenAI-compatible /images/generations endpoint
//                      and post the result into the chat.
//   3. read_image    — describe an image through an external vision API
//                      (OpenAI- or Anthropic-compatible), cached on disk keyed
//                      by the image digest so a restart never re-reads it.
// Images are stored as durable attachments and served back through a
// same-origin /dsh-img2/<sha256-hex> webServer route.
//
// Config (all optional, nothing baked in to any particular vendor):
//   Generation : env DSH_IMAGE_API_KEY / DSH_IMAGE_API_BASE / DSH_IMAGE_API_MODEL
//                or ~/.dsh/image-sender.json { apiKey, baseURL, model }.
//   Vision     : ~/.dsh/vision-sender.json { primary, fallback, upstreams }
//                (each backend { baseURL, apiKey, model, format:'openai'|'anthropic' }),
//                else env DSH_VISION_API_KEY / DSH_VISION_API_BASE / DSH_VISION_API_MODEL.
//                Evidence is cached in ~/.dsh/imgpost-vision-cache/<sha256>.json.
export const name = 'imgpost';
// Hard dependencies: the loader parks this plugin until these host services are
// provided, so apply() never races startup order. `llm` powers the vision
// provider wrap (imgpost-<upstream>) that lets pasted images pass admission.
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
  // Optional public base URL for served images (e.g. a Tailscale tailnet), falls
  // back to the runtime-probed web origin (webServer.port → DSH_WEB_URL → default).
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

  // Runtime origin of the web GUI, probed lazily and cached. The /dsh-img2 route
  // is served by the same webServer as the GUI, whose port is dynamic (--port 0),
  // so hardcoding it would break image display across restarts.
  let resolvedOrigin = null;
  let originPromise = null;
  function ensureWebOrigin(signal, cwd) {
    if (resolvedOrigin) return Promise.resolve(resolvedOrigin);
    if (!originPromise) {
      originPromise = (async () => {
        if (publicOrigin) return publicOrigin;
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

  const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  function isNegativeCacheFresh(entry) {
    if (!entry || entry.refused !== true) return false;
    return Date.now() - (entry.savedAt || 0) < NEGATIVE_CACHE_TTL_MS;
  }

  async function writeVisionCache(sha, text, model, refused) {
    try {
      const dir = await visionCacheDir();
      const payload = JSON.stringify({ text: text, model: model || '', savedAt: Date.now(), refused: refused === true });
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
  // Precedence: ~/.dsh/vision-sender.json { primary, fallback } →
  // env DSH_VISION_* → (nothing vendor-specific). The model listed in each
  // backend config is honoured as-is; there is no default vendor model fallback.
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
      const envModel = (typeof process !== 'undefined' && process.env && process.env.DSH_VISION_API_MODEL) || null;
      if (envKey && envBase) primary = { baseURL: envBase, apiKey: envKey, model: envModel || '', format: 'openai' };
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
  // base64. Returns the model's text answer.
  async function callVisionBackend(backend, bytes, mediaType, prompt, signal) {
    if (!backend || !backend.baseURL || !backend.apiKey) throw new Error('vision backend is not configured');
    if (!backend.model) throw new Error('vision backend has no model configured');
    const b64 = Buffer.from(bytes).toString('base64');
    const userPrompt = (prompt && String(prompt).trim()) || 'Describe this image in detail: what is in it, any text (transcribe it), layout, colors, and anything notable.';
    let url;
    let headers;
    let body;
    if (backend.format === 'anthropic') {
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
  async function describeBytes(bytes, mediaType, prompt, signal, refresh) {
    if (!mediaType || !/^image\//.test(mediaType)) mediaType = 'image/png';
    const sha = await sha256OfBytes(bytes);
    if (!refresh) {
      const cached = await readVisionCache(sha);
      if (cached) {
        return { text: cached.text, model: cached.model || '', cached: true, refused: cached.refused === true, sha: sha, mediaType: mediaType, bytes: bytes.length };
      }
    }
    const cfg = await resolveVisionConfig(signal, 'C:\\', refresh);
    let lastError = null;
    if (cfg.primary) {
      try {
        const text = await callVisionBackend(cfg.primary, bytes, mediaType, prompt, signal);
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
    const lastMsg = String(lastError && lastError.message || lastError);
    if (lastError && /declined|could not be read|refus|declin/i.test(lastMsg)) {
      const declinedText = '[imgpost vision] 该图片因内容安全策略被视觉服务拒绝，暂无法生成描述。可尝试用 refresh 重新请求，或换一个视觉后端。';
      await writeVisionCache(sha, declinedText, (cfg.fallback && cfg.fallback.model) || (cfg.primary && cfg.primary.model) || '', true);
      return { text: declinedText, model: (cfg.fallback && cfg.fallback.model) || '', cached: false, refused: true, sha: sha, mediaType: mediaType, bytes: bytes.length };
    }
    throw new Error('read_image failed' + (lastError ? ': ' + lastMsg : ' (no vision backend configured; set ~/.dsh/vision-sender.json or DSH_VISION_*)'));
  }

  function isUsefulVisionText(text) {
    const t = String(text || '').trim();
    if (!t || t.length < 4) return false;
    return !/我无法|我不能|无法(?:为您|提供|完成|处理|描述|满足)|不能(?:描述|处理|提供|回答|满足)|不(?:方便|能)提供|拒绝|违反(?:安全|内容|隐私)|\bas an? (?:ai|assistant)\b|\bi'?m (?:an? )?(?:ai|language model|assistant)\b|cannot (?:describe|process|handle|provide|do)|(?:refus|declin|unable to|not able to|can'?t|cannot|won'?t) (?:to )?(?:describe|process|handle|provide|do|fulfill|engage|assist)|i (?:can'?t|cannot|won'?t|don'?t) (?:describe|provide|process|handle|fulfill|engage|comply)|i'?m (?:unable|not able) (?:to )?(?:describe|process|handle|provide)|i don'?t (?:describe|provide|engage|do)|not supported|cannot comply|sorry,? (?:i|couldn)/gi.test(t);
  }

  // Read an image from a local path / http(s) URL / data URI / attachment ref.
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
    return await describeBytes(bytes, mediaType, prompt, exec.signal, refresh);
  }

  // ── vision: provider wrapper (imgpost-<upstream>) ─────────────────────────
  function contentHasImage(blocks) {
    return (
      Array.isArray(blocks) &&
      blocks.some((b) => b && (b.type === 'image' || (b.type === 'tool-result' && contentHasImage(b.content))))
    );
  }

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

  // Register an imgpost-<upstream> adapter that wraps one text-only provider.
  function registerVisionWrap(llm, upstream, providerId, displayName) {
    try {
      llm.registerAdapter([providerId], {
        providerInfo() { return { id: providerId, name: displayName }; },
        providerRetryPolicy() { return undefined; },
        async listModels(_provider, signal) {
          const models = await llm.listModels(upstream, signal);
          return (models || []).map((m) => ({
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
            const messages = await convertMessagesImages(options.messages, options.signal);
            yield* llm.stream({ ...options, provider: upstream, messages });
          })();
        },
      });
      return true;
    } catch (error) {
      if (/already|duplicate/i.test(String(error))) {
        console.error('[imgpost] vision provider ' + providerId + ' already registered, keeping the existing one');
        return true;
      }
      console.error('[imgpost] vision provider registration skipped (' + providerId + '): ' + error);
      return false;
    }
  }

  // Auto-discover text-only providers and wrap each one as imgpost-<id>.
  function registerVisionProvider(llm) {
    if (!llm || typeof llm.registerAdapter !== 'function' || typeof llm.listProviders !== 'function') return;
    const wrapped = new Set();
    const wrap = (id, name) => {
      const providerId = 'imgpost-' + id;
      return registerVisionWrap(llm, id, providerId, (name || id) + ' (imgpost vision)');
    };
    const ensureWrap = (id, name) => {
      if (!id || wrapped.has(id)) return;
      wrap(id, name).then((ok) => { if (!ok) wrapped.delete(id); });
    };
    const sweepBody = async () => {
      for (const info of llm.listProviders()) {
        const id = info && info.id;
        if (!id || wrapped.has(id) || String(id).indexOf('imgpost-') === 0 || String(id).indexOf('modlens-') === 0 || String(id).indexOf('deepseek-modlens') === 0) continue;
        let known = false;
        let nativelyVision = false;
        try {
          const models = await llm.listModels(id);
          if (Array.isArray(models) && models.length > 0) {
            known = true;
            nativelyVision = models.some((m) => Array.isArray(m.inputModalities) && m.inputModalities.indexOf('image') >= 0);
          }
        } catch (e) {
          // unreadable right now — wrap anyway; a later sweep can revisit
        }
        if (known && nativelyVision) continue;
        wrapped.add(id);
        if (!await wrap(id, (info && info.name) || id)) {
          wrapped.delete(id);
        }
      }
    };
    let sweeping = sweepBody();
    const sweep = () => {
      sweeping = sweeping.then(sweepBody, sweepBody);
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
        return [{ type: 'text', text: '已生成图片：' + value.model + ' ' + value.size + ' ' + value.width + 'x' + value.height + '\n请在回复中以内嵌图片形式显示它（不要只贴 URL 文本）：\n![' + cap + '](' + url + ')' }];
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
        throw new Error('image-generation API key is not configured. Set the DSH_IMAGE_API_KEY environment variable (optionally DSH_IMAGE_API_BASE and DSH_IMAGE_API_MODEL), or create ~/.dsh/image-sender.json containing { "apiKey": "...", "baseURL": "https://your-provider.example/v1", "model": "..." }.');
      }
      const tempPath = await generateImageToFile(cfg, prompt, args.size, args.model, exec.signal, cwd);
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
        model: args.model || cfg.model,
        size: args.size || '1024x1024',
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

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(sendImageTool),
      ctx.tools.register(generateImageTool),
      ctx.tools.register(readImageTool),
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
