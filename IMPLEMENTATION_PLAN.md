# Muse Spark P0 Agent Capability Implementation Plan

## Goal

Bring the Muse Spark VS Code extension closer to Codex/Claude Code for autonomous coding tasks by adding managed terminal processes, reliable incremental edits, image understanding, web tools, and workspace-aware session resume.

The extension currently has two backends:

- **Direct API agent** (`src/agent.ts`): the extension owns the agent loop and tool execution. All new tools can be implemented here.
- **Muse CLI** (`src/museCliClient.ts`): the Muse binary owns its internal agent loop. The extension can persist/resume its session ID and workdir immediately, but new extension-defined tools require a CLI-supported tool/MCP bridge. CLI capability discovery is therefore an explicit first step rather than assuming unsupported flags.

## Delivery order

### Phase 0 — Baseline and contracts

1. Capture the current behavior with focused tests before changing the tool layer.
2. Define shared result types for tool text, image content, terminal events, and background process state.
3. Add configurable limits with safe defaults:
   - foreground timeout: 120 seconds
   - background process retention: 30 minutes after exit
   - buffered output per process: 1 MiB, retaining the newest output
   - maximum local image size: 10 MiB
   - maximum fetched web response: 1 MiB before text extraction
4. Verify whether the installed Muse CLI exposes MCP/custom-tool support. If it does, route the same tool contracts through a local bridge. If it does not, document that these tools belong to the direct API backend while retaining CLI-native tool behavior.

**Acceptance criteria**

- Existing chat/session tests pass unchanged.
- Tool schemas and limits are centralized and testable.
- No new approval prompt is introduced; the existing full-access policy remains authoritative.

### Phase 1 — Managed shell with streaming, background, and kill

Replace the one-shot `exec` implementation in `src/agent.ts` with a process manager built on `child_process.spawn`.

1. Extend `run_terminal_command` arguments:
   - `command`: shell command
   - `workdir`: optional workspace-relative working directory
   - `timeoutSeconds`: foreground/background timeout, with `0` meaning no automatic timeout for background jobs
   - `background`: return immediately with a process ID
2. Add `get_terminal_output`:
   - accepts process ID, optional cursor, wait duration, and output limit
   - returns incremental stdout/stderr, exit code, running state, and next cursor
   - supports polling without replaying previously consumed output
3. Add `kill_terminal`:
   - validates the managed process ID
   - terminates the process tree on Windows and Unix
   - reports the final state and buffered output
4. Stream foreground stdout/stderr into agent events while still collecting a bounded final tool result.
5. Track all child processes in a `TerminalProcessManager`; terminate active foreground work when Stop is clicked and dispose all managed processes when the extension deactivates.
6. Resolve `workdir` through the existing workspace boundary check so relative paths cannot escape the opened workspace. The default remains the workspace root.
7. Keep the approval policy in the tool contract, but resolve it to `fullAccess` under the current plugin configuration so repeated confirmation prompts do not appear.

**Files**

- Add `src/terminalProcessManager.ts`
- Update `src/agent.ts`
- Update `src/chatPanel.ts` to render concise streamed terminal output/status
- Update `src/extension.ts` to dispose process resources
- Add `test/terminalProcessManager.test.js`

**Acceptance criteria**

- A foreground command emits output before it exits.
- A background command returns a stable ID immediately.
- Output can be fetched incrementally and is bounded in memory.
- Kill stops the full process tree and a second kill is harmless.
- Invalid/out-of-workspace `workdir` is rejected.
- Stop Agent cancels the current command.

### Phase 2 — Fuzzy, atomic multi-hunk file updates

The existing `apply_patch` already accepts multiple file operations and fuzzy unified hunks. Strengthen it and replace the single exact-match limitation of `replace_in_file`.

1. Introduce an `update_file` tool with:
   - workspace-relative `path`
   - ordered `replacements[]`, each containing `oldText`, `newText`, and optional occurrence/context hints
   - optional expected file hash/version for stale-edit protection
