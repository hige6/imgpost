// imgpost（图邮） — host plugin, zero dependencies.
// Sends images into DSH conversations (local file / http(s) URL / data URI) and
// generates images via any OpenAI-compatible /images/generations endpoint.
// Images are stored as durable attachments and served back through a
// same-origin /dsh-img2/<sha256> webServer route so the chat can display them.
//
// Config for generation (optional): env DSH_IMAGE_API_KEY / DSH_IMAGE_API_BASE
// / DSH_IMAGE_API_MODEL, or ~/.dsh/image-sender.json { apiKey, baseURL, model }.
export const name = 'imgpost';
// Hard dependencies: the loader parks this plugin until these host services are
// provided, so apply() never races startup order.
export const inject = ['attachments', 'subprocess', 'fs', 'webServer', 'tools'];

const shellCandidates = [
  'pwsh',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'powershell',
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

export function apply(ctx) {
  const attachments = ctx.get('attachments');
  const subprocess = ctx.get('subprocess');
  const fs = ctx.get('fs');
  const webServer = ctx.get('webServer');
  const sandboxPolicy = ctx.get('sandboxPolicy');
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
      "if (-not $base) { $base='https://api.openai.com/v1' }",
      "if (-not $model) { $model='gpt-image-1' }",
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
    description: 'Call the configured image-generation API and store the resulting image as an attachment served at a /dsh-img2/<sha256-hex> URL (the tool result carries the full URL). Requires credentials: env DSH_IMAGE_API_KEY (plus optional DSH_IMAGE_API_BASE and DSH_IMAGE_API_MODEL), or ~/.dsh/image-sender.json with { apiKey, baseURL, model }. Works with OpenAI-compatible /images/generations endpoints (OpenAI, SiliconFlow, Agnes AI, etc.) returning data[].url or data[].b64_json. IMPORTANT: after a successful call, you MUST render the image inside your reply by inserting the exact markdown image syntax ![caption](<the full URL from the tool result>) — never just quote the URL as plain text, otherwise the user sees no image.',
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
        throw new Error('image-generation API key is not configured. Set the DSH_IMAGE_API_KEY environment variable (optionally DSH_IMAGE_API_BASE and DSH_IMAGE_API_MODEL), or create ~/.dsh/image-sender.json containing { "apiKey": "...", "baseURL": "https://api.siliconflow.cn/v1", "model": "..." }.');
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

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(sendImageTool),
      ctx.tools.register(generateImageTool),
    ];
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
  ctx.logger?.info('imgpost: registered send_image / generate_image + /dsh-img2 route');
}
