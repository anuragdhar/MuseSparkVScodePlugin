import * as vscode from 'vscode';
import { CostTracker, calculateCost, estimateTokens, getPricingForModel } from './costTracker';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface ChatResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cost: number; model: string; estimated: boolean };
}

export class SparkClient {
  private getConfig() {
    const cfg = vscode.workspace.getConfiguration('museSpark');
    const useContributor = cfg.get<boolean>('useContributorPricing') ?? true;
    let model = cfg.get<string>('model') || 'muse-spark-1.2-contributor';
    // Normalize model based on pricing toggle for backward compat
    if (useContributor && model === 'muse-spark-1.2') model = 'muse-spark-1.2-contributor';
    if (!useContributor && model === 'muse-spark-1.2-contributor') model = 'muse-spark-1.2';
    return {
      apiKey: cfg.get<string>('apiKey') || process.env.META_API_KEY || process.env.MODEL_API_KEY || '',
      endpoint: cfg.get<string>('apiEndpoint') || 'https://api.meta.ai/v1/chat/completions',
      model,
      systemPrompt: cfg.get<string>('systemPrompt') || 'You are Muse Spark 1.2, a helpful coding assistant.',
      useContributor,
      showCost: cfg.get<boolean>('showTokenCost') ?? true,
    };
  }

  getPricing(model: string) {
    return getPricingForModel(model);
  }

  private getTracker(): CostTracker | undefined {
    try { return CostTracker.getInstance(); } catch { return undefined; }
  }

  private reportUsage(inputText: string, outputText: string, model: string, label: string, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    const tracker = this.getTracker();
    if (!tracker) return;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
      const inputTokens = usage.prompt_tokens ?? estimateTokens(inputText);
      const outputTokens = usage.completion_tokens ?? estimateTokens(outputText);
      tracker.addUsage({ inputTokens, outputTokens, model, label });
    } else {
      tracker.addEstimatedUsage(inputText, outputText, model, label);
    }
  }

  async chat(messages: ChatMessage[], onDelta?: (text: string) => void, label: string = 'chat'): Promise<string> {
    const { apiKey, endpoint, model, systemPrompt, showCost } = this.getConfig();
    const fullMessages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];
    const inputText = fullMessages.map(m => m.content).join('\n');

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
      if (!res.ok) throw new Error(`Spark API ${res.status}: ${await res.text()}`);

      let full = '';
      let usage: any = undefined;

      if (onDelta && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const d = t.slice(5).trim();
            if (d === '[DONE]') break;
            try {
              const j = JSON.parse(d);
              // Capture usage if present (OpenAI streams usage in final chunk when stream_options.include_usage=true)
              if (j.usage) usage = j.usage;
              if (j.x_groq?.usage) usage = j.x_groq.usage;
              const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
              if (delta) { full += delta; onDelta(delta); }
            } catch {}
          }
        }
        // Fallback: try to parse remaining buffer
        if (buffer.trim().startsWith('data:')) {
          try {
            const j = JSON.parse(buffer.trim().slice(5).trim());
            if (j.usage) usage = j.usage;
          } catch {}
        }
      } else {
        const j = await res.json() as any;
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
    } catch (e: any) {
      vscode.window.showErrorMessage(`Muse Spark error: ${e.message}`);
      throw e;
    }
  }

  /** Non-streaming tool-calling completion used by WorkspaceAgent */
  async complete(messages: any[], tools?: any[], label: string = 'agent'): Promise<any> {
    const { apiKey, endpoint, model, systemPrompt } = this.getConfig();
    if (!apiKey) throw new Error('A Meta Model API key is required for agent mode. Set museSpark.apiKey in VS Code Settings.');

    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const inputText = fullMessages.map((m: any) => m.content || JSON.stringify(m)).join('\n');

    const body: any = {
      model,
      messages: fullMessages,
      stream: false,
      temperature: 0.2,
      max_tokens: 4096
    };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Spark API ${res.status}: ${await res.text()}`);
    const json = await res.json() as any;
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error('The Meta API returned no assistant message.');

    // Track usage for agent step
    const outputText = message.content || JSON.stringify(message.tool_calls || '');
    this.reportUsage(inputText, outputText, model, label, json.usage);

    // Attach usage for caller if needed
    if (json.usage) (message as any)._usage = json.usage;
    return message;
  }

  private async mockChat(messages: ChatMessage[], onDelta?: (text: string) => void, label: string = 'chat'): Promise<string> {
    const last = messages[messages.length - 1]?.content || '';
    const { model } = this.getConfig();
    const p = this.getPricing(model);
    const mockResponse = `**[Mock Mode - ${model}]**\n\nPricing: ${p.label}\n\nYou asked: "${last.slice(0, 200)}"\n\nWhen connected to https://api.meta.ai/v1 : model id = rate.\n\n> Tip: Set \`museSpark.apiKey\` to enable live calls. Token usage will be estimated in mock mode and shown in the Cost Tracker.`;

    if (onDelta) {
      for (const chunk of mockResponse.split(/(\s+)/)) {
        await new Promise(r => setTimeout(r, 12));
        onDelta(chunk);
      }
    }
    // Report estimated usage for mock
    const inputText = messages.map(m => m.content).join('\n');
    this.reportUsage(inputText, mockResponse, model, `${label} (mock)`);
    return mockResponse;
  }

  async explainCode(code: string, language: string): Promise<string> {
    return this.chat([{ role: 'user', content: `Explain this ${language} code concisely, including what it does, complexity, and edge cases:\n\n\`\`\`${language}\n${code}\n\`\`\`` }], undefined, 'explain');
  }
  async refactorCode(code: string, language: string): Promise<string> {
    return this.chat([{ role: 'user', content: `Refactor this ${language} code for clarity and performance. Return ONLY the refactored code in a code block, no extra explanation:\n\n${code}` }], undefined, 'refactor');
  }
  async fixCode(code: string, language: string): Promise<string> {
    return this.chat([{ role: 'user', content: `Find and fix bugs in this ${language} code. Return fixed code in a code block and a brief bullet list of fixes after:\n\n${code}` }], undefined, 'fix');
  }
  async generateDocs(code: string, language: string): Promise<string> {
    return this.chat([{ role: 'user', content: `Generate documentation (JSDoc/docstring style) for this ${language} code. Return only documented code:\n\n${code}` }], undefined, 'docs');
  }
}