2. Keep `replace_in_file` as a backward-compatible alias accepting either one replacement or `replacements[]`.
3. Apply all replacements in memory first, then write once only if every hunk succeeds. A failed hunk must leave the file unchanged.
4. Matching order:
   - exact unique match
   - line-ending-normalized exact match
   - indentation/whitespace-tolerant match with contextual anchors
   - fail with candidate locations when ambiguous
5. Harden `src/patch.ts`:
   - validate every context/removal line instead of silently advancing on mismatch
   - stage all multi-file results before any writes
   - roll back if a filesystem write fails
   - preserve the original newline style and final newline
6. Deprecate model use of full-file `write_file` for existing files; allow it only for new files or require an explicit overwrite flag.

**Files**

- Add `src/fileUpdate.ts`
- Update `src/agent.ts`
- Update `src/patch.ts`
- Add `test/fileUpdate.test.js`
- Add `test/patch.test.js`

**Acceptance criteria**

- Multiple replacements in a large file produce one atomic write.
- Shifted line numbers and harmless indentation drift still patch correctly.
- Ambiguous or stale edits fail without modifying any file.
- Multi-file `apply_patch` is all-or-nothing.
- CRLF/LF and final-newline behavior are preserved.

### Phase 3 — Image reading and vision input

Add a first-class `image_read` tool whose result is sent back to the model as multimodal content rather than a large base64 text blob.

1. Accept local PNG, JPEG, WebP, GIF, and SVG paths inside the workspace.
2. Validate type from file content where practical, enforce the size limit, and return metadata plus an `image_url` data part compatible with `SparkClient`.
3. Update the agent tool-result/message types so a tool result can contain both text and image parts.
4. Reuse the chat panel’s existing image attachment path and normalization code to avoid two incompatible image formats.
5. For Figma:
   - read exported screenshots/assets directly
   - accept a Figma URL only when an authenticated Figma integration or REST token is configured
   - otherwise return a useful instruction to export/attach the relevant frame; do not pretend a webpage thumbnail is full design context
6. Render a compact “Read image: path (dimensions/type)” activity in chat without dumping encoded data.

**Files**

- Add `src/imageReader.ts`
- Update `src/agent.ts`
- Update shared chat content types in `src/sparkClient.ts`
- Update `src/chatPanel.ts`
- Add `test/imageReader.test.js`

**Acceptance criteria**

- The model can inspect a workspace screenshot and reason about visible content.
- Unsupported, oversized, corrupt, and out-of-workspace images fail clearly.
- Base64 image data never appears in the visible transcript or logs.
- Existing user-attached images continue to work.

### Phase 4 — Web search and browser-style page reading

Add focused research tools to the direct agent while keeping network access observable and bounded.

1. Add `web_search` with query, result count, and optional domain/recency filters.
2. Add `fetch_url` (browser/read-page equivalent) with URL and optional character limit.
3. Prefer a documented search provider API configured through VS Code settings. Provide a no-key fallback only if its terms and response format are suitable; return a clear configuration error otherwise.
4. For fetched pages:
   - allow only HTTP/HTTPS
   - block localhost, link-local, private-network, and cloud metadata targets to prevent SSRF
   - enforce redirects, timeout, byte, and text limits
   - extract title, canonical URL, readable text, and links
   - identify PDFs and return metadata/instructions until PDF extraction is separately supported
5. Include source URL and retrieval time in every result so the model can cite evidence.
6. Add settings for provider, API key (stored with `SecretStorage`), timeout, and enable/disable switch.

**Files**

- Add `src/webTools.ts`
- Update `src/agent.ts`
- Update `src/extension.ts` with secure configuration commands if a provider key is needed
- Update `package.json` settings/commands
- Add `test/webTools.test.js`

**Acceptance criteria**

- Search returns structured titles, snippets, and canonical URLs.
- Page reading produces bounded readable text, not raw HTML.
- Private/local network URLs and redirect attempts are rejected.
- Timeout, provider, and HTTP errors are concise and actionable.

### Phase 5 — Workspace-aware session resume (`resume --last` parity)

The plugin already persists session IDs and transcripts. Extend the record so “last” is deterministic for the current workspace and backend.

1. Extend `AgentSession` with backward-compatible optional fields:
   - `workspaceUri`
   - `backend` (`cli` or `api`)
   - `cliThreadId` when it differs from the extension session ID
   - `lastWorkdir`
   - schema version
