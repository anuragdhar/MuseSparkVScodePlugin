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
exports.SparkClient = void 0;
exports.getTextFromContent = getTextFromContent;
exports.countImagesInContent = countImagesInContent;
exports.estimateTokensForContent = estimateTokensForContent;
exports.contentToApiPayload = contentToApiPayload;
const vscode = __importStar(require("vscode"));
const costTracker_1 = require("./costTracker");
function getTextFromContent(content) {
    if (typeof content === 'string')
        return content;
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}
function countImagesInContent(content) {
    if (typeof content === 'string')
        return 0;
    return content.filter(p => p.type === 'image_url').length;
}
function estimateTokensForContent(content) {
    if (typeof content === 'string')
        return (0, costTracker_1.estimateTokens)(content);
    let tokens = 0;
    for (const p of content) {
        if (p.type === 'text')
            tokens += (0, costTracker_1.estimateTokens)(p.text);
        else if (p.type === 'image_url') {
            // Rough estimate: ~85 tokens low, ~170*tiles high; use 1024 as safe avg for cost tracking
            const detail = p.image_url.detail || 'auto';
            tokens += detail === 'low' ? 85 : detail === 'high' ? 1024 : 512;
        }
    }
    return tokens;
}
function contentToApiPayload(content) {
    return content;
}
class SparkClient {
    getConfig() {
        const cfg = vscode.workspace.getConfiguration('museSpark');
        const useContributor = cfg.get('useContributorPricing') ?? true;
        let model = cfg.get('model') || 'muse-spark-1.2-contributor';
        // Normalize model based on pricing toggle for backward compat
        if (useContributor && model === 'muse-spark-1.2')
            model = 'muse-spark-1.2-contributor';
        if (!useContributor && model === 'muse-spark-1.2-contributor')
            model = 'muse-spark-1.2';
        return {
            apiKey: cfg.get('apiKey') || process.env.META_API_KEY || process.env.MODEL_API_KEY || '',
            endpoint: cfg.get('apiEndpoint') || 'https://api.meta.ai/v1/chat/completions',
            model,
            systemPrompt: cfg.get('systemPrompt') || 'You are Muse Spark 1.2, a helpful coding assistant.',
            useContributor,
            showCost: cfg.get('showTokenCost') ?? true,
        };
    }
    getPricing(model) {
        return (0, costTracker_1.getPricingForModel)(model);
    }
    getTracker() {
        try {
            return costTracker_1.CostTracker.getInstance();
        }
        catch {
            return undefined;
        }
    }
    reportUsage(inputText, outputText, model, label, usage) {
        const tracker = this.getTracker();
        if (!tracker)
            return;
        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
            const inputTokens = usage.prompt_tokens ?? (0, costTracker_1.estimateTokens)(inputText);
            const outputTokens = usage.completion_tokens ?? (0, costTracker_1.estimateTokens)(outputText);
            tracker.addUsage({ inputTokens, outputTokens, model, label });
        }
        else {
            tracker.addEstimatedUsage(inputText, outputText, model, label);
        }
    }
    /** Helper to get text representation for token estimation / logging */
    messagesToInputText(messages) {
        return messages.map(m => {
            if (typeof m.content === 'string')
                return m.content;
            return m.content.map(p => p.type === 'text' ? p.text : `[image:${p.image_url.detail || 'auto'}]`).join('\n');
        }).join('\n');
    }
    estimateInputTokens(messages) {
        let t = 0;
        for (const m of messages)
            t += estimateTokensForContent(m.content);
        return t;
    }
    async chat(messages, onDelta, label = 'chat') {
        const { apiKey, endpoint, model, systemPrompt, showCost } = this.getConfig();
        const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];
        const inputText = this.messagesToInputText(fullMessages);
        if (!apiKey) {
            const out = await this.mockChat(messages, onDelta, label);
            return out;
        }
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model, messages: fullMessages, stream: !!onDelta, temperature: 0.3, max_tokens: 4096 })
            });
            if (!res.ok)
                throw new Error(`Spark API ${res.status}: ${await res.text()}`);
            let full = '';
            let usage = undefined;
            if (onDelta && res.body) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        const t = line.trim();
                        if (!t.startsWith('data:'))
                            continue;
                        const d = t.slice(5).trim();
                        if (d === '[DONE]')
                            break;
                        try {
                            const j = JSON.parse(d);
                            // Capture usage if present (OpenAI streams usage in final chunk when stream_options.include_usage=true)
                            if (j.usage)
                                usage = j.usage;
                            if (j.x_groq?.usage)
                                usage = j.x_groq.usage;
                            const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
                            if (delta) {
                                full += delta;
                                onDelta(delta);
                            }
                        }
                        catch { }
                    }
                }
                // Fallback: try to parse remaining buffer
                if (buffer.trim().startsWith('data:')) {
                    try {
                        const j = JSON.parse(buffer.trim().slice(5).trim());
                        if (j.usage)
                            usage = j.usage;
                    }
                    catch { }
                }
            }
            else {
                const j = await res.json();
                full = j.choices?.[0]?.message?.content || j.choices?.[0]?.text || '';
                usage = j.usage;
            }
            // Report to tracker
            this.reportUsage(inputText, full, model, label, usage);
            if (showCost) {
                const tracker = this.getTracker();
                const last = tracker?.getLastRecord();
                if (last) {
                    vscode.window.setStatusBarMessage(`$(sparkle) Spark ${model} | ${last.inputTokens} in / ${last.outputTokens} out | ${last.cost < 0.01 ? `$${last.cost.toFixed(6)}` : `$${last.cost.toFixed(4)}`}`, 8000);
                }
            }
            return full;
        }
        catch (e) {
            vscode.window.showErrorMessage(`Muse Spark error: ${e.message}`);
            throw e;
        }
    }
    /** Non-streaming tool-calling completion used by WorkspaceAgent */
    async complete(messages, tools, label = 'agent') {
        const { apiKey, endpoint, model, systemPrompt } = this.getConfig();
        if (!apiKey)
            throw new Error('A Meta Model API key is required for agent mode. Set museSpark.apiKey in VS Code Settings.');
        const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];
        const inputText = fullMessages.map((m) => {
            const c = m.content;
            if (typeof c === 'string')
                return c;
            if (Array.isArray(c))
                return c.map((p) => p.type === 'text' ? p.text : `[image:${p.image_url?.detail || 'auto'}]`).join('\n');
            return c ? JSON.stringify(c) : JSON.stringify(m);
        }).join('\n');
        const body = {
            model,
            messages: fullMessages,
            stream: false,
            temperature: 0.2,
            max_tokens: 4096
        };
        if (tools?.length) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body)
        });
        if (!res.ok)
            throw new Error(`Spark API ${res.status}: ${await res.text()}`);
        const json = await res.json();
        const message = json.choices?.[0]?.message;
        if (!message)
            throw new Error('The Meta API returned no assistant message.');
        // Track usage for agent step
        const outputText = message.content || JSON.stringify(message.tool_calls || '');
        this.reportUsage(inputText, outputText, model, label, json.usage);
        // Attach usage for caller if needed
        if (json.usage)
            message._usage = json.usage;
        return message;
    }
    async mockChat(messages, onDelta, label = 'chat') {
        const lastContent = messages[messages.length - 1]?.content;
        const last = typeof lastContent === 'string' ? lastContent : getTextFromContent(lastContent) || '';
        const lastImages = Array.isArray(lastContent) ? countImagesInContent(lastContent) : 0;
        const { model } = this.getConfig();
        const p = this.getPricing(model);
        const imageNote = lastImages ? ` [${lastImages} image(s) attached]` : '';
        const mockResponse = `**[Mock Mode - ${model}]**\n\nPricing: ${p.label}\n\nYou asked: "${last.slice(0, 200)}"${imageNote}\n\nWhen connected to https://api.meta.ai/v1 : model id = rate.\n\n> Tip: Set \`museSpark.apiKey\` to enable live calls. Token usage will be estimated in mock mode and shown in the Cost Tracker.${lastImages ? `\n\n> Image support: your ${lastImages} image(s) would be sent as \`image_url\` parts in live mode.` : ''}`;
        if (onDelta) {
            for (const chunk of mockResponse.split(/(\s+)/)) {
                await new Promise(r => setTimeout(r, 12));
                onDelta(chunk);
            }
        }
        // Report estimated usage for mock - include image token cost
        const inputText = this.messagesToInputText(messages);
        // Add image token estimate to usage manually for accurate cost
        const imageTokens = messages.reduce((s, m) => s + (typeof m.content === 'string' ? 0 : countImagesInContent(m.content) * 512), 0);
        if (imageTokens > 0) {
            const textTokens = this.estimateInputTokens(messages);
            const outTokens = (0, costTracker_1.estimateTokens)(mockResponse);
            const tracker = this.getTracker();
            if (tracker) {
                tracker.addUsage({ inputTokens: textTokens, outputTokens: outTokens, model, label: `${label} (mock)` });
                return mockResponse;
            }
        }
        this.reportUsage(inputText, mockResponse, model, `${label} (mock)`);
        return mockResponse;
    }
    async explainCode(code, language) {
        return this.chat([{ role: 'user', content: `Explain this ${language} code concisely, including what it does, complexity, and edge cases:\n\n\`\`\`${language}\n${code}\n\`\`\`` }], undefined, 'explain');
    }
    async refactorCode(code, language) {
        return this.chat([{ role: 'user', content: `Refactor this ${language} code for clarity and performance. Return ONLY the refactored code in a code block, no extra explanation:\n\n${code}` }], undefined, 'refactor');
    }
    async fixCode(code, language) {
        return this.chat([{ role: 'user', content: `Find and fix bugs in this ${language} code. Return fixed code in a code block and a brief bullet list of fixes after:\n\n${code}` }], undefined, 'fix');
    }
    async generateDocs(code, language) {
        return this.chat([{ role: 'user', content: `Generate documentation (JSDoc/docstring style) for this ${language} code. Return only documented code:\n\n${code}` }], undefined, 'docs');
    }
    // ── Live billing — unpaid charges (polled every 5 min by BillingTracker) ──
    getBillingEndpoints() {
        const { endpoint } = this.getConfig();
        const cfg = vscode.workspace.getConfiguration('museSpark');
        const override = cfg.get('billingEndpoint')?.trim();
        if (override)
            return [override];
        let base = (endpoint || 'https://api.meta.ai/v1/chat/completions').trim().replace(/\/+$/, '').replace(/\/chat\/completions\/?$/, '');
        return [...new Set([
                `${base}/billing/balance`,
                `${base}/billing/unpaid`,
                `${base}/billing/subscription`,
                `${base}/credits/balance`,
                `${base}/dashboard/billing/credit_grants`,
                `${base}/billing`,
            ])];
    }
    async fetchLiveBilling() {
        const { apiKey } = this.getConfig();
        if (!apiKey)
            throw new Error('No API key — set museSpark.apiKey to enable live billing');
        const endpoints = this.getBillingEndpoints();
        let lastErr = '';
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
                if (res.status === 404) {
                    lastErr = `404 ${url}`;
                    continue;
                }
                if (!res.ok)
                    throw new Error(`Billing API ${res.status} at ${url}: ${(await res.text()).slice(0, 500)}`);
                const json = await res.json();
                // Reuse same parsing heuristics as BillingTracker
                let unpaid;
                for (const k of ['unpaid', 'unpaid_amount', 'amount_due', 'outstanding', 'pending_charges', 'balance_due']) {
                    const v = json[k] ?? json.data?.[k] ?? json.billing?.[k];
                    if (typeof v === 'number') {
                        unpaid = v;
                        break;
                    }
                    if (typeof v === 'string' && !isNaN(parseFloat(v))) {
                        unpaid = parseFloat(v);
                        break;
                    }
                }
                if (unpaid === undefined && typeof json.total_used === 'number')
                    unpaid = json.total_used;
                if (unpaid === undefined)
                    unpaid = 0;
                const currency = json.currency || json.currency_code || json.data?.currency || 'USD';
                const balance = typeof json.balance === 'number' ? json.balance : undefined;
                return { unpaid, currency, balance, raw: json, fetchedAt: Date.now() };
            }
            catch (e) {
                lastErr = e.message;
                if (String(e.message).includes('404') && endpoints.indexOf(url) < endpoints.length - 1)
                    continue;
                if (endpoints.indexOf(url) === endpoints.length - 1)
                    throw e;
                // try next fallback for 404-like
                if (String(e.message).includes('404'))
                    continue;
                throw e;
            }
        }
        throw new Error(lastErr || 'All billing endpoints failed');
    }
    /** Start a 5-min polling loop for live unpaid charges. Returns a Disposable to stop. */
    startBillingPolling(onUpdate, intervalMs = 5 * 60 * 1000) {
        let stopped = false;
        let timer;
        const tick = async () => {
            if (stopped)
                return;
            try {
                const info = await this.fetchLiveBilling();
                onUpdate?.({ unpaid: info.unpaid, currency: info.currency, fetchedAt: info.fetchedAt });
            }
            catch (e) {
                onUpdate?.({ unpaid: 0, currency: 'USD', fetchedAt: Date.now(), error: e.message });
            }
        };
        void tick();
        timer = setInterval(tick, intervalMs);
        return { dispose: () => { stopped = true; if (timer)
                clearInterval(timer); } };
    }
}
exports.SparkClient = SparkClient;
//# sourceMappingURL=sparkClient.js.map