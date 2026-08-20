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
exports.CostTracker = void 0;
exports.getPricingForModel = getPricingForModel;
exports.calculateCost = calculateCost;
exports.estimateTokens = estimateTokens;
exports.formatCost = formatCost;
exports.formatTokens = formatTokens;
const vscode = __importStar(require("vscode"));
const PRICING_TABLE = {
    contributor: { input: 0.10, output: 0.20, cacheRead: 0.002, label: 'Contributor ($0.10 / $0.20 per 1M)' },
    standard: { input: 1.25, output: 4.25, cacheRead: 0.15, label: 'Standard ($1.25 / $4.25 per 1M)' },
};
function getPricingForModel(model) {
    if (model.includes('contributor'))
        return PRICING_TABLE.contributor;
    return PRICING_TABLE.standard;
}
function calculateCost(inputTokens, outputTokens, model) {
    const p = getPricingForModel(model);
    return (inputTokens / 1000000) * p.input + (outputTokens / 1000000) * p.output;
}
function estimateTokens(text) {
    if (!text)
        return 0;
    // ~4 chars per token is a good heuristic for English/code. Use 3.5 for code-heavy.
    return Math.ceil(text.length / 4);
}
function formatCost(cost) {
    if (cost === 0)
        return '$0.00';
    if (cost < 0.01)
        return `$${cost.toFixed(6)}`;
    if (cost < 1)
        return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}
