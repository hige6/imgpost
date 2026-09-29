// imgpost（图邮）— browser client plugin.
// 在 DSH 设置里加一栏「图邮（识图）」：管理识图后端（primary / fallback）、上游包装名单。
// 纯浏览器 JS：只用 ModuleLoader 提供的 require("react") 与 DOM，零构建。
//
// 与服务端的分工：本页只发同源 fetch 到 /plugins/imgpost/vision-config，
// 该接口自带门禁（仅回环来源 + x-imgpost-config 头 + Origin 校验），并且**永不回传 apiKey**。
window.__ModuleLoader__.load({
  id: 'imgpost',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    const inject = ['slots'];

    const ENDPOINT = '/plugins/imgpost/vision-config';
    const label = '图邮（识图）';

    const styles = {
      wrap: { padding: '4px 2px 20px', fontFamily: 'inherit', fontSize: '13px', lineHeight: 1.6 },
      h: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
      hint: { opacity: 0.7, margin: '0 0 14px' },
      card: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px', padding: '12px 14px', margin: '0 0 12px' },
      cardTitle: { fontWeight: 600, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '8px' },
      row: { display: 'flex', gap: '10px', alignItems: 'center', margin: '0 0 8px', flexWrap: 'wrap' },
      lbl: { width: '74px', opacity: 0.75, flexShrink: 0 },
      input: { flex: '1 1 220px', minWidth: '160px', padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', font: 'inherit' },
      select: { padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', font: 'inherit' },
      btn: { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.45)', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
      btnPrimary: { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.45)', background: 'rgba(127,127,127,0.16)', color: 'inherit', cursor: 'pointer', font: 'inherit', fontWeight: 600 },
      ok: { color: '#2e7d32' },
      err: { color: '#d33' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' },
    };

    const emptySlot = () => ({ baseURL: '', model: '', format: 'openai', apiKey: '' });

    async function callApi(method, body) {
      const res = await fetch(ENDPOINT, {
        method: method,
        credentials: 'same-origin',
        headers: Object.assign({ 'x-imgpost-config': '1' }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        const msg = (data && data.error) || ('HTTP ' + res.status);
        if (res.status === 403) throw new Error(msg + '（请在运行 DSH 的这台机器上打开设置页，或经配置的对外域名访问）');
        throw new Error(msg);
      }
      return data || {};
    }

    function Field(props) {
      return React.createElement('div', { style: styles.row },
        React.createElement('span', { style: styles.lbl }, props.label),
        props.children
      );
    }

    function SlotEditor(props) {
      const slot = props.slot;
      const onChange = props.onChange;
      const set = (patch) => onChange(Object.assign({}, slot, patch));
      const keyPlaceholder = props.hasKey ? '已设置（留空表示不修改）' : '必填：该后端的 API key';
      return React.createElement('div', null,
        React.createElement(Field, { label: '预设' },
          React.createElement('select', {
            style: styles.select,
            value: '',
            onChange: (e) => {
              const id = e.target.value;
              const p = (props.presets || []).find((x) => x.id === id);
              if (p) set({ baseURL: p.baseURL, model: p.model, format: p.format });
            },
          },
            React.createElement('option', { value: '' }, '选择预设…'),
            (props.presets || []).map((p) => React.createElement('option', { key: p.id, value: p.id }, p.label))
          )
        ),
        React.createElement(Field, { label: 'baseURL' },
          React.createElement('input', {
            style: styles.input, value: slot.baseURL || '', placeholder: 'https://api.example.com/v1',
            onChange: (e) => set({ baseURL: e.target.value }),
          })
        ),
        React.createElement(Field, { label: '模型' },
          React.createElement('input', {
            style: styles.input, value: slot.model || '', placeholder: 'vision model id',
            onChange: (e) => set({ model: e.target.value }),
          })
        ),
        React.createElement(Field, { label: '接口风格' },
          React.createElement('select', {
            style: styles.select, value: slot.format || 'openai',
            onChange: (e) => set({ format: e.target.value }),
          },
            React.createElement('option', { value: 'openai' }, 'openai（/chat/completions）'),
            React.createElement('option', { value: 'anthropic' }, 'anthropic（/messages）')
          )
        ),
        React.createElement(Field, { label: 'apiKey' },
          React.createElement('input', {
            style: styles.input, type: 'password', value: slot.apiKey || '', placeholder: keyPlaceholder,
            autoComplete: 'off',
            onChange: (e) => set({ apiKey: e.target.value }),
          })
        )
      );
    }

    function SettingsPage() {
      const [state, setState] = React.useState({ loading: true, error: null, path: null, exists: false });
      const [presets, setPresets] = React.useState([]);
      const [primary, setPrimary] = React.useState(emptySlot());
      const [primaryHasKey, setPrimaryHasKey] = React.useState(false);
      const [useFallback, setUseFallback] = React.useState(false);
      const [fallback, setFallback] = React.useState(emptySlot());
      const [fallbackHasKey, setFallbackHasKey] = React.useState(false);
      const [upstreams, setUpstreams] = React.useState('');
      const [noWrap, setNoWrap] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);

      const applyView = (data) => {
        setPresets(data.presets || []);
        const p = data.primary;
        if (p) {
          setPrimary({ baseURL: p.baseURL, model: p.model, format: p.format, apiKey: '' });
          setPrimaryHasKey(!!p.hasKey);
        } else {
          setPrimary(emptySlot());
          setPrimaryHasKey(false);
        }
        const f = data.fallback;
        setUseFallback(!!f);
        setFallback(f ? { baseURL: f.baseURL, model: f.model, format: f.format, apiKey: '' } : emptySlot());
        setFallbackHasKey(!!(f && f.hasKey));
        setUpstreams((data.upstreams || []).join(', '));
        setNoWrap((data.noWrap || []).join(', '));
        setState({ loading: false, error: null, path: data.path || null, exists: !!data.exists });
      };

      const reload = React.useCallback(() => {
        setMsg(null);
        setState((s) => Object.assign({}, s, { loading: true }));
        callApi('GET').then(applyView).catch((e) => setState({ loading: false, error: String(e.message || e), path: null, exists: false }));
      }, []);

      React.useEffect(() => { reload(); }, [reload]);

      const splitList = (text) => String(text || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

      const save = () => {
        setBusy(true);
        setMsg(null);
        const payload = {
          primary: { baseURL: primary.baseURL, model: primary.model, format: primary.format, apiKey: primary.apiKey },
          fallback: useFallback ? { baseURL: fallback.baseURL, model: fallback.model, format: fallback.format, apiKey: fallback.apiKey } : null,
          upstreams: splitList(upstreams),
          noWrap: splitList(noWrap),
        };
        callApi('POST', payload)
          .then((data) => {
            setMsg({ ok: true, text: '已保存并即时生效（无需重启 DSH）。旧配置已备份到同名 .bak- 文件。' });
            applyView({ presets: presets, primary: data.primary, fallback: data.fallback, upstreams: data.upstreams, noWrap: data.noWrap, path: data.path, exists: true });
          })
          .catch((e) => setMsg({ ok: false, text: String(e.message || e) }))
          .then(() => setBusy(false));
      };

      if (state.loading) {
        return React.createElement('div', { style: styles.wrap }, '正在读取 imgpost 配置…');
      }

      const children = [];
      children.push(React.createElement('h3', { style: styles.h, key: 'h' }, '图邮（识图）'));
      children.push(React.createElement('p', { style: styles.hint, key: 'hint' },
        '配置 imgpost_read_image 用的视觉后端，以及要包装成 imgpost-<上游> 的 provider。留空的 apiKey 表示沿用已存的那个；密钥不会被发送到浏览器。'));

      if (state.error) {
        children.push(React.createElement('div', { style: Object.assign({}, styles.card, styles.err), key: 'err' }, state.error));
      }

      if (state.path) {
        children.push(React.createElement('div', { style: styles.card, key: 'path' },
          React.createElement('div', { style: styles.cardTitle }, '配置文件'),
          React.createElement('div', { style: styles.mono }, state.path + (state.exists ? '' : '（尚不存在，保存后创建）'))
        ));
      }

      children.push(React.createElement('div', { style: styles.card, key: 'primary' },
        React.createElement('div', { style: styles.cardTitle }, '主视觉后端'),
        React.createElement(SlotEditor, { slot: primary, onChange: setPrimary, presets: presets, hasKey: primaryHasKey })
      ));

      children.push(React.createElement('div', { style: styles.card, key: 'fallback' },
        React.createElement('div', { style: styles.cardTitle },
          React.createElement('input', { type: 'checkbox', checked: useFallback, onChange: (e) => setUseFallback(e.target.checked) }),
          React.createElement('span', null, '启用备用后端（主后端失败时自动回退）')
        ),
        useFallback ? React.createElement(SlotEditor, { slot: fallback, onChange: setFallback, presets: presets, hasKey: fallbackHasKey }) : null
      ));

      children.push(React.createElement('div', { style: styles.card, key: 'wrap' },
        React.createElement('div', { style: styles.cardTitle }, '上游包装（让不带视觉的模型也能"看图"）'),
        React.createElement(Field, { label: 'upstreams' },
          React.createElement('input', { style: styles.input, value: upstreams, placeholder: '如 zai, deepseek-official（逗号分隔）', onChange: (e) => setUpstreams(e.target.value) })
        ),
        React.createElement(Field, { label: 'noWrap' },
          React.createElement('input', { style: styles.input, value: noWrap, placeholder: '不要包装的 provider id（逗号分隔）', onChange: (e) => setNoWrap(e.target.value) })
        )
      ));

      children.push(React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' }, key: 'actions' },
        React.createElement('button', { style: styles.btnPrimary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
        React.createElement('button', { style: styles.btn, disabled: busy, onClick: reload }, '重新载入'),
        msg ? React.createElement('span', { style: msg.ok ? styles.ok : styles.err }, msg.text) : null
      ));

      return React.createElement('div', { style: styles.wrap }, children);
    }

    function apply(ctx) {
      try {
        const slots = ctx.get('slots');
        if (!slots) {
          console.warn('[imgpost] slots service unavailable; settings section not mounted');
          return;
        }
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'imgpost', order: 20, label: label },
            SettingsPage
          )
        );
      } catch (e) {
        console.warn('[imgpost] settings section mount failed:', e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
