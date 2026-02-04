import * as vscode from "vscode";
import { CodeEditor } from "./codeEditor";
import { DevAlleyPanel } from "./devAlleyPanel";
import { DevAlleyViewProvider } from "./devAlleyViewProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log("[DevAlley] activating???");
  CodeEditor.registerDiffProvider(context);

  if (vscode.window.registerWebviewPanelSerializer) {
    vscode.window.registerWebviewPanelSerializer("devalleyAssistant", {
      async deserializeWebviewPanel(
        webviewPanel: vscode.WebviewPanel,
        state: any
      ) {
        DevAlleyPanel.revive(webviewPanel, context, state);
      },
    });
  }

  const viewProvider = new DevAlleyViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DevAlleyViewProvider.viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devalley.openAssistant", () => {
      DevAlleyPanel.createOrShow(context, false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devalley.toggleAssistant", () => {
      DevAlleyPanel.toggle(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devalley.focusAssistantView", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.devalley");
      await vscode.commands.executeCommand("devalley.chatView.focus");
      await vscode.commands.executeCommand("workbench.action.focusSideBar");
    })
  );

}

export function deactivate() {
  DevAlleyPanel.dispose();
}
