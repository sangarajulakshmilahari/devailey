import * as vscode from "vscode";
import { getHtmlForWebview } from "./getHtml";
import { WorkspaceIndexer } from "./workspaceIndexer";
import { CodeEditor, CodeEdit } from "./codeEditor";

export class DevAlleyViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "devalley.chatView";

  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  private autoCaptureEnabled: boolean = false;
  private editorChangeListener: vscode.Disposable | undefined;

  private pendingEdits: CodeEdit[] = [];

  // Static indexer shared across all instances
  private static indexer: WorkspaceIndexer | null = null;

  private static readonly TOKEN_KEY = "devalley.token";
  private static readonly USERNAME_KEY = "devalley.username";
  private static readonly REFRESH_TOKEN_KEY = "devalley.refreshToken";
  private static readonly AUTO_CAPTURE_KEY = "devalley.autoCapture";
  private static readonly PREF_MODE_KEY = "devalley.pref.contextMode";
  private static readonly EDIT_MODE_KEY = "devalley.editMode";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Initialize indexer once
    if (!DevAlleyViewProvider.indexer) {
      console.log("[DevAlley] Initializing workspace indexer...");
      DevAlleyViewProvider.indexer = new WorkspaceIndexer(this.context);
      await DevAlleyViewProvider.indexer.initialize();
      console.log("[DevAlley] Workspace indexer ready");
    }

    // Load saved preferences
    await this.loadAutoCapturePreference();

    // Configure webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        this.context.extensionUri,
      ],
    };

    webviewView.webview.html = getHtmlForWebview(
      webviewView.webview,
      this.context.extensionUri
    );

    // Set up message handler
    this.setupMessageHandler();

    // Handle view visibility changes
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        console.log("[DevAlley] View became visible");
        this.syncStateToWebview();
      }
    });

    // Handle view disposal
    webviewView.onDidDispose(() => {
      this.dispose();
    });
  }

  private setupMessageHandler() {
    if (!this._view) return;

    this._view.webview.onDidReceiveMessage(
      async (message) => {
        try {
          console.log("[DevAlley] Received message:", message?.type);

          switch (message?.type) {
            case "prefs:set": {
              const key = message.key;
              const value = message.value;
              if (key === "contextMode") {
                await this.context.globalState.update(
                  DevAlleyViewProvider.PREF_MODE_KEY,
                  value
                );
                console.log(`[DevAlley] ✅ Saved contextMode: ${value}`);
              }
              if (key === "editMode") {
                await this.context.globalState.update(
                  DevAlleyViewProvider.EDIT_MODE_KEY,
                  value
                );
                console.log(`[DevAlley] ✅ Saved editMode: ${value}`);
              }
              break;
            }

            case "insertCode": {
              await this.insertCodeIntoEditor(message.content ?? "");
              break;
            }

            case "getFileContext": {
              const requestedMode = (message?.mode || "snippet") as
                | "file"
                | "snippet"
                | "selection";
              const fileCtx = this.getFileContext(requestedMode);

              this.safePost({
                type: "fileContext:response",
                requestId: message?.requestId,
                fileContext: fileCtx,
                mode: requestedMode,
              });
              break;
            }

            case "toggleAutoCapture": {
              this.autoCaptureEnabled = message.enabled ?? false;
              await this.saveAutoCapturePreference();

              if (this.autoCaptureEnabled) {
                this.startAutoCapture();

                const fileCtx = this.getFileContext();
                this.safePost({
                  type: "fileContext:response",
                  fileContext: fileCtx,
                  autoCapture: true,
                });
              } else {
                this.stopAutoCapture();
              }

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

            case "indexWorkspace": {
              if (!DevAlleyViewProvider.indexer) {
                this.safePost({
                  type: "indexing:complete",
                  stats: { totalChunks: 0, totalFiles: 0 },
                });
                break;
              }

              this.safePost({ type: "indexing:started" });

              await DevAlleyViewProvider.indexer.indexWorkspace((msg) => {
                this.safePost({ type: "indexing:progress", message: msg });
              });

              const stats = await DevAlleyViewProvider.indexer.getStats();

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
              if (!DevAlleyViewProvider.indexer) {
                this.safePost({
                  type: "workspaceContext:response",
                  context: "⚠️ Workspace indexer not initialized",
                });
                break;
              }

              const contextText =
                await DevAlleyViewProvider.indexer.findRelevantContext(
                  message.query || "",
                  15
                );

              this.safePost({
                type: "workspaceContext:response",
                context: contextText,
              });

              break;
            }

            case "previewCodeEdits": {
              const edits: CodeEdit[] = message.edits || [];
              console.log("[DevAlley] Previewing", edits.length, "code edits");

              this.sendAssistantLog(`👁️ Previewing ${edits.length} change(s)…`);
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
                }
              }

              this.sendAssistantLog(
                success
                  ? "✅ Applied edits successfully."
                  : "❌ Failed to apply edits."
              );

              this.pendingEdits = [];
              break;
            }

            case "acceptPendingEdits": {
              if (this.pendingEdits.length > 0) {
                const success = await CodeEditor.applyEdits(this.pendingEdits);
                this.pendingEdits = [];
                this.safePost({ type: "edits:applied", success });

                if (success && this.autoCaptureEnabled) {
                  const refreshedContext = this.getFileContext();
                  this.safePost({
                    type: "fileContext:response",
                    fileContext: refreshedContext,
                    autoCapture: true,
                  });
                }

                this.sendAssistantLog(
                  success
                    ? "✅ Pending edits applied."
                    : "❌ Failed to apply pending edits."
                );
              }
              break;
            }

            case "rejectPendingEdits": {
              this.pendingEdits = [];
              this.safePost({ type: "edits:rejected" });
              this.sendAssistantLog("❌ Pending edits rejected.");
              break;
            }

            case "auth:get": {
              await this.postAuthState();
              break;
            }

            case "auth:set": {
              const token = message.token ?? "";
              const username = message.username ?? "";
              const refreshToken = message.refreshToken ?? "";

              await this.context.secrets.store(
                DevAlleyViewProvider.TOKEN_KEY,
                token
              );
              await this.context.secrets.store(
                DevAlleyViewProvider.USERNAME_KEY,
                username
              );
              if (refreshToken) {
                await this.context.secrets.store(
                  DevAlleyViewProvider.REFRESH_TOKEN_KEY,
                  refreshToken
                );
              }
              await this.context.globalState.update("devAlleyToken", token);

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
              console.log("[DevAlley] ✅ Webview ready - syncing state");
              await this.syncStateToWebview();
              break;
            }

            default:
              console.log("[DevAlley] Unknown message type:", message?.type);
              break;
          }
        } catch (err) {
          console.error("[DevAlley] Error handling message:", err);
          this.safePost({ type: "error", error: String(err) });
        }
      },
      null,
      this.disposables
    );
  }

  private async syncStateToWebview() {
    // Send saved context mode
    const savedMode =
      this.context.globalState.get<string>(
        DevAlleyViewProvider.PREF_MODE_KEY
      ) || "snippet";

    this.safePost({
      type: "prefs:state",
      contextMode: savedMode,
    });

    // Send auto-capture state
    this.safePost({
      type: "autoCapture:state",
      enabled: this.autoCaptureEnabled,
    });

    // Send edit mode state
    const savedEditMode =
      this.context.globalState.get<boolean>(
        DevAlleyViewProvider.EDIT_MODE_KEY
      ) || false;

    this.safePost({
      type: "editMode:state",
      enabled: savedEditMode,
    });

    // Send indexer state
    if (DevAlleyViewProvider.indexer) {
      const stats = await DevAlleyViewProvider.indexer.getStats();
      this.safePost({
        type: "indexer:state",
        indexed: stats.totalFiles > 0,
        stats: stats,
      });
    }

    // Send auth state
    await this.postAuthState();

    // Send current file context if applicable
    if (savedMode === "file" || savedMode === "snippet") {
      const fileCtx = this.getFileContext(savedMode as any);
      if (fileCtx) {
        this.safePost({
          type: "fileContext:response",
          fileContext: fileCtx,
          mode: savedMode,
        });
      }
    }
  }

  private async loadAutoCapturePreference() {
    const stored = this.context.globalState.get<boolean>(
      DevAlleyViewProvider.AUTO_CAPTURE_KEY
    );
    this.autoCaptureEnabled = stored ?? false;

    if (this.autoCaptureEnabled) {
      this.startAutoCapture();
    }
  }

  private async saveAutoCapturePreference() {
    await this.context.globalState.update(
      DevAlleyViewProvider.AUTO_CAPTURE_KEY,
      this.autoCaptureEnabled
    );
  }

  private startAutoCapture() {
    if (this.editorChangeListener) return;

    this.editorChangeListener = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor && this.autoCaptureEnabled && this._view?.visible) {
          setTimeout(() => {
            const fileCtx = this.getFileContext();
            if (fileCtx) {
              this.safePost({
                type: "fileContext:response",
                fileContext: fileCtx,
                autoCapture: true,
              });
            }
          }, 100);
        }
      }
    );

    this.disposables.push(this.editorChangeListener);
  }

  private stopAutoCapture() {
    if (this.editorChangeListener) {
      this.editorChangeListener.dispose();
      this.editorChangeListener = undefined;
    }
  }

  private getFileContext(
    mode: "file" | "snippet" | "selection" = "snippet"
  ): any {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const selection = editor.selection;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const relPath = workspaceFolder
      ? vscode.workspace.asRelativePath(document.uri, false)
      : document.fileName;

    const selectedText = document.getText(selection) || "";

    const cursorLine = selection.active.line;
    const snippetStartLine = Math.max(0, cursorLine - 50);
    const snippetEndLine = Math.min(document.lineCount - 1, cursorLine + 50);

    const snippetRange = new vscode.Range(
      snippetStartLine,
      0,
      snippetEndLine,
      document.lineAt(snippetEndLine).text.length
    );
    const snippetText = document.getText(snippetRange) || "";

    const fullText = document.getText() || "";

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

  private async forceLogout() {
    await this.context.secrets.delete(DevAlleyViewProvider.TOKEN_KEY);
    await this.context.secrets.delete(DevAlleyViewProvider.USERNAME_KEY);
    await this.context.secrets.delete(DevAlleyViewProvider.REFRESH_TOKEN_KEY);
    await this.context.globalState.update("devAlleyToken", null);
  }

  private async postAuthState() {
    try {
      const token = await this.context.secrets.get(
        DevAlleyViewProvider.TOKEN_KEY
      );
      const username = await this.context.secrets.get(
        DevAlleyViewProvider.USERNAME_KEY
      );
      const refreshToken = await this.context.secrets.get(
        DevAlleyViewProvider.REFRESH_TOKEN_KEY
      );

      this.safePost({
        type: "auth:state",
        token: token || null,
        username: username || null,
        refreshToken: refreshToken || null,
      });
    } catch (error) {
      console.error("[DevAlley] Failed to post auth state:", error);
    }
  }

  private async insertCodeIntoEditor(content: string) {
    if (!content || typeof content !== "string" || !content.trim()) {
      vscode.window.showWarningMessage("No code content to insert.");
      this.safePost({ type: "export:error", error: "No code content" });
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor found.");
      this.safePost({ type: "export:error", error: "No active editor" });
      return;
    }

    try {
      await editor.edit((edit) =>
        edit.insert(editor.selection.active, content)
      );
      vscode.window.showInformationMessage("Code inserted successfully!");
      this.safePost({ type: "export:success" });
    } catch (err) {
      vscode.window.showErrorMessage("Failed to insert code");
      this.safePost({ type: "export:error", error: String(err) });
    }
  }

  private sendAssistantLog(message: string) {
    this.safePost({
      type: "assistant:log",
      message,
      ts: Date.now(),
    });
  }

  private safePost(message: any) {
    try {
      if (this._view?.webview) {
        this._view.webview.postMessage(message);
      }
    } catch (error) {
      console.error("[DevAlley] Failed to post message:", error);
    }
  }

  public dispose() {
    this.stopAutoCapture();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {}
    }
  }
}
