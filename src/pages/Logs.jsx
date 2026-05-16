import React, { useEffect, useMemo, useState } from 'react';
import { History, Loader2, RefreshCw, ScrollText } from 'lucide-react';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';
const localEvents = [
  {
    id: 'event-local-1',
    createdAt: Date.now(),
    actorUsername: 'local',
    actorRole: 'admin',
    kind: 'proxy',
    action: 'create',
    targetType: 'proxy',
    targetId: 'new.example.com',
    status: 'success',
    message: 'Created proxy new.example.com.',
    details: { host: 'new.example.com', upstream: '127.0.0.1:8080' },
  },
];

function formatEventTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function stringifyDetails(details = {}) {
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return '{}';
  }
}

export default function Logs({ api, initialView = 'system', selectedEventId = '', onSelectView }) {
  const [logs, setLogs] = useState(localTest ? [{ source: 'local-test', content: 'Local test mode' }] : []);
  const [events, setEvents] = useState(localTest ? localEvents : []);
  const [busy, setBusy] = useState(false);
  const [eventBusy, setEventBusy] = useState(false);
  const [lines, setLines] = useState(250);
  const [mode, setMode] = useState('all');
  const [view, setView] = useState(initialView || 'system');
  const [expandedEventId, setExpandedEventId] = useState(selectedEventId || '');

  const loadLogs = async () => {
    if (localTest) return;
    setBusy(true);
    try {
      setLogs((await api(`/api/logs?lines=${lines}&mode=${mode}`)).logs);
    } finally {
      setBusy(false);
    }
  };

  const loadEvents = async () => {
    if (localTest) return;
    setEventBusy(true);
    try {
      setEvents((await api('/api/events?limit=250')).events || []);
    } finally {
      setEventBusy(false);
    }
  };

  useEffect(() => {
    setView(initialView || 'system');
  }, [initialView]);

  useEffect(() => {
    onSelectView?.(view);
  }, [view, onSelectView]);

  useEffect(() => {
    if (!selectedEventId) return;
    setView('events');
    setExpandedEventId(selectedEventId);
    const row = document.getElementById(`event-row-${selectedEventId}`);
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedEventId, events.length]);

  useEffect(() => {
    loadLogs();
    loadEvents();
    if (localTest) return undefined;
    const t = setInterval(() => {
      loadLogs();
      loadEvents();
    }, 10000);
    return () => clearInterval(t);
  }, [lines, mode]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === expandedEventId) || null,
    [events, expandedEventId]
  );

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Logs</h2>
          <p>System logs and a structured event history with actor tracking.</p>
        </div>
        <div className="toolbar">
          <button type="button" className={view === 'system' ? 'active-tab' : ''} onClick={() => setView('system')}>
            <ScrollText size={16} />
            System logs
          </button>
          <button type="button" className={view === 'events' ? 'active-tab' : ''} onClick={() => setView('events')}>
            <History size={16} />
            Event log
          </button>
          <button onClick={() => { loadLogs(); loadEvents(); }}>
            {(busy || eventBusy) ? <Loader2 className="spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        </div>
      </div>

      {view === 'system' && (
        <>
          <div className="toolbar logs-toolbar">
            <label>
              Source
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="all">All</option>
                <option value="files">Files only</option>
                <option value="journal">journalctl -u caddy</option>
              </select>
            </label>
            <label>
              Lines
              <select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
                <option value={100}>100</option>
                <option value={250}>250</option>
                <option value={500}>500</option>
              </select>
            </label>
          </div>
          {busy && logs.length === 0 && <div className="proxy-loading"><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div><div className="proxy-row-skeleton"><span /><span /><span /><span /><span /></div></div>}
          {logs.map((l) => <article className="log-card" key={l.source}><h3>{l.source}</h3><pre>{l.content}</pre></article>)}
        </>
      )}

      {view === 'events' && (
        <div className="event-log-layout">
          <div className="event-table-card">
            <div className="event-table-head">
              <div>
                <h3>Recent activity</h3>
                <p>{events.length} events loaded.</p>
              </div>
            </div>
            <div className="event-table-wrap">
              {events.length > 0 ? (
                <table className="event-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>User</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Status</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr
                        key={event.id}
                        id={`event-row-${event.id}`}
                        className={event.id === expandedEventId ? 'selected' : ''}
                        onClick={() => setExpandedEventId(event.id)}
                      >
                        <td>{formatEventTime(event.createdAt)}</td>
                        <td>
                          <div className="event-actor-cell">
                            <strong>{event.actorUsername || 'system'}</strong>
                            <small>{event.actorRole || 'system'}</small>
                          </div>
                        </td>
                        <td>
                          <div className="event-action-cell">
                            <span className="event-kind">{event.kind}</span>
                            <strong>{event.action}</strong>
                          </div>
                        </td>
                        <td>
                          <div className="event-target-cell">
                            <strong>{event.targetId || event.targetType || 'n/a'}</strong>
                            <small>{event.targetType || 'event'}</small>
                          </div>
                        </td>
                        <td><span className={`event-status ${event.status || 'success'}`}>{event.status || 'success'}</span></td>
                        <td className="event-message-cell">{event.message || 'No message'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="event-empty-state event-empty-table">No events recorded yet.</div>
              )}
            </div>
          </div>

          <aside className="event-detail-card">
            <div className="event-table-head">
              <div>
                <h3>Event details</h3>
                <p>{selectedEvent ? selectedEvent.id : 'Select an event from the table.'}</p>
              </div>
            </div>
            {selectedEvent ? (
              <div className="event-detail-body">
                <div className="event-detail-grid">
                  <div><span>Time</span><b>{formatEventTime(selectedEvent.createdAt)}</b></div>
                  <div><span>User</span><b>{selectedEvent.actorUsername || 'system'}</b></div>
                  <div><span>Role</span><b>{selectedEvent.actorRole || 'system'}</b></div>
                  <div><span>Status</span><b>{selectedEvent.status || 'success'}</b></div>
                  <div><span>Kind</span><b>{selectedEvent.kind || 'event'}</b></div>
                  <div><span>Action</span><b>{selectedEvent.action || 'action'}</b></div>
                  <div><span>Target type</span><b>{selectedEvent.targetType || 'n/a'}</b></div>
                  <div><span>Target id</span><b>{selectedEvent.targetId || 'n/a'}</b></div>
                </div>
                <div className="event-message-panel">
                  <h4>Message</h4>
                  <p>{selectedEvent.message || 'No message'}</p>
                </div>
                <div className="event-message-panel">
                  <h4>Details</h4>
                  <pre>{stringifyDetails(selectedEvent.details)}</pre>
                </div>
              </div>
            ) : (
              <div className="event-empty-state">Choose an event to inspect its details.</div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
