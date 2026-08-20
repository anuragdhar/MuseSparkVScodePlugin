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
exports.MuseLanguageModelProvider = void 0;
exports.configureMuseLanguageModel = configureMuseLanguageModel;
const vscode = __importStar(require("vscode"));
const SECRET_KEY = 'museSpark.metaApiKey';
class MuseLanguageModelProvider {
    constructor(secrets) {
        this.secrets = secrets;
    }
    provideLanguageModelChatInformation() {
        return [
            this.model('muse-spark-1.2', 'Muse Spark 1.2', 'Private standard endpoint'),
            this.model('muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 'Lower-cost contributor endpoint'),
            this.model('muse-spark-1.2-code', 'Muse Spark 1.2 Code', 'Coding-focused variant')
        ];
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Muse Spark API key is not configured. Run “Muse Spark: Configure Language Model Provider”.');
        }
        const endpoint = vscode.workspace.getConfiguration('museSpark').get('apiEndpoint') || 'https://api.meta.ai/v1/chat/completions';
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const tools = options.tools?.map(item => ({
            type: 'function',
            function: { name: item.name, description: item.description, parameters: item.inputSchema || { type: 'object', properties: {} } }
        }));
        const body = {
            model: model.id,
            messages: this.convertMessages(messages),
            stream: true,
            max_tokens: model.maxOutputTokens,
            temperature: 0.2
        };
        if (tools?.length) {
            body.tools = tools;
            body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
        }
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            if (!response.ok)
                throw new Error(`Meta Model API ${response.status}: ${await response.text()}`);
            if (!response.body)
                throw new Error('Meta Model API returned an empty response stream.');
            await this.readStream(response.body, progress, token);
        }
        catch (error) {
            if (token.isCancellationRequested || error?.name === 'AbortError')
                return;
            throw error;
        }
        finally {
            cancellation.dispose();
        }
    }
    async provideTokenCount(_model, value) {
        const text = typeof value === 'string' ? value : this.partsToText(value.content);
        return Math.max(1, Math.ceil(text.length / 4));
    }
    model(id, name, detail) {
        return {
            id, name, detail, family: 'muse-spark', version: '1.2',
            maxInputTokens: 1048576,
            maxOutputTokens: 131072,
            capabilities: { imageInput: false, toolCalling: true }
        };
    }
    async getApiKey() {
        return (await this.secrets.get(SECRET_KEY))
            || vscode.workspace.getConfiguration('museSpark').get('apiKey')
            || process.env.META_API_KEY
            || process.env.META_MUSE_API_KEY
            || '';
    }
    convertMessages(messages) {
        const output = [];
        for (const message of messages) {
            const text = this.partsToText(message.content);
            const calls = message.content.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
            const results = message.content.filter((part) => part instanceof vscode.LanguageModelToolResultPart);
            if (calls.length) {
                output.push({
                    role: 'assistant', content: text || null,
                    tool_calls: calls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }))
                });
            }
            else if (text || !results.length) {
                output.push({ role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', content: text });
            }
            for (const result of results) {
                output.push({ role: 'tool', tool_call_id: result.callId, content: this.partsToText(result.content) });
            }
        }
        return output;
    }
    partsToText(parts) {
        return parts.map(part => {
            if (part instanceof vscode.LanguageModelTextPart)
                return part.value;
            if (part instanceof vscode.LanguageModelDataPart)
                return `[${part.mimeType} data omitted]`;
            return '';
        }).join('');
    }
    async readStream(stream, progress, token) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const pendingCalls = new Map();
        let buffer = '';
        const consume = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:'))
                return;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]')
                return;
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta || {};
            if (delta.content)
                progress.report(new vscode.LanguageModelTextPart(delta.content));
            for (const call of delta.tool_calls || []) {
                const index = Number(call.index) || 0;
                const current = pendingCalls.get(index) || { id: '', name: '', args: '' };
                current.id += call.id || '';
                current.name += call.function?.name || '';
                current.args += call.function?.arguments || '';
                pendingCalls.set(index, current);
            }
        };
        while (!token.isCancellationRequested) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines)
                consume(line);
        }
        if (buffer.trim())
            consume(buffer);
        for (const call of [...pendingCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
            let input;
            try {
                input = JSON.parse(call.args || '{}');
            }
            catch {
                throw new Error(`Muse Spark returned invalid arguments for tool ${call.name}.`);
            }
            progress.report(new vscode.LanguageModelToolCallPart(call.id || crypto.randomUUID(), call.name, input));
        }
    }
}
exports.MuseLanguageModelProvider = MuseLanguageModelProvider;
async function configureMuseLanguageModel(secrets) {
    const choice = await vscode.window.showQuickPick([
        { label: 'Set API key', description: 'Store the Meta Model API key securely' },
        { label: 'Remove API key', description: 'Delete the securely stored key' }
    ], { title: 'Muse Spark language model provider' });
    if (!choice)
        return;
    if (choice.label === 'Remove API key') {
        await secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage('Muse Spark API key removed.');
        return;
    }
    const key = await vscode.window.showInputBox({ title: 'Meta Model API key', password: true, ignoreFocusOut: true });
    if (!key?.trim())
        return;
    await secrets.store(SECRET_KEY, key.trim());
    vscode.window.showInformationMessage('Muse Spark API key stored securely. Reload the chat model list if needed.');
}
//# sourceMappingURL=languageModelProvider.js.map