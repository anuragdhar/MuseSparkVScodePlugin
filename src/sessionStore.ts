import * as vscode from 'vscode';

export type ApprovalMode = 'readOnly' | 'auto' | 'fullAccess';

export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  model: string;
  approvalMode: ApprovalMode;
}

const STORAGE_KEY = 'museSpark.agentSessions';
const ACTIVE_KEY = 'museSpark.activeSessionId';

export class SessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSessions(): AgentSession[] {
    return this.context.globalState.get<AgentSession[]>(STORAGE_KEY) || [];
  }

  getActiveId(): string | undefined {
    return this.context.globalState.get<string>(ACTIVE_KEY);
  }

  setActiveId(id: string): Thenable<void> {
    return this.context.globalState.update(ACTIVE_KEY, id);
  }

  addSession(session: AgentSession): Thenable<void> {
    const list = this.getSessions();
    list.unshift(session);
    if (list.length > 50) list.length = 50;
    return this.context.globalState.update(STORAGE_KEY, list);
  }

  updateSession(id: string, patch: Partial<AgentSession>): Thenable<void> {
    const list = this.getSessions();
    const idx = list.findIndex(s => s.id === id);
    if (idx >= 0) Object.assign(list[idx], patch);
    return this.context.globalState.update(STORAGE_KEY, list);
  }

  removeSession(id: string): Thenable<void> {
    const list = this.getSessions().filter(s => s.id !== id);
    return this.context.globalState.update(STORAGE_KEY, list);
  }

  getSession(id: string): AgentSession | undefined {
    return this.getSessions().find(s => s.id === id);
  }
}

export function resolveApprovalMode(): ApprovalMode {
  const cfg = vscode.workspace.getConfiguration('museSpark');
  const mode = cfg.get<string>('approvalMode') as ApprovalMode | undefined;
  if (mode === 'readOnly' || mode === 'auto' || mode === 'fullAccess') return mode;
  // backward compat
  const full = cfg.get<boolean>('cliFullAccess');
  if (full === false) return 'auto';
  if (full === true) return 'fullAccess';
  return 'fullAccess';
}

export function isWriteAllowed(mode: ApprovalMode): boolean {
  return mode !== 'readOnly';
}

export function requiresApprovalForWrite(mode: ApprovalMode): boolean {
  return mode === 'readOnly' || mode === 'auto';
}

export function requiresApprovalForTerminal(mode: ApprovalMode): boolean {
  return mode !== 'fullAccess';
}

export function describeApprovalMode(mode: ApprovalMode): string {
  if (mode === 'readOnly') return 'Read-Only (suggest only)';
  if (mode === 'auto') return 'Auto (edits in workspace auto-approved)';
  return 'Full Access (yolo)';
}

const DANGEROUS_PATTERNS = [
  /\brm\s+.*-rf\b/i,
  /\bsudo\b/i,
  /\bchmod\s+.*777\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bformat\b/i,
  />\s*\/dev\//i,
  /\bcurl\b.*\|\s*sh/i,
  /\bwget\b.*\|\s*sh/i,
  /\bpowershell\b.*-EncodedCommand/i,
];

export function isDangerousCommand(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return false;
  // Network exfiltration + shell injection patterns
  if (DANGEROUS_PATTERNS.some(re => re.test(command))) return true;
  // Deleting outside workspace or root
  if (/(^|;|\&\&|\|\|)\s*rm\s/.test(' ' + command) && command.includes('/')) return true;
  // Git push --force to protected branches is not dangerous per se, allow
  return false;
}

export function isSafeWorkspaceCommand(command: string): boolean {
  if (isDangerousCommand(command)) return false;
  const safePrefixes = ['npm ', 'yarn ', 'pnpm ', 'npx ', 'node ', 'tsc ', 'eslint ', 'prettier ', 'git status', 'git diff', 'git log', 'git branch', 'ls ', 'cat ', 'echo ', 'pwd', 'dir', 'Get-ChildItem', 'npm run', 'code '];
  const trimmed = command.trim();
  // Allow common read/build/test commands without approval in auto mode
  if (safePrefixes.some(p => trimmed.startsWith(p))) return true;
  // Default: require approval even in auto for unknown commands
  return false;
}