function formatTokens(n) {
    if (n >= 1000000)
        return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
}
class CostTracker {
    static getInstance() {
        if (!CostTracker._instance)
            throw new Error('CostTracker not initialized. Call CostTracker.init() first.');
        return CostTracker._instance;
    }
    static init(context) {
        if (CostTracker._instance)
            return CostTracker._instance;
        CostTracker._instance = new CostTracker(context);
        return CostTracker._instance;
    }
    constructor(context) {
        this.context = context;
        this.sessionTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0, requestCount: 0 };
        this.history = [];
        this._onDidUpdate = new vscode.EventEmitter();
        this.onDidUpdate = this._onDidUpdate.event;
        // Restore persisted totals
        const saved = context.globalState.get('museSpark.sessionTotals');
        const savedHistory = context.globalState.get('museSpark.usageHistory');
        if (saved)
            this.sessionTotals = saved;
        if (savedHistory)
            this.history = savedHistory.slice(-100); // keep last 100
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        this.statusBarItem.command = 'museSpark.showCostTracker';
        this.statusBarItem.tooltip = 'Click to view Muse Spark cost breakdown';
        this.updateStatusBar();
        context.subscriptions.push(this.statusBarItem);
        context.subscriptions.push(this._onDidUpdate);
    }
    addUsage(record) {
        const totalTokens = record.totalTokens ?? (record.inputTokens + record.outputTokens);
        const cost = record.cost ?? calculateCost(record.inputTokens, record.outputTokens, record.model);
        const full = {
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            totalTokens,
            cost,
            model: record.model,
            timestamp: record.timestamp ?? Date.now(),
            label: record.label,
        };
        this.sessionTotals.inputTokens += full.inputTokens;
        this.sessionTotals.outputTokens += full.outputTokens;
        this.sessionTotals.totalTokens += full.totalTokens;
        this.sessionTotals.totalCost += full.cost;
        this.sessionTotals.requestCount += 1;
        this.history.push(full);
        if (this.history.length > 200)
            this.history.shift();
        // Persist
        this.context.globalState.update('museSpark.sessionTotals', this.sessionTotals);
        this.context.globalState.update('museSpark.usageHistory', this.history);
        this.updateStatusBar();
        this._onDidUpdate.fire({ ...this.sessionTotals });
        return full;
    }
    /** Estimate and add when API doesn't return usage (e.g. mock or streaming without usage field) */
    addEstimatedUsage(inputText, outputText, model, label) {
        return this.addUsage({
            inputTokens: estimateTokens(inputText),
            outputTokens: estimateTokens(outputText),
            model,
            label: label ? `${label} (est.)` : 'estimated',
        });
    }
    getSessionTotals() {
        return { ...this.sessionTotals };
    }
    getHistory() {
        return [...this.history];
    }
    getLastRecord() {
        return this.history[this.history.length - 1];
    }
    showLiveEstimate(inputText, outputText, model) {
        const inputTokens = estimateTokens(inputText);
        const outputTokens = estimateTokens(outputText);
        const cost = calculateCost(inputTokens, outputTokens, model);
        this.statusBarItem.text = `$(sync~spin) Spark live: ~${formatTokens(inputTokens + outputTokens)} • ~${formatCost(cost)}`;
        this.statusBarItem.tooltip = `Current Muse Code request (estimated)\nInput: ~${inputTokens.toLocaleString()} tokens\nOutput: ~${outputTokens.toLocaleString()} tokens\nCost: ~${formatCost(cost)}\nExact CLI usage is recorded when the run completes.`;
        this.statusBarItem.show();
    }
    async resetSession() {
        this.sessionTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0, requestCount: 0 };
        this.history = [];
        await this.context.globalState.update('museSpark.sessionTotals', this.sessionTotals);
        await this.context.globalState.update('museSpark.usageHistory', this.history);
        this.updateStatusBar();
        this._onDidUpdate.fire({ ...this.sessionTotals });
    }
    updateStatusBar() {
        const t = this.sessionTotals;
        if (t.requestCount === 0) {
            this.statusBarItem.text = `$(dashboard) Spark Cost: $0.00`;
            this.statusBarItem.tooltip = 'No requests yet. Click for details.';
            this.statusBarItem.show();
            return;
        }
        this.statusBarItem.text = `$(dashboard) Spark: ${formatTokens(t.totalTokens)} • ${formatCost(t.totalCost)}`;
        this.statusBarItem.tooltip = `Muse Spark — Session Usage\n` +
            `Requests: ${t.requestCount}\n` +
            `Input:  ${t.inputTokens.toLocaleString()} tokens\n` +
            `Output: ${t.outputTokens.toLocaleString()} tokens\n` +
            `Total:  ${t.totalTokens.toLocaleString()} tokens\n` +
            `Cost:   ${formatCost(t.totalCost)}\n` +
            `Click for breakdown • Command: Muse Spark: Show Cost Tracker`;
        this.statusBarItem.show();
    }
    getSummaryMarkdown() {
        const t = this.sessionTotals;
        const last = this.getLastRecord();
        const pricing = last ? getPricingForModel(last.model) : null;
        return [
            `# Muse Spark — Cost Tracker`,
            ``,
            `**Session Totals**`,
            `- Requests: **${t.requestCount}**`,
            `- Input tokens: **${t.inputTokens.toLocaleString()}** (${formatTokens(t.inputTokens)})`,
            `- Output tokens: **${t.outputTokens.toLocaleString()}** (${formatTokens(t.outputTokens)})`,
            `- Total tokens: **${t.totalTokens.toLocaleString()}**`,
            `- **Total cost: ${formatCost(t.totalCost)}**`,
            ``,
            last ? `**Last request** — ${last.label || 'chat'} | Model: \`${last.model}\` | ${last.inputTokens} in / ${last.outputTokens} out | ${formatCost(last.cost)} | ${new Date(last.timestamp).toLocaleString()}` : `_No requests yet_`,
            pricing ? `\n**Pricing (active model)**: ${pricing.label}` : '',
            ``,
            `**History (last ${Math.min(this.history.length, 10)}):**`,
            ...this.history.slice(-10).reverse().map((r, i) => `${i + 1}. \`${r.model}\` — ${r.label || 'request'} — ${r.inputTokens} in / ${r.outputTokens} out — ${formatCost(r.cost)} — ${new Date(r.timestamp).toLocaleTimeString()}`),
            ``,
            `> Tip: Toggle Contributor vs Private Standard mode via status bar (left) or command \`Muse Spark: Toggle Contributor / Standard Mode\`. Contributor is 12.5× cheaper but data may be used for training.`,
        ].join('\n');
    }
    dispose() {
        this.statusBarItem.dispose();
        this._onDidUpdate.dispose();
    }
}
exports.CostTracker = CostTracker;
//# sourceMappingURL=costTracker.js.map