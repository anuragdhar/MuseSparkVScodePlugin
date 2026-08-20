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
exports.BillingTracker = void 0;
const vscode = __importStar(require("vscode"));
function formatCurrency(amount, currency) {
    if (amount === 0)
        return `$0.00`;
    if (amount < 0.01)
        return `$${amount.toFixed(6)}`;
    if (amount < 1)
        return `$${amount.toFixed(4)}`;
    if (amount < 1000)
        return `$${amount.toFixed(2)}`;
    return `$${amount.toFixed(2)}`;
}
function parseBillingJson(json) {
    const currency = json.currency || json.currency_code || json.data?.currency || 'USD';
    let unpaid;
    const candidates = [];
    const keys = ['unpaid', 'unpaid_amount', 'amount_due', 'outstanding', 'pending_charges', 'pending', 'balance_due', 'due', 'amountDue'];
    for (const k of keys) {
        if (json[k] !== undefined)
            candidates.push({ obj: json, key: k });
        if (json.data && json.data[k] !== undefined)
            candidates.push({ obj: json.data, key: k });
        if (json.billing && json.billing[k] !== undefined)
            candidates.push({ obj: json.billing, key: k });
    }
    for (const c of candidates) {
        const v = c.obj[c.key];
        if (typeof v === 'number' && !isNaN(v)) {
            unpaid = v;
            break;
        }
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(parseFloat(v))) {
            unpaid = parseFloat(v);
            break;
        }
        if (v && typeof v === 'object' && typeof v.amount === 'number') {
            unpaid = v.amount;
            break;
        }
    }
    // OpenAI legacy: credit_grants / total_used
    if (unpaid === undefined && typeof json.total_used === 'number') {
        // total_used is effectively unpaid/used; treat as unpaid if no other field
        unpaid = json.total_used;
    }
    if (unpaid === undefined && json.data && typeof json.data.total_used === 'number') {
        unpaid = json.data.total_used;
    }
    // Stripe-style nested
    if (unpaid === undefined && typeof json.amount === 'number' && json.object === 'balance') {
        unpaid = json.amount / 100; // cents
    }
    if (unpaid === undefined)
        unpaid = 0;
    const totalGranted = typeof json.total_granted === 'number' ? json.total_granted : json.data?.total_granted;
    const totalUsed = typeof json.total_used === 'number' ? json.total_used : json.data?.total_used;
    const totalAvailable = typeof json.total_available === 'number' ? json.total_available : json.data?.total_available;
    const hardLimitUsd = typeof json.hard_limit_usd === 'number' ? json.hard_limit_usd : json.hard_limit_usd ?? json.hardLimitUsd;
    const softLimitUsd = typeof json.soft_limit_usd === 'number' ? json.soft_limit_usd : json.soft_limit_usd ?? json.softLimitUsd;
    const balance = typeof json.balance === 'number' ? json.balance : typeof json.available === 'number' ? json.available : undefined;
    // Normalize string numbers
    const toNum = (v) => typeof v === 'string' ? parseFloat(v) : v;
    return {
        unpaid: toNum(unpaid) ?? 0,
        currency,
        totalGranted: totalGranted !== undefined ? toNum(totalGranted) : undefined,
        totalUsed: totalUsed !== undefined ? toNum(totalUsed) : undefined,
        totalAvailable: totalAvailable !== undefined ? toNum(totalAvailable) : undefined,
        hardLimitUsd: hardLimitUsd !== undefined ? toNum(hardLimitUsd) : undefined,
        softLimitUsd: softLimitUsd !== undefined ? toNum(softLimitUsd) : undefined,
        hasPaymentMethod: json.has_payment_method ?? json.hasPaymentMethod ?? json.data?.has_payment_method,
        balance: balance !== undefined ? toNum(balance) : undefined,
    };
}
class BillingTracker {
    static getInstance() {
        if (!BillingTracker._instance)
            throw new Error('BillingTracker not initialized. Call BillingTracker.init() first.');
        return BillingTracker._instance;
    }
    static init(context) {
        if (BillingTracker._instance)
            return BillingTracker._instance;
        BillingTracker._instance = new BillingTracker(context);
        return BillingTracker._instance;
    }
    constructor(context) {
        this.context = context;
        this.isFetching = false;
        this._onDidUpdate = new vscode.EventEmitter();
        this.onDidUpdate = this._onDidUpdate.event;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
        this.statusBarItem.command = 'museSpark.showBillingDetails';
        this.statusBarItem.tooltip = 'Muse Spark — Live unpaid charges';
        this.statusBarItem.text = '$(sync~spin) Spark Billing: loading…';
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem, this._onDidUpdate);
        this.updateStatusBarLoading();
        // Initial fetch (async, no await in ctor)
        void this.refreshNow();
        if (this.isAutoRefreshEnabled())
            this.startPolling();
        // Persist last fetch for quick restore on restart
        const saved = context.globalState.get('museSpark.lastBillingInfo');
        if (saved && saved.fetchedAt) {
            this.lastInfo = saved;
            this.updateStatusBar(saved);
        }
    }
    getConfig() {
        const cfg = vscode.workspace.getConfiguration('museSpark');
        const apiKey = cfg.get('apiKey') || process.env.META_API_KEY || process.env.MODEL_API_KEY || '';
        const endpoint = cfg.get('apiEndpoint') || 'https://api.meta.ai/v1/chat/completions';
        const billingEndpointCfg = cfg.get('billingEndpoint') || '';
        const autoRefresh = cfg.get('billingAutoRefresh') ?? true;
        const intervalMinutes = cfg.get('billingRefreshIntervalMinutes') ?? 5;
        const showBilling = cfg.get('showBillingStatus') ?? true;
        return { apiKey, endpoint, billingEndpointCfg, autoRefresh, intervalMinutes, showBilling };
    }
    isAutoRefreshEnabled() {
        return this.getConfig().autoRefresh;
    }
    getIntervalMs() {
        const mins = this.getConfig().intervalMinutes;
        const clamped = Math.min(Math.max(mins, 1), 60);
        return clamped * 60 * 1000;
    }
    getLastInfo() {
        return this.lastInfo ? { ...this.lastInfo } : undefined;
    }
    startPolling() {
        this.stopPolling();
        if (!this.getConfig().autoRefresh)
            return;
        const ms = this.getIntervalMs();
        this.interval = setInterval(() => { void this.refreshNow(); }, ms);
        // Ensure interval doesn't keep extension host alive unnecessarily after deactivate? Keep normally.
    }
    stopPolling() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }
    restartPolling() {
        this.stopPolling();
        if (this.isAutoRefreshEnabled())
            this.startPolling();
    }
    getBillingEndpoints() {
        const { endpoint, billingEndpointCfg } = this.getConfig();
        if (billingEndpointCfg && billingEndpointCfg.trim()) {
            return [billingEndpointCfg.trim()];
        }
        // Auto-derive from chat completions endpoint: https://api.meta.ai/v1/chat/completions -> https://api.meta.ai/v1/billing/balance
        let base = endpoint.trim().replace(/\/+$/, '');
        base = base.replace(/\/chat\/completions\/?$/, '');
        // Also strip trailing /v1/chat/completions variants already handled
        const candidates = [
            `${base}/billing/balance`,
            `${base}/billing/unpaid`,
            `${base}/billing/subscription`,
            `${base}/credits/balance`,
            `${base}/dashboard/billing/credit_grants`,
            `${base}/billing`,
        ];
        // Deduplicate
        return [...new Set(candidates)];
    }
    async refreshNow() {
        if (this.isFetching)
            return this.lastInfo;
        const { apiKey, showBilling } = this.getConfig();
        if (!showBilling) {
            this.statusBarItem.hide();
            return undefined;
        }
        this.statusBarItem.show();
        if (!apiKey) {
            const info = {
                unpaid: 0,
                currency: 'USD',
                fetchedAt: Date.now(),
                error: 'No API key — set museSpark.apiKey to enable live billing',
            };
            this.lastInfo = info;
            this.lastError = info.error;
            this.updateStatusBar(info);
            this._onDidUpdate.fire(info);
            return info;
        }
        this.isFetching = true;
        this.updateStatusBarLoading();
        try {
            const info = await this.fetchWithFallback();
            this.lastInfo = info;
            this.lastError = undefined;
            await this.context.globalState.update('museSpark.lastBillingInfo', info);
            this.updateStatusBar(info);
            this._onDidUpdate.fire(info);
            return info;
        }
        catch (e) {
            const errMsg = e?.message || String(e);
            this.lastError = errMsg;
            const info = {
                unpaid: this.lastInfo?.unpaid ?? 0,
                currency: this.lastInfo?.currency ?? 'USD',
                fetchedAt: Date.now(),
                error: errMsg,
                raw: this.lastInfo?.raw,
            };
            this.lastInfo = info;
            this.updateStatusBar(info);
            this._onDidUpdate.fire(info);
            return info;
        }
        finally {
            this.isFetching = false;
        }
    }
    async fetchWithFallback() {
        const { apiKey } = this.getConfig();
        const endpoints = this.getBillingEndpoints();
        let lastError;
        for (const url of endpoints) {
            try {
                const res = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                });
                if (res.status === 404) {
                    lastError = `404 ${url}`;
                    continue; // try next fallback
                }
                if (!res.ok) {
                    const txt = await res.text().catch(() => '');
                    throw new Error(`Billing API ${res.status} at ${url}: ${txt.slice(0, 500)}`);
                }
                const json = await res.json().catch(async () => {
                    const txt = await res.text();
                    try {
                        return JSON.parse(txt);
                    }
                    catch {
                        throw new Error(`Invalid JSON from ${url}: ${txt.slice(0, 300)}`);
                    }
                });
                const parsed = parseBillingJson(json);
                const info = {
                    ...parsed,
                    fetchedAt: Date.now(),
                    raw: json,
                };
                return info;
            }
            catch (e) {
                lastError = e.message;
                // Network error — try next endpoint only if 404-like, otherwise fail fast
                if (String(e.message).includes('404'))
                    continue;
                // For other errors, still try next fallback if we have more candidates and error looks like endpoint not found
                if (endpoints.indexOf(url) < endpoints.length - 1 && (String(e.message).includes('Not Found') || String(e.message).includes('404'))) {
                    continue;
                }
                throw e;
            }
        }
        throw new Error(lastError || 'All billing endpoints failed');
    }
    updateStatusBarLoading() {
        if (!this.getConfig().showBilling) {
            this.statusBarItem.hide();
            return;
        }
        this.statusBarItem.text = '$(sync~spin) Spark Billing: syncing…';
        this.statusBarItem.tooltip = `Muse Spark — Live unpaid charges\nRefreshing…\nClick for details — Auto-refresh every ${this.getConfig().intervalMinutes} min`;
        this.statusBarItem.show();
    }
    updateStatusBar(info) {
        if (!this.getConfig().showBilling) {
            this.statusBarItem.hide();
            return;
        }
        const mins = this.getConfig().intervalMinutes;
        if (info.error) {
            // If no api key, show muted prompt
            if (info.error.includes('No API key')) {
                this.statusBarItem.text = '$(key) Spark Billing: set API key';
                this.statusBarItem.tooltip = `Muse Spark — Live billing disabled\n${info.error}\nClick to open settings (museSpark.apiKey)\nBilling refresh: every ${mins} min when configured`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.show();
                return;
            }
            this.statusBarItem.text = '$(warning) Spark Billing: error';
            this.statusBarItem.tooltip = `Muse Spark — Billing error\n${info.error}\nLast unpaid: ${formatCurrency(info.unpaid, info.currency)}\nFetched: ${new Date(info.fetchedAt).toLocaleString()}\nClick to retry • Auto-refresh every ${mins} min`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.statusBarItem.show();
            return;
        }
        this.statusBarItem.backgroundColor = undefined;
        const formatted = formatCurrency(info.unpaid, info.currency);
        const timeStr = new Date(info.fetchedAt).toLocaleTimeString();
        if (info.unpaid > 0) {
            this.statusBarItem.text = `$(credit-card) Spark Unpaid: ${formatted}`;
            this.statusBarItem.tooltip = `Muse Spark — Live unpaid charges\nUnpaid: ${formatted} ${info.currency}\nFetched: ${timeStr}\nAuto-refresh every ${mins} min • Click for breakdown`;
        }
        else {
            this.statusBarItem.text = `$(check) Spark Unpaid: ${formatted}`;
            this.statusBarItem.tooltip = `Muse Spark — Live unpaid charges\nUnpaid: ${formatted} • All clear ✓\nFetched: ${timeStr}\nAuto-refresh every ${mins} min • Click for breakdown`;
        }
        // Append extra limits if present
        if (info.hardLimitUsd !== undefined || info.balance !== undefined || info.totalAvailable !== undefined) {
            const extra = [
                info.balance !== undefined ? `Balance: ${formatCurrency(info.balance, info.currency)}` : '',
                info.totalAvailable !== undefined ? `Available: ${formatCurrency(info.totalAvailable, info.currency)}` : '',
                info.hardLimitUsd !== undefined ? `Hard limit: ${formatCurrency(info.hardLimitUsd, info.currency)}` : '',
            ].filter(Boolean).join(' • ');
            if (extra)
                this.statusBarItem.tooltip += `\n${extra}`;
        }
        this.statusBarItem.show();
    }
    getSummaryMarkdown() {
        const info = this.lastInfo;
        if (!info)
            return '# Muse Spark — Live Billing\n\n_No data yet — click Refresh._\n';
        const lines = [];
        lines.push('# Muse Spark — Live Billing (Unpaid Charges)');
        lines.push('');
        if (info.error) {
            lines.push(`> ⚠️ **Error:** ${info.error}`);
            lines.push('');
        }
        lines.push(`**Unpaid:** ${formatCurrency(info.unpaid, info.currency)} ${info.currency}`);
        lines.push(`**Fetched:** ${new Date(info.fetchedAt).toLocaleString()}`);
        lines.push(`**Auto-refresh:** every ${this.getConfig().intervalMinutes} min — ${this.isAutoRefreshEnabled() ? 'enabled' : 'paused'}`);
        lines.push('');
        if (info.balance !== undefined)
            lines.push(`- Balance: ${formatCurrency(info.balance, info.currency)}`);
        if (info.totalGranted !== undefined)
            lines.push(`- Total granted: ${formatCurrency(info.totalGranted, info.currency)}`);
        if (info.totalUsed !== undefined)
            lines.push(`- Total used: ${formatCurrency(info.totalUsed, info.currency)}`);
        if (info.totalAvailable !== undefined)
            lines.push(`- Total available: ${formatCurrency(info.totalAvailable, info.currency)}`);
        if (info.hardLimitUsd !== undefined)
            lines.push(`- Hard limit: ${formatCurrency(info.hardLimitUsd, info.currency)}`);
        if (info.softLimitUsd !== undefined)
            lines.push(`- Soft limit: ${formatCurrency(info.softLimitUsd, info.currency)}`);
        if (info.hasPaymentMethod !== undefined)
            lines.push(`- Has payment method: ${info.hasPaymentMethod ? 'yes' : 'no'}`);
        lines.push('');
        if (info.raw) {
            lines.push('<details><summary>Raw response</summary>');
            lines.push('');
            lines.push('```json');
            lines.push(JSON.stringify(info.raw, null, 2).slice(0, 4000));
            lines.push('```');
            lines.push('</details>');
        }
        lines.push('');
        lines.push(`> Endpoints tried: ${this.getBillingEndpoints().join(', ')}`);
        return lines.join('\n');
    }
    dispose() {
        this.stopPolling();
        this.statusBarItem.dispose();
        this._onDidUpdate.dispose();
    }
}
exports.BillingTracker = BillingTracker;
//# sourceMappingURL=billingTracker.js.map