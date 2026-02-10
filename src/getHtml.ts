import * as vscode from "vscode";
export function getHtmlForWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = getNonce();
  const logo = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "Adroitent_logo.png")
  );

  // Get URIs for external files
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "main.js")
  );

  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "styles.css")
  );

  return buildHtmlContent(
    nonce,
    logo.toString(),
    scriptUri.toString(),
    styleUri.toString()
  );
}
function buildHtmlContent(
  nonce: string,
  logoUrl: string,
  scriptUri: string,
  styleUri: string
): string {
  // Extract the base URI scheme for the webview
  const styleUriScheme = styleUri.split(':')[0];

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${styleUriScheme}: https: data:; script-src 'nonce-${nonce}'; style-src ${styleUriScheme}: 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src http://202.153.39.93:7067; font-src https: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Devailey Assistant</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="${styleUri}">
  </head>
  <body>
    ${getBodyContent(logoUrl)}
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
  </html>`;
}


function getBodyContent(logoUrl: string): string {
  return `<div class="app-container">
    <!-- Main Content -->
    <div class="main-content">
      <!-- Header -->
      <div class="header">
        <div class="brand">
          <div class="brand-actions-dropdown">
            <button id="newChatDropdownBtn" class="new-chat-dropdown-btn" title="New chat options">
              <i class="fa-solid fa-plus"></i>
            </button>
            <div id="newChatDropdown" class="new-chat-dropdown hidden">
              <button class="dropdown-item" data-action="new-chat">
                <span>New Chat</span>
              </button>
              <button class="dropdown-item" data-action="new-chat-editor">
                <span>New Chat Editor</span>
              </button>
              <button class="dropdown-item" data-action="new-chat-window">
                <span>New Chat Window</span>
              </button>
            </div>
          </div>
          
          <img src="${logoUrl}" alt="Devailey" class="brand-logo">
        </div>
        <div class="header-actions">
          <div class="status-indicator">
            <div class="status-dot" id="statusDot"></div>
            <span id="statusText">Connecting...</span>
          </div>
          <button id="settingsToggle" class="settings-toggle" title="Settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z" />
            </svg>
          </button>
        </div>
      </div>
      
        <div id="activityRibbon" class="activity-ribbon hidden" aria-live="polite">
    <div class="activity-ribbon-left">
      <span id="activityDot" class="activity-dot"></span>
      <span id="activityText" class="activity-text">Working…</span>
    </div>
    <button id="activityClose" class="activity-close" title="Dismiss">×</button>
  </div>
      <!-- Login -->
      <div id="loginContainer" class="login-container">
        <div class="login-card">
          <div class="login-header">
            <h2 class="login-title">Welcome Back</h2>
            <p class="login-subtitle">Sign in to Devailey Assistant</p>
          </div>
          <form id="loginForm">
            <div class="form-group">
              <input type="email" id="email" class="form-input" placeholder="Email address" required />
            </div>
            <div class="form-group">
              <input type="password" id="password" class="form-input" placeholder="Password" required />
            </div>
            <button type="submit" id="loginBtn" class="login-btn">Sign In</button>
            <div id="loginError" class="error-text"></div>
          </form>
        </div>
      </div>
      
      <!-- Chat -->
      <div id="chatContainer" class="chat-container hidden">
        <div class="messages-container" id="messagesContainer"></div>
        <div class="input-container">
          <!-- File Context Preview -->
          <div id="fileContextContainer" style="display: none;">
            <div class="file-context-display">
              <div class="file-context-header">
                <div>
                  <div class="file-path" id="fileContextPath"></div>
                  <div class="file-scope" id="fileContextScope"></div>
                </div>
                <button class="file-context-close" id="clearContextBtn" title="Remove file context">×</button>
              </div>
              <div class="file-context-preview" id="fileContextPreview"></div>
            </div>
          </div>
          
          <!-- Quick Access Bar -->
          <div class="quick-access-bar">
            <div class="context-mode-indicator">
              <span class="mode-icon" id="currentModeIcon"><i class="fa-solid fa-file" style="color: #ffffff;"></i></span>
              <span id="currentModeText">Snippet</span>
            </div>
            
            <div class="quick-toggles">
              <button id="quickAutoCapture" class="quick-toggle-btn" title="Auto-capture">
                <span class="toggle-icon"><i class="fa-solid fa-arrows-rotate" style="color: #fafafa;"></i></span>
              </button>
              <button id="quickEditMode" class="quick-toggle-btn" title="Edit mode">
                <span class="toggle-icon"><i class="fa-regular fa-pen-to-square" style="color: #ffffff;"></i></span>
              </button>
            </div>
          </div>
          
          <!-- Message Input -->
          <div class="input-wrapper">
            <textarea id="messageInput" class="message-input" placeholder="Ask me anything..." rows="1"></textarea>
            <button id="sendBtn" class="send-btn" title="Send message">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2,21L23,12L2,3V10L17,12L2,14V21Z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Settings Backdrop -->
    <div id="settingsBackdrop" class="settings-backdrop hidden"></div>
    
    <!-- Settings Panel -->
    <div id="settingsPanel" class="settings-panel hidden">
      <div class="settings-header">
        <h2>Settings</h2>
        <button id="signOutBtn" class="signout-btn" title="Sign out">Sign out</button>
        <button id="closeSettingsBtn" class="close-settings-btn">×</button>
      </div>
      
      <div class="settings-content">
        <div class="settings-section">
          <h3 class="settings-section-title">
            <span class="section-icon">📝</span>
            Context Mode
          </h3>
          <p class="settings-description">Choose how code context is sent with your messages</p>
          
          <div class="settings-option-group">
            <label class="settings-option">
              <input type="radio" name="contextMode" value="snippet" id="settingModeSnippet" checked />
              <div class="option-content">
                <div class="option-header">
                  <span class="option-icon"><i class="fa-solid fa-code" style="color: #ffffff;"></i></span>
                  <span class="option-title">Snippet</span>
                </div>
                <p class="option-description">Send code snippet around cursor position</p>
              </div>
            </label>
            
            <label class="settings-option">
              <input type="radio" name="contextMode" value="file" id="settingModeFile" />
              <div class="option-content">
                <div class="option-header">
                  <span class="option-icon"><i class="fa-solid fa-file" style="color: #ffffff;"></i></span>
                  <span class="option-title">Full File</span>
                </div>
                <p class="option-description">Send entire file content</p>
              </div>
            </label>
            
            <label class="settings-option">
              <input type="radio" name="contextMode" value="project" id="settingModeProject" />
              <div class="option-content">
                <div class="option-header">
                  <span class="option-icon"><i class="fa-solid fa-folder" style="color: #ffffff;"></i></span>
                  <span class="option-title">Project</span>
                </div>
                <p class="option-description">Search entire project codebase</p>
              </div>
            </label>
          </div>
          
          <div id="settingsFilePreview" class="settings-file-preview" style="display: none;">
            <div class="preview-header">
              <span class="preview-label">Current Context:</span>
              <button id="settingsClearContext" class="preview-clear-btn" title="Clear context"><i class="fa-solid fa-xmark" style="color: #ffffff;"></i></button>
            </div>
            <div class="preview-info">
              <div class="preview-file-path" id="settingsFilePath"></div>
              <div class="preview-scope" id="settingsFileScope"></div>
            </div>
            <div class="preview-content" id="settingsFileContent"></div>
          </div>
        </div>
        
        <div class="settings-section">
          <h3 class="settings-section-title">
            <span class="section-icon"><i class="fa-solid fa-arrows-rotate" style="color: #fafafa;"></i></span>
            Auto-Capture
          </h3>
          <p class="settings-description">Automatically capture file context when switching editors</p>
          
          <label class="settings-toggle-label">
            <input type="checkbox" id="settingAutoCapture" />
            <span class="toggle-slider"></span>
            <span class="toggle-text">Enable auto-capture</span>
          </label>
        </div>
        
        <div class="settings-section">
          <h3 class="settings-section-title">
            <span class="section-icon"><i class="fa-regular fa-pen-to-square" style="color: #ffffff;"></i></span>
            Edit Mode
          </h3>
          <p class="settings-description">Enable AI-powered code editing capabilities</p>
          
          <label class="settings-toggle-label">
            <input type="checkbox" id="settingEditMode" />
            <span class="toggle-slider"></span>
            <span class="toggle-text">Enable edit mode</span>
          </label>
        </div>
        
        <div class="settings-section">
          <h3 class="settings-section-title">
            <span class="section-icon"><i class="fa-solid fa-magnifying-glass" style="color: #ffffff;"></i></span>
            Project Indexing
          </h3>
          <p class="settings-description">Index your workspace for project-wide search</p>
          
          <button id="settingIndexWorkspace" class="settings-action-btn">
            <span class="btn-icon">🔄</span>
            Index Workspace
          </button>
          <div id="indexStatus" class="index-status"></div>
        </div>
      </div>
    </div>
  </div>`;
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
