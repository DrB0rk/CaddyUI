import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

export default function Logs({ api }) {
  const [logs, setLogs] = useState(localTest ? [{ source: 'local-test', content: 'Local test mode' }] : []);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState(250);
  const [mode, setMode] = useState('all');
  const load = async () => { if (localTest) return; setBusy(true); try { setLogs((await api(`/api/logs?lines=${lines}&mode=${mode}`)).logs); } finally { setBusy(false); } };
  useEffect(() => { load(); if (localTest) return undefined; const t = setInterval(load, 10000); return () => clearInterval(t); }, [lines, mode]);

  return <section><div className="section-head"><div><h2>Logs</h2><p>Auto-refresh every 10 seconds.</p></div><div className="toolbar"><label>Source<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="all">All</option><option value="files">Files only</option><option value="journal">journalctl -u caddy</option></select></label><label>Lines<select value={lines} onChange={(e) => setLines(Number(e.target.value))}><option value={100}>100</option><option value={250}>250</option><option value={500}>500</option></select></label><button onClick={load}>{busy ? <Loader2 className="spin" /> : <RefreshCw size={16} />}Refresh</button></div></div>{busy && logs.length === 0 && <div className="proxy-loading"><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div></div>}{logs.map((l) => <article className="log-card" key={l.source}><h3>{l.source}</h3><pre>{l.content}</pre></article>)}</section>;
}
