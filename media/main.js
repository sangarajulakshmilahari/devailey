(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const API_BASE = 'http://202.153.39.93:7067/api/vscode';

  // Initialize state
  let state = (() => {
    if (vscode && typeof vscode.getState === 'function') {
      const persistedState = vscode.getState();
      if (persistedState) {
        return { ...persistedState };
      }
    }
    return {
      token: null,
      username: null,
      transcript: [],
      currentSessionId: null,
      refreshToken: null
    };
  })();

  if (state.token === undefined) state.token = null;
  if (state.username === undefined) state.username = null;
  if (state.transcript === undefined) state.transcript = [];
  if (state.currentSessionId === undefined) state.currentSessionId = null;
  if (state.refreshToken === undefined) state.refreshToken = null;

  let isLoading = false;
  let transcript = [...state.transcript];
  let currentSessionId = state.currentSessionId;
  let allSessions = [];
  let currentFileContext = null;
  let autoCaptureEnabled = false;
  let currentMode = 'snippet';
  let editModeEnabled = false;
  let workspaceIndexed = false;
  let activityRibbonEl = null;
  let activityTextEl = null;
  let activityDismissEl = null;

  let activityTimer = null;
  let activityHardHideTimer = null;
  // DOM elements
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const loginContainer = document.getElementById('loginContainer');
  const chatContainer = document.getElementById('chatContainer');
  const loginForm = document.getElementById('loginForm');
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');
  const messagesContainer = document.getElementById('messagesContainer');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const sidebar = document.getElementById('sidebar');
  const chatSessions = document.getElementById('chatSessions');
  const signOutBtn = document.getElementById('signOutBtn');
  if (state.currentMode) currentMode = state.currentMode;
  if (typeof state.workspaceIndexed === 'boolean') workspaceIndexed = state.workspaceIndexed;
  if (typeof state.autoCaptureEnabled === 'boolean') autoCaptureEnabled = state.autoCaptureEnabled;
  if (typeof state.editModeEnabled === 'boolean') editModeEnabled = state.editModeEnabled;
  window.addEventListener('error', (e) => {
    console.error('[DevAlley] 💥 Webview crashed:', e.error || e.message);

    // Show a visible banner in UI (so you don't miss it)
    const banner = document.createElement('div');
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:99999;" +
      "background:#ff4d4f;color:#fff;padding:10px;font-size:12px;" +
      "font-family:monospace;white-space:pre-wrap;max-height:40vh;overflow:auto;";
    banner.textContent =
      "[DevAlley] Webview error:\n" + (e.error?.stack || e.message || 'Unknown error');
    document.body.appendChild(banner);
  });

  // Sidebar resizing
  const resizer = document.getElementById('sidebarResizer');

  if (resizer && sidebar) {
    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const newWidth = e.clientX;

      if (newWidth >= 200 && newWidth <= 480) {
        sidebar.style.width = `${newWidth}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;

      isResizing = false;
      document.body.style.cursor = 'default';
    });
  }


  // Utility functions
  function saveState() {
    try {
      if (vscode && vscode.setState) {
        state.transcript = transcript.slice(-50);
        state.currentSessionId = currentSessionId;
        vscode.setState({
          token: state.token,
          username: state.username,
          refreshToken: state.refreshToken,
          transcript: state.transcript,
          currentSessionId: currentSessionId,
          currentMode,
          workspaceIndexed,
          autoCaptureEnabled,
          editModeEnabled
        });
      }
    } catch (error) {
      console.error('[DevAlley] Save state error:', error);
    }
  }
  function initActivityRibbon() {
    activityRibbonEl = document.getElementById('activityRibbon');
    activityTextEl = document.getElementById('activityText');
    activityDismissEl = document.getElementById('activityClose');

    if (!activityRibbonEl || !activityTextEl) {
      console.warn('[DevAlley] Activity ribbon elements not found');
      return;
    }

    if (activityDismissEl) {
      activityDismissEl.addEventListener('click', () => hideActivity(true));
    }
  }
  function showActivity(text, level = 'info', opts = {}) {
    if (!activityRibbonEl || !activityTextEl) return;

    const allowed = new Set(['info', 'success', 'error']);
    level = allowed.has(level) ? level : 'info';

    if (activityTimer) clearTimeout(activityTimer);
    if (activityHardHideTimer) clearTimeout(activityHardHideTimer);

    activityRibbonEl.classList.remove('hidden', 'info', 'success', 'error');
    activityRibbonEl.classList.add(level);

    activityTextEl.textContent = (text || 'Working…').trim();

    const autoHideMs =
      typeof opts.autoHideMs === 'number'
        ? opts.autoHideMs
        : (level === 'success' ? 1800 : level === 'error' ? 7000 : 3500);

    if (opts.sticky) return;

    activityTimer = setTimeout(() => {
      hideActivity(false);
    }, autoHideMs);
  }

  function hideActivity(immediate = false) {
    if (!activityRibbonEl) return;

    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = null;

    if (activityHardHideTimer) clearTimeout(activityHardHideTimer);
    activityHardHideTimer = null;

    if (immediate) {
      activityRibbonEl.classList.add('hidden');
      activityRibbonEl.classList.remove('info', 'success', 'error');
      return;
    }

    // If you add CSS transition later, this delay is where it can complete.
    activityHardHideTimer = setTimeout(() => {
      activityRibbonEl.classList.add('hidden');
      activityRibbonEl.classList.remove('info', 'success', 'error');
    }, 150);
  }
  function signOutUser() {
    try {
      console.log('[DevAlley] Signing out user');

      // Clear local state
      state.token = null;
      state.username = null;
      state.refreshToken = null;
      currentSessionId = null;
      transcript = [];

      saveState();

      // Tell extension to clear secrets
      vscode.postMessage({ type: 'auth:clear' });

      // Reset UI
      showLogin();
      setStatus(false, 'Please sign in');
      showActivity('✅ Signed out', 'success');

    } catch (e) {
      console.error('[DevAlley] Sign out failed:', e);
      showActivity('❌ Sign out failed', 'error');
    }
  }

  function setStatus(connected, text) {
    if (statusDot) statusDot.className = 'status-dot' + (connected ? ' connected' : '');
    if (statusText) statusText.textContent = text;
  }

  // Settings Panel Toggle
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');

  function openSettings() {
    settingsPanel?.classList.remove('hidden');
    settingsBackdrop?.classList.remove('hidden');
  }

  function closeSettings() {
    settingsPanel?.classList.add('hidden');
    settingsBackdrop?.classList.add('hidden');
  }

  settingsToggle?.addEventListener('click', openSettings);
  closeSettingsBtn?.addEventListener('click', closeSettings);
  settingsBackdrop?.addEventListener('click', closeSettings);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel?.classList.contains('hidden')) {
      closeSettings();
    }
  });

  // Auto-capture sync
  const settingAutoCapture = document.getElementById('settingAutoCapture');
  const quickAutoCapture = document.getElementById('quickAutoCapture');

  // Auto-capture change handler
  settingAutoCapture?.addEventListener('change', (e) => {
    autoCaptureEnabled = e.target.checked;
    quickAutoCapture?.classList.toggle('active', e.target.checked);

    if (e.target.checked && (currentMode === 'file' || currentMode === 'snippet')) {
      console.log('[DevAlley] Auto-capture enabled, capturing current file');
      vscode.postMessage({ type: 'getFileContext' });
    }
    vscode.postMessage({ type: 'toggleAutoCapture', enabled: e.target.checked });
  });


  quickAutoCapture?.addEventListener('click', () => {
    if (settingAutoCapture) {
      settingAutoCapture.checked = !settingAutoCapture.checked;
      settingAutoCapture.dispatchEvent(new Event('change'));
    }
  });

  // Edit mode sync
  const settingEditMode = document.getElementById('settingEditMode');
  const quickEditMode = document.getElementById('quickEditMode');

  // Edit mode change handler
  settingEditMode?.addEventListener('change', (e) => {
    editModeEnabled = e.target.checked;
    quickEditMode?.classList.toggle('active', e.target.checked);
    console.log('[DevAlley] Edit mode:', e.target.checked ? 'enabled' : 'disabled');
    saveState();
    vscode.postMessage({ type: 'prefs:set', key: 'editMode', value: editModeEnabled });
  });

  quickEditMode?.addEventListener('click', () => {
    if (settingEditMode) {
      settingEditMode.checked = !settingEditMode.checked;
      settingEditMode.dispatchEvent(new Event('change'));
    }
  });

  // Index workspace
  document.getElementById('settingIndexWorkspace')?.addEventListener('click', () => {
    const btn = document.getElementById('settingIndexWorkspace');
    const statusEl = document.getElementById('indexStatus');

    if (btn && statusEl) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span> Indexing...';
      statusEl.textContent = 'Please wait, this may take a minute...';
      statusEl.style.color = 'var(--vscode-textLink-foreground)';

      vscode.postMessage({ type: 'indexWorkspace' });
    }
  });

  const contextModeRadios = document.querySelectorAll('input[name="contextMode"]');
  const currentModeIcon = document.getElementById('currentModeIcon');
  const currentModeText = document.getElementById('currentModeText');
  function bindSettingsActions() {
    const signOutBtn = document.getElementById('signOutBtn');

    if (signOutBtn) {
      signOutBtn.addEventListener('click', signOutUser);
    }
  }

  // Context mode change handler
  contextModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const mode = e.target.value;

const icons = {
  snippet: '<i class="fa-solid fa-file" style="color:#ffffff;"></i>',
  file: '<i class="fa-solid fa-file-lines" style="color:#ffffff;"></i>',
  project: '<i class="fa-solid fa-folder" style="color:#ffffff;"></i>',
};

const labels = {
  snippet: 'Snippet',
  file: 'Full File',
  project: 'Project',
};

currentMode = mode;
saveState();

vscode.postMessage({ type: 'prefs:set', key: 'contextMode', value: mode });

if (currentModeIcon) currentModeIcon.innerHTML = icons[mode];
if (currentModeText) currentModeText.textContent = labels[mode];


      console.log('[DevAlley] Mode changed to:', mode);

      if (mode === 'file' || mode === 'snippet') {
        console.log('[DevAlley] Requesting file context for mode:', mode);
        vscode.postMessage({ type: 'getFileContext' });
      } else if (mode === 'project') {
        clearFileContext();
      }
    });
  });

  function tryParseEditPayload(raw) {
    if (!raw) return null;

    // If backend already returns an object (rare)
    if (typeof raw === 'object') {
      return (raw.edits && Array.isArray(raw.edits)) ? raw : null;
    }

    if (typeof raw !== 'string') return null;
    const text = raw.trim();

    // A) Direct JSON
    try {
      const obj = JSON.parse(text);
      if (obj && obj.edits && Array.isArray(obj.edits)) return obj;
    } catch (_) { }

    // B) ```json ... ```
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence && fence[1]) {
      try {
        const obj = JSON.parse(fence[1].trim());
        if (obj && obj.edits && Array.isArray(obj.edits)) return obj;
      } catch (_) { }
    }

    // C) First { ... last }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        const obj = JSON.parse(text.slice(first, last + 1));
        if (obj && obj.edits && Array.isArray(obj.edits)) return obj;
      } catch (_) { }
    }

    return null;
  }



  // Message formatting functions
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function parseAndRenderMessage(content, isAssistant) {
    if (!isAssistant) {
      return escapeHtml(content);
    }

    let html = content;
    const codeBlocks = [];

    html = html.replace(/```([\w]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const placeholder = '___CODE_BLOCK_' + codeBlocks.length + '___';
      codeBlocks.push({ lang: lang || 'text', code: code.trim() });
      return placeholder;
    });

    html = escapeHtml(html);

    codeBlocks.forEach((block, index) => {
      const rendered = renderCodeBlock(block.code, block.lang);
      html = html.replace('___CODE_BLOCK_' + index + '___', rendered);
    });

    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  function renderCodeBlock(code, language) {
    const codeId = 'code_' + Math.random().toString(36).substr(2, 9);
    return `<div class="code-block">
        <div class="code-header">
          <span class="code-language">${language}</span>
          <div class="code-actions">
            <button class="code-btn" data-code-id="${codeId}">
              <span class="code-btn-text">Copy</span>
            </button>
          </div>
        </div>
        <pre class="code-content" id="${codeId}"><code>${escapeHtml(code)}</code></pre>
      </div>`;
  }

  function setupCodeButtons() {
    document.querySelectorAll('.code-btn').forEach(btn => {
      if (btn.dataset.initialized) return;
      btn.dataset.initialized = 'true';

      btn.addEventListener('click', async () => {
        const codeId = btn.dataset.codeId;
        const codeEl = document.getElementById(codeId);
        if (!codeEl) return;

        const code = codeEl.textContent || codeEl.innerText;

        try {
          await navigator.clipboard.writeText(code);
          const btnText = btn.querySelector('.code-btn-text');
          const originalText = btnText.textContent;
          btnText.textContent = 'Copied!';
          btn.classList.add('copied');

          setTimeout(() => {
            btnText.textContent = originalText;
            btn.classList.remove('copied');
          }, 2000);
        } catch (error) {
          console.error('[DevAlley] Copy failed:', error);
        }
      });
    });
  }

  // Session management
  async function loadChatSessions() {
    if (!state.token) return;

    try {
      const resp = await apiFetch('/sessions');

      const data = await resp.json();

      if (resp.ok && data.sessions) {
        allSessions = data.sessions;
        displayChatSessions();
      }
    } catch (error) {
      console.error('[DevAlley] Load sessions error:', error);
      if (chatSessions) {
        chatSessions.innerHTML = '<div style="text-align: center; color: var(--muted); font-size: 12px; padding: 20px;">Failed to load conversations</div>';
      }
    }
  }

  function displayChatSessions() {
    if (!chatSessions) return;

    chatSessions.innerHTML = '';

    if (allSessions.length === 0) {
      chatSessions.innerHTML = '<div style="text-align: center; color: var(--muted); font-size: 12px; padding: 20px;">No previous conversations</div>';
      return;
    }

    allSessions.forEach((session) => {
      const sessionEl = document.createElement('div');
      sessionEl.className = 'chat-session-item';
      if (session.session_id === currentSessionId) {
        sessionEl.classList.add('active');
      }

      const date = new Date(session.last_activity);
      const dateStr = date.toLocaleDateString();
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      sessionEl.innerHTML = `<div class="session-title">Chat · ${session.message_count} messages</div><div class="session-info"><span>${dateStr}</span><span>${timeStr}</span></div>`;

      sessionEl.addEventListener('click', () => {
        loadSession(session.session_id);
      });

      chatSessions.appendChild(sessionEl);
    });
  }

  async function loadSession(sessionId) {
    if (!state.token || !sessionId || sessionId === currentSessionId) return;

    try {
      const resp = await apiFetch('/conversations?session_id=' + sessionId + '&limit=50');

      const data = await resp.json();

      if (resp.ok && data.messages) {
        currentSessionId = sessionId;
        transcript = data.messages;
        saveState();

        if (messagesContainer) {
          messagesContainer.innerHTML = '';
          restoreMessages();
        }

        displayChatSessions();
      }
    } catch (error) {
      console.error('[DevAlley] Load session error:', error);
    }
  }

  function startNewChat() {
    currentSessionId = null;
    transcript = [];

    if (messagesContainer) {
      messagesContainer.innerHTML = '';
      addSystemMessageToDOM('Started new chat session. Ask me anything!');
    }

    saveState();
    displayChatSessions();
  }

  // Authentication
  function showLogin() {
    if (loginContainer) {
      loginContainer.classList.remove('hidden');
      loginContainer.style.display = 'flex';
    }
    if (chatContainer) {
      chatContainer.classList.add('hidden');
      chatContainer.style.display = 'none';
    }
    if (sidebar) sidebar.classList.add('hidden');
    setStatus(false, 'Not signed in');
  }

  function showChat() {
    if (loginContainer) {
      loginContainer.classList.add('hidden');
      loginContainer.style.display = 'none';
    }
    if (chatContainer) {
      chatContainer.classList.remove('hidden');
      chatContainer.style.display = 'flex';
    }
    if (sidebar) sidebar.classList.remove('hidden');

    loadChatSessions();

    // If we have any transcript, restore it once. Otherwise show a single welcome message
    if (transcript.length > 0) {
      restoreMessages();
    } else {
      // Only add welcome message when the messages container is empty to avoid duplicates
      if (!messagesContainer || messagesContainer.children.length === 0) {
        addSystemMessageToDOM('Welcome! Start a new conversation or select a previous chat.');
      }
    }

    if (messageInput) messageInput.focus();
  }

  function setTokens(accessToken, refreshToken, username) {
    state.token = accessToken || null;
    state.refreshToken = refreshToken || state.refreshToken || null;
    if (username) state.username = username;
    saveState();
    vscode.postMessage({
      type: 'auth:set',
      token: state.token,
      refreshToken: state.refreshToken,
      username: state.username || ''
    });
  }

  async function apiFetch(path, opts = {}) {
    const url = path.startsWith('http') ? path : (API_BASE + path);
    const baseHeaders = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const doFetch = async (token) =>
      fetch(url, {
        ...opts,
        headers: token
          ? { ...baseHeaders, Authorization: 'Bearer ' + token }
          : baseHeaders
      });

    let res = await doFetch(state.token);

    if (res.status === 401 && state.refreshToken) {
      try {
        const refreshRes = await fetch(API_BASE + '/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: state.refreshToken })
        });

        if (refreshRes.ok) {
          const data = await refreshRes.json();
          setTokens(data.access_token, state.refreshToken, data.username);
          res = await doFetch(data.access_token); // retry once
        } else {
          signOutUser();
        }
      } catch (err) {
        console.error('[DevAlley] Refresh failed:', err);
        signOutUser();
      }
    }

    return res;
  }

  async function handleLogin(e) {
    e.preventDefault();
    if (isLoading) return;

    try {
      const emailEl = document.getElementById('email');
      const passEl = document.getElementById('password');
      const email = (emailEl && emailEl.value) ? emailEl.value.trim() : '';
      const password = (passEl && passEl.value) ? passEl.value : '';

      if (!email || !password) {
        if (loginError) loginError.textContent = 'Email and password required';
        return;
      }

      isLoading = true;
      if (loginBtn) loginBtn.disabled = true;
      if (loginError) loginError.textContent = '';
      if (loginBtn) loginBtn.textContent = 'Signing in...';

      const resp = await fetch(API_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await resp.json();

      if (resp.ok && data.access_token) {
        const access = data.access_token;
        const refresh = data.refresh_token || null;
        const username = data.username || email;

        setTokens(access, refresh, username);

        showChat();
        // setStatus(true, 'Signed in as ' + (state.username || 'User'));
        addSystemMessageToDOM('Signed in successfully as ' + (state.username || 'User'));
      } else {
        throw new Error(data.error || 'Login failed');
      }
    } catch (error) {
      console.error('[DevAlley] Login error:', error);
      if (loginError) loginError.textContent = error.message;
      setStatus(false, 'Login failed');
    } finally {
      isLoading = false;
      if (loginBtn) loginBtn.disabled = false;
      if (loginBtn) loginBtn.textContent = 'Sign In';
    }
  }
  function requestFreshFileContext(modeWanted = 'file') {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('Timed out waiting for file context'));
      }, 8000);

      function onMsg(event) {
        const msg = event.data;
        if (!msg || msg.type !== 'fileContext:response' || msg.requestId !== requestId) return;

        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        resolve(msg.fileContext || null);
      }

      window.addEventListener('message', onMsg);

      vscode.postMessage({
        type: 'getFileContext',
        requestId,
        mode: modeWanted
      });
    });
  }


  // File context
  function attachCurrentFile() {
    console.log('[DevAlley] Requesting file context');
    vscode.postMessage({ type: 'getFileContext' });
  }

  function clearFileContext() {
    currentFileContext = null;
    const container = document.getElementById('fileContextContainer');
    if (container) container.style.display = 'none';

    const settingsPreview = document.getElementById('settingsFilePreview');
    if (settingsPreview) settingsPreview.style.display = 'none';
  }

  function displayFileContext(fileContext) {
    console.log('[DevAlley] displayFileContext called with:', fileContext);

    if (!fileContext) {
      // ✅ Replace alert() - it's blocked by sandbox
      console.warn('[DevAlley] No file context - no active editor');
      // addSystemMessageToDOM('⚠️ No active file. Please open a code file in the editor.');
      return;
    }

    currentFileContext = fileContext;
    console.log('[DevAlley] File context stored:', {
      filePath: fileContext.filePath,
      hasFullText: !!fileContext.fullText,
      fullTextLength: fileContext.fullText?.length,
      hasSnippet: !!fileContext.snippetText,
      snippetLength: fileContext.snippetText?.length,
      hasSelection: !!fileContext.selectedText,
      selectionLength: fileContext.selectedText?.length
    });

    // Rest of your code...
    const container = document.getElementById('fileContextContainer');
    const pathEl = document.getElementById('fileContextPath');
    const scopeEl = document.getElementById('fileContextScope');
    const previewEl = document.getElementById('fileContextPreview');

    const settingsPreview = document.getElementById('settingsFilePreview');
    const settingsPathEl = document.getElementById('settingsFilePath');
    const settingsScopeEl = document.getElementById('settingsFileScope');
    const settingsContentEl = document.getElementById('settingsFileContent');

    const fileName = fileContext.filePath.split(/[\/\\]/).pop();
    let scope = 'Full File';
    let previewText = fileContext.fullText;
    let scopeIcon = '📋';

    // Priority: Selected text > Mode-specific text
    if (fileContext.selectedText && fileContext.selectedText.trim().length > 0) {
      scope = 'Selected Text';
      previewText = fileContext.selectedText;
      scopeIcon = '✂️';
    } else if (currentMode === 'snippet') {
      scope = `Snippet (Lines ${fileContext.snippetStartLine}-${fileContext.snippetEndLine})`;
      previewText = fileContext.snippetText || fileContext.fullText;
      scopeIcon = '📄';
    } else if (currentMode === 'file') {
      scope = 'Full File';
      previewText = fileContext.fullText;
      scopeIcon = '📋';
    }

    console.log('[DevAlley] Display context - Mode:', currentMode, 'Scope:', scope, 'Preview length:', previewText?.length);

    if (pathEl) pathEl.textContent = fileName;
    if (scopeEl) scopeEl.innerHTML = `${scopeIcon} ${scope} <span style="color: var(--muted);">(${fileContext.languageId})</span>`;

    const maxPreviewLength = 500;
    const displayText = previewText.substring(0, maxPreviewLength);
    if (previewEl) previewEl.textContent = displayText + (previewText.length > maxPreviewLength ? '...' : '');
    if (container) container.style.display = 'block';

    // Update settings panel preview
    if (settingsPreview && settingsPathEl && settingsScopeEl && settingsContentEl) {
      settingsPathEl.textContent = fileContext.filePath;
      settingsScopeEl.textContent = `${scopeIcon} ${scope} (${fileContext.languageId})`;
      settingsContentEl.textContent = displayText + (previewText.length > maxPreviewLength ? '...' : '');
      settingsPreview.style.display = 'block';
    }

    console.log('[DevAlley] ✅ File context displayed successfully');
  }

  // Message bubbles
  function addTypingBubble() {
    const el = document.createElement('div');
    el.className = 'message assistant typing';
    el.setAttribute('data-typing', '1');

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = '<div class="typing-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';

    el.appendChild(bubble);
    if (messagesContainer) {
      messagesContainer.appendChild(el);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    return el;
  }

  function replaceTypingBubble(el, text) {
    if (!el) {
      addAssistantMessage(text);
      return;
    }

    el.classList.remove('typing');
    const bubble = el.querySelector('.message-bubble');
    if (bubble) {
      bubble.innerHTML = parseAndRenderMessage(text, true);
    }

    setupCodeButtons();
  }

  // Send message
  async function sendMessage() {
    if (!messageInput) return;

    const message = messageInput.value.trim();
    if (!message || isLoading || !state.token) return;

    try {
      // Clear input immediately for smooth UX
      addUserMessage(message);
      messageInput.value = '';
      messageInput.style.height = 'auto';

      isLoading = true;
      if (sendBtn) sendBtn.disabled = true;
      setStatus(true, 'Thinking…');

      // Start file context capture in background (don't await)
      let fileContextPromise = null;
      if (editModeEnabled) {
        fileContextPromise = requestFreshFileContext('file').catch(e => {
          console.warn('[DevAlley] Could not capture fresh file context:', e);
          return null;
        });
      }

      if (currentMode === 'project' && !workspaceIndexed) {
        addSystemMessageToDOM('⚠️ Please index the workspace first by clicking "Index Workspace" in settings!');
        isLoading = false;
        if (sendBtn) sendBtn.disabled = false;
        setStatus(true, 'Signed in as ' + (state.username || 'User'));
        return;
      }

      if (currentMode === 'project') {
        // For project mode, capture context then proceed
        if (fileContextPromise) {
          const fresh = await fileContextPromise;
          if (fresh) currentFileContext = fresh;
        }

        setStatus(true, 'Searching codebase…');
        addSystemMessageToDOM('🔍 Searching project for relevant code...');
        vscode.postMessage({ type: 'getWorkspaceContext', query: message });
        window.pendingMessage = message;
        return;
      }

      // NON-PROJECT PATH
      const typingEl = addTypingBubble();

      // Wait for file context if needed, but don't block UI
      if (fileContextPromise) {
        const fresh = await fileContextPromise;
        if (fresh) currentFileContext = fresh;
      }

      const requestBody = {
        content: message,
        model: 'version-2',
        edit_mode: editModeEnabled
      };

      if (currentSessionId) requestBody.session_id = currentSessionId;

      // Add file context to request
      if (currentFileContext) {
        if (editModeEnabled || currentMode === 'file') {
          requestBody.file_context = {
            filePath: currentFileContext.filePath,
            languageId: currentFileContext.languageId,
            content: currentFileContext.fullText,
            mode: 'file'
          };
        } else {
          requestBody.file_context = {
            filePath: currentFileContext.filePath,
            languageId: currentFileContext.languageId,
            content: currentFileContext.snippetText,
            mode: 'snippet',
            startLine: currentFileContext.snippetStartLine,
            endLine: currentFileContext.snippetEndLine
          };
        }

        if (currentFileContext.selectedText && currentFileContext.selectedText.trim()) {
          requestBody.file_context.content = currentFileContext.selectedText;
          requestBody.file_context.mode = 'selection';
        }
      }

      const resp = await apiFetch('/send_message', {
        method: 'POST',
        body: JSON.stringify(requestBody)
      });

      if (!editModeEnabled) clearFileContext();

      const data = await resp.json();

      if (resp.ok) {
        if (data.session_id && !currentSessionId) {
          currentSessionId = data.session_id;
          saveState();
          loadChatSessions();
        }

        const editPayload = tryParseEditPayload(data.assistant);

        if (editPayload && editPayload.edit_mode) {
          handleEditResponse(editPayload, typingEl);
          return;
        }

        replaceTypingBubble(typingEl, data.assistant || 'No response received');
      } else {
        if (typingEl && typingEl.remove) typingEl.remove();
        throw new Error(data.error || 'Request failed');
      }

    } catch (error) {
      console.error('[DevAlley] Send error:', error);
      const typing = document.querySelector('.message.typing');
      if (typing) typing.remove();
      addErrorMessageToDOM('Error: ' + error.message);
    } finally {
      isLoading = false;
      if (sendBtn) sendBtn.disabled = false;
      setStatus(true, 'Signed in as ' + (state.username || 'User'));
      if (messageInput) messageInput.focus();
    }
  }

  async function sendMessageWithWorkspaceContext(workspaceContext) {
    console.log('[DevAlley] Sending with workspace context');

    const message = window.pendingMessage;
    if (!message) return;
    window.pendingMessage = null;

    const typingEl = addTypingBubble();

    try {
      // Background file context capture for edit mode
      if (editModeEnabled) {
        try {
          const fresh = await requestFreshFileContext('file');
          if (fresh) currentFileContext = fresh;
        } catch (e) {
          console.warn('[DevAlley] Could not capture fresh file context:', e);
        }
      }

      const requestBody = {
        content: message,
        model: 'version-2',
        workspace_context: workspaceContext,
        edit_mode: editModeEnabled,
        session_id: currentSessionId
      };

      // Include file_context in project mode when edit mode is on
      if (editModeEnabled && currentFileContext?.fullText) {
        requestBody.file_context = {
          filePath: currentFileContext.filePath,
          languageId: currentFileContext.languageId,
          content: currentFileContext.fullText,
          mode: 'file'
        };
      }

      const resp = await apiFetch('/send_message', {
        method: 'POST',
        body: JSON.stringify(requestBody)
      });

      const data = await resp.json();

      if (resp.ok) {
        const editPayload = tryParseEditPayload(data.assistant);
        if (editPayload && editPayload.edit_mode) {
          handleEditResponse(editPayload, typingEl);
          return;
        }
        replaceTypingBubble(typingEl, data.assistant || 'No response received');
      } else {
        if (typingEl && typingEl.remove) typingEl.remove();
        throw new Error(data.error || 'Request failed');
      }
    } catch (error) {
      console.error('[DevAlley] Send with workspace context error:', error);
      if (typingEl && typingEl.remove) typingEl.remove();
      addErrorMessageToDOM('Error: ' + error.message);
    } finally {
      isLoading = false;
      if (sendBtn) sendBtn.disabled = false;
      setStatus(true, 'Signed in as ' + (state.username || 'User'));
    }
  }

  function handleEditResponse(parsed, typingEl) {
    console.log('[DevAlley] Handle edit response:', parsed);

    if (typingEl && typingEl.remove) typingEl.remove();

    const edits = Array.isArray(parsed?.edits) ? parsed.edits : [];
    const explanation = parsed?.explanation || 'No detailed explanation provided.';

    if (edits.length === 0) {
      console.log('[DevAlley] No edits found');
      addSystemMessageToDOM("✅ No code changes needed - code is already optimal!");
      return;
    }

    // Normalize edits for safer rendering
    const normalizedEdits = edits.map((e) => {
      const op = (e?.op || 'modify').toLowerCase();
      return {
        op: (op === 'create' || op === 'delete' || op === 'modify') ? op : 'modify',
        filePath: (e?.filePath || 'unknown').trim(),
        startLine: Number.isFinite(Number(e?.startLine)) ? Number(e.startLine) : null,
        endLine: Number.isFinite(Number(e?.endLine)) ? Number(e.endLine) : null,
        oldText: typeof e?.oldText === 'string' ? e.oldText : '',
        newText: typeof e?.newText === 'string' ? e.newText : ''
      };
    });

    // UI container
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant edit-message';
    messageEl.setAttribute('data-edit-message', 'true');

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'message-bubble';

    let currentPreviewIndex = 0;

    function getFileName(fp) {
      return (fp || 'unknown').split(/[\/\\]/).pop() || fp;
    }

    function describeEdit(e) {
      const fileName = getFileName(e.filePath);

      if (e.op === 'create') {
        const newLines = (e.newText || '').split(/\r?\n/).length;
        return `🆕 Create <strong>${escapeHtml(fileName)}</strong> <span style="color: var(--muted);">(${newLines} lines)</span>`;
      }

      if (e.op === 'delete') {
        return `🗑️ Delete <strong>${escapeHtml(fileName)}</strong>`;
      }

      // modify
      const s = (typeof e.startLine === 'number') ? (e.startLine + 1) : '?';
      const en = (typeof e.endLine === 'number') ? (e.endLine + 1) : '?';
      const newLines = (e.newText || '').split(/\r?\n/).length;
      return `✏️ Modify <strong>${escapeHtml(fileName)}</strong><br>
            <span style="color: var(--muted);">Lines ${s}-${en} (${newLines} lines)</span>`;
    }

    function buildEditItemsHTML() {
      return normalizedEdits.map((e, idx) => {
        return `
        <div class="edit-item" data-edit-index="${idx}">
          ${describeEdit(e)}
        </div>
      `;
      }).join('');
    }

    bubbleEl.innerHTML = `
    <div class="message-header">
      <span class="role-badge assistant">🤖 AI Edit</span>
      <span class="timestamp">${(typeof formatTime === 'function') ? formatTime(Date.now()) : ''}</span>
    </div>

    <div class="edit-explanation">
      <strong>📋 CHANGE SUMMARY:</strong>
      <div class="explanation-text">${escapeHtml(explanation)}</div>
    </div>

    <div class="edit-message">${escapeHtml(parsed?.message || `💡 ${normalizedEdits.length} change(s) proposed`)}</div>

    <div class="edit-summary">
      ${buildEditItemsHTML()}
    </div>

    <div class="edit-status" style="display:none; padding:10px; margin:10px 0; border-radius:6px; font-size:13px;"></div>

    <div class="edit-actions">
      <button class="btn-edit-preview" data-action="preview">
        👁️ Preview <span class="preview-counter">1/${normalizedEdits.length}</span>
      </button>
      <button class="btn-edit-accept" data-action="accept">✅ Accept All</button>
      <button class="btn-edit-reject" data-action="reject">❌ Reject</button>
    </div>
  `;

    messageEl.appendChild(bubbleEl);

    if (messagesContainer) {
      messagesContainer.appendChild(messageEl);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Store pending edits globally
    window.pendingEdits = normalizedEdits;
    window.currentEditMessage = messageEl;

    const statusEl = messageEl.querySelector('.edit-status');
    const previewBtn = messageEl.querySelector('.btn-edit-preview');
    const acceptBtn = messageEl.querySelector('.btn-edit-accept');
    const rejectBtn = messageEl.querySelector('.btn-edit-reject');
    const previewCounter = messageEl.querySelector('.preview-counter');

    function showStatus(message, type) {
      if (!statusEl) return;
      statusEl.style.display = 'block';
      statusEl.textContent = message;

      if (type === 'success') {
        statusEl.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
        statusEl.style.color = '#10b981';
        statusEl.style.borderLeft = '3px solid #10b981';
      } else if (type === 'error') {
        statusEl.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
        statusEl.style.color = '#ef4444';
        statusEl.style.borderLeft = '3px solid #ef4444';
      } else {
        statusEl.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
        statusEl.style.color = '#3b82f6';
        statusEl.style.borderLeft = '3px solid #3b82f6';
      }
    }

    function setActiveIndex(idx) {
      currentPreviewIndex = Math.max(0, Math.min(idx, normalizedEdits.length - 1));
      if (previewCounter) previewCounter.textContent = `${currentPreviewIndex + 1}/${normalizedEdits.length}`;

      // highlight selected
      messageEl.querySelectorAll('.edit-item').forEach((el) => {
        el.style.background = '';
        el.style.border = '1px solid transparent';
      });
      const active = messageEl.querySelector(`.edit-item[data-edit-index="${currentPreviewIndex}"]`);
      if (active) {
        active.style.background = '#bfdbfe';
        active.style.border = '2px solid #3b82f6';
      }
    }

    function previewCurrent() {
      if (!window.pendingEdits || window.pendingEdits.length === 0) {
        showStatus('❌ No edits available', 'error');
        return;
      }

      const currentEdit = window.pendingEdits[currentPreviewIndex];
      const fileName = getFileName(currentEdit.filePath);

      showStatus(`👁️ Previewing ${fileName} (${currentPreviewIndex + 1}/${normalizedEdits.length})`, 'info');

      vscode.postMessage({
        type: 'previewCodeEdits',
        edits: [currentEdit],
        currentIndex: currentPreviewIndex,
        totalEdits: normalizedEdits.length
      });
    }

    // Clickable list
    messageEl.querySelectorAll('.edit-item').forEach((itemEl) => {
      const idx = Number(itemEl.getAttribute('data-edit-index') || '0');

      itemEl.style.cursor = 'pointer';
      itemEl.style.padding = '12px';
      itemEl.style.borderRadius = '6px';
      itemEl.style.margin = '6px 0';
      itemEl.style.transition = 'all 0.15s';
      itemEl.style.border = '1px solid transparent';

      itemEl.addEventListener('mouseenter', () => {
        if (idx !== currentPreviewIndex) itemEl.style.background = '#dbeafe';
      });
      itemEl.addEventListener('mouseleave', () => {
        if (idx !== currentPreviewIndex) itemEl.style.background = '';
      });

      itemEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex(idx);
        previewCurrent();
      });
    });

    setActiveIndex(0);

    if (previewBtn) {
      previewBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        previewCurrent();
        setActiveIndex((currentPreviewIndex + 1) % normalizedEdits.length);
        previewBtn.innerHTML = `👁️ Preview Next <span class="preview-counter">${currentPreviewIndex + 1}/${normalizedEdits.length}</span>`;
      });
    }

    if (acceptBtn) {
      acceptBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!window.pendingEdits || window.pendingEdits.length === 0) {
          showStatus('❌ No edits to apply', 'error');
          return;
        }

        showStatus('🛠️ Applying edits...', 'info');
        vscode.postMessage({ type: 'applyCodeEdits', edits: window.pendingEdits });
        acceptBtn.disabled = true;
        rejectBtn.disabled = true;
        if (previewBtn) previewBtn.disabled = true;
      });
    }

    if (rejectBtn) {
      rejectBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        window.pendingEdits = null;
        vscode.postMessage({ type: 'rejectPendingEdits' });
        showStatus('❌ All changes rejected', 'error');

        if (acceptBtn) acceptBtn.disabled = true;
        if (rejectBtn) rejectBtn.disabled = true;
        if (previewBtn) previewBtn.disabled = true;
      });
    }
  }

  function addMessageToDOM(role, content, className) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message ' + className;

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'message-bubble';

    if (role === 'assistant') {
      const editPayload = tryParseEditPayload(content);
      if (editPayload && editPayload.edit_mode) {
        handleEditResponse(editPayload, null);
        return;
      }
      bubbleEl.innerHTML = parseAndRenderMessage(content, true);
    } else {
      bubbleEl.innerHTML = parseAndRenderMessage(content, false);
    }

    messageEl.appendChild(bubbleEl);

    if (messagesContainer) {
      messagesContainer.appendChild(messageEl);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    if (role === 'assistant') {
      setupCodeButtons();
    }
  }

  function addMessage(role, content, className) {
    const message = { role, content, timestamp: Date.now() };
    transcript.push(message);
    saveState();
    addMessageToDOM(role, content, className);
  }

  function addUserMessage(content) { addMessage('user', content, 'user'); }
  function addAssistantMessage(content) { addMessage('assistant', content, 'assistant'); }
  function addSystemMessageToDOM(content) { addMessageToDOM('system', content, 'system'); }
  function addErrorMessageToDOM(content) { addMessageToDOM('error', content, 'system'); }

  // Event listeners
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    messageInput.addEventListener('input', () => {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 130) + 'px';
    });
  }

  // Dropdown menu for new chat options
  const newChatDropdownBtn = document.getElementById('newChatDropdownBtn');
  const newChatDropdown = document.getElementById('newChatDropdown');
  
  if (newChatDropdownBtn) {
    newChatDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      newChatDropdown.classList.toggle('hidden');
    });
  }

  // Handle dropdown items
  const dropdownItems = document.querySelectorAll('.dropdown-item');
  if (dropdownItems) {
    dropdownItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        
        if (action === 'new-chat') {
          startNewChat();
        } else if (action === 'new-chat-editor') {
          vscode.postMessage({
            command: 'newChatEditor'
          });
        } else if (action === 'new-chat-window') {
          vscode.postMessage({
            command: 'newChatWindow'
          });
        }
        
        // Close dropdown
        newChatDropdown.classList.add('hidden');
      });
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (newChatDropdown && !newChatDropdown.contains(e.target) && newChatDropdownBtn && !newChatDropdownBtn.contains(e.target)) {
      newChatDropdown.classList.add('hidden');
    }
  });

  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
    });
  }

  // Clear context button
  const clearContextBtn = document.getElementById('clearContextBtn');
  if (clearContextBtn) {
    clearContextBtn.addEventListener('click', () => {
      console.log('[DevAlley] Manual clear file context');
      clearFileContext();
    });
  }

  // Settings clear context button
  document.getElementById('settingsClearContext')?.addEventListener('click', () => {
    console.log('[DevAlley] Settings clear file context');
    clearFileContext();
  });

  window.addEventListener('message', (event) => {
    const message = event.data;

    console.log('[DevAlley] Received message:', message.type);

    switch (message.type) {
      case 'prefs:state': {
        const mode = message.contextMode || 'snippet';
        const radio = document.querySelector(`input[name="contextMode"][value="${mode}"]`);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change'));
        }
        break;
      }


      case 'auth:state': {
        const token = message.token || null;
        const username = message.username || null;
        const refreshToken = message.refreshToken || null;
        if (token && username) {
          state.token = token;
          state.username = username;
          state.refreshToken = refreshToken || state.refreshToken;
          saveState();
          showChat();
          setStatus(true, 'Signed in as ' + username);
          console.log('[DevAlley] Auth state received and applied');
        } else {
          showLogin();
          console.log('[DevAlley] No auth credentials, showing login');
        }
        break;
      }

      case 'auth:forceLogin':
        console.log('[DevAlley] Forced login requested');
        showLogin();
        setStatus(false, 'Please sign in');
        break;

      case 'fileContext:response':
        console.log('[DevAlley] File context received:', message.fileContext);
        currentFileContext = message.fileContext;
        displayFileContext(message.fileContext);
        if (message.autoCapture) {
          console.log('[DevAlley] File auto-captured');
        }
        break;


      case 'editsApplied': {
        console.log('[DevAlley] editsApplied received -> re-capturing context');
        const requestedMode = editModeEnabled ? 'file' : currentMode;
        showActivity('✅ Edits applied. Refreshing context…', 'success', { autoHideMs: 1500 });
        vscode.postMessage({ type: 'getFileContext', mode: requestedMode });
        break;
      }

      case 'workspaceContext:response':
        console.log('[DevAlley] Received workspace context');
        sendMessageWithWorkspaceContext(message.context);
        break;

      case 'indexing:started': {
        console.log('[DevAlley] Indexing started');
        // Ribbon stays visible while indexing
        showActivity('Indexing workspace…', 'info', { sticky: true });
        break;
      }
      case 'indexing:progress': {
        const msg = message.message || '';
        console.log('[DevAlley] Indexing progress:', msg);

        // Update ribbon text (still sticky)
        if (msg) showActivity(msg, 'info', { sticky: true });
        break;
      }

      case 'indexing:complete': {
        console.log('[DevAlley] Indexing complete');
        workspaceIndexed = true;
        saveState();
        const btn = document.getElementById('settingIndexWorkspace');
        const statusEl = document.getElementById('indexStatus');

        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="btn-icon">✅</span> Index Workspace';
        }
        if (statusEl) {
          statusEl.textContent = 'Workspace indexed successfully!';
          statusEl.style.color = '#10b981';
        }

        hideActivity(true);

        if (message.stats) {
          showActivity(
            `✅ Indexed ${message.stats.totalChunks} chunks from ${message.stats.totalFiles} files`,
            'success'
          );
        } else {
          showActivity('✅ Workspace indexed successfully!', 'success');
        }

        break;
      }
      case 'codeEditLog': {
        const level = message.level || 'info';
        const text = message.message || '';
        if (text) showActivity(text, level);
        break;
      }
      case 'indexer:state':
        workspaceIndexed = message.indexed || false;
        saveState();

        const btn = document.getElementById('settingIndexWorkspace');
        const statusEl = document.getElementById('indexStatus');

        if (workspaceIndexed && message.stats) {
          console.log('[DevAlley] Restored indexed state:', message.stats);

          if (btn) {
            btn.innerHTML = '<span class="btn-icon">✅</span> Re-index Workspace';
          }
          if (statusEl) {
            statusEl.textContent = `Indexed ${message.stats.totalChunks} chunks from ${message.stats.totalFiles} files`;
            statusEl.style.color = '#10b981';
          }
        }
        break;

      case 'autoCapture:state':
        autoCaptureEnabled = message.enabled || false;
        if (settingAutoCapture) {
          settingAutoCapture.checked = autoCaptureEnabled;
        }
        if (quickAutoCapture) {
          quickAutoCapture.classList.toggle('active', autoCaptureEnabled);
        }
        console.log('[DevAlley] Auto-capture state synced:', autoCaptureEnabled);
        break;
      case 'editMode:state':
        editModeEnabled = message.enabled || false;
        if (settingEditMode) {
          settingEditMode.checked = editModeEnabled;
        }
        if (quickEditMode) {
          quickEditMode.classList.toggle('active', editModeEnabled);
        }
        saveState();
        console.log('[DevAlley] Edit mode state synced:', editModeEnabled);
        break;
      case 'assistant:log': {
        const text = message.message || '';
        if (!text) break;

        // Heuristic mapping
        const lower = text.toLowerCase();
        let level = 'info';
        if (lower.includes('✅') || lower.includes('applied') || lower.includes('success')) level = 'success';
        if (lower.includes('❌') || lower.includes('failed') || lower.includes('error')) level = 'error';

        showActivity(text, level);
        break;
      }

      default:
        console.log('[DevAlley] Unhandled message type:', message.type);
        break;

    }
  });
  function restoreMessages() {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = '';

    transcript.forEach(msg => {
      if (!msg.role || !msg.content) return;

      const className = msg.role === 'user' ? 'user' :
        msg.role === 'assistant' ? 'assistant' : 'system';

      if (msg.role === 'assistant') {
        // ✅ Skip if already marked as edit response
        if (msg.processed && msg.isEditResponse) {
          console.log('[DevAlley] Skipping processed edit response');
          return;
        }

        const editPayload = tryParseEditPayload(msg.content);
        if (editPayload) {
          console.log('[DevAlley] Restoring edit response with buttons');
          handleEditResponse(editPayload, null);
          return;
        }

      }

      addMessageToDOM(msg.role, msg.content, className);
    });

    if (messagesContainer.children.length === 0) {
      addSystemMessageToDOM('Session restored. Continue your conversation!');
    }

    setupCodeButtons();
  }


  // Initialize UI state on load
  (function initializeUI() {
    initActivityRibbon();

    const preferredMode = state.currentMode || 'snippet';
    const radio = document.querySelector(`input[name="contextMode"][value="${preferredMode}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    }

    console.log('[DevAlley] UI initialized with mode:', currentMode);

    vscode.postMessage({ type: 'webview:ready' });
    vscode.postMessage({ type: 'auth:get' });
    bindSettingsActions();
    setStatus(false, 'Restoring session…');
  })();


})();
