import React, { useState } from 'react';
import Editor from '@monaco-editor/react';
import { parseCaddyfile } from '../../server/caddyParser.js';
import { ConfirmModal, Notice, deleteConfirm, findBlockRange } from '../components/common.jsx';

const localTest = import.meta.env.DEV && import.meta.env.VITE_CADDYUI_LOCAL_TEST === '1';

function normalizeEditorBody(value = '') {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const content = lines.filter((line) => line.trim().length > 0);
  if (!content.length) return '';
  const minIndent = content.reduce((min, line) => {
    const indent = (line.match(/^\s*/) || [''])[0].length;
    return Math.min(min, indent);
  }, Number.POSITIVE_INFINITY);
  return lines.map((line) => (line.trim().length ? line.slice(minIndent) : '')).join('\n');
}

function localSnippetBlock(name, body) {
  const normalized = normalizeEditorBody(body);
  const lines = normalized
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `\t${line}`)
    .join('\n');
  return `(${name}) {\n${lines}\n}`;
}

export default function Middlewares({ config, setConfig, canEdit, theme, api }) {
  const snippets = config?.parsed?.snippets || [];
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ name: '', body: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const applyLocal = (content) => {
    setConfig({
      path: config?.path || 'Caddyfile',
      content,
      parsed: parseCaddyfile(content),
      health: config?.health || {},
    });
  };

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const normalizedBody = normalizeEditorBody(form.body);
      if (localTest) {
        applyLocal(`${config.content.trimEnd()}\n\n${localSnippetBlock(form.name, normalizedBody)}\n`);
        setForm({ name: '', body: '' });
        return;
      }
      const data = await api('/api/middlewares', {
        method: 'POST',
        body: JSON.stringify({ ...form, body: normalizedBody }),
      });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      setForm({ name: '', body: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError('');
    try {
      const normalizedBody = normalizeEditorBody(edit.body);
      if (localTest) {
        const range = findBlockRange(config.content, edit.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) {
          lines.splice(
            range.start,
            range.end - range.start + 1,
            ...localSnippetBlock(edit.name, normalizedBody).split('\n')
          );
        }
        applyLocal(lines.join('\n'));
        setEdit(null);
        return;
      }
      const data = await api(`/api/middlewares/${edit.line}`, {
        method: 'PUT',
        body: JSON.stringify({ ...edit, body: normalizedBody }),
      });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
      setEdit(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteMiddleware = async (item) => {
    setBusy(true);
    setError('');
    try {
      if (localTest) {
        const range = findBlockRange(config.content, item.line);
        const lines = config.content.replace(/\r\n/g, '\n').split('\n');
        if (range) lines.splice(range.start, range.end - range.start + 1);
        applyLocal(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
        return;
      }
      const data = await api(`/api/middlewares/${item.line}`, { method: 'DELETE' });
      setConfig((current) => ({ ...current, content: data.content, parsed: data.parsed }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Middlewares</h2>
          <p>Snippets and imports.</p>
        </div>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      {canEdit && (
        <form className="middleware-form" onSubmit={add}>
          <input
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div className="middleware-editor">
            <Editor
              height="180px"
              defaultLanguage="caddyfile"
              theme={theme === 'light' ? 'light' : 'vs-dark'}
              value={form.body}
              onChange={(value) => setForm({ ...form, body: value || '' })}
              options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }}
            />
          </div>
          <button className="primary" disabled={busy}>Add middleware</button>
        </form>
      )}

      <div className="middleware-list">
        {snippets.map((snippet) => (
          <div className="middleware-row" key={snippet.name}>
            <span className="proxy-host">({snippet.name})</span>
            <span className="status-dot online">{snippet.inferredType}</span>
            <span className="proxy-mw">{snippet.usedBy?.join(', ') || 'unused'}</span>
            <div className="row-actions">
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setEdit({
                        line: snippet.line,
                        name: snippet.name,
                        body: normalizeEditorBody(snippet.body),
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={(e) =>
                      setConfirmDelete(deleteConfirm(e, 'Delete middleware', snippet.name, () => deleteMiddleware(snippet)))
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {edit && (
        <div className="modal-backdrop" onMouseDown={() => setEdit(null)}>
          <form className="edit-modal" onSubmit={save} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Edit middleware</h3>
              <button type="button" onClick={() => setEdit(null)}>Close</button>
            </div>
            <label>
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <div className="middleware-editor">
              <Editor
                height="260px"
                defaultLanguage="caddyfile"
                theme={theme === 'light' ? 'light' : 'vs-dark'}
                value={edit.body}
                onChange={(value) => setEdit({ ...edit, body: value || '' })}
                options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false }}
              />
            </div>
            <div className="toolbar">
              <button className="primary" disabled={busy}>Save</button>
              <button type="button" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmModal
        confirm={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete?.action()}
      />
    </section>
  );
}
