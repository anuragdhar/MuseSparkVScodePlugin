# Muse Spark 1.2 for VS Code

Muse Spark is a VS Code extension for coding with Meta's Muse Spark 1.2 models. It supports two complementary agent experiences:

- **Muse Code CLI sidebar** — runs the official Muse Code agent harness behind the extension's sidebar for repository inspection, file editing, terminal commands, verification, long-running tasks, and persistent sessions.
- **VS Code Agent Mode provider** — contributes Muse Spark models to VS Code Chat so they can use the tools supplied by VS Code/Copilot Agent Mode.

The extension also provides selection actions, inline completions, code generation, model/pricing controls, and live token and cost tracking.

## Requirements

- Windows with WSL and an Ubuntu distribution for the Muse Code CLI backend
- VS Code 1.134.0 or newer
- Node.js and npm when developing or packaging the extension
- Meta Model API access and a valid API key
- GitHub Copilot/VS Code Chat when using the Language Model provider in Agent Mode

## Feature overview

### Official Muse Code agent backend

The sidebar uses `muse exec --json` by default. The extension:

- Starts Muse Code inside the Ubuntu WSL distribution.
- Uses Muse's legacy shell tool for WSL1 compatibility, avoiding managed process-owner host failures.
- Limits workspace tools to the currently opened VS Code workspace.
- Streams Muse JSON events and assistant output into the sidebar.
- Lets Muse inspect and edit files, execute commands, and verify its changes.
- Keeps one Muse session ID for follow-up messages.
- Starts a new Muse session when chat is cleared.
- Supports configurable reasoning effort and maximum model steps.
- Can run with unrestricted `--yolo` access or with the Muse sandbox enabled.

Only the first open VS Code workspace folder is currently used. The workspace must be on a local Windows drive available to WSL under `/mnt/<drive>/...`.

### VS Code Agent Mode provider

The extension registers Muse Spark 1.2, Muse Spark 1.2 Contributor, and Muse Spark 1.2 Code in the VS Code Chat model picker.

The provider supports streamed text, VS Code tool definitions, tool calls, tool results, automatic tool selection, and required-tool mode. VS Code invokes Agent Mode tools and displays its own approval UI.

This route calls the Meta Model API directly; it does not run the Muse Code CLI harness. Use the sidebar when you specifically want Muse Code's agent runtime.

### Sidebar chat

- Includes the active editor or selection when **Include active editor context** is enabled.
- Shows tool activity and streaming responses.
- Hides internal model-call noise and translates Muse tool events into readable activity such as reading files, editing files, searching, running commands, and checking diagnostics.
- Provides an **Insert** button for fenced code blocks.
- Supports follow-up prompts and clearing the active session.
- Can switch between the CLI and basic direct-API agent backends.

### Editor actions and completions

Select code—or leave the selection empty to use the complete active document—and run:

- **Muse Spark: Explain Selection**
- **Muse Spark: Refactor Selection**
- **Muse Spark: Fix Issues in Selection**
- **Muse Spark: Generate Docs**

These are also available from the editor context menu. Refactor, fix, and documentation actions replace the current selection with generated code.

**Muse Spark: Generate Code from Comment** asks for a description and inserts generated code at the cursor. Inline completions provide short ghost-text suggestions based on text preceding the cursor; set `museSpark.enableInlineCompletion` to `false` to disable them.

## Install Muse Code

On Windows, install and initialize WSL with Ubuntu. If WSL2 is unavailable—for example, inside a VM without nested virtualization—Ubuntu can run under WSL1.

Inside Ubuntu, install and authenticate Muse Code:

```bash
curl -fsSL https://dev.meta.ai/install.sh | bash
source ~/.bashrc
muse --version
muse login
```

The default extension configuration expects Muse at `/root/.local/bin/muse` in a WSL distribution named `Ubuntu`. Change `museSpark.cliPath` if your executable is elsewhere.

## Configure the extension

### CLI sidebar setup

The sidebar defaults to the official CLI backend:

