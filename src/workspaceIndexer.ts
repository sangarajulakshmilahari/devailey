import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import axios from 'axios';


export class WorkspaceIndexer {
    private workspacePath: string | null = null;
    private context: vscode.ExtensionContext;

    // Backend configuration
    private readonly apiBaseUrl: string = 'http://202.153.39.93:7067';

    // Extensions to IGNORE (binary/generated files)
    private readonly ignoreExtensions = new Set([
        '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib',
        '.class', '.jar', '.war', '.ear', '.apk', '.ipa', '.deb', '.rpm',
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
        '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wav', '.ogg',
        '.pdf', '.eps', '.psd', '.ai',
        '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.tgz', '.xz',
        '.ttf', '.otf', '.woff', '.woff2', '.eot',
        '.db', '.sqlite', '.sqlite3', '.mdb',
        '.log', '.cache', '.tmp', '.temp',
        '.lock', '.map', '.min.js', '.min.css',
        '.pyc', '.pyo', '.pyd', '.rbc',
    ]);

    private readonly ignoreDirs = new Set([
        'node_modules', '__pycache__', 'venv', 'env', '.env', '.conda',
        'dist', 'build', '.git', '.next', '.nuxt', 'target',
        'bin', 'obj', 'out', 'coverage', '.pytest_cache',
        'vendor', 'Pods', '.gradle', '.vscode',
        '.idea', '.vs', 'bower_components', '.cache', '.parcel-cache',
    ]);

