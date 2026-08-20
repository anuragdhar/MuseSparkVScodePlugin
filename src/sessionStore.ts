import * as vscode from 'vscode';

export type ApprovalMode = 'readOnly' | 'auto' | 'fullAccess';

export type PlanMode = 'off' | 'plan';

export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  model: string;
  approvalMode: ApprovalMode;
  // Codex-style enrichments — all optional for backward compat with old globalState
  preview?: string;
  msgCount?: number;
  updatedAt?: number;
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
    // normalize enrichments for new sessions
    session.updatedAt = session.updatedAt ?? session.createdAt;
    session.msgCount = session.msgCount ?? 0;
    session.preview = session.preview ?? '';
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

  /** Codex-like stats: enrich each session with live msgCount/preview from globalState */
  getSessionsEnriched(getMessages: (id: string) => any[] | undefined): AgentSession[] {
    return this.getSessions().map(s => {
      const msgs = getMessages(s.id);
      if (!msgs) return s;
      const last = msgs.length ? String((msgs[msgs.length - 1] as any)?.content ?? '').slice(0, 120) : s.preview ?? '';
      // try to extract text from ChatMessage content
      let preview = s.preview ?? '';
      if (msgs.length) {
        const firstUser = msgs.find((m: any) => m.role === 'user');
        if (firstUser) {
          const c: any = firstUser.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ') : '';
          preview = t.slice(0, 120);
        }
      }
      return { ...s, msgCount: msgs.length, preview, updatedAt: s.updatedAt ?? s.createdAt };
    });
  }
}

export function resolveApprovalMode(): ApprovalMode {
  // This extension is intentionally configured as an unrestricted coding
  // agent. Ignore stale user/workspace settings that could re-enable prompts.
  return 'fullAccess';
}

export function resolvePlanMode(): PlanMode {
  const cfg = vscode.workspace.getConfiguration('museSpark');
  const raw = cfg.get<string>('planMode') || 'off';
  return raw === 'plan' ? 'plan' : 'off';
}

export function describePlanMode(mode: PlanMode): string {
  return mode === 'plan' ? 'Plan (read-only, propose plan only)' : 'Off (normal execution)';
}

export function isPlanModeActive(): boolean {
  return resolvePlanMode() === 'plan';
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
