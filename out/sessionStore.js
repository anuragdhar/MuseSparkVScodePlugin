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
exports.SessionStore = void 0;
exports.resolveApprovalMode = resolveApprovalMode;
exports.isWriteAllowed = isWriteAllowed;
exports.requiresApprovalForWrite = requiresApprovalForWrite;
exports.requiresApprovalForTerminal = requiresApprovalForTerminal;
exports.describeApprovalMode = describeApprovalMode;
exports.isDangerousCommand = isDangerousCommand;
exports.isSafeWorkspaceCommand = isSafeWorkspaceCommand;
const vscode = __importStar(require("vscode"));
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
}
exports.SessionStore = SessionStore;
function resolveApprovalMode() {
    const cfg = vscode.workspace.getConfiguration('museSpark');
    const mode = cfg.get('approvalMode');
    if (mode === 'readOnly' || mode === 'auto' || mode === 'fullAccess')
        return mode;
    // backward compat
    const full = cfg.get('cliFullAccess');
    if (full === false)
        return 'auto';
    if (full === true)
        return 'fullAccess';
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