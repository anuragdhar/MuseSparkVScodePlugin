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
exports.parsePatch = parsePatch;
exports.applyPatch = applyPatch;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
function parsePatch(patchText) {
    const text = patchText.replace(/\r\n/g, '\n');
    if (text.includes('*** Begin Patch'))
        return parseWrappedPatch(text);
    return parseSingleFilePatch(text);
}
function parseWrappedPatch(text) {
    const ops = [];
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();
        if (line.startsWith('*** Add File:')) {
            const filePath = line.slice('*** Add File:'.length).trim();
            i++;
            const contentLines = [];
            while (i < lines.length && !lines[i].startsWith('***')) {
                contentLines.push(lines[i]);
                i++;
            }
            ops.push({ kind: 'add', filePath, content: contentLines.join('\n') });
        }
        else if (line.startsWith('*** Update File:')) {
            const filePath = line.slice('*** Update File:'.length).trim();
            i++;
            const hunkLines = [];
            while (i < lines.length && !lines[i].startsWith('***')) {
                hunkLines.push(lines[i]);
                i++;
            }
            ops.push({ kind: 'update', filePath, hunks: hunkLines.join('\n') });
        }
        else if (line.startsWith('*** Delete File:')) {
            const filePath = line.slice('*** Delete File:'.length).trim();
            ops.push({ kind: 'delete', filePath });
            i++;
        }
        else if (line === '*** Begin Patch' || line === '*** End Patch' || line === '') {
            i++;
        }
        else {
            i++;
        }
    }
    return ops;
}
function parseSingleFilePatch(text) {
    // Heuristic: treat as single update to first file mentioned after ---/+++
    const m = text.match(/^\+\+\+\s+([^\n]+)/m);
    const filePath = m ? m[1].replace(/^b\//, '').trim() : 'patch.diff';
    return [{ kind: 'update', filePath, hunks: text }];
}
async function applyPatch(patchText, resolve, getFileContent) {
    const ops = parsePatch(patchText);
    if (!ops.length)
        throw new Error('No operations found in patch. Expected *** Begin Patch ... *** End Patch.');
    const results = [];
    for (const op of ops) {
        const uri = resolve(op.filePath);
        if (op.kind === 'add') {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
            try {
                await vscode.workspace.fs.stat(uri);
                throw new Error(`File already exists: ${op.filePath}. Use Update instead.`);
            }
            catch (e) {
                if (e.code !== 'FileNotFound' && !String(e.message).includes('already exists')) {
                    // if not FileNotFound, rethrow existence error already thrown
                    if (String(e.message).includes('already exists'))
                        throw e;
                }
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(op.content || '', 'utf8'));
            results.push(`Added ${op.filePath} (${Buffer.byteLength(op.content || '', 'utf8')} bytes)`);
        }
        else if (op.kind === 'delete') {
            await vscode.workspace.fs.delete(uri, { useTrash: false });
            results.push(`Deleted ${op.filePath}`);
        }
        else if (op.kind === 'update') {
            const original = getFileContent ? await getFileContent(uri) : undefined;
            let text;
            if (original !== undefined)
                text = original;
            else {
                try {
                    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                }
                catch {
                    throw new Error(`File not found for update: ${op.filePath}`);
                }
            }
            const patched = applyHunks(text, op.hunks || '');
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
            await vscode.workspace.fs.writeFile(uri, Buffer.from(patched, 'utf8'));
            results.push(`Updated ${op.filePath}`);
        }
    }
    return results.join('\n');
}
/**
 * Robust hunk applier: Codex-compatible unified diff.
 * - Handles @@ -a,b +c,d @@ with context lines
 * - Validates context, falls back to fuzzy matching when line numbers drift
 * - Respects ---/+++ headers and \ No newline at end of file
 */
function applyHunks(original, hunks) {
    if (!hunks.trim())
        return original;
    const hasDiffMarkers = hunks.split('\n').some(l => l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('+') || l.startsWith('-'));
    if (!hasDiffMarkers)
        return hunks;
    const origLines = original.split('\n');
    // Normalize: keep trailing empty from split(\n) if original ends with \n
    const outLines = [];
    const hunkLines = hunks.split('\n');
    let origIdx = 0;
    const hunksParsed = [];
    let cur = null;
    for (const line of hunkLines) {
        if (line.startsWith('@@')) {
            const m = /@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/.exec(line);
            if (m) {
                if (cur)
                    hunksParsed.push(cur);
                cur = { oldStart: Math.max(0, parseInt(m[1], 10) - 1), oldCount: m[2] ? parseInt(m[2], 10) : 1, lines: [] };
            }
        }
        else if (line.startsWith('---') || line.startsWith('+++')) {
            continue;
        }
        else if (cur) {
            cur.lines.push(line);
        }
        else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
            // hunk without @@ header — treat as single hunk at current position
            if (!cur)
                cur = { oldStart: origIdx, oldCount: 0, lines: [] };
            cur.lines.push(line);
        }
    }
    if (cur)
        hunksParsed.push(cur);
    if (!hunksParsed.length)
        return original;
    for (const hunk of hunksParsed) {
        // Advance to hunk start, with fuzzy search if context mismatches
        let target = hunk.oldStart;
        if (target < origIdx)
            target = origIdx;
        // Build expected context signature: first 2 context/removed lines
        const signature = hunk.lines.filter(l => l.startsWith(' ') || l.startsWith('-')).map(l => l.slice(1)).slice(0, 2).filter(Boolean);
        if (signature.length && target < origLines.length) {
            // If next lines don't match signature, search forward up to 8 lines for anchor
            let matched = signature.every((sig, idx) => origLines[target + idx] === sig);
            if (!matched) {
                let found = -1;
                for (let drift = 1; drift <= 8 && target + drift < origLines.length; drift++) {
                    if (signature.every((sig, idx) => origLines[target + drift + idx] === sig)) {
                        found = target + drift;
                        break;
                    }
                }
                if (found !== -1)
                    target = found;
            }
        }
        while (origIdx < target && origIdx < origLines.length) {
            outLines.push(origLines[origIdx]);
            origIdx++;
        }
        for (const line of hunk.lines) {
            if (line.startsWith('+') && !line.startsWith('++')) {
                outLines.push(line.slice(1));
            }
            else if (line.startsWith('-') && !line.startsWith('--')) {
                // Validate removed line matches original for safety; skip if drifted but still advance
                const expected = line.slice(1);
                if (origLines[origIdx] !== undefined && origLines[origIdx] !== expected) {
                    // Fuzzy: search for expected nearby
                    let searchIdx = origIdx;
                    for (let k = 0; k < 4 && searchIdx < origLines.length; k++, searchIdx++) {
                        if (origLines[searchIdx] === expected) {
                            while (origIdx < searchIdx) {
                                outLines.push(origLines[origIdx]);
                                origIdx++;
                            }
                            break;
                        }
                    }
                }
                origIdx++;
            }
            else if (line.startsWith(' ') || line === '') {
                const expected = line.startsWith(' ') ? line.slice(1) : line;
                // Keep original line if it matches, else push expected
                if (origLines[origIdx] !== undefined) {
                    outLines.push(origLines[origIdx]);
                    origIdx++;
                }
                else
                    outLines.push(expected);
            }
            else if (line.startsWith('\\')) {
                // \ No newline at end of file — ignore
            }
        }
    }
    while (origIdx < origLines.length) {
        outLines.push(origLines[origIdx]);
        origIdx++;
    }
    return outLines.join('\n');
}
//# sourceMappingURL=patch.js.map