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
exports.WorkspaceAgent = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const patch_1 = require("./patch");
const sessionStore_1 = require("./sessionStore");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const tools = [
    tool('list_files', 'List workspace files matching a glob. Use to discover project structure before editing.', {
        pattern: str('Glob such as **/*.ts'), maxResults: num('Maximum results, up to 200')
    }, ['pattern']),
    tool('read_file', 'Read a UTF-8 text file from the workspace with line numbers.', {
        path: str('Workspace-relative file path'), startLine: num('Optional 1-based start line'), endLine: num('Optional 1-based end line')
    }, ['path']),
    tool('search_files', 'Search workspace text files using plain text or regex.', {
        query: str('Search text or regex'), pattern: str('Optional file glob'), isRegex: bool('Interpret query as regex')
    }, ['query']),
    tool('apply_patch', 'Apply a Codex-style unified patch to the workspace. Preferred over write_file for edits. Wraps multiple file ops atomically. Format: *** Begin Patch / *** Add File: / *** Update File: / *** Delete File: / *** End Patch', {
        patch: str('Complete patch text in Codex apply_patch format')
    }, ['patch']),
    tool('write_file', 'Create or fully replace a UTF-8 workspace file.', {
        path: str('Workspace-relative file path'), content: str('Complete new file contents')
    }, ['path', 'content']),
    tool('replace_in_file', 'Replace one exact, unique text block in a workspace file.', {
        path: str('Workspace-relative file path'), oldText: str('Exact text to replace'), newText: str('Replacement text')
    }, ['path', 'oldText', 'newText']),
    tool('run_terminal_command', 'Run a shell command in the workspace and capture output.', {
        command: str('Shell command'), timeoutSeconds: num('Timeout 1..120 seconds')
    }, ['command']),
    tool('get_diagnostics', 'Get VS Code errors and warnings for workspace files.', {}, []),
    tool('update_plan', 'Track your multi-step plan. Call when you create or update your task plan. Like Codex update_plan.', {
        plan: str('Markdown plan: list steps with - [ ] / - [x]'), explanation: str('Brief explanation of what changed in the plan')
    }, ['plan'])
];
function str(description) { return { type: 'string', description }; }
function num(description) { return { type: 'number', description }; }
function bool(description) { return { type: 'boolean', description }; }
function tool(name, description, properties, required) {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
class WorkspaceAgent {
    constructor(client) {
        this.client = client;
        this.currentPlan = '';
        this.editedFiles = new Set();
        this.abortFlag = false;
    }
    stop() { this.abortFlag = true; }
    async run(history, emit) {
        this.abortFlag = false;
        this.editedFiles.clear();
        const messages = [...history];
        const cfg = vscode.workspace.getConfiguration('museSpark');
        const maxSteps = Math.min(Math.max(cfg.get('cliMaxSteps') || 50, 1), 500);
        const approvalMode = (0, sessionStore_1.resolveApprovalMode)();
        const autoVerify = cfg.get('autoVerify') ?? true;
        // Inject Codex-style system guidance if not already present
        if (!messages.some(m => m.role === 'system' && String(m.content).includes('apply_patch'))) {
            messages.unshift({
                role: 'system',
                content: `You are a Codex-style agentic coder. Rules:\n- Use update_plan for multi-step tasks.\n- Prefer apply_patch for all file edits (atomic, reviewable). Never use write_file unless creating a brand new file.\n- Always read relevant files before editing.\n- After edits, call get_diagnostics and fix errors before finishing.\n- Keep responses concise; explain what you changed.\n- Approval mode is ${approvalMode}. In readOnly you must explain patch but not apply it.`
            });
        }
        // Load AGENTS.md if present
        try {
            const agentsUri = this.resolve('AGENTS.md');
            const data = await vscode.workspace.fs.readFile(agentsUri);
            const agentsMd = Buffer.from(data).toString('utf8').slice(0, 8000);
            messages[0].content += `\n\nProject instructions (AGENTS.md):\n${agentsMd}`;
        }
        catch { /* no AGENTS.md */ }
        for (let step = 1; step <= maxSteps; step++) {
            if (this.abortFlag)
                return 'Agent stopped by user.';
            emit({ type: 'status', text: `Agent step ${step}/${maxSteps} • ${approvalMode}` });
            let response;
            try {
                response = await this.client.complete(messages, tools);
            }
            catch (e) {
                if (this.abortFlag)
                    return 'Agent stopped by user.';
                throw e;
            }
            messages.push(response);
            const content = response.content || '';
            const reasoning = response.reasoning_content || response.reasoning;
            if (reasoning)
                emit({ type: 'reasoning', text: reasoning });
            if (content)
                emit({ type: 'text', text: content });
            const calls = response.tool_calls || [];
            if (!calls.length) {
                // Codex-style verify loop
                if (autoVerify && this.editedFiles.size > 0) {
                    const diag = await this.collectDiagnostics();
                    if (diag !== '(no diagnostics)') {
                        emit({ type: 'status', text: 'Verifying edits — diagnostics found, fixing…' });
                        messages.push({ role: 'user', content: `Diagnostics after your edits:\n${diag}\nPlease fix errors and re-verify before finishing.` });
                        continue;
                    }
                }
                return content || 'Done.';
            }
            for (const call of calls) {
                if (this.abortFlag)
                    break;
                const name = call.function?.name || 'unknown';
                let args = {};
                try {
                    args = JSON.parse(call.function?.arguments || '{}');
                }
                catch {
                    args = {};
                }
                emit({ type: 'tool', text: `${name}${describeArgs(name, args)}` });
                let result;
                try {
                    result = await this.execute(name, args, emit, approvalMode);
                }
                catch (error) {
                    result = `ERROR: ${error.message}`;
                }
                messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
        }
        return `Stopped after ${maxSteps} agent steps. Ask me to continue if more work is needed.`;
    }
    root() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder)
            throw new Error('Open a workspace folder before using agent tools.');
        return folder.uri;
    }
    resolve(relativePath) {
        const root = this.root();
        const absolute = path.resolve(root.fsPath, relativePath);
        const rootPrefix = root.fsPath.endsWith(path.sep) ? root.fsPath : root.fsPath + path.sep;
        if (absolute !== root.fsPath && !absolute.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
            throw new Error('Path is outside the open workspace.');
        }
        return vscode.Uri.file(absolute);
    }
    async execute(name, args, emit, approvalMode) {
        if (name === 'list_files') {
            const max = Math.min(Math.max(Number(args.maxResults) || 100, 1), 500);
            const uris = await vscode.workspace.findFiles(args.pattern, '**/{node_modules,.git,out,dist,.vscode-test}/**', max);
            const root = this.root().fsPath;
            return uris.map(uri => path.relative(root, uri.fsPath).replace(/\\/g, '/')).join('\n') || '(no files)';
        }
        if (name === 'read_file') {
            const data = await vscode.workspace.fs.readFile(this.resolve(args.path));
            const lines = Buffer.from(data).toString('utf8').split(/\r?\n/);
            const start = Math.max(Number(args.startLine) || 1, 1);
            const end = Math.min(Number(args.endLine) || lines.length, lines.length);
            return lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 60000);
        }
        if (name === 'search_files') {
            const matches = [];
            const uris = await vscode.workspace.findFiles(args.pattern || '**/*', '**/{node_modules,.git,out,dist}/**', 500);
            let matcher;
            try {
                matcher = new RegExp(args.isRegex ? args.query : escapeRegex(String(args.query)), 'i');
            }
            catch (error) {
                throw new Error(`Invalid search expression: ${error.message}`);
            }
            for (const uri of uris) {
                if (matches.length >= 100)
                    break;
                let text;
                try {
                    const data = await vscode.workspace.fs.readFile(uri);
                    if (data.byteLength > 1024 * 1024 || data.includes(0))
                        continue;
                    text = Buffer.from(data).toString('utf8');
                }
                catch {
                    continue;
                }
                for (const [index, line] of text.split(/\r?\n/).entries()) {
                    if (matcher.test(line))
                        matches.push(`${path.relative(this.root().fsPath, uri.fsPath)}:${index + 1}: ${line.trim().slice(0, 300)}`);
                    matcher.lastIndex = 0;
                    if (matches.length >= 100)
                        break;
                }
            }
            return matches.join('\n') || '(no matches)';
        }
        if (name === 'apply_patch') {
            if (!(0, sessionStore_1.isWriteAllowed)(approvalMode)) {
                return `Patch blocked (readOnly mode — proposal only):\n${String(args.patch).slice(0, 4000)}\n\nSwitch approval to Auto or Full Access to apply.`;
            }
            if ((0, sessionStore_1.requiresApprovalForWrite)(approvalMode)) {
                await this.approve('Apply patch?', String(args.patch).slice(0, 800));
            }
            const result = await (0, patch_1.applyPatch)(String(args.patch), p => this.resolve(p));
            // track edited files
            for (const op of parsePatchedFiles(String(args.patch)))
                this.editedFiles.add(op);
            emit({ type: 'diff', text: result });
            return result;
        }
        if (name === 'write_file') {
            if (!(0, sessionStore_1.isWriteAllowed)(approvalMode))
                return `Write blocked (readOnly). Proposed ${args.path} content:\n${String(args.content).slice(0, 4000)}`;
            if ((0, sessionStore_1.requiresApprovalForWrite)(approvalMode))
                await this.approve(`Allow write ${args.path}?`, String(args.content).slice(0, 500));
            const uri = this.resolve(args.path);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
            await vscode.workspace.fs.writeFile(uri, Buffer.from(String(args.content), 'utf8'));
            this.editedFiles.add(args.path);
            emit({ type: 'diff', text: `Wrote ${args.path}` });
            return `Wrote ${args.path} (${Buffer.byteLength(String(args.content), 'utf8')} bytes).`;
        }
        if (name === 'replace_in_file') {
            if (!(0, sessionStore_1.isWriteAllowed)(approvalMode))
                return `Edit blocked (readOnly). Proposed edit to ${args.path}:\n${String(args.oldText).slice(0, 300)}\n→\n${String(args.newText).slice(0, 300)}`;
            if ((0, sessionStore_1.requiresApprovalForWrite)(approvalMode))
                await this.approve(`Allow edit ${args.path}?`, `${String(args.oldText).slice(0, 220)}\n→\n${String(args.newText).slice(0, 220)}`);
            const uri = this.resolve(args.path);
            const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            const oldText = String(args.oldText);
            const occurrences = original.split(oldText).length - 1;
            if (occurrences !== 1)
                throw new Error(`Expected one exact match in ${args.path}, found ${occurrences}.`);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(original.replace(oldText, String(args.newText)), 'utf8'));
            this.editedFiles.add(args.path);
            emit({ type: 'diff', text: `Updated ${args.path}` });
            return `Updated ${args.path}.`;
        }
        if (name === 'run_terminal_command') {
            const cmd = String(args.command);
            // Codex-style: auto mode allows safe workspace commands without prompt; fullAccess never prompts; readOnly always prompts (and was already gated for writes)
            const needsApproval = approvalMode === 'readOnly' || approvalMode === 'fullAccess' ? (0, sessionStore_1.requiresApprovalForTerminal)(approvalMode) : ((0, sessionStore_1.isDangerousCommand)(cmd) || !(0, sessionStore_1.isSafeWorkspaceCommand)(cmd));
            if (needsApproval)
                await this.approve('Allow command?', cmd);
            const timeout = Math.min(Math.max(Number(args.timeoutSeconds) || 30, 1), 120) * 1000;
            // Use platform-appropriate shell: powershell on Windows, bash elsewhere
            const isWindows = process.platform === 'win32';
            const { stdout, stderr } = await execAsync(cmd, { cwd: this.root().fsPath, timeout, shell: isWindows ? 'powershell.exe' : '/bin/bash', maxBuffer: 1024 * 1024 * 4 });
            return (`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`).slice(0, 40000);
        }
        if (name === 'get_diagnostics') {
            return this.collectDiagnostics();
        }
        if (name === 'update_plan') {
            this.currentPlan = String(args.plan || '');
            emit({ type: 'plan', text: this.currentPlan });
            return `Plan updated.\n${this.currentPlan}`;
        }
        throw new Error(`Unknown tool: ${name}`);
    }
    async collectDiagnostics() {
        const rows = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
            if (!uri.fsPath.toLowerCase().startsWith(this.root().fsPath.toLowerCase()))
                continue;
            for (const d of diagnostics.slice(0, 50))
                rows.push(`${path.relative(this.root().fsPath, uri.fsPath)}:${d.range.start.line + 1} ${vscode.DiagnosticSeverity[d.severity]}: ${d.message}`);
        }
        return rows.slice(0, 250).join('\n') || '(no diagnostics)';
    }
    async approve(message, detail) {
        const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Allow once', 'Allow for session');
        if (choice !== 'Allow once' && choice !== 'Allow for session')
            throw new Error('User denied this action.');
    }
    getPlan() { return this.currentPlan; }
    getEditedFiles() { return [...this.editedFiles]; }
}
exports.WorkspaceAgent = WorkspaceAgent;
function describeArgs(name, args) {
    if (name === 'apply_patch')
        return `: ${String(args.patch).slice(0, 120).replace(/\n/g, ' ')}…`;
    if (args.path)
        return `: ${args.path}`;
    if (name === 'run_terminal_command')
        return `: ${String(args.command).slice(0, 120)}`;
    if (name === 'search_files')
        return `: ${args.query}`;
    if (name === 'list_files')
        return `: ${args.pattern}`;
    if (name === 'update_plan')
        return '';
    return '';
}
function parsePatchedFiles(patch) {
    const files = [];
    for (const line of patch.split('\n')) {
        const m = line.match(/^\*\*\*\s+(?:Add File|Update File|Delete File):\s*(.+)$/);
        if (m)
            files.push(m[1].trim());
    }
    return files;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=agent.js.map