```json
{
  "museSpark.backend": "cli",
  "museSpark.cliPath": "/root/.local/bin/muse",
  "museSpark.cliFullAccess": true,
  "museSpark.cliReasoningEffort": "high",
  "museSpark.cliMaxSteps": 50,
  "museSpark.model": "muse-spark-1.2-contributor"
}
```

With `museSpark.cliFullAccess: true`, the extension passes `--yolo` to Muse Code. This skips confirmations and disables Muse's approvals and sandbox. Muse commands then run with the permissions of the WSL user and can modify the mounted Windows workspace.

Set `museSpark.cliFullAccess` to `false` to require a VS Code confirmation for each submitted task and retain sandboxed execution.

### Agent Mode setup

1. Run **Muse Spark: Configure Language Model Provider** from the Command Palette.
2. Select **Set API key** and enter the Meta Model API key. It is stored in VS Code Secret Storage.
3. Run **Developer: Reload Window** after installing or updating the extension.
4. Open VS Code Chat and choose **Agent** mode.
5. Select a Muse Spark model from the model picker.

The same configuration command can remove the securely stored key.

### Direct API setup

The sidebar's alternative `api` backend and editor commands read the API key from `museSpark.apiKey`, then `META_API_KEY`, then `MODEL_API_KEY`.

```json
{
  "museSpark.backend": "api",
  "museSpark.apiEndpoint": "https://api.meta.ai/v1/chat/completions",
  "museSpark.model": "muse-spark-1.2-contributor"
}
```

Without an API key, ordinary direct chat requests use demo/mock mode. The basic direct-API workspace agent requires a real API key.

## Full access and safety

Full access is enabled by default. In this mode Muse Code can run commands and change files without another approval prompt. To restore the safer mode:

```json
{
  "museSpark.cliFullAccess": false
}
```

The extension still scopes Muse's workspace argument to the first open workspace folder, but `--yolo` disables the CLI sandbox. Review generated changes and use source control for important projects.

## Token usage and cost tracking

The right side of the VS Code status bar displays Muse Spark usage and cost.

For Muse Code CLI tasks:

- While a task runs, the status bar shows a live token and cost estimate.
- After completion, the extension reads exact provider usage from the Muse session log.
- Usage from all recorded model steps in the run is totaled.
- Exact totals replace the live estimate in the persistent session tracker.
- If exact log data cannot be read, the request is recorded as estimated.

For direct API calls, returned API usage is used when available; otherwise the extension estimates approximately four characters per token.

Cost commands:

- **Muse Spark: Show Cost Tracker** — session totals, latest request, pricing, and recent history.
- **Muse Spark: Copy Cost Summary to Clipboard** — copies the Markdown summary.
- **Muse Spark: Reset Cost Tracker** — clears persisted totals and history.

The tracker currently calculates using these configured rates:

| Mode | Input / 1M | Output / 1M | Cache read / 1M |
| --- | ---: | ---: | ---: |
| Contributor | $0.10 | $0.20 | $0.002 |
| Standard/private | $1.25 | $4.25 | $0.15 |

Contributor mode may allow data to be used for training. Confirm current pricing and data terms with Meta before using these estimates for billing reconciliation.

## Pricing and model switching

Use **Muse Spark: Toggle Contributor / Standard Mode** or click the left-side Spark status item.

- Contributor mode selects `muse-spark-1.2-contributor` when switching from standard.
- Standard mode selects `muse-spark-1.2` when switching from contributor.
- The selected model is used by the CLI backend, direct API features, and inline completions.

## Commands

| Command | Function |
| --- | --- |
| Muse Spark: Configure Language Model Provider | Securely set or remove the Agent Mode API key |
| Muse Spark: Open Chat | Focus the Muse Spark sidebar |
| Muse Spark: Explain Selection | Explain selected code or the active document |
| Muse Spark: Refactor Selection | Generate and apply refactored code |
| Muse Spark: Fix Issues in Selection | Generate and apply a bug fix |
| Muse Spark: Generate Docs | Add generated documentation to code |
| Muse Spark: Generate Code from Comment | Insert code generated from a description |
| Muse Spark: Toggle Contributor / Standard Mode | Switch pricing/model mode |
| Muse Spark: Show Cost Tracker | Open the usage and cost report |
| Muse Spark: Reset Cost Tracker | Clear the current usage session |
| Muse Spark: Copy Cost Summary to Clipboard | Copy the usage report |

