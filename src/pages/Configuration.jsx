import React, { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Save } from 'lucide-react';
import { parseCaddyfile } from '../../server/caddyParser.js';
import { Notice } from '../components/common.jsx';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

export default function Configuration({ config, setConfig, refresh, canEdit, theme, api }) {
  const [draft, setDraft] = useState(config?.content || '');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(config?.content || ''), [config?.content]);

  const save = async () => {
    if (!canEdit) return;
    if (localTest) { setConfig((c) => ({ ...c, content: draft, parsed: parseCaddyfile(draft) })); setResult({ ok: true, stdout: 'Saved in browser only' }); return; }
    setBusy(true); setResult(null);
    try { const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ content: draft, validate: true }) }); setConfig((c) => ({ ...c, content: draft, parsed: r.parsed })); setResult({ ok: true, stdout: `Saved. Backup: ${r.backup}` }); }
    catch (e) { setResult({ ok: false, stderr: e.message }); }
    finally { setBusy(false); }
  };

  return <section><div className="section-head"><div><h2>Configuration editor</h2><p>Edit the live Caddyfile.</p></div><div className="toolbar"><button onClick={refresh}>Reload file</button>{canEdit && <button className="primary" onClick={save} disabled={busy}><Save size={16} />Save</button>}</div></div>{result && <Notice type={result.ok ? 'success' : 'error'}>{result.ok ? result.stdout || 'Command succeeded' : result.stderr || 'Command failed'}</Notice>}<div className="editor-wrap"><Editor height="68vh" defaultLanguage="caddyfile" theme={theme === 'light' ? 'light' : 'vs-dark'} value={draft} onChange={(v) => setDraft(v || '')} options={{ minimap: { enabled: false }, fontSize: 14, wordWrap: 'on', scrollBeyondLastLine: false, readOnly: !canEdit }} /></div></section>;
}
