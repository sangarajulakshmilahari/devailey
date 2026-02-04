import * as vscode from 'vscode';
import * as path from 'path';

export type CodeEditOp = 'modify' | 'create' | 'delete';

export interface CodeEdit {
  op?: CodeEditOp;

  // Prefer workspace-relative paths like "templates/alerts.html"
  // Absolute paths still supported.
  filePath: string;

  // For modify (0-indexed, inclusive)
  startLine?: number;
  endLine?: number;

  // Optional but useful for validation
  oldText?: string;

  // For modify/create
  newText?: string;
}

/**
 * VS Code Editor utilities for previewing and applying edits.
 *
 * Key behaviors:
 * - filePath can be workspace-relative OR absolute.
 * - "create" previews diff vs empty; apply writes file + opens it.
 * - "modify" previews diff against original; apply replaces range (inclusive lines).
 * - "delete" previews diff vs empty; apply deletes file (to trash).
 */
export class CodeEditor {
  private static diffProvider: DiffContentProvider | null = null;

  /**
   * Register the diff content provider (call this in extension activation)
   */
  public static registerDiffProvider(context: vscode.ExtensionContext) {
    if (!CodeEditor.diffProvider) {
      CodeEditor.diffProvider = new DiffContentProvider();
      context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('devalley-diff', CodeEditor.diffProvider)
      );
      console.log('[DevAlley] Diff content provider registered');
    }
  }
  private static normalizeText(s: string): string {
    // normalize CRLF -> LF and remove trailing whitespace differences
    return (s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')  // trim end-of-line spaces
      .trimEnd();                // avoid "one extra newline" mismatches
  }

  private static findTextRangeFlexible(
    document: vscode.TextDocument,
    needleRaw: string
  ): vscode.Range | null {
    if (!needleRaw) return null;

    const fullRaw = document.getText();

    const full = CodeEditor.normalizeText(fullRaw);
    const needle = CodeEditor.normalizeText(needleRaw);

    // 1) exact normalized match
    let idx = full.indexOf(needle);
    if (idx >= 0) {
      const start = document.positionAt(CodeEditor.mapNormalizedIndexToRaw(fullRaw, idx));
      const end = document.positionAt(
        CodeEditor.mapNormalizedIndexToRaw(fullRaw, idx + needle.length)
      );
      return new vscode.Range(start, end);
    }

    // 2) try without final newline (common)
    const needleNoLastNewline = needle.replace(/\n$/, '');
    idx = full.indexOf(needleNoLastNewline);
    if (idx >= 0) {
      const start = document.positionAt(CodeEditor.mapNormalizedIndexToRaw(fullRaw, idx));
      const end = document.positionAt(
        CodeEditor.mapNormalizedIndexToRaw(fullRaw, idx + needleNoLastNewline.length)
      );
      return new vscode.Range(start, end);
    }

    return null;
  }

  /**
   * Because we search on normalized text but need positions in the raw document,
   * we map by rebuilding a normalized version while tracking raw indices.
   * (Good enough + fast for typical file sizes.)
   */
  private static mapNormalizedIndexToRaw(raw: string, normalizedIndex: number): number {
    let n = 0;
    for (let i = 0; i < raw.length; i++) {
      // treat CRLF as LF
      if (raw[i] === '\r' && raw[i + 1] === '\n') {
        if (n === normalizedIndex) return i;
        n += 1;
        i += 1;
        continue;
      }
      if (n === normalizedIndex) return i;
      n += 1;
    }
    return raw.length;
  }

  /**
   * Resolve user-provided filePath:
   * - absolute -> keep
   * - relative -> resolve against workspace root
   */
  private static resolveToAbsoluteFsPath(inputPath: string): string {
    const pRaw = (inputPath || '').trim();
    if (!pRaw) throw new Error('Empty filePath');

    // Normalize slashes for checks (don’t destroy original)
    const p = pRaw.replace(/\//g, '\\');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error(`Cannot resolve "${pRaw}" because no workspace folder is open.`);
    }

    // Windows drive absolute: C:\...
    const hasDrive = /^[a-zA-Z]:\\/.test(p);

    // UNC absolute: \\server\share\...
    const isUNC = /^\\\\[^\\]+\\[^\\]+/.test(p);

    // Rooted-but-not-drive path: \app.py (THIS is your problem)
    const isRootedNoDrive = p.startsWith('\\') && !hasDrive && !isUNC;

    if (path.isAbsolute(p) && !isRootedNoDrive) {
      return pRaw; // keep as-is (true absolute)
    }

    // Treat as workspace-relative
    const clean = pRaw.replace(/^[\\\/]+/, '');
    return path.join(workspaceFolder.uri.fsPath, clean);
  }


  private static toFileUriFromEdit(edit: CodeEdit): vscode.Uri {
    const abs = CodeEditor.resolveToAbsoluteFsPath(edit.filePath);
    return vscode.Uri.file(abs);
  }

  private static async fileExists(fileUri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(fileUri);
      return true;
    } catch {
      return false;
    }
  }

  private static async ensureDirExists(dirUri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // idempotent enough
    }
  }

  private static normalizeEdits(edits: CodeEdit[]): CodeEdit[] {
    return (edits || []).map(e => ({
      op: e.op ?? 'modify',
      ...e
    }));
  }

  private static makeVirtualUri(kind: string, absPath: string): vscode.Uri {
    // keep it deterministic per call but unique enough
    return vscode.Uri.parse(`devalley-diff:${encodeURIComponent(absPath)}?kind=${kind}&t=${Date.now()}`);
  }

  /**
   * Build modified file content by replacing inclusive [startLine..endLine] with newText.
   */
  private static buildModifiedContent(
    originalContent: string,
    startLine: number,
    endLine: number,
    newText: string
  ): { modifiedContent: string; safeStart: number; safeEnd: number; lines: string[] } {
    const lines = originalContent.split('\n');

    const safeStart = Math.max(0, Math.min(startLine, lines.length - 1));
    const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length - 1));

    const before = lines.slice(0, safeStart);
    const after = lines.slice(safeEnd + 1);

    const replacement = (newText ?? '').split('\n');

    const modifiedContent = [...before, ...replacement, ...after].join('\n');
    return { modifiedContent, safeStart, safeEnd, lines };
  }

  /**
   * Extract inclusive [startLine..endLine] block from file content (0-indexed).
   */
  private static extractOldBlock(
    originalContent: string,
    startLine: number,
    endLine: number
  ): string {
    const lines = originalContent.split('\n');
    const safeStart = Math.max(0, Math.min(startLine, lines.length - 1));
    const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length - 1));
    return lines.slice(safeStart, safeEnd + 1).join('\n');
  }
  /**
   * Show diff preview for code edits
   */
  public static async showDiffPreview(edits: CodeEdit[]): Promise<void> {
    if (!edits || edits.length === 0) {
      vscode.window.showWarningMessage('No edits to preview');
      return;
    }
    if (!CodeEditor.diffProvider) {
      vscode.window.showErrorMessage('Diff provider not initialized');
      return;
    }

    const normalized = CodeEditor.normalizeEdits(edits);

    for (const edit of normalized) {
      try {
        const op = edit.op ?? 'modify';
        const fileUri = CodeEditor.toFileUriFromEdit(edit);
        const absPath = fileUri.fsPath;
        const exists = await CodeEditor.fileExists(fileUri);

        console.log('[DevAlley] Preview:', { op, input: edit.filePath, resolved: absPath, exists });

        // CREATE: empty -> new file
        if (op === 'create') {
          const content = (edit.newText ?? '');

          const left = CodeEditor.makeVirtualUri('create-empty', absPath);
          const right = CodeEditor.makeVirtualUri('create-new', absPath);

          CodeEditor.diffProvider.update(left, '');
          CodeEditor.diffProvider.update(right, content);

          await vscode.commands.executeCommand(
            'vscode.diff',
            left,
            right,
            `${path.basename(absPath)} (New File)`
          );

          console.log('[DevAlley] ✓ Preview opened for create:', absPath);
          continue;
        }

        // DELETE: file -> empty (real diff)
        if (op === 'delete') {
          if (!exists) {
            vscode.window.showWarningMessage(`File not found (already deleted?): ${absPath}`);
            continue;
          }

          const originalDocument = await vscode.workspace.openTextDocument(fileUri);
          const originalContent = originalDocument.getText();

          const empty = CodeEditor.makeVirtualUri('delete-empty', absPath);
          CodeEditor.diffProvider.update(empty, '');

          await vscode.commands.executeCommand(
            'vscode.diff',
            fileUri,
            empty,
            `${path.basename(absPath)} (Delete File)`
          );

          console.log('[DevAlley] ✓ Preview opened for delete:', absPath);
          continue;
        }

        // MODIFY
        if (!exists) {
          throw new Error(`File does not exist: ${absPath}`);
        }

        const originalDocument = await vscode.workspace.openTextDocument(fileUri);
        const originalContent = originalDocument.getText();

        const startLine = Number.isFinite(Number(edit.startLine)) ? Number(edit.startLine) : 0;
        const endLine = Number.isFinite(Number(edit.endLine)) ? Number(edit.endLine) : startLine;

        // Optional safety check: if oldText exists, confirm it matches actual block
        if (typeof edit.oldText === 'string' && edit.oldText.length > 0) {
          const actual = CodeEditor.extractOldBlock(originalContent, startLine, endLine);
          if (actual !== edit.oldText) {
            console.warn('[DevAlley] oldText mismatch for preview', {
              file: absPath,
              startLine,
              endLine
            });

            // Don’t block preview; just inform user
            vscode.window.showWarningMessage(
              `⚠️ Proposed edit may be out-of-date: oldText does not match current file block (${path.basename(absPath)}).`
            );
          }
        }

        const { modifiedContent } = CodeEditor.buildModifiedContent(
          originalContent,
          startLine,
          endLine,
          edit.newText ?? ''
        );

        const modifiedUri = CodeEditor.makeVirtualUri('modify', absPath);
        CodeEditor.diffProvider.update(modifiedUri, modifiedContent);

        await vscode.commands.executeCommand(
          'vscode.diff',
          fileUri,
          modifiedUri,
          `${path.basename(absPath)} (Proposed Changes)`
        );

        console.log('[DevAlley] ✓ Preview opened for modify:', absPath);
      } catch (error: any) {
        console.error('[DevAlley] Preview error:', error);
        vscode.window.showErrorMessage(
          `Failed to preview changes for ${path.basename(edit.filePath || 'unknown')}: ${error?.message ?? String(error)}`
        );
      }
    }
  }
  /**
   * Deduplicate edits that target the same text ranges
   */
  private static deduplicateEdits(document: vscode.TextDocument, edits: CodeEdit[]): CodeEdit[] {
    if (edits.length <= 1) return edits;

    const rangeMap = new Map<string, CodeEdit>();

    for (const edit of edits) {
      let rangeKey: string;

      // Try to get actual range from oldText first
      if (typeof edit.oldText === 'string' && edit.oldText.trim().length > 0) {
        const found = CodeEditor.findTextRangeFlexible(document, edit.oldText);
        if (found) {
          rangeKey = `${found.start.line}-${found.end.line}`;
        } else {
          // Fallback to line numbers
          const startLine = Number.isFinite(Number(edit.startLine)) ? Number(edit.startLine) : 0;
          const endLine = Number.isFinite(Number(edit.endLine)) ? Number(edit.endLine) : startLine;
          rangeKey = `${startLine}-${endLine}`;
        }
      } else {
        // Use line numbers
        const startLine = Number.isFinite(Number(edit.startLine)) ? Number(edit.startLine) : 0;
        const endLine = Number.isFinite(Number(edit.endLine)) ? Number(edit.endLine) : startLine;
        rangeKey = `${startLine}-${endLine}`;
      }

      // Keep the last edit for each range (or merge if needed)
      rangeMap.set(rangeKey, edit);
    }

    const result = Array.from(rangeMap.values());

    if (result.length < edits.length) {
      console.log(`[DevAlley] Deduplicated ${edits.length} edits to ${result.length} for file`);
    }

    return result;
  }
  public static async applyEdits(edits: CodeEdit[]): Promise<boolean> {
    if (!edits || edits.length === 0) {
      vscode.window.showWarningMessage('No edits to apply');
      return false;
    }

    const normalized = CodeEditor.normalizeEdits(edits);
    const creates = normalized.filter(e => (e.op ?? 'modify') === 'create');
    const modifies = normalized.filter(e => (e.op ?? 'modify') === 'modify');
    const deletes = normalized.filter(e => (e.op ?? 'modify') === 'delete');

    // Group modifies by file and deduplicate/merge overlapping ranges
    const modifiesByFile = new Map<string, CodeEdit[]>();
    for (const edit of modifies) {
      const absPath = CodeEditor.resolveToAbsoluteFsPath(edit.filePath);
      if (!modifiesByFile.has(absPath)) {
        modifiesByFile.set(absPath, []);
      }
      modifiesByFile.get(absPath)!.push(edit);
    }

    try {
      // 1) CREATE
      for (const edit of creates) {
        const fileUri = CodeEditor.toFileUriFromEdit(edit);
        const absPath = fileUri.fsPath;

        const exists = await CodeEditor.fileExists(fileUri);
        if (exists) {
          throw new Error(`Cannot create "${absPath}" because it already exists.`);
        }

        const content = edit.newText ?? '';
        const dirUri = vscode.Uri.file(path.dirname(absPath));
        await CodeEditor.ensureDirExists(dirUri);

        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
        console.log('[DevAlley] ✅ Created file:', absPath);

        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        await doc.save();
      }

      // 2) MODIFY (with deduplication per file)
      for (const [absPath, fileEdits] of modifiesByFile) {
        const fileUri = vscode.Uri.file(absPath);
        const exists = await CodeEditor.fileExists(fileUri);
        if (!exists) {
          throw new Error(`Cannot modify "${absPath}" because it does not exist.`);
        }

        const document = await vscode.workspace.openTextDocument(fileUri);
        const wsEdit = new vscode.WorkspaceEdit();

        // Deduplicate edits for this file
        const deduplicatedEdits = CodeEditor.deduplicateEdits(document, fileEdits);

        for (const edit of deduplicatedEdits) {
          const startLine = Number.isFinite(Number(edit.startLine)) ? Number(edit.startLine) : 0;
          const endLine = Number.isFinite(Number(edit.endLine)) ? Number(edit.endLine) : startLine;

          if (startLine >= document.lineCount) {
            throw new Error(`Invalid startLine ${startLine}. File has ${document.lineCount} lines.`);
          }

          const safeEndLine = Math.min(Math.max(endLine, startLine), document.lineCount - 1);
          let range: vscode.Range | null = null;

          // Try oldText-based targeting first
          if (typeof edit.oldText === 'string' && edit.oldText.trim().length > 0) {
            const found = CodeEditor.findTextRangeFlexible(document, edit.oldText);

            if (found) {
              const start = new vscode.Position(found.start.line, 0);
              let end: vscode.Position;
              if (found.end.line + 1 < document.lineCount) {
                end = new vscode.Position(found.end.line + 1, 0);
              } else {
                end = new vscode.Position(found.end.line, document.lineAt(found.end.line).text.length);
              }
              range = new vscode.Range(start, end);

              console.log('[DevAlley] ✅ oldText match apply:', {
                file: absPath,
                matchedLines: `${found.start.line}-${found.end.line}`
              });
            }
          }

          // Fallback: line-based range
          if (!range) {
            const startPos = new vscode.Position(startLine, 0);
            let endPos: vscode.Position;
            if (safeEndLine + 1 < document.lineCount) {
              endPos = new vscode.Position(safeEndLine + 1, 0);
            } else {
              endPos = new vscode.Position(safeEndLine, document.lineAt(safeEndLine).text.length);
            }
            range = new vscode.Range(startPos, endPos);

            // Validate if oldText was provided
            // if (typeof edit.oldText === 'string' && edit.oldText.trim().length > 0) {
            //   const actual = CodeEditor.normalizeText(document.getText(range));
            //   const expected = CodeEditor.normalizeText(edit.oldText);

            //   if (actual !== expected) {
            //     throw new Error(
            //       `oldText mismatch for ${path.basename(absPath)} at lines ${startLine}-${safeEndLine}. ` +
            //       `File changed since context was captured and oldText was not found. Please re-run with fresh context.`
            //     );
            //   }
            // }

            console.log('[DevAlley] ⚠️ using line-range apply:', {
              file: absPath,
              startLine,
              endLine: safeEndLine
            });
          }

          wsEdit.replace(fileUri, range, edit.newText ?? '');
        }

        const success = await vscode.workspace.applyEdit(wsEdit);
        if (!success) throw new Error('VS Code failed to apply one or more edits.');

        const doc = await vscode.workspace.openTextDocument(fileUri);
        await doc.save();
        console.log('[DevAlley] ✅ Applied and saved edits for:', absPath);
      }

      // 3) DELETE
      for (const edit of deletes) {
        const fileUri = CodeEditor.toFileUriFromEdit(edit);
        const absPath = fileUri.fsPath;

        const exists = await CodeEditor.fileExists(fileUri);
        if (!exists) {
          console.warn('[DevAlley] delete skipped, file missing:', absPath);
          continue;
        }

        await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: true });
        console.log('[DevAlley] ✅ Deleted file:', absPath);
      }

      vscode.window.showInformationMessage(`Successfully applied ${edits.length} edit(s)`);
      return true;
    } catch (error: any) {
      console.error('[DevAlley] Apply edits error:', error);
      vscode.window.showErrorMessage(`Failed to apply edits: ${error?.message ?? String(error)}`);
      return false;
    }
  }
}

/**
 * Content provider for virtual diff documents
 */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private _cache = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    const content = this._cache.get(uri.toString());
    if (content === undefined) {
      console.warn('[DevAlley] No content found for URI:', uri.toString());
      return '';
    }
    return content;
  }

  update(uri: vscode.Uri, content: string) {
    this._cache.set(uri.toString(), content);
    this._onDidChange.fire(uri);
    console.log('[DevAlley] Updated diff content for:', uri.toString().substring(0, 160));
  }

  clear() {
    this._cache.clear();
  }
}