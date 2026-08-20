import * as vscode from 'vscode';
import { ChatViewProvider } from './chatPanel';
import { SparkClient } from './sparkClient';
import { CostTracker } from './costTracker';
import { BillingTracker } from './billingTracker';
import { MuseLanguageModelProvider, configureMuseLanguageModel } from './languageModelProvider';
import { resolveApprovalMode, resolvePlanMode } from './sessionStore';

let chatProvider: ChatViewProvider;
let statusBarItem: vscode.StatusBarItem;

function getPricingConfig() {
  const cfg = vscode.workspace.getConfiguration('museSpark');
  const useContributor = cfg.get<boolean>('useContributorPricing') ?? true;
  let model = cfg.get<string>('model') || 'muse-spark-1.2-contributor';
  if (useContributor && model === 'muse-spark-1.2') model = 'muse-spark-1.2-contributor';
  if (!useContributor && model === 'muse-spark-1.2-contributor') model = 'muse-spark-1.2';
  return { useContributor, model };
}

function updateStatusBar() {
  const { useContributor, model } = getPricingConfig();
  if (!statusBarItem) return;

  if (useContributor) {
    statusBarItem.text = '$(flame) SPARK: CONTRIBUTOR';
    statusBarItem.tooltip = `Contributor Mode Active\nModel: ${model}\n$0.10/M input, $0.20/M output\n⚠️ Inputs/outputs may be used by Meta for training\nClick to toggle to Private Standard mode`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  } else {
    statusBarItem.text = '$(lock) SPARK: PRIVATE STANDARD';
    statusBarItem.tooltip = `Standard Private Mode Active\nModel: ${model}\n$1.25/M input, $4.25/M output\n🔒 Your data NOT used for training\nClick to toggle to Contributor mode`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = undefined;
  }
  statusBarItem.command = 'museSpark.togglePricingMode';
  statusBarItem.show();

  if (chatProvider) {
    chatProvider.updatePricingMode(useContributor, model);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Init live cost + billing trackers (status bars)
  const costTracker = CostTracker.init(context);
  const billingTracker = BillingTracker.init(context);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('muse-spark', new MuseLanguageModelProvider(context.secrets)),
    vscode.commands.registerCommand('museSpark.manageLanguageModelProvider', () => configureMuseLanguageModel(context.secrets))
  );

  const client = new SparkClient();
  chatProvider = new ChatViewProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Pricing mode status bar (left side)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Forward cost + live billing updates to chat webview
  context.subscriptions.push(
    costTracker.onDidUpdate(totals => {
      chatProvider.updateCostTotals(totals, costTracker.getLastRecord());
    }),
    billingTracker.onDidUpdate(info => {
      chatProvider.updateBillingInfo(info);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('museSpark')) {
        updateStatusBar();
        if (e.affectsConfiguration('museSpark.planMode')) {
          chatProvider?.updatePlanMode(resolvePlanMode());
        }
        if (e.affectsConfiguration('museSpark.billingAutoRefresh') || e.affectsConfiguration('museSpark.billingRefreshIntervalMinutes') || e.affectsConfiguration('museSpark.showBillingStatus') || e.affectsConfiguration('museSpark.billingEndpoint') || e.affectsConfiguration('museSpark.apiKey') || e.affectsConfiguration('museSpark.apiEndpoint')) {
          billingTracker.restartPolling();
          void billingTracker.refreshNow();
          // push latest to webview too
          const info = billingTracker.getLastInfo();
          if (info) chatProvider.updateBillingInfo(info);
        }
      }
    })
  );

  // Codex-style agent commands — Codex parity
  context.subscriptions.push(
    vscode.commands.registerCommand('museSpark.stopAgent', () => chatProvider.stopAgent()),
    vscode.commands.registerCommand('museSpark.newSession', () => chatProvider.newSession()),
    vscode.commands.registerCommand('museSpark.forkSession', () => chatProvider.forkSession()),
    vscode.commands.registerCommand('museSpark.listSessions', async () => chatProvider.listSessions()),
    vscode.commands.registerCommand('museSpark.sessionStats', async () => {
      const s = chatProvider.getSessionStats();
      if (!s) { vscode.window.showInformationMessage('No active session'); return; }
      const all = chatProvider.getAllSessionsStats();
      const totalMsgs = all.reduce((a, b) => a + b.total, 0);
      const totalTokens = all.reduce((a, b) => a + b.tokens, 0);
      const lines = [
        `# Spark Session Stats — Codex style`,
        ``,
        `**Active: ${s.title} (${s.id.slice(0, 8)})** — ${s.stats.total} msgs (${s.stats.user} user / ${s.stats.assistant} assistant) • ~${s.stats.tokens} tokens • ${s.stats.images} images`,
        s.createdAt ? `Created ${new Date(s.createdAt).toLocaleString()}${s.updatedAt ? ` • Updated ${new Date(s.updatedAt).toLocaleString()}` : ''}` : '',
        `Model: ${s.model}`,
        ``,
        `**All sessions: ${all.length} • ${totalMsgs} msgs • ~${totalTokens} tokens**`,
        ``,
        ...all.slice(0, 20).map(e => `- \`${e.session.id.slice(0,8)}\` **${e.session.title}** — ${e.total} msgs • ~${e.tokens} tok • ${new Date(e.session.updatedAt || e.session.createdAt).toLocaleDateString()} • _${e.preview.slice(0, 80)}_`),
      ];
      if (all.length > 20) lines.push(`_…and ${all.length - 20} more_`);
      // Also render in chat
      (chatProvider as any).showStatsInChat?.();
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),
    vscode.commands.registerCommand('museSpark.deleteSession', async () => {
      const all = chatProvider.getAllSessionsStats();
      if (!all.length) { vscode.window.showInformationMessage('No sessions to delete'); return; }
      const pick = await vscode.window.showQuickPick(all.map(e => ({ label: e.session.title, description: `${e.total} msgs • ${e.session.id.slice(0,8)}`, detail: e.preview.slice(0,80), id: e.session.id })), { title: 'Delete Spark Session' });
      if (!pick) return;
      const ok = await vscode.window.showWarningMessage(`Delete "${(pick as any).label}"?`, { modal: true }, 'Delete');
      if (ok === 'Delete') await chatProvider.deleteSession((pick as any).id);
    }),
    vscode.commands.registerCommand('museSpark.renameSession', async () => {
      const all = chatProvider.getAllSessionsStats();
      if (!all.length) { vscode.window.showInformationMessage('No sessions'); return; }
      const pick = await vscode.window.showQuickPick(all.map(e => ({ label: e.session.title, description: e.session.id.slice(0,8), id: e.session.id })), { title: 'Rename Spark Session' });
      if (!pick) return;
      const title = await vscode.window.showInputBox({ prompt: 'New title', value: (pick as any).label });
      if (title) await chatProvider.renameSession((pick as any).id, title);
    }),
    vscode.commands.registerCommand('museSpark.exportSession', async () => {
      const all = chatProvider.getAllSessionsStats();
      if (!all.length) { vscode.window.showInformationMessage('No sessions'); return; }
      const pick = await vscode.window.showQuickPick(all.map(e => ({ label: e.session.title, description: e.session.id.slice(0,8), id: e.session.id })), { title: 'Export Spark Session' });
      if (!pick) return;
      await chatProvider.exportSession((pick as any).id);
    }),
    vscode.commands.registerCommand('museSpark.showDiff', async () => {
      // Parity: show git diff for files touched in this session first, fallback to SCM view
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { await vscode.commands.executeCommand('workbench.view.scm'); return; }
      try {
        const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
        const repo = git?.getRepository(folder.uri);
        if (repo) {
          const changes: any[] = [...repo.state.workingTreeChanges, ...repo.state.indexChanges];
          if (changes.length) {
            const first = changes[0];
            const uri = first.uri || first.originalUri;
            if (uri) {
              await vscode.commands.executeCommand('vscode.diff', first.originalUri || uri, uri, `Spark diff: ${vscode.workspace.asRelativePath(uri)}`);
              return;
            }
          }
        }
      } catch {}
      await vscode.commands.executeCommand('workbench.view.scm');
      vscode.window.showInformationMessage('Review changes in Source Control. Diff preview is also shown inline in Spark chat.');
    }),
    vscode.commands.registerCommand('museSpark.acceptEdits', async () => {
      try {
        const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
        const repo = git?.getRepository(vscode.workspace.workspaceFolders?.[0]?.uri);
        if (repo && repo.state.workingTreeChanges.length) {
          // Stage all working tree changes — Codex "accept" parity (not auto-commit)
          await vscode.commands.executeCommand('workbench.view.scm');
          vscode.window.showInformationMessage(`Accepted ${repo.state.workingTreeChanges.length} file(s) — review staged changes in Source Control.`);
          return;
        }
      } catch {}
      vscode.window.showInformationMessage('Edits are live in workspace — review via Source Control.');
    }),
    vscode.commands.registerCommand('museSpark.undoEdits', async () => {
      const confirm = await vscode.window.showWarningMessage('Undo all uncommitted Spark edits in this workspace?', { modal: true }, 'Undo');
      if (confirm !== 'Undo') return;
      try {
        const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
        const repo = git?.getRepository(vscode.workspace.workspaceFolders?.[0]?.uri);
        if (repo) { await repo.clean(repo.state.workingTreeChanges.map((c: any) => c.uri)); vscode.window.showInformationMessage('Reverted working tree changes.'); return; }
      } catch {}
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }),
    vscode.commands.registerCommand('museSpark.setApprovalMode', async () => {
      const pick = await vscode.window.showQuickPick([
        { label: 'Read-Only', description: 'Suggest only — no writes or terminal without approval', value: 'readOnly' },
        { label: 'Auto', description: 'Auto-approve workspace edits, prompt for risky commands', value: 'auto' },
        { label: 'Full Access', description: 'Yolo — no approvals, sandbox disabled', value: 'fullAccess' },
      ], { title: 'Muse Spark Approval Mode (Codex-style)' });
      if (!pick) return;
      await vscode.workspace.getConfiguration('museSpark').update('approvalMode', (pick as any).value, vscode.ConfigurationTarget.Global);
      // migrate legacy
      await vscode.workspace.getConfiguration('museSpark').update('cliFullAccess', (pick as any).value === 'fullAccess', vscode.ConfigurationTarget.Global);
      chatProvider.updatePricingMode(getPricingConfig().useContributor, getPricingConfig().model);
      vscode.window.showInformationMessage(`Approval mode: ${pick.label}`);
    }),
    vscode.commands.registerCommand('museSpark.togglePricingMode', async () => {
      const cfg = vscode.workspace.getConfiguration('museSpark');
      const current = cfg.get<boolean>('useContributorPricing') ?? true;
      const newVal = !current;
      await cfg.update('useContributorPricing', newVal, vscode.ConfigurationTarget.Global);

      let model = cfg.get<string>('model') || 'muse-spark-1.2-contributor';
      if (newVal && model === 'muse-spark-1.2') {
        await cfg.update('model', 'muse-spark-1.2-contributor', vscode.ConfigurationTarget.Global);
      } else if (!newVal && model === 'muse-spark-1.2-contributor') {
        await cfg.update('model', 'muse-spark-1.2', vscode.ConfigurationTarget.Global);
      }

      const modeName = newVal ? 'CONTRIBUTOR (cheap $0.10/M)' : 'PRIVATE STANDARD ($1.25/M)';
      const icon = newVal ? '$(flame)' : '$(lock)';
      vscode.window.showInformationMessage(`${icon} Switched to ${modeName} mode`, 'Open Settings').then(sel => {
        if (sel === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'museSpark');
        }
      });
    }),

    vscode.commands.registerCommand('museSpark.showCostTracker', async () => {
      const totals = costTracker.getSessionTotals();
      const history = costTracker.getHistory();
      // Show in webview + also as markdown preview
      chatProvider.reveal();
      // Also show quick pick with summary
      const summary = costTracker.getSummaryMarkdown();
      const doc = await vscode.workspace.openTextDocument({ content: summary, language: 'markdown' });
      vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),

    vscode.commands.registerCommand('museSpark.resetCostTracker', async () => {
      const confirm = await vscode.window.showWarningMessage('Reset Muse Spark cost tracker session? This clears totals and history.', { modal: true }, 'Reset');
      if (confirm === 'Reset') {
        await costTracker.resetSession();
        vscode.window.showInformationMessage('Muse Spark cost tracker reset.');
      }
    }),

    vscode.commands.registerCommand('museSpark.copyCostSummary', async () => {
      const summary = costTracker.getSummaryMarkdown();
      await vscode.env.clipboard.writeText(summary);
      vscode.window.showInformationMessage('Cost summary copied to clipboard.');
    }),

    vscode.commands.registerCommand('museSpark.refreshBilling', async () => {
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Muse Spark: refreshing live billing…' }, async () => {
        const info = await billingTracker.refreshNow();
        if (info?.error) vscode.window.showWarningMessage(`Billing refresh: ${info.error}`);
        else vscode.window.showInformationMessage(`Live unpaid: $${(info?.unpaid ?? 0).toFixed(4)} ${info?.currency ?? 'USD'}`);
      });
    }),

    vscode.commands.registerCommand('museSpark.showBillingDetails', async () => {
      chatProvider.reveal();
      // Also open markdown preview with full breakdown
      const summary = billingTracker.getSummaryMarkdown();
      const doc = await vscode.workspace.openTextDocument({ content: summary, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),

    vscode.commands.registerCommand('museSpark.copyBillingSummary', async () => {
      const summary = billingTracker.getSummaryMarkdown();
      await vscode.env.clipboard.writeText(summary);
      vscode.window.showInformationMessage('Billing summary copied to clipboard.');
    }),

    vscode.commands.registerCommand('museSpark.togglePlanMode', () => chatProvider.togglePlanMode()),
    vscode.commands.registerCommand('museSpark.approvePlan', () => chatProvider.approvePlan()),
    vscode.commands.registerCommand('museSpark.showPlan', () => chatProvider.showPlan()),

    vscode.commands.registerCommand('museSpark.startChat', () => {
      vscode.commands.executeCommand('museSpark.chatView.focus');
    }),

    vscode.commands.registerCommand('museSpark.explainCode', async () => {
      const sel = getSelection();
      if (!sel) return;
      const { code, lang } = sel;
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Muse Spark 1.2 explaining..." }, async () => {
        const explanation = await client.explainCode(code, lang);
        const doc = await vscode.workspace.openTextDocument({ content: explanation, language: 'markdown' });
        vscode.window.showTextDocument(doc);
      });
    }),

    vscode.commands.registerCommand('museSpark.refactorCode', async () => {
      await runTransform('Refactor this code', client.refactorCode.bind(client));
    }),

    vscode.commands.registerCommand('museSpark.fixCode', async () => {
      await runTransform('Fix bugs in this code', client.fixCode.bind(client));
    }),

    vscode.commands.registerCommand('museSpark.generateDocs', async () => {
      await runTransform('Add docs to this code', client.generateDocs.bind(client));
    }),

    vscode.commands.registerCommand('museSpark.generateCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const prompt = await vscode.window.showInputBox({ prompt: "Describe code to generate (from comment/selection)", placeHolder: "e.g. a fast LRU cache in TypeScript" });
      if (!prompt) return;
      const lang = editor.document.languageId;
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Muse Spark 1.2 generating..." }, async () => {
        const result = await client.chat([{ role: 'user', content: `Generate ${lang} code for: ${prompt}. Return ONLY code in a code block.` }], undefined, 'generate');
        const code = extractCodeBlock(result) || result;
        editor.edit(e => e.insert(editor.selection.active, code));
      });
    })
  );

  const inlineProvider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, context, token) {
      const enabled = vscode.workspace.getConfiguration('museSpark').get<boolean>('enableInlineCompletion');
      if (!enabled) return;
      if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && Math.random() > 0.5) return;
      const prefix = document.getText(new vscode.Range(new vscode.Position(0,0), position));
      if (prefix.length < 20) return;
      const line = document.lineAt(position).text.slice(0, position.character);
      if (!line.trim() && prefix.trim().length < 50) return;
      try {
        const prompt = `Complete this ${document.languageId} code. Only output the completion (no explanation), 1-3 lines max. Context:\n${prefix.slice(-2000)}`;
        const completion = await client.chat([{ role: 'user', content: prompt }], undefined, 'inline');
        const cleaned = extractCodeBlock(completion) || completion.split('\n').slice(0,3).join('\n');
        if (!cleaned.trim()) return;
        return [new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position))];
      } catch { return; }
    }
  };
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
  );

  const { useContributor } = getPricingConfig();
  const modeStr = useContributor ? 'CONTRIBUTOR $0.10/M (shared)' : 'PRIVATE STANDARD $1.25/M';
  const totals = costTracker.getSessionTotals();
  const costStr = totals.requestCount > 0 ? ` • Session: ${totals.totalTokens} tokens • $${totals.totalCost.toFixed(4)}` : '';
  vscode.window.showInformationMessage(`Muse Spark 1.2 active ✨ Mode: ${modeStr}${costStr} — Check status bar`);
}

function getSelection(): { code: string; lang: string; editor: vscode.TextEditor } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showErrorMessage("No active editor"); return; }
  const sel = editor.selection;
  const code = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  if (!code.trim()) { vscode.window.showErrorMessage("Select code first"); return; }
  return { code, lang: editor.document.languageId, editor };
}

async function runTransform(title: string, fn: (code: string, lang: string) => Promise<string>) {
  const sel = getSelection(); if (!sel) return;
  const { code, lang, editor } = sel;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Muse Spark 1.2: ${title}...` }, async () => {
    const result = await fn(code, lang);
    const newCode = extractCodeBlock(result) || result;
    const selection = editor.selection;
    await editor.edit(e => { e.replace(selection, newCode); });
  });
}

function extractCodeBlock(text: string): string | null {
  const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export function deactivate() {}
