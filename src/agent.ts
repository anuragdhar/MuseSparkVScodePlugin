import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SparkClient } from './sparkClient';
import { applyPatch } from './patch';
import { resolveApprovalMode, resolvePlanMode, isWriteAllowed, requiresApprovalForWrite, requiresApprovalForTerminal, isDangerousCommand, isSafeWorkspaceCommand } from './sessionStore';

const execAsync = promisify(exec);

export interface AgentEvent {
  type: 'status' | 'tool' | 'text' | 'reasoning' | 'plan' | 'diff';
  text: string;
}

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

function str(description: string) { return { type: 'string', description }; }
function num(description: string) { return { type: 'number', description }; }
function bool(description: string) { return { type: 'boolean', description }; }
function tool(name: string, description: string, properties: any, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export class WorkspaceAgent {
  private currentPlan: string = '';
  private editedFiles: Set<string> = new Set();
  private abortFlag = false;

  constructor(private readonly client: SparkClient) {}

  stop() { this.abortFlag = true; }

  async run(history: any[], emit: (event: AgentEvent) => void): Promise<string> {
    this.abortFlag = false;
    this.editedFiles.clear();
    const messages = [...history];
    const cfg = vscode.workspace.getConfiguration('museSpark');
    const maxSteps = Math.min(Math.max(cfg.get<number>('cliMaxSteps') || 50, 1), 500);
    const approvalMode = resolveApprovalMode();
    const planMode = resolvePlanMode();
    const autoVerify = cfg.get<boolean>('autoVerify') ?? true;

    // Inject Codex-style system guidance if not already present
    if (!messages.some(m => m.role === 'system' && String(m.content).includes('apply_patch'))) {
      const planExtra = planMode === 'plan'
        ? '\n- PLAN MODE IS ACTIVE: You MUST NOT edit files, write files, or run terminal commands. Your ONLY allowed actions are list_files, read_file, search_files, get_diagnostics, and update_plan. Produce a detailed markdown plan via update_plan and then summarize it. Explain that the user must approve the plan before execution.'
        : '';
      messages.unshift({
        role: 'system',
        content: `You are a Codex-style agentic coder. Rules:\n- Use update_plan for multi-step tasks.\n- Prefer apply_patch for all file edits (atomic, reviewable). Never use write_file unless creating a brand new file.\n- Always read relevant files before editing.\n- After edits, call get_diagnostics and fix errors before finishing.\n- Keep responses concise; explain what you changed.\n- Approval mode is ${approvalMode}. In readOnly you must explain patch but not apply it.${planExtra}`
      });
    } else if (planMode === 'plan') {
      // Append plan constraint to existing system message
      const sys = messages.find(m => m.role === 'system');
      if (sys && typeof sys.content === 'string' && !sys.content.includes('PLAN MODE')) {
        sys.content += '\n\nPLAN MODE IS ACTIVE: Do NOT edit files or run commands. Use update_plan only, then stop and ask for approval.';
      }
    }

    // Load AGENTS.md if present
    try {
      const agentsUri = this.resolve('AGENTS.md');
      const data = await vscode.workspace.fs.readFile(agentsUri);
      const agentsMd = Buffer.from(data).toString('utf8').slice(0, 8000);
      messages[0].content += `\n\nProject instructions (AGENTS.md):\n${agentsMd}`;
    } catch { /* no AGENTS.md */ }

    for (let step = 1; step <= maxSteps; step++) {
      if (this.abortFlag) return 'Agent stopped by user.';
      emit({ type: 'status', text: `Agent step ${step}/${maxSteps} • ${approvalMode}` });
      let response: any;
      try {
        response = await this.client.complete(messages, tools);
      } catch (e: any) {
        if (this.abortFlag) return 'Agent stopped by user.';
        throw e;
      }
      messages.push(response);
      const content: string = response.content || '';
      const reasoning: string | undefined = response.reasoning_content || response.reasoning;
      if (reasoning) emit({ type: 'reasoning', text: reasoning });
      if (content) emit({ type: 'text', text: content });
      const calls: any[] = response.tool_calls || [];
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
        if (this.abortFlag) break;
        const name = call.function?.name || 'unknown';
        let args: any = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        emit({ type: 'tool', text: `${name}${describeArgs(name, args)}` });
        let result: string;
        try { result = await this.execute(name, args, emit, approvalMode); }
        catch (error: any) { result = `ERROR: ${error.message}`; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    return `Stopped after ${maxSteps} agent steps. Ask me to continue if more work is needed.`;
  }

  private root(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a workspace folder before using agent tools.');
    return folder.uri;
  }

  private resolve(relativePath: string): vscode.Uri {
    const root = this.root();
    const absolute = path.resolve(root.fsPath, relativePath);
    const rootPrefix = root.fsPath.endsWith(path.sep) ? root.fsPath : root.fsPath + path.sep;
    if (absolute !== root.fsPath && !absolute.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
      throw new Error('Path is outside the open workspace.');
    }
    return vscode.Uri.file(absolute);
  }

  private async execute(name: string, args: any, emit: (e: AgentEvent) => void, approvalMode: string): Promise<string> {
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
      const matches: string[] = [];
      const uris = await vscode.workspace.findFiles(args.pattern || '**/*', '**/{node_modules,.git,out,dist}/**', 500);
      let matcher: RegExp;
      try { matcher = new RegExp(args.isRegex ? args.query : escapeRegex(String(args.query)), 'i'); }
      catch (error: any) { throw new Error(`Invalid search expression: ${error.message}`); }
      for (const uri of uris) {
        if (matches.length >= 100) break;
        let text: string;
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          if (data.byteLength > 1024 * 1024 || data.includes(0)) continue;
          text = Buffer.from(data).toString('utf8');
        } catch { continue; }
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (matcher.test(line)) matches.push(`${path.relative(this.root().fsPath, uri.fsPath)}:${index + 1}: ${line.trim().slice(0, 300)}`);
          matcher.lastIndex = 0;
          if (matches.length >= 100) break;
        }
      }
      return matches.join('\n') || '(no matches)';
    }
    // Plan-mode guard: block any mutation regardless of approvalMode
    const planModeActive = resolvePlanMode() === 'plan';
    if (planModeActive && (name === 'apply_patch' || name === 'write_file' || name === 'replace_in_file' || name === 'run_terminal_command')) {
      const hint = name === 'run_terminal_command' ? String(args.command).slice(0, 400) : String(args.patch || args.content || args.oldText || '').slice(0, 600);
      return `BLOCKED by Plan Mode: ${name} is not allowed while plan mode is active. Create or update the plan via update_plan instead. User must run "Approve Plan & Execute" to enable writes.\nProposed:\n${hint}`;
    }

    if (name === 'apply_patch') {
      if (!isWriteAllowed(approvalMode as any)) {
        return `Patch blocked (readOnly mode — proposal only):\n${String(args.patch).slice(0, 4000)}\n\nSwitch approval to Auto or Full Access to apply.`;
      }
      if (requiresApprovalForWrite(approvalMode as any)) {
        await this.approve('Apply patch?', String(args.patch).slice(0, 800));
      }
      const result = await applyPatch(String(args.patch), p => this.resolve(p));
      // track edited files
      for (const op of parsePatchedFiles(String(args.patch))) this.editedFiles.add(op);
      emit({ type: 'diff', text: result });
      return result;
    }
    if (name === 'write_file') {
      if (!isWriteAllowed(approvalMode as any)) return `Write blocked (readOnly). Proposed ${args.path} content:\n${String(args.content).slice(0, 4000)}`;
      if (requiresApprovalForWrite(approvalMode as any)) await this.approve(`Allow write ${args.path}?`, String(args.content).slice(0, 500));
      const uri = this.resolve(args.path);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(String(args.content), 'utf8'));
      this.editedFiles.add(args.path);
      emit({ type: 'diff', text: `Wrote ${args.path}` });
      return `Wrote ${args.path} (${Buffer.byteLength(String(args.content), 'utf8')} bytes).`;
    }
    if (name === 'replace_in_file') {
      if (!isWriteAllowed(approvalMode as any)) return `Edit blocked (readOnly). Proposed edit to ${args.path}:\n${String(args.oldText).slice(0, 300)}\n→\n${String(args.newText).slice(0, 300)}`;
      if (requiresApprovalForWrite(approvalMode as any)) await this.approve(`Allow edit ${args.path}?`, `${String(args.oldText).slice(0, 220)}\n→\n${String(args.newText).slice(0, 220)}`);
      const uri = this.resolve(args.path);
      const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const oldText = String(args.oldText);
      const occurrences = original.split(oldText).length - 1;
      if (occurrences !== 1) throw new Error(`Expected one exact match in ${args.path}, found ${occurrences}.`);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(original.replace(oldText, String(args.newText)), 'utf8'));
      this.editedFiles.add(args.path);
      emit({ type: 'diff', text: `Updated ${args.path}` });
      return `Updated ${args.path}.`;
    }
    if (name === 'run_terminal_command') {
      const cmd = String(args.command);
      // Codex-style: auto mode allows safe workspace commands without prompt; fullAccess never prompts; readOnly always prompts (and was already gated for writes)
      const needsApproval = approvalMode === 'readOnly' || approvalMode === 'fullAccess' ? requiresApprovalForTerminal(approvalMode as any) : (isDangerousCommand(cmd) || !isSafeWorkspaceCommand(cmd));
      if (needsApproval) await this.approve('Allow command?', cmd);
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
      // Persist plan to file for approval flow (.sparkrun/plan.md)
      try {
        const planUri = vscode.Uri.file(path.join(this.root().fsPath, '.sparkrun', 'plan.md'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(planUri.fsPath)));
        await vscode.workspace.fs.writeFile(planUri, Buffer.from(this.currentPlan, 'utf8'));
      } catch {}
      return `Plan updated.\n${this.currentPlan}`;
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  private async collectDiagnostics(): Promise<string> {
    const rows: string[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (!uri.fsPath.toLowerCase().startsWith(this.root().fsPath.toLowerCase())) continue;
      for (const d of diagnostics.slice(0, 50))
        rows.push(`${path.relative(this.root().fsPath, uri.fsPath)}:${d.range.start.line + 1} ${vscode.DiagnosticSeverity[d.severity]}: ${d.message}`);
    }
    return rows.slice(0, 250).join('\n') || '(no diagnostics)';
  }

  private async approve(message: string, detail: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Allow once', 'Allow for session');
    if (choice !== 'Allow once' && choice !== 'Allow for session') throw new Error('User denied this action.');
  }

  getPlan(): string { return this.currentPlan; }
  getEditedFiles(): string[] { return [...this.editedFiles]; }
}

function describeArgs(name: string, args: any): string {
  if (name === 'apply_patch') return `: ${String(args.patch).slice(0, 120).replace(/\n/g, ' ')}…`;
  if (args.path) return `: ${args.path}`;
  if (name === 'run_terminal_command') return `: ${String(args.command).slice(0, 120)}`;
  if (name === 'search_files') return `: ${args.query}`;
  if (name === 'list_files') return `: ${args.pattern}`;
  if (name === 'update_plan') return '';
  return '';
}

function parsePatchedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    const m = line.match(/^\*\*\*\s+(?:Add File|Update File|Delete File):\s*(.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
