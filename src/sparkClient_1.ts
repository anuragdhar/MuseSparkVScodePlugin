import * as vscode from 'vscode';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export class SparkClient {
  private getConfig() {
    const cfg = vscode.workspace.getConfiguration('museSpark');
    const useContributor = cfg.get<boolean>('useContributorPricing') ?? true;
    let model = cfg.get<string>('model') || 'muse-spark-1.2-contributor';
    if (useContributor && model === 'muse-spark-1.2') model = 'muse-spark-1.2-contributor';
    if (!useContributor && model === 'muse-spark-1.2-contributor') model = 'muse-spark-1.2';
    return {
      apiKey: cfg.get<string>('apiKey') || process.env.META_API_KEY || process.env.MODEL_API_KEY || '',
      endpoint: cfg.get<string>('apiEndpoint') || 'https://api.meta.ai/v1/chat/completions',
      model, systemPrompt: cfg.get<string>('systemPrompt') || 'You are Muse Spark 1.2',
      useContributor, showCost: cfg.get<boolean>('showTokenCost') ?? true
    };
  }
  getPricing(model: string) {
    if (model.includes('contributor')) return { input: 0.10, output: 0.20, cacheRead: 0.002, label: 'Contributor ($0.10/$0.20 per M)' };
    return { input: 1.25, output: 4.25, cacheRead: 0.15, label: 'Standard ($1.25/$4.25 per M)' };
  }
  async chat(messages: ChatMessage[], onDelta?: (text: string) => void): Promise<string> {
    const { apiKey, endpoint, model, systemPrompt, showCost } = this.getConfig();
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    if (!apiKey) return this.mockChat(messages, onDelta);
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: fullMessages, stream: !!onDelta, temperature: 0.3, max_tokens: 4096 }) });
      if (!res.ok) throw new Error(`Spark API ${res.status}: ${await res.text()}`);
      let full = ''; let inputTokens = 0; let outputTokens = 0;
      if (onDelta && res.body) {
        const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines) { const t = line.trim(); if (!t.startsWith('data:')) continue; const d = t.slice(5).trim(); if (d === '[DONE]') break; try { const j = JSON.parse(d); const delta = j.choices?.[0]?.delta?.content || ''; if (delta) { full += delta; onDelta(delta); } if (j.usage) { inputTokens = j.usage.prompt_tokens||0; outputTokens=j.usage.completion_tokens||0; } } catch {} } }
      } else { const j = await res.json() as any; full = j.choices?.[0]?.message?.content || ''; inputTokens=j.usage?.prompt_tokens||0; outputTokens=j.usage?.completion_tokens||0; }
      if (showCost) { const p=this.getPricing(model); const cost=(inputTokens/1e6)*p.input+(outputTokens/1e6)*p.output; vscode.window.setStatusBarMessage(`$(sparkle) Spark ${model} | ${inputTokens} in / ${outputTokens} out | ~$${cost.toFixed(6)} | ${p.label}`,8000); }
      return full;
    } catch (e:any) { vscode.window.showErrorMessage(`Muse Spark error: ${e.message}`); throw e; }
  }
  private async mockChat(messages: ChatMessage[], onDelta?: (text: string) => void): Promise<string> {
    const last = messages[messages.length-1]?.content||''; const {model}=this.getConfig(); const p=this.getPricing(model);
    const mock=`**[Mock Mode - ${model}]**\nPricing: ${p.label}\nYou asked: "${last.slice(0,200)}"\n\nWhen connected to https://api.meta.ai/v1 : model id = rate.`;
    if (onDelta) { for (const c of mock.split(/(\s+)/)) { await new Promise(r=>setTimeout(r,12)); onDelta(c); } }
    return mock;
  }
  async explainCode(code:string,language:string){return this.chat([{role:'user',content:`Explain this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``}]);}
  async refactorCode(code:string,language:string){return this.chat([{role:'user',content:`Refactor this ${language} code, return only code block:\n\n${code}`}]);}
  async fixCode(code:string,language:string){return this.chat([{role:'user',content:`Fix bugs in this ${language} code:\n\n${code}`}]);}
  async generateDocs(code:string,language:string){return this.chat([{role:'user',content:`Generate docs for this ${language} code:\n\n${code}`}]);}
}
