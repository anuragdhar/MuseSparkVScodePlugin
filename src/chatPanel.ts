import * as vscode from 'vscode';
import { SparkClient, ChatMessage } from './sparkClient';
import { WorkspaceAgent } from './agent';
import { MuseCliClient } from './museCliClient';
import { resolveApprovalMode } from './sessionStore';
import { SessionStore, AgentSession } from './sessionStore';
import { randomUUID } from 'crypto';
import * as path from 'path';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'museSpark.chatView';
  private _view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private client = new SparkClient();
  private agent = new WorkspaceAgent(this.client);
  private cli = new MuseCliClient();
  private isContributor: boolean = true;
  private currentModel: string = 'muse-spark-1.2-contributor';
  private running = false;
  private sessionStore?: SessionStore;
  private activeSessionId: string = randomUUID();
  private activeSessionTitle: string = 'New session';

  constructor(private readonly _extensionUri: vscode.Uri, private readonly context?: vscode.ExtensionContext) {
    const cfg = vscode.workspace.getConfiguration('museSpark');
    this.isContributor = cfg.get<boolean>('useContributorPricing') ?? true;
    this.currentModel = cfg.get<string>('model') || 'muse-spark-1.2-contributor';
    if (context) {
      this.sessionStore = new SessionStore(context);
      const active = this.sessionStore.getActiveId();
      if (active) this.activeSessionId = active;
      // restore messages if prior session stored — we store serialized in globalState under key museSpark.sessionMessages.<id>
      const saved = context.globalState.get<ChatMessage[]>(`museSpark.sessionMessages.${this.activeSessionId}`);
      if (saved && Array.isArray(saved)) this.messages = saved;
    }
  }

  public updatePricingMode(isContributor: boolean, model: string) {
    this.isContributor = isContributor;
    this.currentModel = model;
    this.post({ type: 'pricingUpdate', isContributor, model });
    this.post({ type: 'approvalUpdate', mode: resolveApprovalMode() });
  }

  public reveal() { void vscode.commands.executeCommand('museSpark.chatView.focus'); }

  public updateCostTotals(totals: unknown, lastRecord: unknown) {
    this.post({ type: 'costUpdate', totals, lastRecord });
  }

  public stopAgent() {
    this.agent.stop();
    this.cli.stop();
    this.running = false;
    this.post({ type: 'agentStatus', content: 'Stopped' });
    this.post({ type: 'enableSend', enabled: true });
  }

  public async newSession() {
    await this.persistMessages();
    this.messages = [];
    this.activeSessionId = randomUUID();
    this.activeSessionTitle = `Session ${new Date().toLocaleTimeString()}`;
    this.cli.resetSession();
    if (this.sessionStore) {
      await this.sessionStore.addSession({ id: this.activeSessionId, title: this.activeSessionTitle, createdAt: Date.now(), model: this.currentModel, approvalMode: resolveApprovalMode() });
      await this.sessionStore.setActiveId(this.activeSessionId);
    }
    this.post({ type: 'cleared' });
    this.post({ type: 'agentStatus', content: 'New session ready' });
    await this.persistMessages();
  }

  public async forkSession() {
    await this.persistMessages();
    const forkedMessages = [...this.messages];
    const newId = randomUUID();
    this.activeSessionId = newId;
    this.activeSessionTitle = `Fork ${new Date().toLocaleTimeString()}`;
    this.cli.forkSession();
    if (this.sessionStore) {
      await this.sessionStore.addSession({ id: newId, title: this.activeSessionTitle, createdAt: Date.now(), model: this.currentModel, approvalMode: resolveApprovalMode() });
      await this.sessionStore.setActiveId(newId);
    }
    this.messages = forkedMessages;
    await this.persistMessages();
    // Re-render forked history in webview
    this.post({ type: 'cleared' });
    for (const m of this.messages) this.post({ type: 'addMessage', role: m.role, content: m.content });
    this.post({ type: 'agentStatus', content: `Forked session ${newId.slice(0, 8)}` });
    vscode.window.showInformationMessage(`Muse Spark: forked to ${this.activeSessionTitle}`);
  }

  public async listSessions(): Promise<void> {
    if (!this.sessionStore) {
      const cfg = vscode.workspace.getConfiguration('museSpark');
      vscode.window.showInformationMessage(`Spark session: model=${cfg.get('model')} • backend=${cfg.get('backend')} • approval=${resolveApprovalMode()} • id=${this.activeSessionId.slice(0,8)} • msgs=${this.messages.length}`);
      return;
    }
    const sessions = this.sessionStore.getSessions();
    if (!sessions.length) {
      vscode.window.showInformationMessage('No saved Spark sessions yet. Current: ' + this.activeSessionId.slice(0, 8));
      return;
    }
    const pick = await vscode.window.showQuickPick(sessions.map(s => ({
      label: `${s.id === this.activeSessionId ? '$(check) ' : ''}${s.title}`,
      description: `${s.model} • ${s.approvalMode} • ${new Date(s.createdAt).toLocaleString()}`,
      detail: s.id,
      session: s
    })), { title: 'Muse Spark Sessions', placeHolder: 'Select session to resume' });
    if (!pick) return;
    const chosen = (pick as any).session as AgentSession;
    await this.resumeSession(chosen.id);
  }

  public async resumeSession(id: string) {
    await this.persistMessages();
    try { this.cli.resumeSession(id); } catch {}
    this.activeSessionId = id;
    if (this.sessionStore) await this.sessionStore.setActiveId(id);
    const saved = this.context?.globalState.get<ChatMessage[]>(`museSpark.sessionMessages.${id}`);
    this.messages = Array.isArray(saved) ? saved : [];
    this.post({ type: 'cleared' });
    for (const m of this.messages) this.post({ type: 'addMessage', role: m.role, content: m.content });
    this.post({ type: 'agentStatus', content: `Resumed ${id.slice(0, 8)} • ${this.messages.length} msgs` });
  }

  public getActiveSessionId(): string { return this.activeSessionId; }
  public getMessages(): ChatMessage[] { return [...this.messages]; }

  private async persistMessages() {
    if (!this.context) return;
    await this.context.globalState.update(`museSpark.sessionMessages.${this.activeSessionId}`, this.messages.slice(-200));
  }

  private async handleSlashCommand(text: string): Promise<boolean> {
    const cmd = text.trim().toLowerCase();
    if (cmd === '/clear' || cmd === '/new') { await this.newSession(); return true; }
    if (cmd === '/fork') { await this.forkSession(); return true; }
    if (cmd === '/sessions' || cmd === '/list') { await this.listSessions(); return true; }
    if (cmd.startsWith('/model')) {
      const model = text.slice('/model'.length).trim();
      if (model) { await vscode.workspace.getConfiguration('museSpark').update('model', model, vscode.ConfigurationTarget.Global); vscode.window.showInformationMessage(`Model set to ${model}`); }
      else vscode.window.showInformationMessage(`Current model: ${this.currentModel}`);
      return true;
    }
    if (cmd.startsWith('/approval')) {
      const mode = text.slice('/approval'.length).trim();
      if (mode) vscode.commands.executeCommand('museSpark.setApprovalMode');
      return true;
    }
    if (cmd === '/diff') { vscode.commands.executeCommand('museSpark.showDiff'); return true; }
    if (cmd === '/help') {
      const help = 'Commands: /clear, /fork, /sessions, /model <id>, /approval, /diff, /help\nFile refs: @path/to/file or #path/to/file expands to file content.';
      this.post({ type: 'addMessage', role: 'assistant', content: help });
      return true;
    }
    if (cmd.startsWith('/')) {
      this.post({ type: 'addMessage', role: 'assistant', content: `Unknown command ${cmd}. Try /help` });
      return true;
    }
    return false;
  }

  private async expandFileRefs(text: string): Promise<string> {
    // Expand @path or #path references: replace with file content excerpt
    const re = /(^|\s)[@#]([\w./\-]+)/g;
    let match: RegExpExecArray | null;
    let expanded = text;
    const seen = new Set<string>();
    while ((match = re.exec(text)) !== null) {
      const rawPath = match[2];
      if (seen.has(rawPath)) continue;
      seen.add(rawPath);
      if (rawPath.length < 2) continue;
      try {
        const uri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', rawPath));
        const data = await vscode.workspace.fs.readFile(uri);
        if (data.byteLength > 8000) continue;
        const content = Buffer.from(data).toString('utf8').slice(0, 6000);
        expanded += `\n\nFile ${rawPath}:\n\`\`\`\n${content}\n\`\`\``;
      } catch { /* ignore missing file */ }
    }
    return expanded;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    view.webview.html = this.getHtml(view.webview);

    // Restore history into view on first load
    setTimeout(() => {
      for (const m of this.messages.slice(-50)) this.post({ type: 'addMessage', role: m.role, content: m.content });
      this.post({ type: 'pricingUpdate', isContributor: this.isContributor, model: this.currentModel });
      this.post({ type: 'approvalUpdate', mode: resolveApprovalMode() });
    }, 300);

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') {
        if (this.running) { this.stopAgent(); return; }
        let userText: string = msg.text;
        // Slash commands intercept before agent
        if (userText.trim().startsWith('/')) {
          if (await this.handleSlashCommand(userText)) return;
        }
        userText = await this.expandFileRefs(userText);
        const includeContext = msg.includeContext;
        let contextualCode = '';
        if (includeContext) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const sel = editor.selection;
            const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
            if (text) {
              contextualCode = `\n\nCurrent file: ${editor.document.fileName} (${editor.document.languageId})\n\`\`\`${editor.document.languageId}\n${text.slice(0, 8000)}\n\`\`\``;
            }
          }
        }
        const fullPrompt = userText + contextualCode;
        this.messages.push({ role: 'user', content: fullPrompt });
        await this.persistMessages();
        this.post({ type: 'addMessage', role: 'user', content: msg.text });
        this.post({ type: 'startStream' });
        this.running = true;
        this.post({ type: 'enableSend', enabled: false, running: true });
        try {
          const backend = vscode.workspace.getConfiguration('museSpark').get<string>('backend') || 'cli';
          const full = backend === 'cli'
            ? await this.cli.run(fullPrompt, event => {
                if (event.type === 'tool') this.post({ type: 'toolEvent', content: event.text });
                if (event.type === 'status') this.post({ type: 'agentStatus', content: event.text });
                if (event.type === 'delta') this.post({ type: 'delta', content: event.text });
                if (event.type === 'reasoning') this.post({ type: 'reasoning', content: event.text });
              })
            : await this.agent.run(this.messages, event => {
                if (event.type === 'tool') this.post({ type: 'toolEvent', content: event.text });
                if (event.type === 'status') this.post({ type: 'agentStatus', content: event.text });
                if (event.type === 'reasoning') this.post({ type: 'reasoning', content: event.text });
                if (event.type === 'plan') this.post({ type: 'planUpdate', content: event.text });
                if (event.type === 'diff') this.post({ type: 'diffEvent', content: event.text });
                if (event.type === 'text') this.post({ type: 'delta', content: event.text });
              });
          this.messages.push({ role: 'assistant', content: full });
          await this.persistMessages();
          this.post({ type: 'endStream', content: full });
        } catch (e: any) {
          const msg2 = e.message || String(e);
          if (msg2.includes('stopped by user') || msg2.includes('cancelled')) {
            this.post({ type: 'error', content: 'Stopped.' });
          } else {
            this.post({ type: 'error', content: msg2 });
          }
        } finally {
          this.running = false;
          this.post({ type: 'enableSend', enabled: true, running: false });
        }
      } else if (msg.type === 'stop') {
        this.stopAgent();
      } else if (msg.type === 'clear') {
        this.newSession();
      } else if (msg.type === 'insertCode') {
        const editor = vscode.window.activeTextEditor;
        if (editor) { editor.edit(edit => { edit.insert(editor.selection.active, msg.code); }); }
      } else if (msg.type === 'togglePricing') {
        vscode.commands.executeCommand('museSpark.togglePricingMode');
      } else if (msg.type === 'changeApproval') {
        vscode.commands.executeCommand('museSpark.setApprovalMode');
      } else if (msg.type === 'requestPricing') {
        this.post({ type: 'pricingUpdate', isContributor: this.isContributor, model: this.currentModel });
        this.post({ type: 'approvalUpdate', mode: resolveApprovalMode() });
      } else if (msg.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'museSpark');
      }
    });
  }

  public sendSelectionToChat(code: string, prompt: string) {
    this.messages.push({ role: 'user', content: `${prompt}:\n\`\`\`\n${code}\n\`\`\`` });
    this._view?.show?.(true);
    this.post({ type: 'addMessage', role: 'user', content: prompt });
    this.post({ type: 'startStream' });
    this.client.chat(this.messages, delta => { this.post({ type: 'delta', content: delta }); }).then(async full => {
      this.messages.push({ role: 'assistant', content: full });
      await this.persistMessages();
      this.post({ type: 'endStream', content: full });
    });
  }

  private post(msg: any) { this._view?.webview.postMessage(msg); }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin:0; padding:0; display:flex; flex-direction:column; height:100vh; background: var(--vscode-sideBar-background); }
  #pricingBanner { padding:8px 12px; display:flex; align-items:center; justify-content:space-between; font-size:11px; font-weight:600; letter-spacing:0.3px; cursor:pointer; }
  #pricingBanner.contributor { background: #1f1f1f; color: #ffb347; border-bottom: 1px solid #333; }
  #pricingBanner.standard { background: #0e2a3f; color: #7fb8ff; border-bottom: 1px solid #1a3f5f; }
  #pricingBanner .dot { width:7px; height:7px; border-radius:50%; display:inline-block; margin-right:6px; }
  #pricingBanner.contributor .dot { background: #ffb347; }
  #pricingBanner.standard .dot { background: #4ea1ff; }
  .toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; font-size:11px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background); }
  .toolbar .pill { font-size:10px; padding:2px 6px; border-radius:10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .toolbar select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius:4px; padding:2px 4px; font-size:11px; }
  #status { flex:1; opacity:0.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .msg { padding:9px 11px; border-radius:6px; line-height:1.5; font-size:13px; white-space:pre-wrap; word-break:break-word; }
  .user { background: var(--vscode-inputValidation-infoBorder); align-self:flex-end; max-width:88%; border: 1px solid var(--vscode-focusBorder); }
  .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .assistant pre { background: var(--vscode-textCodeBlock-background); padding:8px; border-radius:4px; overflow-x:auto; margin:6px 0; position:relative; }
  .assistant pre button { position:absolute; top:6px; right:6px; font-size:10px; padding:2px 6px; }
  #inputBar { padding:10px; border-top:1px solid var(--vscode-panel-border); display:flex; flex-direction:column; gap:8px; background: var(--vscode-sideBar-background); }
  #input { width:100%; min-height:64px; max-height:160px; resize:vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:8px; border-radius:6px; font-family:inherit; font-size:13px; }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { opacity:0.9; }
  button:disabled { opacity:0.45; cursor:not-allowed; }
  button.stop { background: var(--vscode-errorForeground); color: #fff; }
  #ctxLabel { font-size:11px; display:flex; align-items:center; gap:4px; cursor:pointer; }
  .tool { background: #1a1a1a; border-left:3px solid #3a7bff; font-family: var(--vscode-editor-font-family); font-size:11px; opacity:0.95; padding:6px 9px; border-radius:4px; }
  .reasoning { background: #111; border: 1px dashed #444; font-size:11px; opacity:0.9; padding:8px 10px; border-radius:4px; }
  .reasoning summary { cursor:pointer; font-weight:600; }
  .plan { background: var(--vscode-textBlockQuote-background); border-left: 3px solid #4caf50; font-size:12px; padding:8px 10px; border-radius:4px; }
  .diff { background: #0f1a0f; border-left:3px solid #2ea043; font-family: var(--vscode-editor-font-family); font-size:11px; }
  code { font-family: var(--vscode-editor-font-family); }
  .muted { opacity:0.6; font-size:11px; }
</style>
</head>
<body>
  <div id="pricingBanner" class="contributor" title="Click to toggle pricing mode">
    <span><span class="dot"></span><span id="pricingLabel">CONTRIBUTOR MODE</span><span style="font-weight:400; opacity:0.85; margin-left:6px;" id="pricingDetails">$0.10/M • Click to switch</span></span>
    <span style="font-size:12px; opacity:0.7;">⇄</span>
  </div>
  <div class="toolbar">
    <span id="modelLabel" class="pill">muse-spark-1.2-contributor</span>
    <select id="approvalSel" title="Approval mode">
      <option value="readOnly">Read-Only</option>
      <option value="auto">Auto</option>
      <option value="fullAccess">Full Access</option>
    </select>
    <span id="status">Ready</span>
    <button id="clearButton" class="secondary" type="button" title="New session">New</button>
  </div>
  <div id="messages"></div>
  <div id="inputBar">
    <textarea id="input" placeholder="Ask Spark 1.2…  (Enter to send, Shift+Enter for newline, @file or #file to reference, /help for commands)"></textarea>
    <div class="row">
      <label id="ctxLabel"><input type="checkbox" id="ctx" checked> Include editor context</label>
      <span class="muted" style="flex:1"></span>
      <button id="stopButton" class="secondary" type="button" style="display:none;">Stop</button>
      <button id="sendButton" type="button">Send</button>
    </div>
    <div class="muted">Codex-style: <code>apply_patch</code> • <code>update_plan</code> • diff preview • Auto-verify diagnostics • <code>/help</code></div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const bannerEl = document.getElementById('pricingBanner');
  const labelEl = document.getElementById('pricingLabel');
  const detailsEl = document.getElementById('pricingDetails');
  const modelEl = document.getElementById('modelLabel');
  const approvalSel = document.getElementById('approvalSel');
  const statusEl = document.getElementById('status');
  const sendBtn = document.getElementById('sendButton');
  const stopBtn = document.getElementById('stopButton');
  let streamingEl = null;
  let reasoningEl = null;

  function updateBanner(isContributor, model) {
    modelEl.textContent = model;
    if (isContributor) {
      bannerEl.className = 'contributor';
      labelEl.textContent = 'CONTRIBUTOR';
      detailsEl.textContent = '$0.10/M in • $0.20/M out';
    } else {
      bannerEl.className = 'standard';
      labelEl.textContent = 'PRIVATE STANDARD';
      detailsEl.textContent = '$1.25/M in • $4.25/M out';
    }
  }
  function updateApproval(mode) { approvalSel.value = mode; }

  function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = content;
    if (role === 'assistant' && content.includes('\`\`\`')) {
      div.innerHTML = content.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (m, lang, code) => {
        const esc = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return '<pre><code>' + esc + '</code><button type="button" onclick="insertCode(this)">Insert</button></pre>';
      });
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    statusEl.textContent = 'Sending…';
    sendBtn.disabled = true;
    stopBtn.style.display = 'inline-block';
    const includeContext = document.getElementById('ctx').checked;
    vscode.postMessage({ type: 'send', text, includeContext });
    inputEl.value = '';
  }

  function stop() { vscode.postMessage({ type: 'stop' }); }
  function clearChat() { vscode.postMessage({ type: 'clear' }); }
  function insertCode(btn) {
    const code = btn.parentElement.querySelector('code').innerText;
    vscode.postMessage({ type: 'insertCode', code });
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);
  document.getElementById('clearButton').addEventListener('click', clearChat);
  bannerEl.addEventListener('click', () => vscode.postMessage({ type: 'togglePricing' }));
  approvalSel.addEventListener('change', () => vscode.postMessage({ type: 'changeApproval' }));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      // Enter => send, Shift+Enter => newline, Ctrl/Cmd+Enter => send even with Shift
      const isPlainEnter = !e.shiftKey;
      const isCtrlEnter = e.ctrlKey || e.metaKey;
      if (isPlainEnter || isCtrlEnter) {
        e.preventDefault();
        send();
        return;
      }
      // Shift+Enter without Ctrl/Cmd: allow default newline
    }
    if (e.key === 'Escape') stop();
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'addMessage') addMessage(msg.role, msg.content);
    else if (msg.type === 'pricingUpdate') updateBanner(msg.isContributor, msg.model);
    else if (msg.type === 'approvalUpdate') updateApproval(msg.mode);
    else if (msg.type === 'toolEvent') addMessage('tool', '◆ ' + msg.content);
    else if (msg.type === 'diffEvent') addMessage('diff', '✔ ' + msg.content);
    else if (msg.type === 'planUpdate') {
      const d = document.createElement('div');
      d.className = 'msg plan';
      d.innerHTML = '<strong>Plan</strong><pre style="white-space:pre-wrap; margin:6px 0 0;">' + msg.content.replace(/</g,'&lt;') + '</pre>';
      messagesEl.appendChild(d);
    }
    else if (msg.type === 'reasoning') {
      if (!reasoningEl) {
        reasoningEl = document.createElement('details');
        reasoningEl.className = 'msg reasoning';
        reasoningEl.open = true;
        reasoningEl.innerHTML = '<summary>Thinking…</summary><div class="reasonBody" style="white-space:pre-wrap; margin-top:6px;"></div>';
        messagesEl.appendChild(reasoningEl);
      }
      reasoningEl.querySelector('.reasonBody').textContent += msg.content;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    else if (msg.type === 'agentStatus') statusEl.textContent = msg.content;
    else if (msg.type === 'startStream') {
      reasoningEl = null;
      streamingEl = addMessage('assistant', '▌');
      statusEl.textContent = 'Spark thinking…';
      sendBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
    }
    else if (msg.type === 'delta') {
      if (streamingEl) {
        const current = streamingEl.textContent === '▌' ? '' : streamingEl.textContent.replace('▌','');
        streamingEl.textContent = current + msg.content + '▌';
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } else if (msg.type === 'endStream') {
      if (streamingEl) {
        streamingEl.textContent = msg.content;
        streamingEl.innerHTML = msg.content.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (m, lang, code) => {
          const esc = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          return '<pre><code>' + esc + '</code><button type="button" onclick="insertCode(this)">Insert</button></pre>';
        });
      }
      streamingEl = null; reasoningEl = null;
      statusEl.textContent = 'Ready';
      sendBtn.disabled = false;
      stopBtn.style.display = 'none';
    } else if (msg.type === 'enableSend') {
      sendBtn.disabled = !msg.enabled;
      stopBtn.style.display = msg.running ? 'inline-block' : 'none';
      if (msg.running) sendBtn.textContent = 'Stop';
      else sendBtn.textContent = 'Send';
    } else if (msg.type === 'cleared') { messagesEl.innerHTML = ''; reasoningEl=null; streamingEl=null; }
    else if (msg.type === 'error') { addMessage('assistant', 'Error: ' + msg.content); statusEl.textContent = 'Error'; sendBtn.disabled = false; stopBtn.style.display='none'; streamingEl = null; reasoningEl=null; }
  });

  vscode.postMessage({ type: 'requestPricing' });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
