"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const sparkClient_1 = require("./sparkClient");
const agent_1 = require("./agent");
const museCliClient_1 = require("./museCliClient");
const sessionStore_1 = require("./sessionStore");
const sessionStore_2 = require("./sessionStore");
const crypto_1 = require("crypto");
const path = __importStar(require("path"));
class ChatViewProvider {
    constructor(_extensionUri, context) {
        this._extensionUri = _extensionUri;
        this.context = context;
        this.messages = [];
        this.client = new sparkClient_1.SparkClient();
        this.agent = new agent_1.WorkspaceAgent(this.client);
        this.cli = new museCliClient_1.MuseCliClient();
        this.isContributor = true;
        this.currentModel = 'muse-spark-1.2-contributor';
        this.running = false;
        this.activeSessionId = (0, crypto_1.randomUUID)();
        this.activeSessionTitle = 'New session';
        const cfg = vscode.workspace.getConfiguration('museSpark');
        this.isContributor = cfg.get('useContributorPricing') ?? true;
        this.currentModel = cfg.get('model') || 'muse-spark-1.2-contributor';
        if (context) {
            this.sessionStore = new sessionStore_2.SessionStore(context);
            const active = this.sessionStore.getActiveId();
            if (active)
                this.activeSessionId = active;
            this.cli.resumeSession(this.activeSessionId);
            // restore messages if prior session stored — we store serialized in globalState under key museSpark.sessionMessages.<id>
            const saved = context.globalState.get(`museSpark.sessionMessages.${this.activeSessionId}`);
            if (saved && Array.isArray(saved))
                this.messages = saved;
        }
    }
    updatePricingMode(isContributor, model) {
        this.isContributor = isContributor;
        this.currentModel = model;
        this.post({ type: 'pricingUpdate', isContributor, model });
        this.post({ type: 'approvalUpdate', mode: (0, sessionStore_1.resolveApprovalMode)() });
    }
    reveal() { void vscode.commands.executeCommand('museSpark.chatView.focus'); }
    updateCostTotals(totals, lastRecord) {
        this.post({ type: 'costUpdate', totals, lastRecord });
    }
    updateBillingInfo(info) {
        this.post({ type: 'billingUpdate', info });
    }
    stopAgent() {
        this.agent.stop();
        this.cli.stop();
        this.running = false;
        this.post({ type: 'agentStatus', content: 'Stopped' });
        this.post({ type: 'enableSend', enabled: true });
    }
    async newSession() {
        this.agent.stop();
        this.cli.stop();
        this.running = false;
        await this.persistMessages();
        this.messages = [];
        this.activeSessionId = (0, crypto_1.randomUUID)();
        this.activeSessionTitle = `Session ${new Date().toLocaleTimeString()}`;
        this.cli.resetSession(this.activeSessionId);
        if (this.sessionStore) {
            await this.sessionStore.addSession({ id: this.activeSessionId, title: this.activeSessionTitle, createdAt: Date.now(), model: this.currentModel, approvalMode: (0, sessionStore_1.resolveApprovalMode)() });
            await this.sessionStore.setActiveId(this.activeSessionId);
        }
        this.post({ type: 'cleared' });
        this.post({ type: 'agentStatus', content: 'New session ready' });
        this.post({ type: 'enableSend', enabled: true, running: false });
        this.post({ type: 'focusInput' });
        await this.persistMessages();
    }
    async forkSession() {
        await this.persistMessages();
        const forkedMessages = [...this.messages];
        const newId = (0, crypto_1.randomUUID)();
        this.activeSessionId = newId;
        this.activeSessionTitle = `Fork ${new Date().toLocaleTimeString()}`;
        this.cli.forkSession(newId);
        if (this.sessionStore) {
            await this.sessionStore.addSession({ id: newId, title: this.activeSessionTitle, createdAt: Date.now(), model: this.currentModel, approvalMode: (0, sessionStore_1.resolveApprovalMode)() });
            await this.sessionStore.setActiveId(newId);
        }
        this.messages = forkedMessages;
        await this.persistMessages();
        // Re-render forked history in webview
        this.post({ type: 'cleared' });
        for (const m of this.messages)
            this.post({ type: 'addMessage', role: m.role, content: m.content });
        this.post({ type: 'agentStatus', content: `Forked session ${newId.slice(0, 8)}` });
        vscode.window.showInformationMessage(`Muse Spark: forked to ${this.activeSessionTitle}`);
    }
    async listSessions() {
        if (!this.sessionStore) {
            const cfg = vscode.workspace.getConfiguration('museSpark');
            const cur = this.getSessionStats();
            vscode.window.showInformationMessage(`Spark session: model=${cfg.get('model')} • backend=${cfg.get('backend')} • approval=${(0, sessionStore_1.resolveApprovalMode)()} • id=${this.activeSessionId.slice(0, 8)} • msgs=${this.messages.length} • ~${cur?.stats.tokens ?? 0} tokens`);
            return;
        }
        const enriched = this.getAllSessionsStats();
        if (!enriched.length) {
            vscode.window.showInformationMessage('No saved Spark sessions yet. Current: ' + this.activeSessionId.slice(0, 8));
            return;
        }
        const pick = await vscode.window.showQuickPick(enriched.map(e => ({
            label: `${e.session.id === this.activeSessionId ? '$(check) ' : ''}${e.session.title}`,
            description: `${e.total} msgs • ~${e.tokens} tok • ${e.images ? e.images + ' img • ' : ''}${e.session.model} • ${e.session.approvalMode}`,
            detail: `${e.preview ? e.preview.slice(0, 100) : '(no preview)'}  —  ${new Date(e.session.updatedAt || e.session.createdAt).toLocaleString()}  •  ${e.session.id}`,
            session: e.session
        })), { title: 'Muse Spark Sessions — Codex style', placeHolder: 'Select session (Enter to resume, then choose action)' });
        if (!pick)
            return;
        const chosen = pick.session;
        // Codex-like action picker after session choice
        const action = await vscode.window.showQuickPick([
            { label: '$(arrow-right) Resume', description: `Load ${chosen.title} into chat`, value: 'resume' },
            { label: '$(graph) Show stats', description: 'In-chat token / message breakdown', value: 'stats' },
            { label: '$(output) Export', description: 'Open transcript as markdown', value: 'export' },
            { label: '$(edit) Rename', description: 'Change session title', value: 'rename' },
            { label: '$(trash) Delete', description: 'Remove session + transcript', value: 'delete' },
        ], { title: `${chosen.title} — ${chosen.id.slice(0, 8)}`, placeHolder: 'Choose action' });
        if (!action)
            return;
        const val = action.value;
        if (val === 'resume')
            await this.resumeSession(chosen.id);
        else if (val === 'stats')
            this.showStatsInChat(chosen.id);
        else if (val === 'export')
            await this.exportSession(chosen.id);
        else if (val === 'delete') {
            const ok = await vscode.window.showWarningMessage(`Delete session "${chosen.title}"?`, { modal: true }, 'Delete');
            if (ok === 'Delete')
                await this.deleteSession(chosen.id);
        }
        else if (val === 'rename') {
            const title = await vscode.window.showInputBox({ prompt: 'New session title', value: chosen.title, validateInput: v => v.trim().length < 2 ? 'Title too short' : undefined });
            if (title)
                await this.renameSession(chosen.id, title);
        }
    }
    async resumeSession(id) {
        await this.persistMessages();
        try {
            this.cli.resumeSession(id);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Cannot resume Muse session: ${error.message}`);
            return;
        }
        this.running = false;
        this.activeSessionId = id;
        if (this.sessionStore)
            await this.sessionStore.setActiveId(id);
        const saved = this.context?.globalState.get(`museSpark.sessionMessages.${id}`);
        this.messages = Array.isArray(saved) ? saved : [];
        this.post({ type: 'cleared' });
        for (const m of this.messages)
            this.post({ type: 'addMessage', role: m.role, content: m.content });
        this.post({ type: 'agentStatus', content: `Resumed ${id.slice(0, 8)} • ${this.messages.length} msgs` });
        this.post({ type: 'enableSend', enabled: true, running: false });
        this.post({ type: 'focusInput' });
    }
    getActiveSessionId() { return this.activeSessionId; }
    getMessages() { return [...this.messages]; }
    // ---- Codex-like stats/helpers ----
    getSessionMessages(id) {
        return this.context?.globalState.get(`museSpark.sessionMessages.${id}`);
    }
    computeStats(messages) {
        let tokens = 0, images = 0, user = 0, assistant = 0;
        for (const m of messages) {
            tokens += (0, sparkClient_1.estimateTokensForContent)(m.content);
            images += (0, sparkClient_1.countImagesInContent)(m.content);
            if (m.role === 'user')
                user++;
            else if (m.role === 'assistant')
                assistant++;
        }
        return { tokens, images, user, assistant, total: messages.length };
    }
    getSessionStats(id) {
        const sid = id || this.activeSessionId;
        const msgs = sid === this.activeSessionId ? this.messages : (this.getSessionMessages(sid) || []);
        const s = this.sessionStore?.getSession(sid);
        return { id: sid, title: s?.title || this.activeSessionTitle, stats: this.computeStats(msgs), createdAt: s?.createdAt, updatedAt: s?.updatedAt, model: s?.model };
    }
    getAllSessionsStats() {
        if (!this.sessionStore)
            return [];
        return this.sessionStore.getSessions().map(s => {
            const msgs = this.getSessionMessages(s.id) || [];
            return { session: s, ...this.computeStats(msgs), preview: this.previewFor(msgs, s) };
        });
    }
    previewFor(messages, s) {
        if (s?.preview)
            return s.preview;
        const firstUser = messages.find(m => m.role === 'user');
        if (!firstUser)
            return '';
        const t = (0, sparkClient_1.getTextFromContent)(firstUser.content);
        return t.slice(0, 120).replace(/\n/g, ' ');
    }
    deriveTitleFromMessages(messages) {
        const firstUser = messages.find(m => m.role === 'user');
        if (!firstUser)
            return undefined;
        const t = (0, sparkClient_1.getTextFromContent)(firstUser.content).trim().split('\n')[0].slice(0, 48);
        return t.length >= 3 ? t : undefined;
    }
    async syncSessionMeta() {
        if (!this.sessionStore)
            return;
        const preview = this.previewFor(this.messages);
        const title = this.deriveTitleFromMessages(this.messages);
        const patch = { msgCount: this.messages.length, preview, updatedAt: Date.now() };
        // Codex-style: auto-title from first prompt if still default "Session ..." / "New session"
        const cur = this.sessionStore.getSession(this.activeSessionId);
        if (title && cur && (/^Session /.test(cur.title) || cur.title === 'New session')) {
            patch.title = title;
            this.activeSessionTitle = title;
        }
        await this.sessionStore.updateSession(this.activeSessionId, patch);
    }
    async deleteSession(id) {
        if (!this.sessionStore)
            return;
        await this.context?.globalState.update(`museSpark.sessionMessages.${id}`, undefined);
        await this.sessionStore.removeSession(id);
        if (id === this.activeSessionId)
            await this.newSession();
        else
            this.post({ type: 'agentStatus', content: `Deleted ${id.slice(0, 8)}` });
    }
    async renameSession(id, title) {
        if (!this.sessionStore)
            return;
        await this.sessionStore.updateSession(id, { title: title.slice(0, 80) });
        if (id === this.activeSessionId)
            this.activeSessionTitle = title;
        this.post({ type: 'agentStatus', content: `Renamed ${id.slice(0, 8)} → ${title}` });
    }
    async exportSession(id) {
        const msgs = id === this.activeSessionId ? this.messages : (this.getSessionMessages(id) || []);
        const s = this.sessionStore?.getSession(id);
        const lines = [`# Spark Session ${s?.title || id} (${id})`, `Model: ${s?.model || this.currentModel} • ${new Date(s?.createdAt || Date.now()).toLocaleString()}`, ''];
        for (const m of msgs) {
            const text = (0, sparkClient_1.getTextFromContent)(m.content);
            const imgs = (0, sparkClient_1.countImagesInContent)(m.content);
            lines.push(`## ${m.role}${imgs ? ` (${imgs} image${imgs > 1 ? 's' : ''})` : ''}`, text || '_[images only]_', '');
        }
        const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: false });
        return lines.join('\n');
    }
    async persistMessages() {
        if (!this.context)
            return;
        await this.context.globalState.update(`museSpark.sessionMessages.${this.activeSessionId}`, this.messages.slice(-200));
        await this.syncSessionMeta();
    }
    async handleSlashCommand(text) {
        const raw = text.trim();
        const cmd = raw.toLowerCase();
        if (cmd === '/clear' || cmd === '/new') {
            await this.newSession();
            return true;
        }
        if (cmd === '/fork') {
            await this.forkSession();
            return true;
        }
        if (cmd === '/sessions' || cmd === '/list' || cmd === '/session' || cmd === '/history') {
            // Codex-like: render in-chat browser + also show QuickPick
            this.showSessionsInChat();
            // also offer QuickPick for keyboard flow
            setTimeout(() => this.listSessions(), 150);
            return true;
        }
        if (cmd === '/stats' || cmd === '/stat' || cmd.startsWith('/stats ') || cmd.startsWith('/stat ')) {
            const arg = raw.slice(raw.toLowerCase().startsWith('/stats') ? 6 : 5).trim();
            if (arg) {
                const found = this.sessionStore?.getSessions().find(s => s.id.startsWith(arg) || s.title.toLowerCase().includes(arg.toLowerCase()));
                if (found)
                    this.showStatsInChat(found.id);
                else
                    this.showStatsInChat();
            }
            else
                this.showStatsInChat();
            return true;
        }
        if (cmd.startsWith('/rename')) {
            const title = raw.slice('/rename'.length).trim();
            if (!title) {
                this.post({ type: 'addMessage', role: 'assistant', content: 'Usage: /rename <new title>' });
                return true;
            }
            await this.renameSession(this.activeSessionId, title);
            return true;
        }
        if (cmd.startsWith('/delete')) {
            const arg = raw.slice('/delete'.length).trim();
            const id = arg || this.activeSessionId;
            const found = this.sessionStore?.getSessions().find(s => s.id === id || s.id.startsWith(id));
            await this.deleteSession(found?.id || id);
            return true;
        }
        if (cmd.startsWith('/export')) {
            const arg = raw.slice('/export'.length).trim();
            const id = arg ? (this.sessionStore?.getSessions().find(s => s.id.startsWith(arg))?.id || arg) : this.activeSessionId;
            await this.exportSession(id);
            return true;
        }
        if (cmd.startsWith('/model')) {
            const model = text.slice('/model'.length).trim();
            if (model) {
                await vscode.workspace.getConfiguration('museSpark').update('model', model, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Model set to ${model}`);
            }
            else
                vscode.window.showInformationMessage(`Current model: ${this.currentModel}`);
            return true;
        }
        if (cmd.startsWith('/approval')) {
            const mode = text.slice('/approval'.length).trim();
            if (mode)
                vscode.commands.executeCommand('museSpark.setApprovalMode');
            return true;
        }
        if (cmd === '/diff') {
            vscode.commands.executeCommand('museSpark.showDiff');
            return true;
        }
        if (cmd === '/help') {
            const help = 'Commands: /clear, /fork, /sessions (/list /history), /stats [id|title], /rename <title>, /delete [id], /export [id], /model <id>, /approval, /diff, /help\nFile refs: @path/to/file or #path/to/file expands to file content.';
            this.post({ type: 'addMessage', role: 'assistant', content: help });
            return true;
        }
        if (cmd.startsWith('/')) {
            this.post({ type: 'addMessage', role: 'assistant', content: `Unknown command ${cmd}. Try /help` });
            return true;
        }
        return false;
    }
    showSessionsInChat() {
        if (!this.sessionStore) {
            this.post({ type: 'addMessage', role: 'assistant', content: `Active session ${this.activeSessionId.slice(0, 8)} • ${this.messages.length} msgs` });
            return;
        }
        const enriched = this.getAllSessionsStats();
        if (!enriched.length) {
            this.post({ type: 'addMessage', role: 'assistant', content: 'No saved Spark sessions yet. Start chatting and they will appear here. Try /clear to start a new session.' });
            return;
        }
        this.post({ type: 'sessionsBrowser', sessions: enriched.map(e => ({
                id: e.session.id, title: e.session.title, model: e.session.model, approvalMode: e.session.approvalMode,
                createdAt: e.session.createdAt, updatedAt: e.session.updatedAt, preview: e.preview,
                msgCount: e.total, tokens: e.tokens, images: e.images, isActive: e.session.id === this.activeSessionId
            })) });
    }
    showStatsInChat(id) {
        const target = id ? this.getSessionStats(id) : this.getSessionStats();
        const all = this.getAllSessionsStats();
        const totalMsgs = all.reduce((a, b) => a + b.total, 0);
        const totalTokens = all.reduce((a, b) => a + b.tokens, 0);
        const totalImages = all.reduce((a, b) => a + b.images, 0);
        const lines = [];
        if (target) {
            lines.push(`**Session \`${target.id.slice(0, 8)}\` — ${target.title}**`, `Model: ${target.model} • ${target.stats.total} msgs (${target.stats.user} user / ${target.stats.assistant} assistant) • ~${target.stats.tokens} tokens • ${target.stats.images} images`, target.createdAt ? `Created: ${new Date(target.createdAt).toLocaleString()}${target.updatedAt ? ` • Updated: ${new Date(target.updatedAt).toLocaleString()}` : ''}` : '', '');
        }
        lines.push(`**All sessions: ${all.length} • ${totalMsgs} msgs • ~${totalTokens} tokens • ${totalImages} images**`, '');
        for (const e of all.slice(0, 20)) {
            lines.push(`- \`${e.session.id.slice(0, 8)}\` **${e.session.title}** — ${e.total} msgs • ~${e.tokens} tok • ${new Date(e.session.updatedAt || e.session.createdAt).toLocaleDateString()} • _${e.preview.slice(0, 80)}_`);
        }
        if (all.length > 20)
            lines.push(`_…and ${all.length - 20} more (use QuickPick: Muse Spark: List Sessions)_`);
        this.post({ type: 'addMessage', role: 'assistant', content: lines.join('\n') });
    }
    async expandFileRefs(text) {
        // Expand @path or #path references: replace with file content excerpt
        const re = /(^|\s)[@#]([\w./\-]+)/g;
        let match;
        let expanded = text;
        const seen = new Set();
        while ((match = re.exec(text)) !== null) {
            const rawPath = match[2];
            if (seen.has(rawPath))
                continue;
            seen.add(rawPath);
            if (rawPath.length < 2)
                continue;
            try {
                const uri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', rawPath));
                const data = await vscode.workspace.fs.readFile(uri);
                if (data.byteLength > 8000)
                    continue;
                const content = Buffer.from(data).toString('utf8').slice(0, 6000);
                expanded += `\n\nFile ${rawPath}:\n\`\`\`\n${content}\n\`\`\``;
            }
            catch { /* ignore missing file */ }
        }
        return expanded;
    }
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') {
                this.post({ type: 'cleared' });
                for (const m of this.messages.slice(-200))
                    this.post({ type: 'addMessage', role: m.role, content: m.content });
                this.post({ type: 'pricingUpdate', isContributor: this.isContributor, model: this.currentModel });
                this.post({ type: 'approvalUpdate', mode: (0, sessionStore_1.resolveApprovalMode)() });
                this.post({ type: 'enableSend', enabled: !this.running, running: this.running });
            }
            else if (msg.type === 'send') {
                if (this.running) {
                    this.post({ type: 'agentStatus', content: 'Muse is still working — wait or use Stop.' });
                    return;
                }
                let userText = msg.text;
                const incomingImages = Array.isArray(msg.images) ? msg.images.filter((u) => typeof u === 'string' && u.startsWith('data:image/')) : [];
                // Slash commands intercept before agent - but not when images attached
                if (!incomingImages.length && userText.trim().startsWith('/')) {
                    if (await this.handleSlashCommand(userText))
                        return;
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
                let userContent = fullPrompt;
                if (incomingImages.length) {
                    const parts = [{ type: 'text', text: fullPrompt }];
                    for (const url of incomingImages.slice(0, 6)) {
                        parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
                    }
                    userContent = parts;
                }
                this.messages.push({ role: 'user', content: userContent });
                await this.persistMessages();
                this.post({ type: 'addMessage', role: 'user', content: userContent });
                this.post({ type: 'startStream' });
                this.running = true;
                this.post({ type: 'enableSend', enabled: false, running: true });
                try {
                    const backend = vscode.workspace.getConfiguration('museSpark').get('backend') || 'cli';
                    const hasImages = incomingImages.length > 0;
                    // CLI backend does not support images — route through direct Spark API when images present
                    const full = (backend === 'cli' && !hasImages)
                        ? await this.cli.run(fullPrompt, event => {
                            if (event.type === 'tool')
                                this.post({ type: 'toolEvent', content: event.text });
                            if (event.type === 'status')
                                this.post({ type: 'agentStatus', content: event.text });
                            if (event.type === 'delta')
                                this.post({ type: 'delta', content: event.text });
                            if (event.type === 'reasoning')
                                this.post({ type: 'reasoning', content: event.text });
                        })
                        : hasImages
                            ? await this.client.chat(this.messages, delta => { this.post({ type: 'delta', content: delta }); })
                            : await this.agent.run(this.messages, event => {
                                if (event.type === 'tool')
                                    this.post({ type: 'toolEvent', content: event.text });
                                if (event.type === 'status')
                                    this.post({ type: 'agentStatus', content: event.text });
                                if (event.type === 'reasoning')
                                    this.post({ type: 'reasoning', content: event.text });
                                if (event.type === 'plan')
                                    this.post({ type: 'planUpdate', content: event.text });
                                if (event.type === 'diff')
                                    this.post({ type: 'diffEvent', content: event.text });
                                if (event.type === 'text')
                                    this.post({ type: 'delta', content: event.text });
                            });
                    this.messages.push({ role: 'assistant', content: full });
                    await this.persistMessages();
                    this.post({ type: 'endStream', content: full });
                }
                catch (e) {
                    const msg2 = e.message || String(e);
                    if (msg2.includes('stopped by user') || msg2.includes('cancelled')) {
                        this.post({ type: 'error', content: 'Stopped.' });
                    }
                    else {
                        this.post({ type: 'error', content: msg2 });
                    }
                }
                finally {
                    this.running = false;
                    this.post({ type: 'enableSend', enabled: true, running: false });
                }
            }
            else if (msg.type === 'stop') {
                this.stopAgent();
            }
            else if (msg.type === 'clear') {
                this.newSession();
            }
            else if (msg.type === 'showSessions') {
                await this.showSessionsInChat();
            }
            else if (msg.type === 'insertCode') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit(edit => { edit.insert(editor.selection.active, msg.code); });
                }
            }
            else if (msg.type === 'togglePricing') {
                vscode.commands.executeCommand('museSpark.togglePricingMode');
            }
            else if (msg.type === 'changeApproval') {
                vscode.commands.executeCommand('museSpark.setApprovalMode');
            }
            else if (msg.type === 'requestPricing') {
                this.post({ type: 'pricingUpdate', isContributor: this.isContributor, model: this.currentModel });
                this.post({ type: 'approvalUpdate', mode: (0, sessionStore_1.resolveApprovalMode)() });
            }
            else if (msg.type === 'requestBilling') {
                try {
                    const mod = await Promise.resolve().then(() => __importStar(require('./billingTracker')));
                    const info = mod.BillingTracker?.getInstance?.()?.getLastInfo?.();
                    if (info)
                        this.post({ type: 'billingUpdate', info });
                }
                catch { }
            }
            else if (msg.type === 'refreshBilling') {
                vscode.commands.executeCommand('museSpark.refreshBilling');
            }
            else if (msg.type === 'resumeSession') {
                if (msg.id)
                    await this.resumeSession(msg.id);
            }
            else if (msg.type === 'deleteSession') {
                if (msg.id) {
                    const ok = await vscode.window.showWarningMessage(`Delete session ${msg.id.slice(0, 8)}?`, { modal: true }, 'Delete');
                    if (ok === 'Delete')
                        await this.deleteSession(msg.id);
                }
            }
            else if (msg.type === 'renameSession') {
                if (msg.id) {
                    const cur = this.sessionStore?.getSession(msg.id);
                    const title = await vscode.window.showInputBox({ prompt: 'New title', value: cur?.title || '' });
                    if (title)
                        await this.renameSession(msg.id, title);
                }
            }
            else if (msg.type === 'exportSession') {
                if (msg.id)
                    await this.exportSession(msg.id);
            }
            else if (msg.type === 'showStats') {
                this.showStatsInChat(msg.id);
            }
            else if (msg.type === 'openSettings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'museSpark');
            }
        });
    }
    sendSelectionToChat(code, prompt) {
        this.messages.push({ role: 'user', content: `${prompt}:\n\`\`\`\n${code}\n\`\`\`` });
        this._view?.show?.(true);
        this.post({ type: 'addMessage', role: 'user', content: prompt });
        this.post({ type: 'startStream' });
        this.client.chat(this.messages, delta => { this.post({ type: 'delta', content: delta }); }).then(async (full) => {
            this.messages.push({ role: 'assistant', content: full });
            await this.persistMessages();
            this.post({ type: 'endStream', content: full });
        });
    }
    post(msg) { this._view?.webview.postMessage(msg); }
    getHtml(webview) {
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
  #billingBar { display:flex; align-items:center; justify-content:space-between; padding:6px 10px; font-size:11px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-statusBar-background); cursor:pointer; }
  #billingBar.has-unpaid { background: #2a1f1a; color: #ffb347; }
  #billingBar.paid { background: #0f1f14; color: #7fbf9a; }
  #billingBar.error { background: #2a1111; color: #ff8a8a; }
  #billingBar .billing-left { display:flex; align-items:center; gap:6px; }
  #billingBar .billing-amount { font-weight:700; }
  #billingBar .billing-refresh { opacity:0.7; font-size:11px; }
  #messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .msg { padding:9px 11px; border-radius:6px; line-height:1.5; font-size:13px; white-space:pre-wrap; word-break:break-word; }
  .msg img.thumb { max-width:100%; max-height:220px; border-radius:6px; border:1px solid var(--vscode-panel-border); margin-top:6px; display:block; }
  .msg .img-grid { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .msg .img-grid img { max-width:160px; max-height:160px; border-radius:6px; border:1px solid var(--vscode-panel-border); object-fit:cover; }
  .user { background: var(--vscode-inputValidation-infoBorder); align-self:flex-end; max-width:88%; border: 1px solid var(--vscode-focusBorder); }
  .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .assistant pre { background: var(--vscode-textCodeBlock-background); padding:8px; border-radius:4px; overflow-x:auto; margin:6px 0; position:relative; }
  .assistant pre button { position:absolute; top:6px; right:6px; font-size:10px; padding:2px 6px; }
  #inputBar { padding:10px; border-top:1px solid var(--vscode-panel-border); display:flex; flex-direction:column; gap:8px; background: var(--vscode-sideBar-background); }
  #input { width:100%; min-height:64px; max-height:160px; resize:vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:8px; border-radius:6px; font-family:inherit; font-size:13px; }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  #input.drag-over { outline: 2px dashed var(--vscode-focusBorder); background: var(--vscode-inputValidation-infoBorder); }
  #preview { display:none; flex-wrap:wrap; gap:6px; padding:6px; border:1px dashed var(--vscode-panel-border); border-radius:6px; background: var(--vscode-editor-background); }
  #preview.has-items { display:flex; }
  .preview-item { position:relative; }
  .preview-item img { width:64px; height:64px; object-fit:cover; border-radius:6px; border:1px solid var(--vscode-panel-border); }
  .preview-item button { position:absolute; top:-6px; right:-6px; width:18px; height:18px; padding:0; border-radius:50%; font-size:11px; line-height:18px; background: var(--vscode-errorForeground); color:#fff; }
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
  .sessions { display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid var(--vscode-panel-border); border-radius:8px; background: var(--vscode-editor-background); }
  .sessions h3 { margin:0 0 4px; font-size:12px; opacity:0.9; }
  .session-card { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:8px 10px; background: var(--vscode-sideBar-background); display:flex; flex-direction:column; gap:4px; }
  .session-card.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
  .session-card .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .session-card .title { font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session-card .meta { font-size:11px; opacity:0.75; }
  .session-card .preview { font-size:11px; opacity:0.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .session-card .actions { display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; }
  .session-card .actions button { padding:3px 7px; font-size:11px; }
</style>
</head>
<body>
  <div id="pricingBanner" class="contributor" title="Click to toggle pricing mode">
    <span><span class="dot"></span><span id="pricingLabel">CONTRIBUTOR MODE</span><span style="font-weight:400; opacity:0.85; margin-left:6px;" id="pricingDetails">$0.10/M • Click to switch</span></span>
    <span style="font-size:12px; opacity:0.7;">⇄</span>
  </div>
  <div class="toolbar">
    <span id="modelLabel" class="pill">muse-spark-1.2-contributor</span>
    <select id="approvalSel" title="Full Access is always enabled" disabled>
      <option value="fullAccess" selected>Full Access</option>
    </select>
    <span id="status">Ready</span>
    <button id="sessionsButton" class="secondary" type="button" title="Browse and resume old chat sessions">Sessions</button>
    <button id="clearButton" class="secondary" type="button" title="New session">New</button>
  </div>
  <div id="billingBar" class="paid" title="Live unpaid charges — click to refresh">
    <span class="billing-left"><span id="billingIcon">💳</span> <span id="billingLabel">Unpaid: —</span> <span id="billingMeta" class="muted"></span></span>
    <span class="billing-refresh" id="billingRefresh">↻ 5m</span>
  </div>
  <div id="messages"></div>
  <div id="inputBar">
    <div id="preview"></div>
    <textarea id="input" placeholder="Ask Spark 1.2…  (Enter to send, Shift+Enter for newline, @file or #file to reference, /help for commands, drop or paste images)"></textarea>
    <div class="row">
      <label id="ctxLabel"><input type="checkbox" id="ctx" checked> Include editor context</label>
      <span class="muted" style="flex:1"></span>
      <input type="file" id="fileInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple style="display:none">
      <button id="attachButton" class="secondary" type="button" title="Attach images (png/jpg/webp/gif, max 4MB each, 6 max)">📎 Attach</button>
      <button id="stopButton" class="secondary" type="button" style="display:none;">Stop</button>
      <button id="sendButton" type="button">Send</button>
    </div>
    <div class="muted">Codex-style: <code>apply_patch</code> • <code>update_plan</code> • diff preview • drag, paste or attach images • <code>/help</code></div>
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
  const attachBtn = document.getElementById('attachButton');
  const fileInput = document.getElementById('fileInput');
  const previewEl = document.getElementById('preview');
  const inputBarEl = document.getElementById('inputBar');
  let pendingImages = [];
  let streamingEl = null;
  let reasoningEl = null;

  const MAX_IMAGES = 6;
  const MAX_BYTES = 4 * 1024 * 1024;

  function renderPreview() {
    previewEl.innerHTML = '';
    if (!pendingImages.length) { previewEl.classList.remove('has-items'); return; }
    previewEl.classList.add('has-items');
    pendingImages.forEach((src, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'preview-item';
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'attached ' + (idx+1);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.title = 'Remove';
      btn.addEventListener('click', () => { pendingImages.splice(idx,1); renderPreview(); });
      wrap.appendChild(img);
      wrap.appendChild(btn);
      previewEl.appendChild(wrap);
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_BYTES) return reject(new Error(file.name + ' exceeds 4MB'));
      if (!file.type.startsWith('image/')) return reject(new Error(file.name + ' is not an image'));
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read ' + file.name));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    const list = Array.from(files || []);
    for (const f of list) {
      if (pendingImages.length >= MAX_IMAGES) { statusEl.textContent = 'Max ' + MAX_IMAGES + ' images'; break; }
      try {
        const url = await fileToDataUrl(f);
        pendingImages.push(url);
      } catch (e) { statusEl.textContent = e.message; }
    }
    renderPreview();
  }

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

  function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const t = content.filter(p => p.type === 'text').map(p => p.text).join('\\n');
      return t || '';
    }
    return String(content || '');
  }
  function extractImages(content) {
    if (Array.isArray(content)) return content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
    return [];
  }
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function addMessage(role, content) {
    const text = extractText(content);
    const images = extractImages(content);
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'user' && images.length) {
      const t = document.createElement('div');
      t.textContent = text;
      div.appendChild(t);
      const grid = document.createElement('div');
      grid.className = 'img-grid';
      images.forEach(src => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'attached';
        img.loading = 'lazy';
        grid.appendChild(img);
      });
      div.appendChild(grid);
    } else {
      div.textContent = text;
      if (role === 'assistant' && text.includes('\`\`\`')) {
        div.innerHTML = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (m, lang, code) => {
          const esc = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          return '<pre><code>' + esc + '</code><button type="button" onclick="insertCode(this)">Insert</button></pre>';
        });
        if (images.length) {
          const grid = document.createElement('div');
          grid.className = 'img-grid';
          images.forEach(src => { const img = document.createElement('img'); img.src = src; grid.appendChild(img); });
          div.appendChild(grid);
        }
      } else if (images.length) {
        const grid = document.createElement('div');
        grid.className = 'img-grid';
        images.forEach(src => { const img = document.createElement('img'); img.src = src; img.alt='image'; grid.appendChild(img); });
        div.appendChild(grid);
      }
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function send() {
    if (sendBtn.disabled) return;
    const text = inputEl.value.trim();
    if (!text && !pendingImages.length) return;
    statusEl.textContent = 'Sending…';
    sendBtn.disabled = true;
    stopBtn.style.display = 'inline-block';
    const includeContext = document.getElementById('ctx').checked;
    const images = pendingImages.slice();
    vscode.postMessage({ type: 'send', text, includeContext, images });
    inputEl.value = '';
    pendingImages = [];
    renderPreview();
  }

  function stop() { vscode.postMessage({ type: 'stop' }); }
  function clearChat() { vscode.postMessage({ type: 'clear' }); }
  function insertCode(btn) {
    const code = btn.parentElement.querySelector('code').innerText;
    vscode.postMessage({ type: 'insertCode', code });
  }

  const billingBarEl = document.getElementById('billingBar');
  const billingLabelEl = document.getElementById('billingLabel');
  const billingMetaEl = document.getElementById('billingMeta');
  const billingRefreshEl = document.getElementById('billingRefresh');

  function formatBilling(amount, currency) {
    if (amount === 0) return '$0.00';
    if (amount < 0.01) return '$' + amount.toFixed(6);
    if (amount < 1) return '$' + amount.toFixed(4);
    return '$' + amount.toFixed(2);
  }
  function updateBilling(info) {
    if (!info) return;
    if (info.error) {
      billingBarEl.className = 'error';
      billingLabelEl.textContent = info.error.includes('No API key') ? 'Set API key for live billing' : 'Billing error';
      billingMetaEl.textContent = info.error.slice(0, 60);
      billingRefreshEl.textContent = '↻ retry';
      return;
    }
    const formatted = formatBilling(info.unpaid, info.currency);
    billingLabelEl.textContent = 'Unpaid: ' + formatted + ' ' + (info.currency || 'USD');
    const timeStr = new Date(info.fetchedAt).toLocaleTimeString();
    billingMetaEl.textContent = '• ' + timeStr + ' • every 5m';
    if (info.unpaid > 0) {
      billingBarEl.className = 'has-unpaid';
      billingRefreshEl.textContent = '↻ now';
    } else {
      billingBarEl.className = 'paid';
      billingRefreshEl.textContent = '✓ paid • ↻';
    }
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  // drag & drop on input and preview and whole bar
  ['dragenter','dragover'].forEach(ev => {
    inputEl.addEventListener(ev, e => { e.preventDefault(); inputEl.classList.add('drag-over'); });
    inputBarEl.addEventListener(ev, e => { e.preventDefault(); });
  });
  ['dragleave','drop'].forEach(ev => {
    inputEl.addEventListener(ev, e => { if (ev==='dragleave') inputEl.classList.remove('drag-over'); });
  });
  inputEl.addEventListener('drop', e => { e.preventDefault(); inputEl.classList.remove('drag-over'); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
  inputBarEl.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
  // paste images
  document.addEventListener('paste', e => {
    const files = [];
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile(); if (f) files.push(f);
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);
  document.getElementById('clearButton').addEventListener('click', clearChat);
  document.getElementById('sessionsButton').addEventListener('click', () => vscode.postMessage({ type: 'showSessions' }));
  bannerEl.addEventListener('click', () => vscode.postMessage({ type: 'togglePricing' }));
  billingBarEl.addEventListener('click', () => vscode.postMessage({ type: 'refreshBilling' }));
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
    else if (msg.type === 'billingUpdate') { updateBilling(msg.info); }
    else if (msg.type === 'focusInput') { inputEl.focus(); }
    else if (msg.type === 'sessionsBrowser') {
      const wrap = document.createElement('div');
      wrap.className = 'msg sessions';
      const title = document.createElement('h3');
      title.textContent = 'Sessions — Codex style (' + msg.sessions.length + ') — click Resume to restore';
      wrap.appendChild(title);
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = 'Tip: /stats [id] for token breakdown • rename/delete/export from here or QuickPick';
      hint.style.marginBottom = '4px';
      wrap.appendChild(hint);
      msg.sessions.forEach(s => {
        const card = document.createElement('div');
        card.className = 'session-card' + (s.isActive ? ' active' : '');
        const row = document.createElement('div');
        row.className = 'row';
        const t = document.createElement('span');
        t.className = 'title';
        t.textContent = (s.isActive ? '● ' : '') + s.title;
        t.title = s.id;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = s.msgCount + ' msgs • ~' + s.tokens + ' tok' + (s.images ? ' • ' + s.images + ' img' : '');
        row.appendChild(t); row.appendChild(meta);
        card.appendChild(row);
        const prev = document.createElement('div');
        prev.className = 'preview';
        prev.textContent = s.preview || '(no preview)';
        prev.title = s.preview || '';
        card.appendChild(prev);
        const sub = document.createElement('div');
        sub.className = 'meta';
        sub.textContent = s.model + ' • ' + s.approvalMode + ' • ' + new Date(s.updatedAt || s.createdAt).toLocaleString() + ' • ' + s.id.slice(0,8);
        card.appendChild(sub);
        const actions = document.createElement('div');
        actions.className = 'actions';
        const mkBtn = (label, type) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = type === 'resume' ? '' : 'secondary';
          b.textContent = label;
          b.addEventListener('click', () => vscode.postMessage({ type: type, id: s.id }));
          return b;
        };
        actions.appendChild(mkBtn('Resume','resumeSession'));
        actions.appendChild(mkBtn('Stats','showStats'));
        actions.appendChild(mkBtn('Export','exportSession'));
        actions.appendChild(mkBtn('Rename','renameSession'));
        actions.appendChild(mkBtn('Delete','deleteSession'));
        card.appendChild(actions);
        wrap.appendChild(card);
      });
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'requestPricing' });
  vscode.postMessage({ type: 'requestBilling' });
</script>
</body>
</html>`;
    }
}
exports.ChatViewProvider = ChatViewProvider;
ChatViewProvider.viewType = 'museSpark.chatView';
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++)
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    return nonce;
}
//# sourceMappingURL=chatPanel.js.map