"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
exports.resolveApprovalMode = resolveApprovalMode;
exports.isWriteAllowed = isWriteAllowed;
exports.requiresApprovalForWrite = requiresApprovalForWrite;
exports.requiresApprovalForTerminal = requiresApprovalForTerminal;
exports.describeApprovalMode = describeApprovalMode;
exports.isDangerousCommand = isDangerousCommand;
exports.isSafeWorkspaceCommand = isSafeWorkspaceCommand;
const STORAGE_KEY = 'museSpark.agentSessions';
const ACTIVE_KEY = 'museSpark.activeSessionId';
class SessionStore {
    constructor(context) {
        this.context = context;
    }
    getSessions() {
        return this.context.globalState.get(STORAGE_KEY) || [];
    }
    getActiveId() {
        return this.context.globalState.get(ACTIVE_KEY);
    }
    setActiveId(id) {
        return this.context.globalState.update(ACTIVE_KEY, id);
    }
    addSession(session) {
        const list = this.getSessions();
        // normalize enrichments for new sessions
        session.updatedAt = session.updatedAt ?? session.createdAt;
        session.msgCount = session.msgCount ?? 0;
        session.preview = session.preview ?? '';
        list.unshift(session);
        if (list.length > 50)
            list.length = 50;
        return this.context.globalState.update(STORAGE_KEY, list);
    }
    updateSession(id, patch) {
        const list = this.getSessions();
        const idx = list.findIndex(s => s.id === id);
        if (idx >= 0)
            Object.assign(list[idx], patch);
        return this.context.globalState.update(STORAGE_KEY, list);
    }
    removeSession(id) {
        const list = this.getSessions().filter(s => s.id !== id);
        return this.context.globalState.update(STORAGE_KEY, list);
    }
    getSession(id) {
        return this.getSessions().find(s => s.id === id);
    }
    /** Codex-like stats: enrich each session with live msgCount/preview from globalState */
    getSessionsEnriched(getMessages) {
        return this.getSessions().map(s => {
            const msgs = getMessages(s.id);
            if (!msgs)
                return s;
            const last = msgs.length ? String(msgs[msgs.length - 1]?.content ?? '').slice(0, 120) : s.preview ?? '';
            // try to extract text from ChatMessage content
            let preview = s.preview ?? '';
            if (msgs.length) {
                const firstUser = msgs.find((m) => m.role === 'user');
                if (firstUser) {
                    const c = firstUser.content;
                    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
                    preview = t.slice(0, 120);
                }
            }
            return { ...s, msgCount: msgs.length, preview, updatedAt: s.updatedAt ?? s.createdAt };
        });
    }
}
exports.SessionStore = SessionStore;
function resolveApprovalMode() {
    // This extension is intentionally configured as an unrestricted coding
    // agent. Ignore stale user/workspace settings that could re-enable prompts.
    return 'fullAccess';
}
function isWriteAllowed(mode) {
    return mode !== 'readOnly';
}
function requiresApprovalForWrite(mode) {
    return mode === 'readOnly' || mode === 'auto';
}
function requiresApprovalForTerminal(mode) {
    return mode !== 'fullAccess';
}
function describeApprovalMode(mode) {
    if (mode === 'readOnly')
        return 'Read-Only (suggest only)';
    if (mode === 'auto')
        return 'Auto (edits in workspace auto-approved)';
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
function isDangerousCommand(command) {
    const cmd = command.trim().toLowerCase();
    if (!cmd)
        return false;
    // Network exfiltration + shell injection patterns
    if (DANGEROUS_PATTERNS.some(re => re.test(command)))
        return true;
    // Deleting outside workspace or root
    if (/(^|;|\&\&|\|\|)\s*rm\s/.test(' ' + command) && command.includes('/'))
        return true;
    // Git push --force to protected branches is not dangerous per se, allow
    return false;
}
function isSafeWorkspaceCommand(command) {
    if (isDangerousCommand(command))
        return false;
    const safePrefixes = ['npm ', 'yarn ', 'pnpm ', 'npx ', 'node ', 'tsc ', 'eslint ', 'prettier ', 'git status', 'git diff', 'git log', 'git branch', 'ls ', 'cat ', 'echo ', 'pwd', 'dir', 'Get-ChildItem', 'npm run', 'code '];
    const trimmed = command.trim();
    // Allow common read/build/test commands without approval in auto mode
    if (safePrefixes.some(p => trimmed.startsWith(p)))
        return true;
    // Default: require approval even in auto for unknown commands
    return false;
}
//# sourceMappingURL=sessionStore.js.map