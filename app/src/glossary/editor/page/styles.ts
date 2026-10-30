/**
 * The editor's stylesheet, the WordPress admin palette of the approved
 * mockup. Light only on the local page: the people using it spend their day
 * in wp-admin and GlotPress, and a grid that looks like those reads as one.
 * The colours are custom properties on .ge, so the website can map them onto
 * its own theme without overriding a single rule.
 */
export const EDITOR_CSS = `
.ge {
  --ge-bg: #f0f0f1; --ge-surface: #fff; --ge-bar: #f6f7f7; --ge-panel: #fcfcfc;
  --ge-text: #1d2327; --ge-muted: #50575e; --ge-faint: #787c82;
  --ge-line: #dcdcde; --ge-line-soft: #f0f0f1; --ge-border: #c3c4c7;
  --ge-accent: #2271b1; --ge-accent-soft: #f0f6fc; --ge-ring: #c5d9ed;
  --ge-changed: #dba617; --ge-added: #00a32a; --ge-local: #72aee6;
  --ge-warn: #b32d2e; --ge-warn-soft: #fcf0f1;
  color-scheme: light;
  color: var(--ge-text); background: var(--ge-bg);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; gap: 8px;
  max-width: 1400px; margin: 0 auto; padding: 16px; box-sizing: border-box;
  border-radius: var(--ge-radius, 8px);
}
.ge *, .ge *::before, .ge *::after { box-sizing: border-box; }
.ge-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.ge-title { font-size: 20px; margin: 0; }
.ge-file { color: var(--ge-muted); font-size: 13px; overflow-wrap: anywhere; }
.ge-loading { color: var(--ge-muted); }
.ge-bar {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px;
  background: var(--ge-bar); border: 1px solid var(--ge-border); border-radius: 6px;
  position: sticky; top: 0; z-index: 2;
}
.ge-search {
  flex: 1 1 220px; min-width: 0; padding: 5px 8px; font: inherit; color: var(--ge-text);
  background: var(--ge-surface); border: 1px solid var(--ge-border); border-radius: 4px;
}
.ge-chips, .ge-group { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ge-chip {
  padding: 2px 9px; border: 1px solid var(--ge-border); border-radius: 999px; font: inherit; font-size: 12px;
  background: var(--ge-surface); color: var(--ge-text); cursor: pointer;
}
.ge-chip.on { background: var(--ge-accent); border-color: var(--ge-accent); color: #fff; }
.ge-count { font-size: 12px; color: var(--ge-muted); white-space: nowrap; }
.ge-btn {
  padding: 5px 11px; border-radius: 4px; border: 1px solid var(--ge-accent); font: inherit; font-size: 13px;
  font-weight: 600; cursor: pointer; background: var(--ge-accent); color: #fff; white-space: nowrap;
}
.ge-btn.ge-ghost { background: var(--ge-surface); color: var(--ge-accent); }
.ge-btn.ge-danger { background: var(--ge-warn); border-color: var(--ge-warn); color: #fff; }
.ge-btn.ge-danger-text { color: var(--ge-warn); border-color: var(--ge-warn); }
.ge-busy .ge-grid td.ge-cell { cursor: progress; }
.ge-btn:disabled { opacity: .5; cursor: not-allowed; }
.ge-btn:focus-visible, .ge-chip:focus-visible, .ge-link:focus-visible, .ge-search:focus-visible {
  outline: 2px solid var(--ge-accent); outline-offset: 1px;
}
.ge-link { background: none; border: 0; padding: 0; font: inherit; color: var(--ge-accent); text-decoration: underline; cursor: pointer; }
.ge-reason, .ge-notice { margin: 0; font-size: 13px; }
.ge-notice { padding: 6px 10px; border-left: 4px solid var(--ge-changed); background: var(--ge-surface); }
.ge-status:empty { display: none; }
.ge-status { font-size: 13px; padding: 6px 10px; background: var(--ge-surface); border-left: 4px solid var(--ge-accent); }
.ge-status.ge-error { border-left-color: var(--ge-warn); }
.ge-body {
  display: grid; grid-template-columns: minmax(0, 1fr) 260px; flex: 1 1 auto; min-height: 0;
  background: var(--ge-surface); border: 1px solid var(--ge-border); border-radius: 6px; overflow: hidden;
}
.ge-body.ge-no-panel { grid-template-columns: minmax(0, 1fr); }
.ge-scroll { overflow: auto; max-height: calc(100vh - 190px); }
.ge-grid { width: 100%; border-collapse: collapse; font-size: 13px; }
.ge-grid th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--ge-muted);
  padding: 7px 8px; border-bottom: 1px solid var(--ge-line); background: var(--ge-surface);
  position: sticky; top: 0; z-index: 1;
}
.ge-grid td { padding: 6px 8px; border-bottom: 1px solid var(--ge-line-soft); vertical-align: top; overflow-wrap: anywhere; }
.ge-grid th.ge-pos, .ge-grid td.ge-pos { width: 130px; }
.ge-grid th.ge-acts, .ge-grid td.ge-acts { width: 70px; text-align: right; }
.ge-grid td.ge-cell { cursor: cell; }
.ge-grid td.ge-cell:focus { outline: 2px solid var(--ge-accent); outline-offset: -2px; background: var(--ge-accent-soft); }
.ge-grid tr:focus-within td { background: var(--ge-accent-soft); }
.ge-grid td.ge-editing { outline: 2px solid var(--ge-accent); outline-offset: -2px; background: var(--ge-surface) !important; padding: 3px 4px; }
.ge-grid td.ge-editing input, .ge-grid td.ge-editing select {
  width: 100%; font: inherit; color: var(--ge-text); background: var(--ge-surface);
  border: 1px solid var(--ge-accent); border-radius: 3px; padding: 2px 4px;
}
.ge-grid td.ge-editing input:focus, .ge-grid td.ge-editing select:focus { outline: none; }
.ge-grid td.ge-changed { box-shadow: inset 3px 0 0 var(--ge-changed); }
.ge-grid td.ge-added { box-shadow: inset 3px 0 0 var(--ge-added); }
.ge-grid td.ge-local { box-shadow: inset 3px 0 0 var(--ge-local); }
.ge-grid tr.ge-deleted td.ge-cell { text-decoration: line-through; color: var(--ge-faint); }
.ge-warn { color: var(--ge-warn); }
.ge-muted { color: var(--ge-faint); }
.ge-tag {
  display: inline-block; padding: 0 6px; border-radius: 3px; background: var(--ge-warn-soft); color: var(--ge-warn);
  font-size: 11px; text-transform: none; letter-spacing: 0; font-weight: 400;
}
.ge-empty { padding: 16px; color: var(--ge-muted); margin: 0; }
.ge-panel {
  border-left: 1px solid var(--ge-line); padding: 10px 12px; background: var(--ge-panel); font-size: 12px;
  overflow: auto; max-height: calc(100vh - 190px);
}
.ge-panel h4 { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; color: var(--ge-muted); }
.ge-panel h4:first-child { margin-top: 0; font-size: 13px; text-transform: none; color: var(--ge-text); }
.ge-panel p { margin: 0 0 4px; }
.ge-panel ul { margin: 0; padding-left: 16px; }
.ge-legend { font-size: 12px; color: var(--ge-muted); margin: 0; }
.ge-key { display: inline-block; width: 10px; height: 10px; vertical-align: middle; margin: 0 4px 0 10px; }
.ge-key-changed { background: var(--ge-changed); }
.ge-key-local[hidden] { display: none; }
.ge-key-added { background: var(--ge-added); }
.ge-key-local .ge-key { background: var(--ge-local); }
.ge-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ge-layer { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 16px; }
.ge-layer[hidden] { display: none; }
.ge-backdrop { position: absolute; inset: 0; background: rgba(29, 35, 39, .45); }
.ge-dialog {
  position: relative; background: var(--ge-surface); border-radius: 8px; padding: 16px 20px;
  width: min(720px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-shadow: 0 8px 30px rgba(0, 0, 0, .25);
}
.ge-dialog.ge-small { width: min(460px, 100%); }
.ge-dialog:focus { outline: none; }
.ge-dialog h2 { font-size: 18px; margin: 0 0 12px; }
.ge-dialog h3 { font-size: 13px; text-transform: uppercase; color: var(--ge-muted); margin: 14px 0 6px; }
.ge-dialog ul { margin: 0; padding-left: 18px; }
.ge-dialog li { margin: 2px 0; }
.ge-dialog ul.ge-fields { padding-left: 16px; color: var(--ge-muted); }
.ge-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
@media (max-width: 760px) {
  .ge { padding: 8px; }
  .ge-body { grid-template-columns: minmax(0, 1fr); }
  .ge-panel { border-left: 0; border-top: 1px solid var(--ge-line); max-height: 40vh; }
}
`