2. Persist these fields when creating, updating, and forking sessions.
3. Add `SessionStore.getLastResumableSession(workspaceUri, backend)` sorted by `updatedAt`, with migration behavior for old records lacking workspace metadata.
4. Add `ChatViewProvider.resumeLastSession()`:
   - stop/cancel current work
   - restore transcript and UI state
   - restore the persisted Muse CLI thread ID
   - resume with the stored workdir after verifying it still belongs to the open workspace
   - re-enable and focus the composer
5. Expose it through:
   - command palette: `Muse Spark: Resume Last Session`
   - Sessions UI button
   - slash commands `/resume --last` and `/resume <id-or-title>`
6. If the last session belongs to another workspace/backend, show the exact reason and offer the filtered session browser instead of silently opening the wrong thread.

**Files**

- Update `src/sessionStore.ts`
- Update `src/chatPanel.ts`
- Update `src/museCliClient.ts`
- Update `src/extension.ts`
- Update `package.json`
- Add `test/sessionStore.test.js`
- Extend `test/chatPanel.send.test.js`

**Acceptance criteria**

- Reloading VS Code and choosing Resume Last restores the newest session for the current workspace/backend.
- The Muse CLI receives the same persisted thread ID and the validated workdir.
- Old stored sessions remain listable and can be migrated on first resume.
- Starting a new chat never leaves the Send button disabled.

### Phase 6 — Agent-loop reliability and user experience

1. Update the system prompt to teach the model when to use background jobs, poll output, kill processes, patch incrementally, inspect images, and search the web.
2. Replace repetitive generic activity lines with meaningful summaries:
   - command, workdir, PID, running/exited state
   - file and hunk count
   - image metadata
   - search query/result count and fetched domain
3. Add loop safeguards:
   - detect repeated identical tool calls with unchanged results
   - cap consecutive polling calls with no output
   - preserve partial terminal output on cancellation/error
   - require a final diagnostics/test pass after edits when `autoVerify` is enabled
4. Persist in-flight background process metadata only for display; do not claim processes survive extension-host or VM restart.
5. Update README feature documentation, settings, security boundaries, and examples.

**Files**

- Update `src/agent.ts`
- Update `src/chatPanel.ts`
- Update `README.md`
- Add/extend agent-loop tests

**Acceptance criteria**

- Tool activity is specific enough to diagnose what the agent is doing.
- The loop stops cleanly on repeated/no-progress behavior.
- Completion reports changed files, verification performed, and any still-running background processes.

## Test and release checklist

1. Run `npm run compile` and `npx tsc --noEmit`.
2. Run all Node tests, including new terminal, patch, image, web, and session suites.
3. Test on Windows extension host with the repository opened from `C:\code\...`.
4. Test Muse CLI execution inside Ubuntu WSL, including a path containing spaces.
5. Manual scenarios:
   - stream a long-running foreground build
   - start, poll, and kill a background dev server
   - make a multi-hunk edit to a large CRLF file
   - inspect an attached error screenshot
   - search documentation and fetch a result
   - reload VS Code and run Resume Last
   - switch workspaces and confirm sessions do not cross-resume
6. Package a VSIX and install it into the VM’s VS Code instance.
7. Bump the extension version only after all acceptance criteria pass.

## Recommended implementation slices

Keep commits reviewable and independently testable:

1. `feat(agent): add managed streaming terminal processes`
2. `feat(agent): add atomic fuzzy multi-replacement edits`
3. `feat(agent): add multimodal image_read tool`
4. `feat(agent): add bounded web search and page fetch tools`
5. `feat(sessions): add workspace-aware resume last`
6. `test/docs: harden agent loop and document P0 capabilities`

## Definition of done

This P0 work is complete when the direct API backend can autonomously run and manage long-lived commands, edit large files incrementally and atomically, inspect local images, research public web sources, and resume the latest workspace thread after reload. The CLI backend must reliably restore its thread ID/workdir; extension-defined tool parity must either work through a verified Muse CLI bridge or be explicitly documented as a direct-backend capability.
