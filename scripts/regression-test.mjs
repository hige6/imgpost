import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pluginPath = process.argv[2] || fileURLToPath(new URL('../src/host.js', import.meta.url));
const { apply } = await import(pathToFileURL(pluginPath));
let checks = 0;
const check = (value) => { assert.ok(value); checks++; };
async function fixture({ target = true, readError, emptyRead = false } = {}) {
  const adapters = new Map(), tools = new Map(), warnings = [];
  let queries = 0, rawReads = 0, sent;
  const model = { id: 'text-model', contextWindow: 100000, maxTokens: 1000, inputModalities: ['text'] };
  const upstreamTarget = { width: 512, height: 256, maxBytes: 1024 };
  const llm = {
    listProviders: () => [{ id: 'text-provider' }, { id: 'native-provider' }],
    listModels: async (id) => id === 'native-provider' ? [{ id: 'native', inputModalities: ['text', 'image'] }] : [model],
    resolveModelInfo: async (_p, id, signal) => { signal?.throwIfAborted(); queries++; return { ...model, id, inputModalities: id === 'native' ? ['text', 'image'] : ['text'] }; },
    registerAdapter: (ids, adapter) => { ids.forEach(id => adapters.set(id, adapter)); return () => ids.forEach(id => adapters.delete(id)); },
    providerRetryPolicy: () => ({ attempts: 2 }),
    imageRequestPricing: () => 'upstream-pricing',
    ...(target ? { imageRequestTarget: () => upstreamTarget } : {}),
    stream: async function* (options) { sent = options; yield { type: 'finish', reason: 'stop' }; },
  };
  const services = {
    llm,
    fs: { resolve: async p => p, stat: async () => { throw new Error('no config'); }, readBytes: async () => { rawReads++; throw new Error('raw read must not happen'); } },
    attachments: { readImage: async () => { if (readError) throw readError; return emptyRead ? {} : { data: Buffer.from('invalid-image') }; } },
    subprocess: {}, webServer: { port: 12345, register: () => () => {} },
  };
  const ctx = { get: name => services[name], tools: { register: t => { tools.set(t.name, t); return () => {}; } }, effect: fn => fn(), on() {}, logger: { info() {}, warn: text => warnings.push(text) } };
  apply(ctx, {});
  for (let i = 0; i < 50 && !adapters.size; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(adapters.size, 'provider discovery completed');
  return { adapter: adapters.get('imgpost-text-provider'), adapters, tools, warnings, upstreamTarget, queries: () => queries, rawReads: () => rawReads, sent: () => sent };
}
const f = await fixture();
check(f.tools.size === 4);
check(!f.adapters.has('imgpost-native-provider'));
for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget', 'listModels', 'resolveModel', 'prepareCall']) {
  check(typeof f.adapter[method] === 'function');
}
check(f.adapter.imageRequestTarget('', 'text-model', {}) === f.upstreamTarget);
check(f.adapter.imageRequestPricing('', '') === 'upstream-pricing');
check(f.adapter.providerRetryPolicy().attempts === 2);
const before = f.queries();
const call = await f.adapter.prepareCall('', 'text-model');
check(f.queries() === before + 1);
check(call.model.provider === 'imgpost-text-provider' && call.model.inputModalities.includes('image'));
for await (const _ of call.stream({ model: 'text-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {}
check(f.sent().provider === 'text-provider' && f.sent().messages[0].content[0].text === 'hi');
const old = await fixture({ target: false });
assert.deepEqual(old.adapter.imageRequestTarget('', '', { width: 20, height: 10, bytes: 40 }), { width: 20, height: 10, maxBytes: 40 }); checks++;
const abort = new AbortController(); abort.abort();
await assert.rejects(f.adapter.prepareCall('', 'text-model', abort.signal)); checks++;
const image = { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), width: 1, height: 1, bytes: 1, mediaType: 'image/png' } };
for (const options of [{ readError: new Error('ATTACHMENT_CORRUPT') }, { emptyRead: true }]) {
  const bad = await fixture(options);
  for await (const _ of bad.adapter.stream({ model: 'text-model', messages: [{ role: 'user', content: [image] }] })) {}
  check(bad.rawReads() === 0);
  check(bad.sent().messages[0].content[0].text.includes('could not be read'));
}
const native = await fixture();
const messages = [{ role: 'user', content: [image] }];
for await (const _ of native.adapter.stream({ model: 'native', messages })) {}
check(native.sent().messages === messages);
check(native.rawReads() === 0);
console.log(JSON.stringify({ passed: checks, providerDiscovery: 'mock host', externalRequests: 0 }));