    private readonly maxFileSize = 10 * 1024 * 1024; // 10MB limit

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        console.log('[Indexer] WorkspaceIndexer created');
    }

    private async generateWorkspaceId(): Promise<string> {
        if (!this.workspacePath) return 'unknown';

        const folderName = path.basename(this.workspacePath);
        const workspaceKey = `workspace_id_${this.workspacePath}`;

        // ✅ CHECK ALL STORED KEYS
        const allKeys = this.context.workspaceState.keys();
        console.log('[Indexer] 🔑 All workspaceState keys:', allKeys);
        console.log('[Indexer] Looking for key:', workspaceKey);

        let workspaceId = this.context.workspaceState.get<string>(workspaceKey);

        if (!workspaceId) {
            const pathHash = require('crypto')
                .createHash('md5')
                .update(path.resolve(this.workspacePath))
                .digest('hex')
                .slice(0, 8);

            workspaceId = `${folderName}_${pathHash}`;
            await this.context.workspaceState.update(workspaceKey, workspaceId);
            console.log(`[Indexer] 🆕 Generated NEW workspace ID: ${workspaceId}`);
            console.log(`[Indexer] Saved to key: ${workspaceKey}`);
        } else {
            console.log(`[Indexer] ♻️ Found EXISTING workspace ID: ${workspaceId}`);
        }

        return workspaceId;
    }

    private getAuthHeaders(): any {
        const token = this.context.globalState.get<string>("devAlleyToken");

        console.log("[Indexer] Getting auth headers");
        console.log("[Indexer] Token exists:", !!token);
        if (token) {
            console.log("[Indexer] Token preview:", token.substring(0, 20) + "...");
        }

        if (!token) {
            console.warn("[Indexer] ⚠️ No authentication token found");
            return {
                "Content-Type": "application/json"
            };
        }

        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        };
    }


    async initialize() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('[Indexer] No workspace folder open');
            return;
        }

        this.workspacePath = workspaceFolders[0].uri.fsPath;
        console.log('[Indexer] Initializing for workspace:', this.workspacePath);
        console.log('[Indexer] ✅ Indexer ready (will connect on first use)');
    }

    private async ensureConnected(): Promise<boolean> {
        const token = this.context.globalState.get<string>('devAlleyToken');

        if (!token) {
            console.error('[Indexer] No authentication token found');
            vscode.window.showErrorMessage('Please login to Devailey first');
            return false;
        }

        try {
            console.log('[Indexer] Verifying backend connection...');
            const workspaceId = await this.generateWorkspaceId();  // ✅ Get workspace ID

            const response = await axios.get(
                `${this.apiBaseUrl}/api/vscode/index/stats`,
                {
                    timeout: 5000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        workspace_id: workspaceId  // ✅ Check THIS workspace
                    }
                }
            );

            if (response.data.success) {
                const stats = response.data.stats;
                console.log(`[Indexer] ✅ Workspace ${workspaceId} has ${stats.total_chunks} chunks, ${stats.total_files} files`);
                return true;
            }

            console.error('[Indexer] Backend response invalid:', response.data);
            return false;

        } catch (error: any) {
            console.error('[Indexer] ❌ Connection test failed:', error.message);

            if (error.response?.status === 401) {
                vscode.window.showErrorMessage('Devailey: Authentication failed. Please login again.');
            } else if (error.response?.status) {
                vscode.window.showErrorMessage(`Devailey: Backend error (${error.response.status}). Check server logs.`);
            } else {
                vscode.window.showErrorMessage(`Devailey: Cannot connect to backend. Is the server running?`);
            }

            return false;
        }
    }

    async indexWorkspace(progressCallback?: (msg: string) => void): Promise<number> {
        if (!this.workspacePath) {
            throw new Error("Indexer not initialized");
        }

        progressCallback?.("🔗 Connecting to backend...");

        if (!(await this.ensureConnected())) {
            progressCallback?.("❌ Connection failed");
            return 0;
        }

        const startTime = Date.now();
        progressCallback?.("📁 Scanning workspace...");

        const files = await this.collectCodeFiles(this.workspacePath);

        if (files.length === 0) {
            progressCallback?.("No files found to index");
            return 0;
        }

        console.log(`[Indexer] Found ${files.length} files to index`);
        progressCallback?.(`Found ${files.length} files to index`);

        let totalChunks = 0;
        let processedFiles = 0;
        let failedFiles = 0;

        for (const filePath of files) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');

                //  CRITICAL FIX: Convert to relative path
                const relativePath = path.relative(this.workspacePath, filePath);

                console.log(`[Indexer] Indexing ${path.basename(filePath)} (${content.length} chars)`);
                console.log(`[Indexer] - Absolute path: ${filePath}`);
                console.log(`[Indexer] - Relative path: ${relativePath}`);

                const url = `${this.apiBaseUrl}/api/vscode/index/file`;
                const headers = this.getAuthHeaders();
                const workspaceId = await this.generateWorkspaceId();

                const payload = {
                    file_path: relativePath,  // ✅ USE RELATIVE PATH
                    content: content,
                    workspace_id: workspaceId
                };

                console.log("[Indexer] POST URL:", url);
                console.log("[Indexer] Payload file_path:", relativePath);
                console.log("[Indexer] content length:", content.length);

                const response = await axios.post(
                    url,
                    payload,
                    {
                        timeout: 30000,
                        headers: headers
                    }
                );

                if (response.data.success) {
                    const chunksAdded = response.data.chunks_added || 0;
                    totalChunks += chunksAdded;
                    console.log(`[Indexer] ✅ ${path.basename(filePath)} -> ${chunksAdded} chunks`);
                } else {
                    console.warn(`[Indexer] ⚠️ Backend returned success=false for ${relativePath}`);
                    failedFiles++;
                }

                processedFiles++;

                if (processedFiles % 5 === 0) {
                    progressCallback?.(`Indexed ${processedFiles}/${files.length} files (${totalChunks} chunks)`);
                }

            } catch (error: any) {
                failedFiles++;
                console.error(`[Indexer] ❌ Error indexing ${path.basename(filePath)}:`, error.message);

                if (error.response) {
                    console.error("[Indexer] Response status:", error.response.status);
                    console.error("[Indexer] Response data:", error.response.data);
                }

                if (failedFiles >= 5) {
                    console.error("[Indexer] Too many failures, stopping indexing");
                    progressCallback?.("❌ Indexing stopped due to errors. Check authentication.");
                    break;
                }
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const successMsg = `Indexed ${totalChunks} chunks from ${processedFiles} files in ${elapsed}s`;

        if (failedFiles > 0) {
            console.warn(`[Indexer] ${failedFiles} files failed to index`);
            progressCallback?.(`${successMsg} (${failedFiles} failed)`);
        } else {
            progressCallback?.(successMsg);
        }

        console.log(`[Indexer] Indexing complete: ${totalChunks} chunks, ${processedFiles} files, ${failedFiles} failed`);

        return totalChunks;
    }

    async findRelevantContext(query: string, topK: number = 15): Promise<string> {
        if (!this.workspacePath) {
            return '⚠️ Indexer not initialized';
        }

        // Check connection before searching
        if (!await this.ensureConnected()) {
            return '⚠️ Cannot connect to backend. Please check authentication and server status.';
        }

        try {
            console.log(`[Indexer] Searching for: "${query}"`);

            // Search ChromaDB backend
            const response = await axios.post(
                `${this.apiBaseUrl}/api/vscode/index/search`,
                {
                    query: query,
                    n_results: topK,
                    workspace_id: await this.generateWorkspaceId()
                },
                {
                    timeout: 15000,
                    headers: this.getAuthHeaders()
                }
            );

            if (!response.data.success || !response.data.results || response.data.results.length === 0) {
                console.log('[Indexer] No results found');
                return '⚠️ No relevant code found in workspace. Try re-indexing the project.';
            }

            const results = response.data.results;
            console.log(`[Indexer] Found ${results.length} results`);

            // Format results as context
            const contextParts: string[] = [];
            const seenFiles = new Set<string>();
            const uniqueFiles = new Set(results.map((r: any) => r.file_path));

            const summary = `\nPROJECT CONTEXT (${results.length} most relevant code chunks):\nFiles referenced: ${uniqueFiles.size}\n${'='.repeat(80)}\n`;

            for (const result of results) {
                const filePath = result.file_path;
                const relativePath = path.relative(this.workspacePath!, filePath);
                const fileMarker = !seenFiles.has(relativePath) ? '📄 NEW FILE\n' : '';
                seenFiles.add(relativePath);

                const similarity = (result.similarity * 100).toFixed(0);

                contextParts.push(`
${fileMarker}--- ${relativePath} (Lines ${result.start_line}-${result.end_line}) [Relevance: ${similarity}%] ---
\`\`\`${result.language}
${result.content}
\`\`\`
`);
            }

            return summary + contextParts.join('\n');

        } catch (error: any) {
            console.error('[Indexer] Search failed:', error);

            if (error.response?.status === 401) {
                return '⚠️ Authentication failed. Please login again.';
            }

            return `⚠️ Search failed: ${error.message}`;
        }
    }


    private async collectCodeFiles(dir: string): Promise<string[]> {
        const files: string[] = [];

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Skip ignored directories
                    if (this.ignoreDirs.has(entry.name) || entry.name.startsWith('.')) {
                        continue;
                    }

                    // Recursively collect from subdirectories
                    const subFiles = await this.collectCodeFiles(fullPath);
                    files.push(...subFiles);

                } else if (entry.isFile()) {
                    if (await this.shouldIndexFile(fullPath, entry.name)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (error: any) {
            console.error(`[Indexer] Error reading directory ${dir}:`, error.message);
        }

        return files;
    }


    private async shouldIndexFile(filePath: string, fileName: string): Promise<boolean> {
        const ext = path.extname(fileName).toLowerCase();

        // Skip ignored extensions
        if (this.ignoreExtensions.has(ext)) {
            return false;
        }

        // Skip files without extension (usually binary)
        if (!ext) {
            return false;
        }

        try {
            const stats = await fs.stat(filePath);

            // Skip large files
            if (stats.size > this.maxFileSize) {
                console.log(`[Indexer] Skipping large file (${(stats.size / 1024 / 1024).toFixed(1)}MB): ${fileName}`);
                return false;
            }

            // Skip empty files
            if (stats.size === 0) {
                return false;
            }

        } catch (error) {
            return false;
        }

        // Verify it's a text file
        return await this.isTextFile(filePath);
    }


    private async isTextFile(filePath: string): Promise<boolean> {
        try {
            const buffer = Buffer.alloc(8192);
            const fileHandle = await fs.open(filePath, 'r');
            const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
            await fileHandle.close();

            if (bytesRead === 0) {
                return false;
            }

            // Check for null bytes (binary indicator)
            for (let i = 0; i < bytesRead; i++) {
                if (buffer[i] === 0) {
                    return false;
                }
            }

            // Check for excessive non-printable characters
            let nonPrintable = 0;
            for (let i = 0; i < bytesRead; i++) {
                const byte = buffer[i];
                // Allow common control chars: tab(9), newline(10), carriage return(13)
                if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) {
                    nonPrintable++;
                }
            }

            // If more than 30% non-printable, consider it binary
            return (nonPrintable / bytesRead) < 0.3;

        } catch (error) {
            return false;
        }
    }


    async getStats() {
        try {
            const token = this.context.globalState.get<string>('devAlleyToken');
            const workspaceId = await this.generateWorkspaceId();  // ✅ Generate workspace ID

            if (!token) {
                console.warn('[Indexer] No token for stats request');
                return { totalChunks: 0, totalFiles: 0 };
            }

            const response = await axios.get(
                `${this.apiBaseUrl}/api/vscode/index/stats`,
                {
                    timeout: 5000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        workspace_id: workspaceId
                    }
                }
            );

            if (response.data.success) {
                const stats = response.data.stats;
                console.log('[Indexer] Stats:', stats);
                return {
                    totalChunks: stats.total_chunks || 0,
                    totalFiles: stats.total_files || 0
                };
            }

        } catch (error: any) {
            console.error('[Indexer] Failed to get stats:', error.message);
        }

        return { totalChunks: 0, totalFiles: 0 };
    }
    // Add this method to WorkspaceIndexer class
    public debugToken(): void {
        const token = this.context.globalState.get<string>('devAlleyToken');
        console.log('[Indexer] DEBUG - Token exists:', !!token);
        console.log('[Indexer] DEBUG - Token value:', token ? `${token.substring(0, 20)}...` : 'null');
        console.log('[Indexer] DEBUG - All keys:', this.context.globalState.keys());
    }

}
