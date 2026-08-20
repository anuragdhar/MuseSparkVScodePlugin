import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { CostTracker } from './costTracker';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveApprovalMode, resolvePlanMode } from './sessionStore';

export interface MuseCliEvent {
  type: 'status' | 'tool' | 'delta' | 'reasoning';
  text: string;
}

export class MuseCliClient {
  private sessionId: string = randomUUID();
  private activeProcess?: ReturnType<typeof spawn>;
  private killed = false;

  getSessionId(): string { return this.sessionId; }

  resetSession(id: string = randomUUID()) {
    this.stop();
    this.sessionId = id;
  }

  forkSession(id: string = randomUUID()) {
    this.stop();
    this.sessionId = id;
  }

  resumeSession(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid session id');
    this.stop();
    this.sessionId = id;
  }

  stop() {
    if (this.activeProcess) {
      this.killed = true;
      try { this.activeProcess.kill('SIGTERM'); } catch {}
      // fallback kill via wsl taskkill if still alive after 800ms is handled by close handler
    }
    this.activeProcess = undefined;
  }

  isRunning(): boolean { return !!this.activeProcess; }

  async run(prompt: string, emit: (event: MuseCliEvent) => void): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a workspace folder before running Muse Code.');
    if (folder.uri.scheme !== 'file') throw new Error('Muse Code currently requires a local filesystem workspace.');

    const workspace = toWslPath(folder.uri.fsPath);
    const cfg = vscode.workspace.getConfiguration('museSpark');
    const approvalMode = resolveApprovalMode();
    const planMode = resolvePlanMode();
    const fullAccess = approvalMode === 'fullAccess' && planMode !== 'plan';

    if (planMode === 'plan') {
      const ok = await vscode.window.showInformationMessage('Plan Mode is active — Muse will produce a plan only (no edits).', { modal: true }, 'Generate plan', 'Cancel');
      if (ok !== 'Generate plan') throw new Error('Plan generation cancelled.');
    } else if (approvalMode !== 'fullAccess') {
      const label = approvalMode === 'readOnly' ? 'Read-Only (suggest only)' : 'Auto';
      const approval = await vscode.window.showWarningMessage(
        `Allow Muse Code to run in ${label} mode for this task?`,
        { modal: true, detail: prompt.slice(0, 800) },
        'Run task'
      );
      if (approval !== 'Run task') throw new Error('Muse Code task cancelled.');
    }
    const model = cfg.get<string>('model') || 'muse-spark-1.2-contributor';
    const effort = cfg.get<string>('cliReasoningEffort') || 'high';
    const maxSteps = Math.min(Math.max(cfg.get<number>('cliMaxSteps') || 50, 1), 500);
    const musePath = cfg.get<string>('cliPath') || '/root/.local/bin/muse';
    const promptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-spark-'));
    const promptFile = path.join(promptDirectory, 'prompt.txt');
    const effectivePrompt = planMode === 'plan'
      ? `[PLAN MODE — READ ONLY. Do NOT edit files or run mutating commands. Produce a detailed plan via update_plan and summarize it.]\n\n${prompt}`
      : prompt;
    await fs.writeFile(promptFile, effectivePrompt, 'utf8');
    const args = [
      '-d', 'Ubuntu', '--', musePath, 'exec', '--json', '--prompt-file', toWslPath(promptFile),
      '--workspace', workspace, '--session-id', this.sessionId,
      '--model', model, '--reasoning-effort', effort,
      '--max-model-steps', String(maxSteps), '--trust-workspace', '--enable-shell-tool'
    ];
    if (planMode === 'plan') {
      args.push('--approval-mode', 'never');
    } else if (fullAccess) args.push('--yolo');
    else if (approvalMode === 'readOnly') args.push('--approval-mode', 'never');
    else args.push('--approval-mode', 'auto');

