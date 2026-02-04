import * as vscode from "vscode";
import * as path from "path";
import { getHtmlForWebview } from "./getHtml";
import { WorkspaceIndexer } from "./workspaceIndexer";
import { CodeEditor, CodeEdit } from "./codeEditor";

export class DevAlleyPanel {
  public static currentPanel: DevAlleyPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;

  private disposables: vscode.Disposable[] = [];

  private autoCaptureEnabled: boolean = false;
  private editorChangeListener: vscode.Disposable | undefined;

  private pendingEdits: CodeEdit[] = [];

  // Static indexer shared across all panel instances
  private static indexer: WorkspaceIndexer | null = null;

  private static readonly TOKEN_KEY = "devalley.token";
  private static readonly USERNAME_KEY = "devalley.username";
  private static readonly AUTO_CAPTURE_KEY = "devalley.autoCapture";
  private static readonly PREF_MODE_KEY = "devalley.pref.contextMode";
  private static readonly EDIT_MODE_KEY = "devalley.editMode";

  public static async createOrShow(
    context: vscode.ExtensionContext,
    forceLogin: boolean = false
  ) {
    const column = vscode.ViewColumn.Beside;

    if (DevAlleyPanel.currentPanel) {
      DevAlleyPanel.currentPanel.panel.reveal(column);
      console.log("[DevAlley] Panel already exists, just revealing");
      return;
    }

    // Initialize indexer once on first panel creation
    if (!DevAlleyPanel.indexer) {
      console.log("[DevAlley] Initializing workspace indexer...");
      DevAlleyPanel.indexer = new WorkspaceIndexer(context);
      await DevAlleyPanel.indexer.initialize();
      console.log("[DevAlley] Workspace indexer ready");
    }

    const panel = vscode.window.createWebviewPanel(
      "devalleyAssistant",
      "Devailey Assistant",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          context.extensionUri,
        ],
      }
    );

    DevAlleyPanel.currentPanel = new DevAlleyPanel(panel, context, forceLogin);
  }

  public static toggle(context: vscode.ExtensionContext) {
    if (DevAlleyPanel.currentPanel) {
      DevAlleyPanel.currentPanel.dispose();
    } else {
      DevAlleyPanel.createOrShow(context, false);
    }
  }

  public static revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    state: any
  ) {
    DevAlleyPanel.currentPanel = new DevAlleyPanel(panel, context, false);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    forceLogin: boolean = false
  ) {
    this.panel = panel;
    this.context = context;

    // ✅ Load saved preferences BEFORE setting HTML
    this.loadAutoCapturePreference();

    // Set webview HTML
    this.panel.webview.html = getHtmlForWebview(
      this.panel.webview,
      this.context.extensionUri
    );

    // Webview message handler
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          console.log("[DevAlleyPanel] Received webview message:", message?.type);

          switch (message?.type) {
            case "prefs:set": {
              const key = message.key;
              const value = message.value;
              if (key === "contextMode") {
                await this.context.globalState.update(
                  DevAlleyPanel.PREF_MODE_KEY,
                  value
                );
                console.log(`[DevAlley] ? Saved contextMode preference: ${value}`);
              }
              if (key === "editMode") {
                await this.context.globalState.update(
                  DevAlleyPanel.EDIT_MODE_KEY,
                  value
                );
                console.log(`[DevAlley] ? Saved editMode preference: ${value}`);
              }
              break;
            }

            case "insertCode": {
              await this.insertCodeIntoEditor(message.content ?? "");
              break;
            }

            // ===== FILE CONTEXT =====
            case "getFileContext": {
              const requestedMode = (message?.mode || "snippet") as "file" | "snippet" | "selection";
              const fileCtx = this.getFileContext(requestedMode);

              console.log(
                "[DevAlley] getFileContext request - mode:",
                requestedMode,
                "- Result:",
                fileCtx ? "✅ Got context" : "❌ No active editor"
              );

              this.safePost({
                type: "fileContext:response",
                requestId: message?.requestId,
                fileContext: fileCtx,
                mode: requestedMode,
              });
              break;
            }

            // ===== AUTO CAPTURE =====
            case "toggleAutoCapture": {
              this.autoCaptureEnabled = message.enabled ?? false;
              await this.saveAutoCapturePreference();

              if (this.autoCaptureEnabled) {
                this.startAutoCapture();

                // Send current file context immediately when enabled
                const fileCtx = this.getFileContext();
                this.safePost({
                  type: "fileContext:response",
                  fileContext: fileCtx,
                  autoCapture: true,
                });
              } else {
                this.stopAutoCapture();
              }

              // Sync state back to webview
              this.safePost({
                type: "autoCapture:state",
                enabled: this.autoCaptureEnabled,
              });

              console.log(
                "[DevAlley] Auto-capture:",
                this.autoCaptureEnabled ? "enabled" : "disabled"
              );
              break;
            }

            // ===== INDEXING =====
            case "indexWorkspace": {
              if (!DevAlleyPanel.indexer) {
                this.safePost({
                  type: "indexing:complete",
                  stats: { totalChunks: 0, totalFiles: 0 },
                });
                break;
              }

              this.safePost({ type: "indexing:started" });

              await DevAlleyPanel.indexer.indexWorkspace((msg) => {
                this.safePost({ type: "indexing:progress", message: msg });
              });

              const stats = await DevAlleyPanel.indexer.getStats();

              this.safePost({
                type: "indexing:complete",
                stats: stats,
              });

              console.log(
                `[DevAlley] Indexed ${stats.totalChunks} chunks from ${stats.totalFiles} files`
              );
              break;
            }

            case "getWorkspaceContext": {
              if (!DevAlleyPanel.indexer) {
                this.safePost({
                  type: "workspaceContext:response",
                  context: "⚠️ Workspace indexer not initialized",
                });
                break;
              }

              console.log(
                "[DevAlley] Finding relevant context for query:",
                message.query
              );

              const contextText =
                await DevAlleyPanel.indexer.findRelevantContext(
                  message.query || "",
                  15
                );

              console.log(
                "[DevAlley] ✅ Found context, length:",
                contextText.length,
                "chars"
              );

              this.safePost({
                type: "workspaceContext:response",
                context: contextText,
              });

              break;
            }

            // ===== CODE EDITS =====
            case "previewCodeEdits": {
              const edits: CodeEdit[] = message.edits || [];
              console.log("[DevAlley] Previewing", edits.length, "code edits");

              this.sendAssistantLog(
                `👁️ Previewing ${edits.length} change(s)…`
              );

              await CodeEditor.showDiffPreview(edits);

              this.pendingEdits = edits;

              this.sendAssistantLog("👁️ Preview opened.");
              break;
            }
            case "applyCodeEdits": {
              const edits: CodeEdit[] = message.edits || [];
              console.log("[DevAlley] Applying", edits.length, "code edits");

              this.sendAssistantLog(`✅ Applying ${edits.length} change(s)…`);

              const success = await CodeEditor.applyEdits(edits);

              this.safePost({ type: "edits:applied", success });

              if (success) {
                this.safePost({ type: "editsApplied" });

                const refreshedContext = this.getFileContext();
                if (refreshedContext) {
                  this.safePost({
                    type: "fileContext:response",
                    fileContext: refreshedContext,
                    refreshAfterEdit: true,
                  });

                  console.log("[DevAlley] ✅ Sent fresh context after edit application");
                }
              }

              this.sendAssistantLog(
                success ? "✅ Applied edits successfully." : "❌ Failed to apply edits."
              );

              this.pendingEdits = [];
              break;
            }
            case "acceptPendingEdits": {
              if (this.pendingEdits.length > 0) {
                console.log("[DevAlley] Accepting pending edits");
                this.sendAssistantLog(`✅ Accepting ${this.pendingEdits.length} pending edit(s)…`);

                const success = await CodeEditor.applyEdits(this.pendingEdits);

                this.pendingEdits = [];
                this.safePost({ type: "edits:applied", success });

                if (success) {
                  this.safePost({ type: "editsApplied" });

                  if (this.autoCaptureEnabled) {
                    const refreshedContext = this.getFileContext();
                    this.safePost({
                      type: "fileContext:response",
                      fileContext: refreshedContext,
                      autoCapture: true,
                    });
                  }
                }

                this.sendAssistantLog(
                  success ? "✅ Pending edits applied." : "❌ Failed to apply pending edits."
                );
              } else {
                this.sendAssistantLog("⚠️ No pending edits to accept.");
              }
              break;
            }
            case "rejectPendingEdits": {
              console.log("[DevAlley] Rejecting pending edits");
              this.pendingEdits = [];
              this.safePost({ type: "edits:rejected" });
              this.sendAssistantLog("❌ Pending edits rejected.");
              break;
            }

            // ===== AUTH =====
            case "auth:get": {
              await this.postAuthState();
              break;
            }

            case "auth:set": {
              const token = message.token ?? "";
              const username = message.username ?? "";

              await this.context.secrets.store(DevAlleyPanel.TOKEN_KEY, token);
              await this.context.secrets.store(
                DevAlleyPanel.USERNAME_KEY,
                username
              );

              await this.context.globalState.update("devAlleyToken", token);

              console.log(
                "[DevAlley] Auth credentials saved to secrets and globalState"
              );

              this.safePost({
                type: "auth:saved",
                success: true,
              });

              await this.postAuthState();
              break;
            }

            case "auth:clear": {
              await this.forceLogout();
              await this.postAuthState();
              break;
            }

            case "webview:ready": {
              console.log("[DevAlley] ✅ Webview ready - sending all saved states");

              // ✅ SEND SAVED CONTEXT MODE
              const savedMode = this.context.globalState.get<string>(
                DevAlleyPanel.PREF_MODE_KEY
              ) || "snippet";

              console.log(`[DevAlley] Restoring saved contextMode: ${savedMode}`);

              this.safePost({
                type: "prefs:state",
                contextMode: savedMode
              });

              await this.postAuthState();

              if (forceLogin) {
                this.safePost({ type: "auth:forceLogin" });
              }

                this.safePost({
                  type: "autoCapture:state",
                  enabled: this.autoCaptureEnabled
                });

                const savedEditMode =
                  this.context.globalState.get<boolean>(
                    DevAlleyPanel.EDIT_MODE_KEY
                  ) || false;
                this.safePost({
                  type: "editMode:state",
                  enabled: savedEditMode
                });


                if (DevAlleyPanel.indexer) {
                  const stats = await DevAlleyPanel.indexer.getStats();
                this.safePost({
                  type: "indexer:state",
                  indexed: stats.totalFiles > 0,
                  stats: stats
                });
              }

              console.log(`[DevAlley] States sent - Mode: ${savedMode}, AutoCapture: ${this.autoCaptureEnabled}`);
              break;
            }


            default:
              console.log("[DevAlley] Unknown message type:", message?.type);
              break;
          }
        } catch (err) {
          console.error("[DevAlleyPanel] Error handling message from webview:", err);
          this.safePost({ type: "error", error: String(err) });
        }
      },
      null,
      this.disposables
    );

    // View state changes
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          console.log("[DevAlley] Panel became visible (state retained)");

          // ✅ RE-SYNC STATES WHEN PANEL BECOMES VISIBLE AGAIN
          const savedMode = this.context.globalState.get<string>(
            DevAlleyPanel.PREF_MODE_KEY
          ) || "snippet";

          this.safePost({
            type: "prefs:state",
            contextMode: savedMode
          });

          this.safePost({
            type: "autoCapture:state",
            enabled: this.autoCaptureEnabled
          });

          const savedEditMode =
            this.context.globalState.get<boolean>(
              DevAlleyPanel.EDIT_MODE_KEY
            ) || false;
          this.safePost({
            type: "editMode:state",
            enabled: savedEditMode
          });
        }
      },
      null,
      this.disposables
    );

    // Dispose
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // ===== Auto-capture preference =====
  private async loadAutoCapturePreference() {
    const stored = this.context.globalState.get<boolean>(
      DevAlleyPanel.AUTO_CAPTURE_KEY
    );
    this.autoCaptureEnabled = stored ?? false;

    console.log(`[DevAlley] Loaded auto-capture preference: ${this.autoCaptureEnabled}`);

    if (this.autoCaptureEnabled) {
      this.startAutoCapture();
    }
  }

  private async saveAutoCapturePreference() {
    await this.context.globalState.update(
      DevAlleyPanel.AUTO_CAPTURE_KEY,
      this.autoCaptureEnabled
    );
    console.log(`[DevAlley] Saved auto-capture preference: ${this.autoCaptureEnabled}`);
  }

  private startAutoCapture() {
    if (this.editorChangeListener) return;

    console.log("[DevAlley] Starting auto-capture");
    this.editorChangeListener = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor && this.autoCaptureEnabled && this.panel.visible) {
          console.log(
            "[DevAlley] Auto-capturing file context for:",
            editor.document.fileName
          );

          setTimeout(() => {
            const fileCtx = this.getFileContext();
            if (fileCtx) {
              this.safePost({
                type: "fileContext:response",
                fileContext: fileCtx,
                autoCapture: true,
              });
              console.log("[DevAlley] ✅ Auto-capture successful");
            } else {
              console.log("[DevAlley] ⚠️ Auto-capture failed - no active editor");
            }
          }, 100);
        }
      }
    );

    this.disposables.push(this.editorChangeListener);
  }

  private stopAutoCapture() {
    if (this.editorChangeListener) {
      console.log("[DevAlley] Stopping auto-capture");
      this.editorChangeListener.dispose();
      this.editorChangeListener = undefined;
    }
  }

  // ===== File context =====
  private getFileContext(mode: 'file' | 'snippet' | 'selection' = 'snippet'): any {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const selection = editor.selection;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const relPath = workspaceFolder
      ? vscode.workspace.asRelativePath(document.uri, false)
      : document.fileName;

    const selectedText = document.getText(selection) || '';

    const cursorLine = selection.active.line;
    const snippetStartLine = Math.max(0, cursorLine - 50);
    const snippetEndLine = Math.min(document.lineCount - 1, cursorLine + 50);

    const snippetRange = new vscode.Range(
      snippetStartLine,
      0,
      snippetEndLine,
      document.lineAt(snippetEndLine).text.length
    );
    const snippetText = document.getText(snippetRange) || '';

    const fullText = document.getText() || '';

    return {
      filePath: relPath,
      languageId: document.languageId,
      selectedText,
      snippetText,
      fullText,
      snippetStartLine,
      snippetEndLine,
      startLine: snippetStartLine,
      endLine: snippetEndLine,
      cursorLine,
      lineCount: document.lineCount,
      uri: document.uri.toString(),
    };
  }

  // ===== Auth =====
  private async forceLogout() {
    await this.context.secrets.delete(DevAlleyPanel.TOKEN_KEY);
    await this.context.secrets.delete(DevAlleyPanel.USERNAME_KEY);
    await this.context.globalState.update("devAlleyToken", null);
    console.log("[DevAlley] Auth credentials cleared");
  }

  private async postAuthState() {
    try {
      const token = await this.context.secrets.get(DevAlleyPanel.TOKEN_KEY);
      const username = await this.context.secrets.get(DevAlleyPanel.USERNAME_KEY);

      console.log("[DevAlley] Posting auth state - token exists:", !!token);

      this.safePost({
        type: "auth:state",
        token: token || null,
        username: username || null,
      });
    } catch (error) {
      console.error("[DevAlley] Failed to post auth state:", error);
    }
  }

  // ===== Editor insert =====
  private async insertCodeIntoEditor(content: string) {
    if (!content || typeof content !== "string" || !content.trim()) {
      vscode.window.showWarningMessage("No code content to insert.");
      this.safePost({ type: "export:error", error: "No code content to insert" });
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor found. Please open a file first.");
      this.safePost({ type: "export:error", error: "No active editor" });
      return;
    }

    try {
      await editor.edit((edit) => edit.insert(editor.selection.active, content));
      vscode.window.showInformationMessage("Code inserted successfully!");
      this.safePost({ type: "export:success" });
      console.log("[DevAlleyPanel] Code successfully exported to IDE.");
    } catch (err) {
      const errMsg =
        err && typeof err === "object" && "message" in err
          ? (err as Error).message
          : String(err);

      vscode.window.showErrorMessage("Failed to insert code: " + errMsg);
      this.safePost({ type: "export:error", error: "Failed to insert code: " + errMsg });
      console.error("[DevAlleyPanel] Failed to export code:", errMsg);
    }
  }

  // ===== Webview messaging =====
  private sendAssistantLog(message: string) {
    this.safePost({
      type: "assistant:log",
      message,
      ts: Date.now(),
    });
  }

  private safePost(message: any) {
    try {
      if (this.panel.webview) {
        this.panel.webview.postMessage(message);
      }
    } catch (error) {
      console.error("[DevAlley] Failed to post message:", error);
    }
  }

  // ===== Dispose =====
  public dispose() {
    DevAlleyPanel.currentPanel = undefined;
    this.stopAutoCapture();

    try {
      this.panel.dispose();
    } catch { }

    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch { }
    }
  }

  public static dispose() {
    if (DevAlleyPanel.currentPanel) {
      DevAlleyPanel.currentPanel.dispose();
    }
  }
}
