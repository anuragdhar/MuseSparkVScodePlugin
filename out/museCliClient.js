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
exports.MuseCliClient = void 0;
exports.toWslPathExport = toWslPathExport;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const costTracker_1 = require("./costTracker");
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const sessionStore_1 = require("./sessionStore");
class MuseCliClient {
    constructor() {
        this.sessionId = (0, crypto_1.randomUUID)();
        this.killed = false;
    }
    getSessionId() { return this.sessionId; }
    resetSession(id = (0, crypto_1.randomUUID)()) {
        this.stop();
        this.sessionId = id;
    }
    forkSession(id = (0, crypto_1.randomUUID)()) {
        this.stop();
        this.sessionId = id;
    }
    resumeSession(id) {
        if (!/^[0-9a-f-]{36}$/i.test(id))
            throw new Error('Invalid session id');
        this.stop();
        this.sessionId = id;
    }
    stop() {
        if (this.activeProcess) {
            this.killed = true;
            try {
                this.activeProcess.kill('SIGTERM');
            }
            catch { }
            // fallback kill via wsl taskkill if still alive after 800ms is handled by close handler
        }
        this.activeProcess = undefined;
    }
    isRunning() { return !!this.activeProcess; }
    async run(prompt, emit) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder)
            throw new Error('Open a workspace folder before running Muse Code.');
        if (folder.uri.scheme !== 'file')
            throw new Error('Muse Code currently requires a local filesystem workspace.');
        const workspace = toWslPath(folder.uri.fsPath);
        const cfg = vscode.workspace.getConfiguration('museSpark');
        const approvalMode = (0, sessionStore_1.resolveApprovalMode)();
        const fullAccess = approvalMode === 'fullAccess';
        if (approvalMode !== 'fullAccess') {
            const label = approvalMode === 'readOnly' ? 'Read-Only (suggest only)' : 'Auto';
            const approval = await vscode.window.showWarningMessage(`Allow Muse Code to run in ${label} mode for this task?`, { modal: true, detail: prompt.slice(0, 800) }, 'Run task');
            if (approval !== 'Run task')
                throw new Error('Muse Code task cancelled.');
        }
        const model = cfg.get('model') || 'muse-spark-1.2-contributor';
        const effort = cfg.get('cliReasoningEffort') || 'high';
        const maxSteps = Math.min(Math.max(cfg.get('cliMaxSteps') || 50, 1), 500);
        const musePath = cfg.get('cliPath') || '/root/.local/bin/muse';
        const promptDirectory = await fs_1.promises.mkdtemp(path.join(os.tmpdir(), 'muse-spark-'));
        const promptFile = path.join(promptDirectory, 'prompt.txt');
        await fs_1.promises.writeFile(promptFile, prompt, 'utf8');
        const args = [
            '-d', 'Ubuntu', '--', musePath, 'exec', '--json', '--prompt-file', toWslPath(promptFile),
            '--workspace', workspace, '--session-id', this.sessionId,
            '--model', model, '--reasoning-effort', effort,
            '--max-model-steps', String(maxSteps), '--trust-workspace', '--enable-shell-tool'
        ];
        if (fullAccess)
            args.push('--yolo');
        else if (approvalMode === 'readOnly')
            args.push('--approval-mode', 'never');
        else
            args.push('--approval-mode', 'auto');
        this.killed = false;
        emit({ type: 'status', text: `Starting Muse Code (${approvalMode})…` });
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)('wsl.exe', args, { cwd: folder.uri.fsPath, windowsHide: true });
            this.activeProcess = child;
            let stdout = '';
            let stderr = '';
            let fullText = '';
            let runId = '';
            const consumeLine = (line) => {
                if (!line.trim().startsWith('{'))
                    return;
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch {
                    return;
                }
                const payload = event.payload || {};
                if (event.payload_type === 'session.run.linked')
                    runId = payload.run_stream?.id || runId;
                if (event.payload_type === 'run.output.delta' && payload.text) {
                    fullText += payload.text;
                    emit({ type: 'delta', text: payload.text });
                    try {
                        costTracker_1.CostTracker.getInstance().showLiveEstimate(prompt, fullText, model);
                    }
                    catch { }
                }
                else if (event.payload_type === 'run.reasoning.delta' && payload.text) {
                    emit({ type: 'reasoning', text: payload.text });
                }
                else if (event.payload_type === 'task.lifecycle.side_effect_intent') {
                    const description = describeMuseOperation(payload.event?.operation, payload.event?.display?.prompt_preview);
                    if (description)
                        emit({ type: 'status', text: `${description}…` });
                }
                else if (event.payload_type === 'task.lifecycle.failed' && payload.event?.reason) {
                    emit({ type: 'tool', text: `Failed: ${String(payload.event.reason).slice(0, 300)}` });
                }
                else if (event.payload_type === 'run.terminal.completed' && !fullText && payload.text) {
                    fullText = payload.text;
                    emit({ type: 'delta', text: payload.text });
                }
                else if (event.payload_type === 'run.terminal.failed') {
                    stderr += payload.reason || payload.text || 'Muse Code run failed.';
                }
            };
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                stdout += chunk;
                const lines = stdout.split(/\r?\n/);
                stdout = lines.pop() || '';
                for (const line of lines)
                    consumeLine(line);
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => { stderr += chunk; });
            const cleanupPrompt = () => fs_1.promises.rm(promptDirectory, { recursive: true, force: true }).catch(() => undefined);
            child.on('error', error => {
                void cleanupPrompt();
                this.activeProcess = undefined;
                reject(new Error(`Could not start Muse Code: ${error.message}`));
            });
            child.on('close', async (code) => {
                this.activeProcess = undefined;
                await cleanupPrompt();
                if (stdout)
                    consumeLine(stdout);
                if (this.killed) {
                    reject(new Error('Muse Code task stopped by user.'));
                    return;
                }
                if (code !== 0) {
                    reject(new Error((stderr || `Muse Code exited with code ${code}.`).trim()));
                    return;
                }
                try {
                    const usage = await readMuseUsage(this.sessionId, runId);
                    for (const activity of usage.activities)
                        emit({ type: 'tool', text: activity });
                    if (usage.inputTokens || usage.outputTokens) {
                        costTracker_1.CostTracker.getInstance().addUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model || model, label: 'Muse Code CLI' });
                    }
                    else {
                        costTracker_1.CostTracker.getInstance().addEstimatedUsage(prompt, fullText, model, 'Muse Code CLI');
                    }
                }
                catch {
                    try {
                        costTracker_1.CostTracker.getInstance().addEstimatedUsage(prompt, fullText, model, 'Muse Code CLI');
                    }
                    catch { }
                }
                resolve(fullText || 'Muse Code completed the task.');
            });
        });
    }
}
exports.MuseCliClient = MuseCliClient;
function describeMuseOperation(operation, preview) {
    const raw = String(operation || '').replace(/^tool:/, '');
    const detail = String(preview || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    // Model calls and reminder machinery are implementation details, not useful
    // workspace activity for the user.
    if (!raw || raw.startsWith('model.') || raw.startsWith('reminder.'))
        return undefined;
    const labels = {
        read_file: 'Reading a workspace file',
        search: 'Searching the workspace',
        list_files: 'Listing workspace files',
        write_file: 'Creating or updating a file',
        edit_file: 'Editing a workspace file',
        shell: 'Running a terminal command',
        bash: 'Running a terminal command',
        get_diagnostics: 'Checking editor diagnostics',
        subagent_spawn: 'Starting a background agent',
        subagent_wait: 'Waiting for a background agent',
        subagent_send_message: 'Coordinating with a background agent',
        read_skill: 'Loading task instructions',
        web_search: 'Searching the web'
    };
    const label = labels[raw] || `Using ${raw.replace(/[._-]+/g, ' ')}`;
    return detail ? `${label}: ${detail}` : label;
}
async function readMuseUsage(sessionId, runId) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId) || (runId && !/^[0-9a-f-]{36}$/i.test(runId))) {
        throw new Error('Invalid Muse session identifier.');
    }
    const script = `p=$(find /root/.local/share/muse/sessions -path '*/${sessionId}/session.jsonl' -print -quit); [ -n "$p" ] && grep -E '"kind":"(model_completed|assistant_tool_calls_committed)"' "$p"`;
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', script], { windowsHide: true });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', () => {
            let inputTokens = 0;
            let outputTokens = 0;
            let model = '';
            const activities = [];
            for (const line of output.split(/\r?\n/)) {
                if (!line.trim())
                    continue;
                try {
                    const record = JSON.parse(line);
                    const event = record.payload?.event;
                    if (runId && record.payload?.run_id !== runId)
                        continue;
                    if (event?.kind === 'model_completed') {
                        inputTokens += Number(event.usage?.input_tokens) || 0;
                        outputTokens += Number(event.usage?.output_tokens) || 0;
                        model = event.model || model;
                    }
                    else if (event?.kind === 'assistant_tool_calls_committed') {
                        for (const call of event.tool_calls || []) {
                            const description = describeToolCall(call.name, call.args);
                            if (description)
                                activities.push(description);
                        }
                    }
                }
                catch { }
            }
            resolve({ inputTokens, outputTokens, model, activities });
        });
    });
}
function describeToolCall(nameValue, argsValue) {
    const name = String(nameValue || '').replace(/^tool:/, '');
    let args = {};
    try {
        args = typeof argsValue === 'string' ? JSON.parse(argsValue) : (argsValue || {});
    }
    catch { }
    const target = args.path || args.file_path || args.file || args.pattern || args.query;
    const quotedTarget = target ? ` \`${String(target).replace(/`/g, '')}\`` : '';
    switch (name) {
        case 'read_file': return `Read${quotedTarget || ' a workspace file'}`;
        case 'edit_file': return `Edited${quotedTarget || ' a workspace file'}`;
        case 'write_file': return `Wrote${quotedTarget || ' a workspace file'}`;
        case 'search': return `Searched${quotedTarget ? ` for${quotedTarget}` : ' the workspace'}`;
        case 'list_files': return `Listed workspace files${quotedTarget ? ` matching${quotedTarget}` : ''}`;
        case 'shell':
        case 'bash': {
            const command = String(args.command || args.cmd || '').trim().replace(/\s+/g, ' ').slice(0, 220);
            return command ? `Ran \`${command.replace(/`/g, '')}\`` : 'Ran a terminal command';
        }
        case 'get_diagnostics': return 'Checked editor diagnostics';
        case 'subagent_spawn': return `Started background agent${args.task ? `: ${String(args.task).slice(0, 140)}` : ''}`;
        case 'subagent_wait': return 'Waited for background agents';
        case 'read_skill': return `Loaded task instructions${quotedTarget}`;
        default: return name && !name.startsWith('model.') ? `Used ${name.replace(/[._-]+/g, ' ')}` : undefined;
    }
}
function toWslPath(windowsPath) {
    // Codex parity: support both Windows and already-Unix paths (tests / Linux hosts)
    if (windowsPath.startsWith('/'))
        return windowsPath;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
    if (!match)
        throw new Error(`Cannot map workspace path to WSL: ${windowsPath}`);
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}
function toWslPathExport(p) { return toWslPath(p); }
//# sourceMappingURL=museCliClient.js.map