import * as vscode from 'vscode';

export interface Pricing {
  input: number;      // $ per 1M tokens
  output: number;     // $ per 1M tokens
  cacheRead: number;  // $ per 1M tokens (cached input)
  label: string;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  model: string;
  timestamp: number;
  label?: string; // e.g. "chat", "explain", "inline"
}

export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  requestCount: number;
}

const PRICING_TABLE: Record<string, Pricing> = {
  contributor: { input: 0.10, output: 0.20, cacheRead: 0.002, label: 'Contributor ($0.10 / $0.20 per 1M)' },
  standard:    { input: 1.25, output: 4.25, cacheRead: 0.15,  label: 'Standard ($1.25 / $4.25 per 1M)' },
};

export function getPricingForModel(model: string): Pricing {
  if (model.includes('contributor')) return PRICING_TABLE.contributor;
  return PRICING_TABLE.standard;
}

export function calculateCost(inputTokens: number, outputTokens: number, model: string): number {
  const p = getPricingForModel(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars per token is a good heuristic for English/code. Use 3.5 for code-heavy.
  return Math.ceil(text.length / 4);
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export class CostTracker implements vscode.Disposable {
  private static _instance: CostTracker | undefined;

  static getInstance(): CostTracker {
    if (!CostTracker._instance) throw new Error('CostTracker not initialized. Call CostTracker.init() first.');
    return CostTracker._instance;
  }

  static init(context: vscode.ExtensionContext): CostTracker {
    if (CostTracker._instance) return CostTracker._instance;
    CostTracker._instance = new CostTracker(context);
    return CostTracker._instance;
  }

  private sessionTotals: SessionTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0, requestCount: 0 };
  private history: UsageRecord[] = [];
  private readonly _onDidUpdate = new vscode.EventEmitter<SessionTotals>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private statusBarItem: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Restore persisted totals
    const saved = context.globalState.get<SessionTotals>('museSpark.sessionTotals');
    const savedHistory = context.globalState.get<UsageRecord[]>('museSpark.usageHistory');
    if (saved) this.sessionTotals = saved;
    if (savedHistory) this.history = savedHistory.slice(-100); // keep last 100

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.statusBarItem.command = 'museSpark.showCostTracker';
    this.statusBarItem.tooltip = 'Click to view Muse Spark cost breakdown';
    this.updateStatusBar();
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(this._onDidUpdate);
  }

  addUsage(record: Omit<UsageRecord, 'cost' | 'totalTokens' | 'timestamp'> & Partial<Pick<UsageRecord, 'cost' | 'totalTokens' | 'timestamp'>>): UsageRecord {
    const totalTokens = record.totalTokens ?? (record.inputTokens + record.outputTokens);
    const cost = record.cost ?? calculateCost(record.inputTokens, record.outputTokens, record.model);
    const full: UsageRecord = {
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
    if (this.history.length > 200) this.history.shift();

    // Persist
    this.context.globalState.update('museSpark.sessionTotals', this.sessionTotals);
    this.context.globalState.update('museSpark.usageHistory', this.history);

    this.updateStatusBar();
    this._onDidUpdate.fire({ ...this.sessionTotals });
    return full;
  }

  /** Estimate and add when API doesn't return usage (e.g. mock or streaming without usage field) */
  addEstimatedUsage(inputText: string, outputText: string, model: string, label?: string): UsageRecord {
    return this.addUsage({
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(outputText),
      model,
      label: label ? `${label} (est.)` : 'estimated',
    });
  }

  getSessionTotals(): SessionTotals {
    return { ...this.sessionTotals };
  }

  getHistory(): UsageRecord[] {
    return [...this.history];
  }

  getLastRecord(): UsageRecord | undefined {
    return this.history[this.history.length - 1];
  }

  showLiveEstimate(inputText: string, outputText: string, model: string) {
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(outputText);
    const cost = calculateCost(inputTokens, outputTokens, model);
    this.statusBarItem.text = `$(sync~spin) Spark live: ~${formatTokens(inputTokens + outputTokens)} • ~${formatCost(cost)}`;
    this.statusBarItem.tooltip = `Current Muse Code request (estimated)\nInput: ~${inputTokens.toLocaleString()} tokens\nOutput: ~${outputTokens.toLocaleString()} tokens\nCost: ~${formatCost(cost)}\nExact CLI usage is recorded when the run completes.`;
    this.statusBarItem.show();
  }

  async resetSession(): Promise<void> {
    this.sessionTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0, requestCount: 0 };
    this.history = [];
    await this.context.globalState.update('museSpark.sessionTotals', this.sessionTotals);
    await this.context.globalState.update('museSpark.usageHistory', this.history);
    this.updateStatusBar();
    this._onDidUpdate.fire({ ...this.sessionTotals });
  }

  private updateStatusBar() {
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

  getSummaryMarkdown(): string {
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
      ...this.history.slice(-10).reverse().map((r, i) =>
        `${i + 1}. \`${r.model}\` — ${r.label || 'request'} — ${r.inputTokens} in / ${r.outputTokens} out — ${formatCost(r.cost)} — ${new Date(r.timestamp).toLocaleTimeString()}`
      ),
      ``,
      `> Tip: Toggle Contributor vs Private Standard mode via status bar (left) or command \`Muse Spark: Toggle Contributor / Standard Mode\`. Contributor is 12.5× cheaper but data may be used for training.`,
    ].join('\n');
  }

  dispose() {
    this.statusBarItem.dispose();
    this._onDidUpdate.dispose();
  }
}