    this.killed = false;
    emit({ type: 'status', text: planMode === 'plan' ? `Starting Muse Code (plan mode)…` : `Starting Muse Code (${approvalMode})…` });
    return new Promise<string>((resolve, reject) => {
      const child = spawn('wsl.exe', args, { cwd: folder.uri.fsPath, windowsHide: true });
      this.activeProcess = child;
      let stdout = '';
      let stderr = '';
      let fullText = '';
      let runId = '';

      const consumeLine = (line: string) => {
        if (!line.trim().startsWith('{')) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        const payload = event.payload || {};
        if (event.payload_type === 'session.run.linked') runId = payload.run_stream?.id || runId;
        if (event.payload_type === 'run.output.delta' && payload.text) {
          fullText += payload.text;
          emit({ type: 'delta', text: payload.text });
          try { CostTracker.getInstance().showLiveEstimate(prompt, fullText, model); } catch {}
        } else if (event.payload_type === 'run.reasoning.delta' && payload.text) {
          emit({ type: 'reasoning', text: payload.text });
        } else if (event.payload_type === 'task.lifecycle.side_effect_intent') {
          const description = describeMuseOperation(payload.event?.operation, payload.event?.display?.prompt_preview);
          if (description) emit({ type: 'status', text: `${description}…` });
        } else if (event.payload_type === 'task.lifecycle.failed' && payload.event?.reason) {
          emit({ type: 'tool', text: `Failed: ${String(payload.event.reason).slice(0, 300)}` });
        } else if (event.payload_type === 'run.terminal.completed' && !fullText && payload.text) {
          fullText = payload.text;
          emit({ type: 'delta', text: payload.text });
        } else if (event.payload_type === 'run.terminal.failed') {
          stderr += payload.reason || payload.text || 'Muse Code run failed.';
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) consumeLine(line);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      const cleanupPrompt = () => fs.rm(promptDirectory, { recursive: true, force: true }).catch(() => undefined);
      child.on('error', error => {
        void cleanupPrompt();
        this.activeProcess = undefined;
        reject(new Error(`Could not start Muse Code: ${error.message}`));
      });
      child.on('close', async code => {
        this.activeProcess = undefined;
        await cleanupPrompt();
        if (stdout) consumeLine(stdout);
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
          for (const activity of usage.activities) emit({ type: 'tool', text: activity });
          if (usage.inputTokens || usage.outputTokens) {
            CostTracker.getInstance().addUsage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model || model, label: 'Muse Code CLI' });
          } else {
            CostTracker.getInstance().addEstimatedUsage(prompt, fullText, model, 'Muse Code CLI');
          }
        } catch {
          try { CostTracker.getInstance().addEstimatedUsage(prompt, fullText, model, 'Muse Code CLI'); } catch {}
        }
        resolve(fullText || 'Muse Code completed the task.');
      });
    });
  }
}

function describeMuseOperation(operation: unknown, preview: unknown): string | undefined {
  const raw = String(operation || '').replace(/^tool:/, '');
  const detail = String(preview || '').trim().replace(/\s+/g, ' ').slice(0, 180);

  // Model calls and reminder machinery are implementation details, not useful
  // workspace activity for the user.
  if (!raw || raw.startsWith('model.') || raw.startsWith('reminder.')) return undefined;

  const labels: Record<string, string> = {
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

async function readMuseUsage(sessionId: string, runId: string): Promise<{ inputTokens: number; outputTokens: number; model: string; activities: string[] }> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || (runId && !/^[0-9a-f-]{36}$/i.test(runId))) {
    throw new Error('Invalid Muse session identifier.');
  }
  const script = `p=$(find /root/.local/share/muse/sessions -path '*/${sessionId}/session.jsonl' -print -quit); [ -n "$p" ] && grep -E '"kind":"(model_completed|assistant_tool_calls_committed)"' "$p"`;
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', script], { windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      let inputTokens = 0;
      let outputTokens = 0;
      let model = '';
      const activities: string[] = [];
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          const event = record.payload?.event;
          if (runId && record.payload?.run_id !== runId) continue;
          if (event?.kind === 'model_completed') {
            inputTokens += Number(event.usage?.input_tokens) || 0;
            outputTokens += Number(event.usage?.output_tokens) || 0;
            model = event.model || model;
          } else if (event?.kind === 'assistant_tool_calls_committed') {
            for (const call of event.tool_calls || []) {
              const description = describeToolCall(call.name, call.args);
              if (description) activities.push(description);
            }
          }
        } catch {}
      }
      resolve({ inputTokens, outputTokens, model, activities });
    });
  });
}

function describeToolCall(nameValue: unknown, argsValue: unknown): string | undefined {
  const name = String(nameValue || '').replace(/^tool:/, '');
  let args: any = {};
  try { args = typeof argsValue === 'string' ? JSON.parse(argsValue) : (argsValue || {}); } catch {}
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

function toWslPath(windowsPath: string): string {
  // Codex parity: support both Windows and already-Unix paths (tests / Linux hosts)
  if (windowsPath.startsWith('/')) return windowsPath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) throw new Error(`Cannot map workspace path to WSL: ${windowsPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

export function toWslPathExport(p: string): string { return toWslPath(p); }