## Settings reference

| Setting | Default | Description |
| --- | --- | --- |
| `museSpark.backend` | `cli` | Sidebar backend: official Muse CLI or basic direct API agent |
| `museSpark.cliPath` | `/root/.local/bin/muse` | Muse executable inside Ubuntu WSL |
| `museSpark.cliFullAccess` | `true` | Run Muse with `--yolo`, without approvals or sandbox |
| `museSpark.cliReasoningEffort` | `high` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `ultra` |
| `museSpark.cliMaxSteps` | `50` | Maximum model steps per CLI task, from 1 to 500 |
| `museSpark.apiKey` | empty | API key for direct API features; stored as a plain VS Code setting |
| `museSpark.apiEndpoint` | Meta chat-completions endpoint | OpenAI-compatible API endpoint |
| `museSpark.model` | `muse-spark-1.2-contributor` | Active model ID |
| `museSpark.useContributorPricing` | `true` | Contributor versus private/standard pricing mode |
| `museSpark.showTokenCost` | `true` | Show token and cost information |
| `museSpark.enableInlineCompletion` | `true` | Enable ghost-text completions |
| `museSpark.systemPrompt` | Agent prompt | Instructions for direct API chat/agent requests |

Configured model IDs: `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.2-instruct`, and `muse-spark-1.2-code`.

## API compatibility

The direct API client expects an OpenAI-compatible chat-completions endpoint with streaming and tool calling:

```json
{
  "model": "muse-spark-1.2",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "tools": [],
  "tool_choice": "auto",
  "stream": true
}
```

Set `museSpark.apiEndpoint` when using another compatible deployment.

## Troubleshooting

### Muse command not found

```powershell
wsl -d Ubuntu -- /root/.local/bin/muse --version
```

Update `museSpark.cliPath` if Muse was installed for another Linux user.

### WSL2 fails inside a VM

WSL2 requires virtualization or nested virtualization. Switch to WSL1 before registering Ubuntu when nested virtualization is unavailable:

```powershell
wsl --set-default-version 1
```

The extension passes `--enable-shell-tool` because Muse's managed process-owner shell can fail under WSL1 with `HostUnavailable ... UnexpectedMessage`.

### Muse models do not appear in Agent Mode

- Confirm VS Code is version 1.134.0 or newer.
- Run **Muse Spark: Configure Language Model Provider**.
- Reload the VS Code window.
- Open **Chat: Manage Language Models** and confirm Muse Spark is enabled.
- A Copilot organization administrator may disable bring-your-own-key providers.

### CLI requests fail but Agent Mode works

These paths authenticate separately. Run `muse login` inside Ubuntu for the CLI. Agent Mode uses the key stored by **Muse Spark: Configure Language Model Provider**.

### Agent Mode works but editor commands fail

Configure `museSpark.apiKey` or set `META_API_KEY`. Secret Storage used by Agent Mode is separate from the direct API setting.

### Cost is marked estimated

The extension could not find exact usage for the completed request. Ensure Muse session logging remains enabled and the CLI runs as the expected WSL user.

## Development

```powershell
npm install
npm run compile
```

Press `F5` to open an Extension Development Host. For continuous compilation, use `npm run watch`. Run tests with:

```powershell
node --test test\*.test.js
```

## Package and install

```powershell
npx @vscode/vsce package --allow-missing-repository
code --install-extension muse-spark-vscode-0.4.0.vsix --force
```

Run **Developer: Reload Window** after reinstalling the VSIX.

## Current limitations

- The CLI integration is Windows/WSL-specific and expects a distribution named `Ubuntu`.
- Only the first open workspace folder is passed to Muse Code.
- Live CLI token counts are estimated until the run completes.
- The Language Model Provider API cannot populate Copilot Chat's native token display; usage appears in this extension's status bar and tracker.
- Image input is not exposed through the Agent Mode provider.
- CLI and Agent Mode authentication are separate.
