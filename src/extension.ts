import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs'; // Keep existing fs import
import { promises as fsPromises } from 'fs'; // Add promises API
import ignore, { Ignore } from 'ignore';

const logChannel = vscode.window.createOutputChannel('shadow-project');

// --- Interfaces ---
interface ShadowProject {
    name: string;
    path: string;
}

// Structure to hold information about a file/directory across different sources
interface MergedItemSource {
    projectName: string; // Name of the shadow project (or special value for workspace)
    projectPath: string; // Root path of the project/workspace
    fullPath: string;    // Full path to this specific item within the source
    fileType: vscode.FileType;
}

// Represents a unique file/directory name found during merging
class MergedItemInfo {
    name: string;
    workspaceSource?: MergedItemSource; // Details if present in workspace
    shadowSources: MergedItemSource[] = [];  // Details from each shadow project it exists in

    constructor(name: string) {
        this.name = name;
    }

    // Determine the primary type (Directory wins over File if conflict)
    get primaryType(): vscode.FileType {
        if (this.workspaceSource?.fileType === vscode.FileType.Directory || this.shadowSources.some((s: MergedItemSource) => s.fileType === vscode.FileType.Directory)) {
            return vscode.FileType.Directory;
        }
        // Ensure shadowSources is not empty before accessing index 0
        return this.workspaceSource?.fileType ?? (this.shadowSources.length > 0 ? this.shadowSources[0].fileType : vscode.FileType.Unknown);
    }
    // Get all unique directory paths this merged item represents
    get directoryPaths(): string[] {
        const paths = new Set<string>();
        if (this.workspaceSource?.fileType === vscode.FileType.Directory) {
            paths.add(this.workspaceSource.fullPath);
        }
        this.shadowSources.forEach((s: MergedItemSource) => {
            if (s.fileType === vscode.FileType.Directory) {
                paths.add(s.fullPath);
            }
        });
        return Array.from(paths);
    }
}

// Custom Tree Item to store source paths for merged directories
class MergedDirectoryItem extends vscode.TreeItem {
    constructor(
        label: string,
        public sourceDirectoryPaths: string[] // Store paths of actual dirs this represents
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        // Use the first path for the main resourceUri, might not be ideal but needed
        this.resourceUri = vscode.Uri.file(sourceDirectoryPaths[0]);
        // Indicate it's potentially merged
        this.contextValue = 'mergedDirectory';
         // Add tooltip showing sources?
         if (sourceDirectoryPaths.length > 1) {
            this.tooltip = `Merged from:\n${sourceDirectoryPaths.join('\n')}`;
         }
    }
}

// Custom Tree Item for Shadow Files to hold source info
class ShadowFileItem extends vscode.TreeItem {
    constructor(
        label: string,
        public shadowSource: MergedItemSource // Store the source info
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(shadowSource.fullPath);
        this.description = `(${shadowSource.projectName})`;
        this.contextValue = 'shadowFile'; // Used for context menu targeting
        // Command to open the file on click
        this.command = { command: 'vscode.open', title: "Open File", arguments: [this.resourceUri] };
    }
}


// --- Merged Tree Data Provider ---
class MergedProjectsTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private workspaceIg: Ignore | undefined;
    private shadowIgs: Map<string, Ignore> = new Map(); // Map shadow path to its ignore instance
    private workspaceRoot: string | undefined;
    private shadowProjects: ShadowProject[];

    // Constants
    private readonly WORKSPACE_ID = '__WORKSPACE__';

    constructor(initialWorkspaceRoot: string | undefined, initialShadowProjects: ShadowProject[]) {
        this.workspaceRoot = initialWorkspaceRoot;
        this.shadowProjects = initialShadowProjects;
        logChannel.appendLine(`MergedProjectsTreeDataProvider initialized.`);
        this.loadIgnoreFiles();
    }

    updateWorkspaceRoot(newRoot: string | undefined): void {
        if (this.workspaceRoot !== newRoot) {
            logChannel.appendLine(`Updating workspace root to: ${newRoot}`);
            this.workspaceRoot = newRoot;
            this.loadIgnoreFiles();
            this.refresh();
        }
    }

    updateShadowProjects(newProjects: ShadowProject[]): void {
        logChannel.appendLine(`Updating shadow projects to: ${JSON.stringify(newProjects)}`);
        // Basic check if projects actually changed might be good
        this.shadowProjects = newProjects;
        this.loadIgnoreFiles(); // Reload ignore rules
        this.refresh();
    }

    refresh(): void {
        logChannel.appendLine('Refreshing MergedProjectsTreeDataProvider');
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    // --- Core Logic: Get Children ---
    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const mergedItemsMap: Map<string, MergedItemInfo> = new Map();
        let pathsToScan: { projectPath: string; readPath: string; projectName: string; isWorkspace: boolean }[] = [];

        if (!element) {
            // Root level: Scan workspace root and all shadow project roots
            logChannel.appendLine('Getting root children.');
            if (this.workspaceRoot && await this.pathExists(this.workspaceRoot)) {
                pathsToScan.push({ projectPath: this.workspaceRoot, readPath: this.workspaceRoot, projectName: this.WORKSPACE_ID, isWorkspace: true });
            }
            this.shadowProjects.forEach(proj => {
                 if (fs.existsSync(proj.path)) { // Check existence before adding
                    pathsToScan.push({ projectPath: proj.path, readPath: proj.path, projectName: proj.name, isWorkspace: false });
                 } else {
                     logChannel.appendLine(`Skipping non-existent shadow project path at root: ${proj.path} (Name: ${proj.name})`);
                 }
            });
        } else if (element instanceof MergedDirectoryItem) {
            // Children of a merged directory: Scan all source directories it represents
            logChannel.appendLine(`Getting children for merged directory: ${element.label}`);
            pathsToScan = element.sourceDirectoryPaths.map(dirPath => {
                // Determine if this dirPath belongs to workspace or a shadow project
                let isWorkspace = false;
                let projectName = '';
                let projectPath = '';
                if (this.workspaceRoot && dirPath.startsWith(this.workspaceRoot)) {
                    isWorkspace = true;
                    projectName = this.WORKSPACE_ID;
                    projectPath = this.workspaceRoot;
                } else {
                    const shadow = this.shadowProjects.find(p => dirPath.startsWith(p.path));
                    if (shadow) {
                        projectName = shadow.name;
                        projectPath = shadow.path;
                    } else {
                        logChannel.appendLine(`Cannot determine project origin for merged directory path: ${dirPath}`);
                        return null; // Skip if origin unknown
                    }
                }
                return { projectPath, readPath: dirPath, projectName, isWorkspace };
            }).filter(p => p !== null) as typeof pathsToScan; // Filter out nulls

        } else if (element.resourceUri && element.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
             // Children of a non-merged directory (exists only in workspace or one shadow)
             const readPath = element.resourceUri.fsPath;
             logChannel.appendLine(`Getting children for simple directory: ${element.label} (${readPath})`);
             let isWorkspace = false;
             let projectName = '';
             let projectPath = '';

             if (this.workspaceRoot && readPath.startsWith(this.workspaceRoot)) {
                 isWorkspace = true;
                 projectName = this.WORKSPACE_ID;
                 projectPath = this.workspaceRoot;
             } else {
                 const shadow = this.shadowProjects.find(p => readPath.startsWith(p.path));
                 if (shadow) {
                     projectName = shadow.name;
                     projectPath = shadow.path;
                 } else {
                     logChannel.appendLine(`Cannot determine project origin for simple directory path: ${readPath}`);
                     return []; // Cannot determine context
                 }
             }
             pathsToScan.push({ projectPath, readPath, projectName, isWorkspace });
        } else {
             logChannel.appendLine(`Cannot get children for element: ${element?.label}`);
             return []; // Should not happen for collapsible items or root
        }

        // --- Process all paths to scan ---
        for (const { projectPath, readPath, projectName, isWorkspace } of pathsToScan) {
            const ig = isWorkspace ? this.workspaceIg : this.shadowIgs.get(projectPath);
            logChannel.appendLine(`Scanning path: ${readPath} (Project: ${projectName}, Base: ${projectPath})`);

            try {
                const entries = await this.readDirectory(readPath);
                for (const [name, type] of entries) {
                    if (name === '.git' && type === vscode.FileType.Directory) continue;

                    const itemFullPath = path.join(readPath, name);
                    const relativePath = path.relative(projectPath, itemFullPath);
                    const pathToCheck = type === vscode.FileType.Directory ? `${relativePath}/` : relativePath;

                    if (ig?.ignores(pathToCheck)) {
                        // logChannel.appendLine(`Ignoring ${pathToCheck} in ${projectName}`);
                        continue;
                    }

                    // Get or create the MergedItemInfo for this name
                    let itemInfo = mergedItemsMap.get(name);
                    if (!itemInfo) {
                        itemInfo = new MergedItemInfo(name); // Use constructor
                        mergedItemsMap.set(name, itemInfo);
                    }

                    // Create the source info
                    const source: MergedItemSource = { projectName, projectPath, fullPath: itemFullPath, fileType: type };

                    // Add the source details (itemInfo is guaranteed to be defined here)
                    if (isWorkspace) {
                        itemInfo.workspaceSource = source;
                    } else {
                        // Avoid adding duplicate shadow sources if a merged dir is scanned multiple times
                        if (!itemInfo.shadowSources.some((s: MergedItemSource) => s.fullPath === source.fullPath)) {
                             itemInfo.shadowSources.push(source);
                        }
                    }
                }
            } catch (error: any) {
                 // Log error if directory is unreadable, but continue processing others
                 if (error.code !== 'ENOENT') { // Ignore "not found" errors silently for getChildren
                    logChannel.appendLine(`Error reading directory ${readPath} for project ${projectName}: ${error.message}`);
                 }
            }
        }

        // --- Convert MergedItemInfo map to TreeItems ---
        const finalTreeItems: vscode.TreeItem[] = [];
        for (const itemInfo of mergedItemsMap.values()) {
            const itemName = itemInfo.name;
            const itemType = itemInfo.primaryType;

            if (itemType === vscode.FileType.Directory) {
                // Create a single MergedDirectoryItem representing all source directories
                const allDirPaths = itemInfo.directoryPaths;
                if (allDirPaths.length > 0) {
                     const newItem = new MergedDirectoryItem(itemName, allDirPaths);
                     // Explicitly ensure it's collapsed when created/refreshed
                     newItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                     finalTreeItems.push(newItem);
                }
            } else if (itemType === vscode.FileType.File) {
                // Handle file merging/display logic
                const workspaceFile = itemInfo.workspaceSource;
                const shadowFiles = itemInfo.shadowSources;

                if (workspaceFile) {
                    // Workspace file exists, show it primarily
                    const wsItem = new vscode.TreeItem(itemName, vscode.TreeItemCollapsibleState.None);
                    wsItem.resourceUri = vscode.Uri.file(workspaceFile.fullPath);
                    wsItem.command = { command: 'vscode.open', title: "Open File", arguments: [wsItem.resourceUri] };
                    wsItem.contextValue = 'workspaceFile'; // Context for potential actions
                    finalTreeItems.push(wsItem);

                    // If also in shadows, add distinct items for them
                    shadowFiles.forEach(shadowSource => {
                        // Use the custom item to store source info
                        finalTreeItems.push(new ShadowFileItem(itemName, shadowSource));
                    });
                } else if (shadowFiles.length > 0) {
                    // File only exists in shadow(s)
                    // Show the first one normally, but with description
                    const firstShadow = shadowFiles[0];
                    // Use the custom item for the first shadow file
                    finalTreeItems.push(new ShadowFileItem(itemName, firstShadow));

                    // Add distinct items for other shadow copies
                    shadowFiles.slice(1).forEach(shadowSource => {
                        // Use the custom item for subsequent shadow files
                        finalTreeItems.push(new ShadowFileItem(itemName, shadowSource));
                    });
                }
                // If neither workspace nor shadow, something's wrong, ignore.
            } else {
                 // Handle Unknown or SymbolicLink? For now, treat like files without commands.
                 if (itemInfo.workspaceSource || itemInfo.shadowSources.length > 0) {
                     const unknownItem = new vscode.TreeItem(itemName, vscode.TreeItemCollapsibleState.None);
                     // Point resourceUri to the first available source
                     const firstSourcePath = itemInfo.workspaceSource?.fullPath ?? itemInfo.shadowSources[0]?.fullPath;
                     if (firstSourcePath) {
                         unknownItem.resourceUri = vscode.Uri.file(firstSourcePath);
                     }
                     unknownItem.contextValue = 'unknownItem';
                     // Add description if only from shadow
                     if (!itemInfo.workspaceSource && itemInfo.shadowSources.length > 0) {
                         unknownItem.description = `(${itemInfo.shadowSources[0].projectName})`;
                     }
                     finalTreeItems.push(unknownItem);
                 }
            }
        }

        // Sort and return
        return finalTreeItems.sort((a, b) => {
            const aIsDir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
            const bIsDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1; // Dirs first
            // Sort by base name, ignore descriptions like "(ProjectName)"
            const labelA = (a.label as string).split(' (')[0];
            const labelB = (b.label as string).split(' (')[0];
            return labelA.localeCompare(labelB);
        });
    }

    // --- Helper Methods ---
    private async readDirectory(dirPath: string): Promise<[string, vscode.FileType][]> {
        try {
            // Check if path exists before reading
            if (!await this.pathExists(dirPath)) {
                return [];
            }
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            return entries.map(entry => {
                let type = vscode.FileType.Unknown;
                if (entry.isFile()) type = vscode.FileType.File;
                else if (entry.isDirectory()) type = vscode.FileType.Directory;
                else if (entry.isSymbolicLink()) type = vscode.FileType.SymbolicLink; // Handle symlinks if needed
                return [entry.name, type];
            });
        } catch (error: any) {
            // Log errors other than ENOENT (file not found), re-throw others?
            if (error.code !== 'ENOENT') {
                 logChannel.appendLine(`Failed to read directory ${dirPath}: ${error.message}`);
            }
            // Propagate error to be handled by the caller, or return empty?
            // Returning empty might be safer for merging.
            return [];
            // throw error;
        }
    }

     private async pathExists(p: string): Promise<boolean> {
        try {
            await fs.promises.access(p);
            return true;
        } catch {
            return false;
        }
    }


    private loadIgnoreFiles(): void {
        this.workspaceIg = this.createIgnoreInstance(this.workspaceRoot);
        this.shadowIgs.clear();
        this.shadowProjects.forEach(proj => {
            const igInstance = this.createIgnoreInstance(proj.path);
            if (igInstance) {
                this.shadowIgs.set(proj.path, igInstance);
            }
        });
        logChannel.appendLine(`Loaded ignore files. Workspace: ${!!this.workspaceIg}, Shadows: ${this.shadowIgs.size}`);
    }

    private createIgnoreInstance(basePath: string | undefined): Ignore | undefined {
        if (!basePath || !fs.existsSync(basePath)) return ignore(); // Return empty if base path doesn't exist
        const ignorePath = path.join(basePath, '.gitignore');
        try {
            if (fs.existsSync(ignorePath)) {
                const ignoreContent = fs.readFileSync(ignorePath).toString();
                logChannel.appendLine(`Loaded .gitignore from ${basePath}`);
                return ignore().add(ignoreContent);
            } else {
                 // logChannel.appendLine(`No .gitignore found at ${basePath}`);
            }
        } catch (error: any) {
            logChannel.appendLine(`Error reading .gitignore from ${basePath}: ${error.message}`);
        }
        return ignore(); // Return empty ignore instance if file not found or error
    }

    // --- NEW: Get Parent Implementation (Required for reveal) ---
    getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
        logChannel.appendLine(`getParent called for element: ${element.label}`);

        // We need the URI of the element to find its parent path
        let elementUri = element.resourceUri;

        // Handle cases where resourceUri might not be directly on the element
        // (e.g., if VS Code passes a generic TreeItem during reveal traversal)
        if (!elementUri && element instanceof ShadowFileItem) {
            elementUri = vscode.Uri.file(element.shadowSource.fullPath);
        } else if (!elementUri && element instanceof MergedDirectoryItem && element.sourceDirectoryPaths.length > 0) {
             // Use the first source path as representative for merged directories
             elementUri = vscode.Uri.file(element.sourceDirectoryPaths[0]);
        }

        if (!elementUri) {
            logChannel.appendLine(`getParent: Could not determine URI for element ${element.label}. Returning undefined.`);
            return undefined; // Cannot determine parent without a URI
        }

        const elementPath = elementUri.fsPath;
        const parentPath = path.dirname(elementPath);
        logChannel.appendLine(`getParent: Element path: ${elementPath}, Parent path: ${parentPath}`);

        // Check if the parent path is one of the roots (workspace or shadow project root)
        if (this.workspaceRoot && parentPath === this.workspaceRoot) {
            logChannel.appendLine(`getParent: Parent is workspace root. Returning undefined.`);
            return undefined;
        }
        const isShadowRoot = this.shadowProjects.some(p => p.path === parentPath);
        if (isShadowRoot) {
            logChannel.appendLine(`getParent: Parent is a shadow project root. Returning undefined.`);
            return undefined;
        }

        // If the parent path is the root of the filesystem, return undefined
        if (parentPath === path.dirname(parentPath)) {
             logChannel.appendLine(`getParent: Parent is filesystem root. Returning undefined.`);
             return undefined;
        }

        // If we reach here, the parent is a directory within the workspace or a shadow project.
        // We need to return a TreeItem representing this parent directory.
        // Constructing the *exact* MergedDirectoryItem with all its sources is complex here.
        // Instead, we return a placeholder TreeItem with the correct URI and label.
        // VS Code will call getChildren on this item if it needs to expand it further.
        const parentDirName = path.basename(parentPath);
        const parentUri = vscode.Uri.file(parentPath);
        logChannel.appendLine(`getParent: Constructing placeholder parent TreeItem for ${parentDirName} at ${parentUri.fsPath}`);

        const parentItem = new vscode.TreeItem(parentDirName, vscode.TreeItemCollapsibleState.Collapsed);
        parentItem.resourceUri = parentUri;
        // We don't know the exact contextValue ('mergedDirectory' or simple dir) here,
        // but this might be sufficient for reveal to traverse upwards.

        return parentItem;
    }
}

// Helper function to check if a path exists and is a file
async function fileExists(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.isFile();
    } catch (error: any) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
            return false; // Doesn't exist or isn't a file
        }
        logChannel.appendLine(`Error checking file existence for ${filePath}: ${error.message}`);
        return false; // Other error
    }
}

// Interface for the result of finding a file
interface FoundFileInfo {
    uri: vscode.Uri;
    type: 'workspace' | 'shadow';
    shadowSource?: MergedItemSource; // Only present if type is 'shadow'
}

// Helper function to find and open the first valid file match
async function findAndOpenFile(
    potentialPath: string,
    workspaceRoot: string | undefined,
    shadowProjects: ShadowProject[],
    workspaceIg: Ignore | undefined,
    shadowIgs: Map<string, Ignore>
): Promise<FoundFileInfo | undefined> { // Return FoundFileInfo or undefined
    logChannel.appendLine(`Attempting to find and open path: ${potentialPath}`);

    // 1. Check Workspace
    if (workspaceRoot) {
        // Resolve relative to workspace root IF the potential path is relative
        // If potentialPath is absolute, resolve will just return it.
        // If potentialPath is relative, it resolves relative to workspaceRoot.
        const workspaceFilePath = path.resolve(workspaceRoot, potentialPath);
        const relativeWorkspacePath = path.relative(workspaceRoot, workspaceFilePath);
        const workspacePathToCheck = relativeWorkspacePath; // For ignore check

        logChannel.appendLine(`Checking workspace: ${workspaceFilePath} (relative: ${relativeWorkspacePath})`);

        // Check ignore using the path relative to the workspace root
        if (!workspaceIg?.ignores(workspacePathToCheck) && await fileExists(workspaceFilePath)) {
            logChannel.appendLine(`Found in workspace: ${workspaceFilePath}`);
            const fileUri = vscode.Uri.file(workspaceFilePath);
            await vscode.commands.executeCommand('vscode.open', fileUri);
            return { uri: fileUri, type: 'workspace' }; // Return FoundFileInfo
        }
    }

    // 2. Check Shadow Projects
    for (const proj of shadowProjects) {
        // Resolve relative to shadow project root IF the potential path is relative
        // If potentialPath is absolute, resolve will just return it.
        // If potentialPath is relative, it resolves relative to proj.path.
        const shadowFilePath = path.resolve(proj.path, potentialPath);
        const relativeShadowPath = path.relative(proj.path, shadowFilePath);
        const shadowPathToCheck = relativeShadowPath; // For ignore check
        const ig = shadowIgs.get(proj.path);

        logChannel.appendLine(`Checking shadow project '${proj.name}': ${shadowFilePath} (relative: ${relativeShadowPath})`);

        // Check ignore using the path relative to the shadow project root
        if (!ig?.ignores(shadowPathToCheck) && await fileExists(shadowFilePath)) {
            logChannel.appendLine(`Found in shadow project '${proj.name}': ${shadowFilePath}`);
            const fileUri = vscode.Uri.file(shadowFilePath);
            await vscode.commands.executeCommand('vscode.open', fileUri);
             // Construct the MergedItemSource for the shadow file
             const shadowSource: MergedItemSource = {
                projectName: proj.name,
                projectPath: proj.path,
                fullPath: shadowFilePath,
                fileType: vscode.FileType.File // Assume file since fileExists passed
            };
            return { uri: fileUri, type: 'shadow', shadowSource: shadowSource }; // Return FoundFileInfo
        }
    }

    logChannel.appendLine(`Path not found in workspace or any shadow projects: ${potentialPath}`);
    return undefined; // Return undefined if not found
}


// --- Extension Activation ---
export function activate(context: vscode.ExtensionContext) {
    logChannel.appendLine('ShadowProject extension activating (merged view)...');

    // --- State Management ---
    const SHADOW_PROJECTS_KEY = 'shadowProjects';
    const getStoredProjects = (): ShadowProject[] => context.workspaceState.get<ShadowProject[]>(SHADOW_PROJECTS_KEY, []);
    const updateStoredProjects = (projects: ShadowProject[]): Thenable<void> => context.workspaceState.update(SHADOW_PROJECTS_KEY, projects);

    let currentShadowProjects = getStoredProjects();
    logChannel.appendLine(`Loaded ${currentShadowProjects.length} shadow projects from state.`);

    // --- Initialize Tree Provider ---
    const getCurrentWorkspaceRoot = (): string | undefined => {
        return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;
    };

    const treeViewId = 'shadowProjectsMergedView';

    // --- Create Provider and View ONCE ---
    logChannel.appendLine('Creating MergedProjectsTreeDataProvider instance...');
    // Assign directly here using const. It's guaranteed to exist before commands/listeners run.
    const treeDataProvider = new MergedProjectsTreeDataProvider(getCurrentWorkspaceRoot(), currentShadowProjects);

    logChannel.appendLine('Creating TreeView instance...');
    const shadowTreeView = vscode.window.createTreeView(treeViewId, {
        treeDataProvider: treeDataProvider,
        canSelectMany: true
    });
    context.subscriptions.push(shadowTreeView); // Register TreeView for disposal

    // Register selection listener
    const selectionDisposable = shadowTreeView.onDidChangeSelection(e => {
        const selectionCount = e.selection.length;
        logChannel.appendLine(`Selection changed. Count: ${selectionCount}`);
        vscode.commands.executeCommand('setContext', 'shadowProject.selectionCount', selectionCount);
    });
    context.subscriptions.push(selectionDisposable);

    // Initial context setting
    vscode.commands.executeCommand('setContext', 'shadowProject.selectionCount', 0);
    logChannel.appendLine('Provider and View created and registered.');

    // Removed initializeOrUpdateTreeView function and its initial call


    // --- Register Commands ---
    logChannel.appendLine('Registering commands...');

    const addShadowProject = vscode.commands.registerCommand('shadow-project.addShadowProject', async () => {
        logChannel.appendLine('Command: addShadowProject triggered.');
        const currentProjects = getStoredProjects(); // Get latest state

        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Folder to Add as Shadow Project',
            title: 'Select Shadow Project Folder'
        });

        if (folderUri && folderUri.length > 0) {
            const newPath = folderUri[0].fsPath;
            const existingPath = currentProjects.find(p => p.path === newPath);
            if (existingPath) {
                vscode.window.showWarningMessage(`Folder already added as shadow project: ${existingPath.name}`);
                return;
            }

            const defaultName = path.basename(newPath);
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a unique name for this shadow project',
                value: defaultName,
                placeHolder: 'e.g., My Library, Backend API',
                validateInput: text => {
                    if (!text) return 'Name cannot be empty.';
                    if (currentProjects.some(p => p.name === text)) return 'A shadow project with this name already exists.';
                    return null; // Valid
                }
            });

            if (name) {
                const newProject: ShadowProject = { name, path: newPath };
                const newProjectUri = folderUri[0]; // URI of the selected folder

                // --- Add to Workspace Folders ---
                const currentFolders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(f => f) : []; // Get a mutable copy
                const folderIndex = currentFolders.findIndex(f => f.uri.fsPath === newProjectUri.fsPath);

                if (folderIndex === -1) {
                    logChannel.appendLine(`Adding folder to workspace: ${newProjectUri.fsPath}`);
                    const success = vscode.workspace.updateWorkspaceFolders(currentFolders.length, 0, { uri: newProjectUri, name: `${name} (Shadow)` }); // Add at the end with name
                    if (!success) {
                        logChannel.appendLine('Failed to add folder to workspace.');
                        vscode.window.showWarningMessage(`Failed to add folder "${name}" to the workspace automatically.`);
                        // Proceed with adding to state anyway? Or stop? Let's proceed for now.
                    }
                } else {
                    logChannel.appendLine(`Folder already exists in workspace: ${newProjectUri.fsPath}`);
                }
                // --- End Add to Workspace Folders ---


                const updatedProjects = [...currentProjects, newProject];
                await updateStoredProjects(updatedProjects);
                logChannel.appendLine(`Added shadow project: ${JSON.stringify(newProject)}`);
                // REMOVED: Let onDidChangeWorkspaceFolders handle the update
                // treeDataProvider.updateShadowProjects(updatedProjects);
                vscode.window.showInformationMessage(`Shadow project "${name}" added.`);
            } else {
                 logChannel.appendLine('Shadow project name not provided.');
            }
        } else {
            logChannel.appendLine('No shadow project folder selected.');
        }
    });

    const removeShadowProject = vscode.commands.registerCommand('shadow-project.removeShadowProject', async () => {
        logChannel.appendLine('Command: removeShadowProject triggered.');
        const currentProjects = getStoredProjects(); // Get latest state

        if (currentProjects.length === 0) {
            vscode.window.showInformationMessage('No shadow projects to remove.');
            return;
        }

        const items: vscode.QuickPickItem[] = currentProjects.map(p => ({
            label: p.name,
            description: p.path
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a shadow project to remove',
            canPickMany: false
        });

        if (selected) {
            const nameToRemove = selected.label;
            const projectToRemove = currentProjects.find(p => p.name === nameToRemove); // Find the full project object

            if (!projectToRemove) {
                 logChannel.appendLine(`Could not find project details for removal: ${nameToRemove}`);
                 vscode.window.showErrorMessage(`Could not find details for project "${nameToRemove}".`);
                 return;
            }

            const pathToRemove = projectToRemove.path;
            const uriToRemove = vscode.Uri.file(pathToRemove);

            // --- Remove from Workspace Folders ---
            const currentFolders = vscode.workspace.workspaceFolders;
            if (currentFolders) {
                const folderIndex = currentFolders.findIndex(f => f.uri.fsPath === uriToRemove.fsPath);
                if (folderIndex !== -1) {
                    logChannel.appendLine(`Removing folder from workspace: ${uriToRemove.fsPath}`);
                    const success = vscode.workspace.updateWorkspaceFolders(folderIndex, 1); // Remove 1 folder at the found index
                     if (!success) {
                        logChannel.appendLine('Failed to remove folder from workspace.');
                        vscode.window.showWarningMessage(`Failed to remove folder "${nameToRemove}" from the workspace automatically.`);
                        // Proceed with removing from state anyway? Yes.
                    }
                } else {
                     logChannel.appendLine(`Folder not found in workspace to remove: ${uriToRemove.fsPath}`);
                }
            }
            // --- End Remove from Workspace Folders ---

            const updatedProjects = currentProjects.filter(p => p.name !== nameToRemove);
            await updateStoredProjects(updatedProjects);
            logChannel.appendLine(`Removed shadow project: ${nameToRemove}`);
             // REMOVED: Let onDidChangeWorkspaceFolders handle the update
            // treeDataProvider.updateShadowProjects(updatedProjects);
            vscode.window.showInformationMessage(`Shadow project "${nameToRemove}" removed.`);
        } else {
             logChannel.appendLine('No shadow project selected for removal.');
        }
    });

    const renameShadowProject = vscode.commands.registerCommand('shadow-project.renameShadowProject', async () => {
        logChannel.appendLine('Command: renameShadowProject triggered.');
        const currentProjects = getStoredProjects();

        if (currentProjects.length === 0) {
            vscode.window.showInformationMessage('No shadow projects to rename.');
            return;
        }

        const items: vscode.QuickPickItem[] = currentProjects.map(p => ({
            label: p.name,
            description: p.path,
            detail: `Current name: ${p.name}`
        }));

        const selectedItem = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a shadow project to rename',
            title: 'Rename Shadow Project'
        });

        if (!selectedItem) {
            logChannel.appendLine('No shadow project selected for renaming.');
            return;
        }

        const projectToRename = currentProjects.find(p => p.name === selectedItem.label);
        if (!projectToRename) {
            logChannel.appendLine(`Could not find project with name: ${selectedItem.label}`);
            vscode.window.showErrorMessage('Could not find the selected project.');
            return;
        }

        const newName = await vscode.window.showInputBox({
            prompt: `Enter the new name for "${projectToRename.name}"`,
            value: projectToRename.name,
            placeHolder: 'e.g., My Updated Library',
            validateInput: text => {
                if (!text) return 'Name cannot be empty.';
                if (text === projectToRename.name) return 'The new name is the same as the current name.';
                if (currentProjects.some(p => p.name === text)) return 'A shadow project with this name already exists.';
                return null; // Valid
            }
        });

        if (newName) {
            const updatedProjects = currentProjects.map(p =>
                p.path === projectToRename.path ? { ...p, name: newName } : p
            );
            await updateStoredProjects(updatedProjects);
            logChannel.appendLine(`Renamed shadow project "${projectToRename.name}" to "${newName}"`);
            // Update provider directly after rename (doesn't change workspace folders)
            treeDataProvider.updateShadowProjects(updatedProjects);
            vscode.window.showInformationMessage(`Shadow project "${projectToRename.name}" renamed to "${newName}".`);
        } else {
            logChannel.appendLine('New name not provided for renaming.');
        }
    });

    const compareWithWorkspace = vscode.commands.registerCommand('shadow-project.compareWithWorkspace', async (shadowItem: ShadowFileItem | vscode.Uri) => {
        logChannel.appendLine('Command: compareWithWorkspace triggered.');

        let shadowUri: vscode.Uri | undefined;
        let shadowSource: MergedItemSource | undefined;

        // Command can be triggered from palette (no arg) or context menu (TreeItem/Uri)
        if (shadowItem instanceof ShadowFileItem) {
            shadowUri = shadowItem.resourceUri;
            shadowSource = shadowItem.shadowSource;
            logChannel.appendLine(`Comparing from context menu: ${shadowUri?.fsPath}`);
        } else if (shadowItem instanceof vscode.Uri) {
            // If triggered via URI, we lack context to find the workspace equivalent easily.
            // This scenario is less likely with the current setup but handle defensively.
            shadowUri = shadowItem;
            logChannel.appendLine(`Comparing from URI (limited context): ${shadowUri?.fsPath}`);
            vscode.window.showWarningMessage("Cannot determine workspace equivalent when comparing from URI directly.");
            return;
        } else {
            // Triggered from command palette - need to select a file? Too complex for now.
            logChannel.appendLine('Compare command triggered without a target file.');
            vscode.window.showInformationMessage('Please right-click a shadow file in the Shadow Projects view to compare.');
            return;
        }

        if (!shadowUri || !shadowSource) {
            logChannel.appendLine('Compare command missing necessary shadow file information.');
            vscode.window.showErrorMessage('Could not get shadow file details.');
            return;
        }

        const workspaceRoot = getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            logChannel.appendLine('No workspace root found for comparison.');
            vscode.window.showWarningMessage('No workspace folder open to compare against.');
            return;
        }

        let workspacePath = ''; // Declare outside the try block
        try {
            const relativePath = path.relative(shadowSource.projectPath, shadowSource.fullPath);
            workspacePath = path.join(workspaceRoot, relativePath); // Assign inside
            const workspaceUri = vscode.Uri.file(workspacePath);

            logChannel.appendLine(`Shadow path: ${shadowUri.fsPath}`);
            logChannel.appendLine(`Shadow project path: ${shadowSource.projectPath}`);
            logChannel.appendLine(`Relative path: ${relativePath}`);
            logChannel.appendLine(`Workspace root: ${workspaceRoot}`);
            logChannel.appendLine(`Calculated workspace path: ${workspacePath}`);

            // Check if workspace file exists
            await fs.promises.access(workspacePath);

            // File exists, open diff view
            logChannel.appendLine(`Workspace file found. Opening diff.`);
            const diffTitle = `${path.basename(shadowUri.fsPath)} (Shadow: ${shadowSource.projectName}) ↔ Workspace`;
            // Ensure workspaceUri is defined before using it for diff
            if (workspaceUri) {
                await vscode.commands.executeCommand('vscode.diff', shadowUri, workspaceUri, diffTitle);
            } else {
                 logChannel.appendLine(`Workspace URI could not be determined.`);
                 vscode.window.showErrorMessage('Could not determine the workspace file URI for comparison.');
            }

        } catch (error: any) {
            // Handle file not found in workspace specifically
            if (error.code === 'ENOENT') {
                // Use workspacePath here - it should be defined even if access failed
                logChannel.appendLine(`Corresponding file not found in workspace: ${workspacePath ?? 'Path not calculated'}`);
                vscode.window.showInformationMessage(`File "${path.basename(shadowUri.fsPath)}" does not exist in the current workspace.`);
            } else {
                // Log other errors
                logChannel.appendLine(`Error during comparison: ${error.message}`);
                vscode.window.showErrorMessage(`An error occurred while trying to compare files: ${error.message}`);
            }
        }
    });

    const compareWithShadow = vscode.commands.registerCommand('shadow-project.compareWithShadow', async (workspaceItem: vscode.TreeItem | vscode.Uri) => {
        logChannel.appendLine('Command: compareWithShadow triggered.');

        let workspaceUri: vscode.Uri | undefined;

        // Command can be triggered from palette (no arg) or context menu (TreeItem/Uri)
        if (workspaceItem instanceof vscode.TreeItem && workspaceItem.resourceUri) {
            workspaceUri = workspaceItem.resourceUri;
            logChannel.appendLine(`Comparing from context menu: ${workspaceUri?.fsPath}`);
        } else if (workspaceItem instanceof vscode.Uri) {
            // Allow triggering via URI, though less common from context menu
            workspaceUri = workspaceItem;
            logChannel.appendLine(`Comparing from URI: ${workspaceUri?.fsPath}`);
        } else {
            // Triggered from command palette - need to select a file? Too complex for now.
            logChannel.appendLine('Compare command triggered without a target file.');
            vscode.window.showInformationMessage('Please right-click a workspace file in the Shadow Projects view to compare.');
            return;
        }

        if (!workspaceUri) {
            logChannel.appendLine('Compare command missing necessary workspace file information.');
            vscode.window.showErrorMessage('Could not get workspace file details.');
            return;
        }

        const workspaceRoot = getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            logChannel.appendLine('No workspace root found for comparison.');
            vscode.window.showWarningMessage('No workspace folder open to compare against.');
            return;
        }

        const relativePath = path.relative(workspaceRoot, workspaceUri.fsPath);
        logChannel.appendLine(`Workspace path: ${workspaceUri.fsPath}`);
        logChannel.appendLine(`Relative path: ${relativePath}`);

        const currentProjects = getStoredProjects(); // Get current shadow projects

        if (currentProjects.length === 0) {
            logChannel.appendLine('No shadow projects configured.');
            vscode.window.showInformationMessage('No shadow projects are configured to compare against.');
            return;
        }

        // Show Quick Pick with ALL configured shadow projects
        logChannel.appendLine(`Showing Quick Pick with ${currentProjects.length} shadow projects.`);
        const items: vscode.QuickPickItem[] = currentProjects.map(proj => ({
            label: proj.name,
            description: proj.path,
            detail: `Compare with potential copy in "${proj.name}" project`
        }));

        const selectedItem = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a shadow project to compare against',
            title: `Compare "${path.basename(workspaceUri.fsPath)}" with Shadow Copy`
        });

        if (selectedItem) {
            const selectedProject = currentProjects.find(proj => proj.name === selectedItem.label);
            if (selectedProject) {
                const shadowPath = path.join(selectedProject.path, relativePath);
                const shadowUri = vscode.Uri.file(shadowPath);
                logChannel.appendLine(`User selected project "${selectedProject.name}". Checking path: ${shadowPath}`);

                try {
                    // Check existence AFTER selection
                    await fs.promises.access(shadowPath);
                    logChannel.appendLine(`File found in "${selectedProject.name}". Opening diff.`);
                    const diffTitle = `${path.basename(workspaceUri.fsPath)} (Workspace ↔ Shadow: ${selectedProject.name})`;
                    await vscode.commands.executeCommand('vscode.diff', workspaceUri, shadowUri, diffTitle);
                } catch (error: any) {
                    // Handle file not found in the selected shadow project
                    if (error.code === 'ENOENT') {
                        logChannel.appendLine(`File not found in selected shadow project "${selectedProject.name}" at: ${shadowPath}`);
                        vscode.window.showInformationMessage(`File "${path.basename(workspaceUri.fsPath)}" was not found in the selected shadow project "${selectedProject.name}".`);
                    } else {
                        // Log other errors
                        logChannel.appendLine(`Error accessing shadow file ${shadowPath}: ${error.message}`);
                        vscode.window.showErrorMessage(`An error occurred while accessing the shadow file: ${error.message}`);
                    }
                }
            } else {
                logChannel.appendLine(`Could not find selected shadow project details for label: ${selectedItem.label}`);
                vscode.window.showErrorMessage('Could not find details for the selected shadow project.'); // Should not happen
            }
        } else {
            logChannel.appendLine('User cancelled shadow project selection.');
        }
    });

    const compareSelectedFiles = vscode.commands.registerCommand('shadow-project.compareSelectedFiles', async (focusedItem: vscode.Uri | vscode.TreeItem | undefined, selectedItems: (vscode.Uri | vscode.TreeItem)[]) => {
        logChannel.appendLine('Command: compareSelectedFiles triggered.');

        // Ensure exactly two items are selected
        if (!selectedItems || selectedItems.length !== 2) {
            logChannel.appendLine(`Expected 2 selected items, but got ${selectedItems?.length ?? 0}.`);
            vscode.window.showInformationMessage('Please select exactly two files in the Shadow Projects view to compare.');
            return;
        }

        const uris: vscode.Uri[] = [];

        // Extract URIs from the selected items
        for (const item of selectedItems) {
            let uri: vscode.Uri | undefined;
            if (item instanceof vscode.Uri) {
                uri = item;
            } else if (item instanceof vscode.TreeItem && item.resourceUri) {
                uri = item.resourceUri;
            } else if (item instanceof ShadowFileItem && item.resourceUri) { // Handle our custom item type
                uri = item.resourceUri;
            }

            if (uri && uri.scheme === 'file') {
                uris.push(uri);
            } else {
                logChannel.appendLine(`Selected item is not a valid file URI: ${JSON.stringify(item)}`);
            }
        }

        // Ensure we got two valid file URIs
        if (uris.length !== 2) {
            logChannel.appendLine(`Could not extract two valid file URIs from selection. Found ${uris.length}.`);
            vscode.window.showErrorMessage('Could not get valid file paths for both selected items.');
            return;
        }

        // Execute the built-in diff command
        const [uri1, uri2] = uris;
        const title = `${path.basename(uri1.fsPath)} ↔ ${path.basename(uri2.fsPath)}`;
        logChannel.appendLine(`Comparing selected files: ${uri1.fsPath} and ${uri2.fsPath}`);
        await vscode.commands.executeCommand('vscode.diff', uri1, uri2, title);
    });

    // Remove the context menu command registration as it's less applicable now
    // const removeShadowProjectFromContext = ... (Removed)

    // --- Command: Open Item in Containing Project ---
    const openItemInContainingProjectCommand = vscode.commands.registerCommand('shadow-project.openItemInContainingProject', async (item: vscode.TreeItem | vscode.Uri | undefined) => {
        logChannel.appendLine('Command: openItemInContainingProject triggered.');

        let itemPath: string | undefined;
        let itemType: 'workspace' | 'shadow' | 'mergedDirectory' | 'unknown' = 'unknown';
        let shadowProjectName: string | undefined;
        let shadowProjectPath: string | undefined;

        // Determine the path and type from the input item
        if (item instanceof ShadowFileItem) {
            itemPath = item.shadowSource.fullPath;
            itemType = 'shadow';
            shadowProjectName = item.shadowSource.projectName;
            shadowProjectPath = item.shadowSource.projectPath;
            logChannel.appendLine(`Item is ShadowFileItem: ${itemPath} from ${shadowProjectName}`);
        } else if (item instanceof MergedDirectoryItem) {
            // For merged dirs, prioritize workspace if present, else first shadow source.
            itemType = 'mergedDirectory';
            const workspaceSourcePath = item.sourceDirectoryPaths.find(p => p.startsWith(getCurrentWorkspaceRoot() ?? '___'));
            if (workspaceSourcePath) {
                itemPath = workspaceSourcePath;
                itemType = 'workspace';
                logChannel.appendLine(`Item is MergedDirectoryItem, using workspace source: ${itemPath}`);
            } else if (item.sourceDirectoryPaths.length > 0) {
                itemPath = item.sourceDirectoryPaths[0]; // Use the first shadow path
                const shadow = currentShadowProjects.find(p => itemPath!.startsWith(p.path));
                if (shadow) {
                    itemType = 'shadow';
                    shadowProjectName = shadow.name;
                    shadowProjectPath = shadow.path;
                    logChannel.appendLine(`Item is MergedDirectoryItem, using shadow source: ${itemPath} from ${shadowProjectName}`);
                } else {
                     logChannel.appendLine(`Item is MergedDirectoryItem, couldn't determine shadow project for path: ${itemPath}`);
                     itemPath = undefined;
                }
            } else {
                 logChannel.appendLine(`Item is MergedDirectoryItem with no source paths.`);
                 itemPath = undefined;
            }
        } else if (item instanceof vscode.TreeItem && item.resourceUri && item.contextValue === 'workspaceFile') {
            itemPath = item.resourceUri.fsPath;
            itemType = 'workspace';
            logChannel.appendLine(`Item is workspaceFile TreeItem: ${itemPath}`);
        } else if (item instanceof vscode.TreeItem && item.resourceUri && item.contextValue === 'unknownItem') {
             itemPath = item.resourceUri.fsPath;
             itemType = 'unknown'; // Need to determine if workspace or shadow
             logChannel.appendLine(`Item is unknownItem TreeItem: ${itemPath}`);
        } else if (item instanceof vscode.Uri) {
            itemPath = item.fsPath;
            itemType = 'unknown'; // Need to determine if workspace or shadow
            logChannel.appendLine(`Item is Uri: ${itemPath}`);
        } else {
            logChannel.appendLine(`Command triggered with invalid or missing item.`);
            vscode.window.showErrorMessage('Cannot determine the item to open.');
            return;
        }

        if (!itemPath) {
             logChannel.appendLine(`Could not determine a valid path for the selected item.`);
             vscode.window.showErrorMessage('Could not determine the path for the selected item.');
             return;
        }

        // If type is unknown, determine it now based on path
        if (itemType === 'unknown') {
             if (itemPath.startsWith(getCurrentWorkspaceRoot() ?? '___')) {
                 itemType = 'workspace';
             } else {
                 const shadow = currentShadowProjects.find(p => itemPath!.startsWith(p.path));
                 if (shadow) {
                     itemType = 'shadow';
                     shadowProjectName = shadow.name; // Not strictly needed here, but good for consistency
                     shadowProjectPath = shadow.path;
                 } else {
                      logChannel.appendLine(`Could not determine if unknown path belongs to workspace or shadow: ${itemPath}`);
                      vscode.window.showErrorMessage('Could not determine the containing project for this item.');
                      return; // Cannot proceed
                 }
             }
             logChannel.appendLine(`Determined type for unknown item as: ${itemType}`);
        }

        // --- Determine Project Root ---
        let projectRootPath: string | undefined;
        if (itemType === 'workspace') {
            projectRootPath = getCurrentWorkspaceRoot();
        } else if (itemType === 'shadow' && shadowProjectPath) {
            projectRootPath = shadowProjectPath;
        }
        // MergedDirectory case already resolved itemType to 'workspace' or 'shadow'

        // --- Get Resource URI for the selected item itself ---
        let resourceUri: vscode.Uri | undefined;
         if (item instanceof vscode.Uri) {
            resourceUri = item;
        } else if (item instanceof vscode.TreeItem && item.resourceUri) {
            resourceUri = item.resourceUri;
        } // ShadowFileItem and MergedDirectoryItem are subclasses of TreeItem

        // --- Execute Actions ---
        if (projectRootPath) {
            logChannel.appendLine(`Opening containing project folder in new window: ${projectRootPath}`);
            const folderUri = vscode.Uri.file(projectRootPath);
            // Open the folder in a new window
            await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: true });

            // Removed the logic to open the file in the current window

        } else {
            logChannel.appendLine(`Could not resolve the containing project root for path: ${itemPath} (Type: ${itemType})`);
            vscode.window.showErrorMessage('Could not determine the containing project folder for this item.');
        }
    });

    // --- NEW COMMAND: Open Shadow File from Path ---
    const openShadowFileFromPath = vscode.commands.registerCommand('shadow-project.openShadowFileFromPath', async () => {
        logChannel.appendLine('Command: openShadowFileFromPath triggered.');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            logChannel.appendLine('No active text editor.');
            return;
        }

        const document = editor.document;
        const position = editor.selection.active;
        const currentWorkspaceRoot = getCurrentWorkspaceRoot(); // Use existing helper

        let potentialPath: string | undefined;
        let isLinkPath = false; // Flag to know if path came from link provider

        // Try using link provider first
        try {
            const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
                'vscode.executeLinkProvider',
                document.uri,
                // Add a cancellation token in case it takes too long
                new vscode.CancellationTokenSource().token
            );
            // Find the most specific link containing the position
            const linkAtPosition = links
                .filter(link => link.range.contains(position))
                .sort((a, b) => {
                    // Sort by range length (smaller range is more specific)
                    const lengthA = document.offsetAt(a.range.end) - document.offsetAt(a.range.start);
                    const lengthB = document.offsetAt(b.range.end) - document.offsetAt(b.range.start);
                    return lengthA - lengthB;
                })[0]; // Get the first one (most specific)

            if (linkAtPosition?.target) {
                // Link targets can be URIs or strings. Handle URI case.
                if (linkAtPosition.target instanceof vscode.Uri) {
                    potentialPath = linkAtPosition.target.fsPath;
                } else if (typeof linkAtPosition.target === 'string') {
                     // If it's a string, it might be a relative path or something else
                     // We'll treat it as a potential path string for now
                     potentialPath = linkAtPosition.target;
                }
                if (potentialPath) {
                    isLinkPath = true;
                    logChannel.appendLine(`Found path via link provider: ${potentialPath}`);
                }
            }
        } catch (err) {
            // Log but don't fail, fallback will handle it
            logChannel.appendLine(`Error executing link provider: ${err}`);
        }

        // Fallback: Get text around cursor if no link found
        if (!potentialPath) {
            // Regex to capture typical file paths (including relative ./ ../ and spaces if quoted)
            // This is a basic attempt and might need refinement
            const pathRegex = /(['"])([^'"]+\.\w+)\1|([\w\/\.\-\_]+(?:\.[\w]+))|(\.\.?\/[\w\/\.\-\_]+)/;
            const wordRange = document.getWordRangeAtPosition(position, pathRegex);
            if (wordRange) {
                potentialPath = document.getText(wordRange);
                // Basic cleanup (remove surrounding quotes)
                potentialPath = potentialPath.replace(/^['"]|['"]$/g, '');
                logChannel.appendLine(`Found potential path via word range: ${potentialPath}`);
            }
        }

        if (!potentialPath) {
            logChannel.appendLine('No potential path found at cursor.');
            vscode.window.showInformationMessage('Shadow Project: No file path found at cursor.');
            return;
        }

        // Determine the path to use for searching
        let searchPath = potentialPath;
        // If the path starts with '/' AND it didn't come from a link provider (which might be a valid absolute URI)
        // treat it as relative-from-root by stripping the leading '/'.
        if (potentialPath.startsWith('/') && !isLinkPath) {
            searchPath = potentialPath.substring(1);
            logChannel.appendLine(`Path started with '/'; treating as relative to project roots: ${searchPath}`);
        } else if (potentialPath.startsWith('/') && isLinkPath) {
             logChannel.appendLine(`Path from link provider starts with '/'; treating as absolute: ${potentialPath}`);
             // Keep searchPath as potentialPath for absolute check
        } else {
             logChannel.appendLine(`Path does not start with '/'; treating as relative or absolute: ${potentialPath}`);
             // Keep searchPath as potentialPath for relative/absolute check
        }

        // We no longer need separate absolutePathForWorkspaceCheck logic,
        // as findAndOpenFile uses path.resolve which handles both absolute and relative searchPath inputs correctly.


        // Get current state for searching
        const currentProjects = getStoredProjects();
        // Access ignore instances safely from the treeDataProvider
        // Need to cast to 'any' temporarily to access private members, or add public getters to the class
        const workspaceIg = treeDataProvider ? (treeDataProvider as any).workspaceIg : undefined;
        const shadowIgs = treeDataProvider ? (treeDataProvider as any).shadowIgs : new Map<string, Ignore>();

        if (!treeDataProvider) {
             logChannel.appendLine('TreeDataProvider not available for ignore rules.');
             vscode.window.showWarningMessage('Shadow Project: View not fully initialized. Cannot check ignore rules.');
             return; // Safer to just return if ignores aren't ready
        }

        // Search and open using the helper function
        const findResult = await findAndOpenFile(searchPath, currentWorkspaceRoot, currentProjects, workspaceIg, shadowIgs);

        if (findResult) {
            // File opened successfully, now reveal it in the tree view
            if (shadowTreeView) {
                try {
                    let itemToReveal: vscode.TreeItem | undefined;
                    const itemName = path.basename(findResult.uri.fsPath);

                    if (findResult.type === 'workspace') {
                        // Construct a basic TreeItem for workspace files matching how getChildren creates them
                        itemToReveal = new vscode.TreeItem(itemName, vscode.TreeItemCollapsibleState.None);
                        itemToReveal.resourceUri = findResult.uri;
                        itemToReveal.contextValue = 'workspaceFile'; // Match context value
                        itemToReveal.command = { command: 'vscode.open', title: "Open File", arguments: [findResult.uri] }; // Add command
                    } else if (findResult.type === 'shadow' && findResult.shadowSource) {
                        // Construct the specific ShadowFileItem
                        itemToReveal = new ShadowFileItem(itemName, findResult.shadowSource);
                        // ShadowFileItem constructor sets resourceUri, description, contextValue, command
                    }

                    if (itemToReveal) {
                        logChannel.appendLine(`Revealing opened file in tree view: ${findResult.uri.fsPath}`);
                        // Simplify options: select the item, but don't force focus or expansion initially
                        await shadowTreeView.reveal(itemToReveal, { select: true, focus: false, expand: false });
                    } else {
                         logChannel.appendLine(`Could not construct TreeItem for reveal: ${findResult.uri.fsPath}`);
                    }

                } catch (revealError: any) {
                    logChannel.appendLine(`Error revealing item in tree view: ${revealError.message}`);
                    // Don't bother the user, just log it.
                }
            } else {
                logChannel.appendLine('Shadow tree view not available to reveal item.');
            }
        } else {
            // File not found or couldn't be opened
            // Use the original potentialPath for the message
            // Use the original potentialPath for the message
            vscode.window.showInformationMessage(`Shadow Project: Could not find '${potentialPath}' in workspace or shadow projects.`);
        }
    });

    // --- UPDATED COMMAND: Copy Workspace/Shadow File to Another Shadow Project ---
    const copyToShadow = vscode.commands.registerCommand('shadow-project.copyToShadow', async (sourceItem: vscode.TreeItem | vscode.Uri | ShadowFileItem) => {
        logChannel.appendLine('Command: copyToShadow triggered.');
        let sourceUri: vscode.Uri | undefined;
        let sourceBasePath: string | undefined; // Can be workspace root or a shadow project path
        let sourceShadowProjectName: string | undefined; // Name of the source shadow project, if applicable

        const currentWorkspaceRoot = getCurrentWorkspaceRoot(); // Get workspace root once

        if (sourceItem instanceof ShadowFileItem) {
            sourceUri = sourceItem.resourceUri;
            sourceBasePath = sourceItem.shadowSource.projectPath;
            sourceShadowProjectName = sourceItem.shadowSource.projectName;
            logChannel.appendLine(`Copying from shadow file context menu: ${sourceUri?.fsPath} (Source Project: ${sourceShadowProjectName})`);
        } else if (sourceItem instanceof vscode.TreeItem && sourceItem.resourceUri && sourceItem.contextValue === 'workspaceFile') {
            sourceUri = sourceItem.resourceUri;
            sourceBasePath = currentWorkspaceRoot;
            logChannel.appendLine(`Copying from workspace file context menu: ${sourceUri?.fsPath}`);
        } else if (sourceItem instanceof vscode.Uri) {
            // Determine if URI is workspace or shadow
            if (currentWorkspaceRoot && sourceItem.fsPath.startsWith(currentWorkspaceRoot)) {
                sourceUri = sourceItem;
                sourceBasePath = currentWorkspaceRoot;
                logChannel.appendLine(`Copying from workspace URI: ${sourceUri?.fsPath}`);
            } else {
                // Check if it's in a known shadow project
                const currentProjects = getStoredProjects();
                const foundShadow = currentProjects.find(p => sourceItem.fsPath.startsWith(p.path));
                if (foundShadow) {
                    sourceUri = sourceItem;
                    sourceBasePath = foundShadow.path;
                    sourceShadowProjectName = foundShadow.name;
                    logChannel.appendLine(`Copying from shadow URI: ${sourceUri?.fsPath} (Source Project: ${sourceShadowProjectName})`);
                } else {
                    logChannel.appendLine(`URI provided is not within the workspace or any known shadow project: ${sourceItem.fsPath}`);
                    vscode.window.showErrorMessage('Selected item is not a file within the workspace or a known shadow project.');
                    return;
                }
            }
        } else {
            logChannel.appendLine('Copy command triggered without a valid source file.');
            vscode.window.showInformationMessage('Please right-click a file in the Shadow Projects view to copy.');
            return;
        }
        if (!sourceUri || !sourceBasePath) {
            logChannel.appendLine('Copy command missing necessary source file information (URI or BasePath).');
            vscode.window.showErrorMessage('Could not get source file details.');
            return;
        }

        // No longer need workspaceRoot check here, sourceBasePath covers it
        // Ensure it's a file, not a directory (for now)
        try {
            const stat = await fsPromises.stat(sourceUri.fsPath);
            if (!stat.isFile()) {
                logChannel.appendLine(`Attempted to copy a directory (not supported yet): ${sourceUri.fsPath}`);
                vscode.window.showInformationMessage('Copying directories is not yet supported. Please select a file.');
                return;
            }
        } catch (error: any) {
             logChannel.appendLine(`Error stating file ${sourceUri.fsPath}: ${error.message}`);
             vscode.window.showErrorMessage(`Could not access the file to copy: ${error.message}`);
             return;
        }

        // Calculate relative path based on the determined sourceBasePath
        const relativePath = path.relative(sourceBasePath, sourceUri.fsPath);
        logChannel.appendLine(`Source path: ${sourceUri.fsPath}`);
        logChannel.appendLine(`Source base path: ${sourceBasePath}`);
        logChannel.appendLine(`Relative path: ${relativePath}`);

        const currentProjects = getStoredProjects();
        // Show Quick Pick to select target shadow project, filtering out the source project if applicable
        const targetProjects = currentProjects.filter(p => p.name !== sourceShadowProjectName);

        if (targetProjects.length === 0) {
             logChannel.appendLine('No other shadow projects available to copy to.');
             vscode.window.showInformationMessage('No other shadow projects configured to copy to.');
             return;
        }

        const items: vscode.QuickPickItem[] = targetProjects.map(proj => ({
            label: proj.name,
            description: proj.path,
            detail: `Copy "${path.basename(sourceUri!.fsPath)}" to this project`
        }));

        const selectedItem = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select the target shadow project',
            title: `Copy "${path.basename(sourceUri.fsPath)}" to Shadow Project`
        });

        if (selectedItem) {
            const selectedProject = targetProjects.find(proj => proj.name === selectedItem.label); // Find within filtered list
            if (selectedProject) {
                const targetShadowPath = path.join(selectedProject.path, relativePath);
                const targetShadowUri = vscode.Uri.file(targetShadowPath);
                logChannel.appendLine(`User selected project "${selectedProject.name}". Target path: ${targetShadowPath}`);

                try {
                    // Check if target exists and confirm overwrite
                    let proceed = true;
                    try {
                        await fsPromises.access(targetShadowPath);
                        logChannel.appendLine(`Target file already exists: ${targetShadowPath}`);
                        const confirmation = await vscode.window.showWarningMessage(
                            `File already exists in shadow project "${selectedProject.name}":\n${relativePath}\n\nOverwrite?`,
                            { modal: true }, // Make it modal so user must respond
                            'Overwrite'
                        );
                        if (confirmation !== 'Overwrite') {
                            proceed = false;
                            logChannel.appendLine('User cancelled overwrite.');
                        }
                    } catch (accessError: any) {
                        // ENOENT means file doesn't exist, which is good. Other errors are problems.
                        if (accessError.code !== 'ENOENT') {
                            throw accessError; // Re-throw other access errors
                        }
                        // File doesn't exist, proceed is already true
                    }

                    if (proceed) {
                        // Ensure target directory exists
                        const targetDir = path.dirname(targetShadowPath);
                        await fsPromises.mkdir(targetDir, { recursive: true });
                        logChannel.appendLine(`Ensured directory exists: ${targetDir}`);

                        // Perform the copy
                        await fsPromises.copyFile(sourceUri.fsPath, targetShadowPath);
                        logChannel.appendLine(`File copied successfully to ${targetShadowPath}`);
                        vscode.window.showInformationMessage(`File copied to shadow project "${selectedProject.name}".`);

                        // Refresh the tree view
                        if (treeDataProvider) {
                            treeDataProvider.refresh();
                        }
                    }
                } catch (error: any) {
                    logChannel.appendLine(`Error copying file to shadow project: ${error.message}`);
                    vscode.window.showErrorMessage(`Failed to copy file: ${error.message}`);
                }
            } else {
                logChannel.appendLine(`Could not find selected shadow project details for label: ${selectedItem.label}`);
                vscode.window.showErrorMessage('Could not find details for the selected shadow project.');
            }
        } else {
            logChannel.appendLine('User cancelled shadow project selection for copy.');
        }
    });

    // --- COMMAND: Copy Shadow File to Workspace (No change needed here, already specific) ---
    const copyToWorkspace = vscode.commands.registerCommand('shadow-project.copyToWorkspace', async (shadowItem: ShadowFileItem | vscode.Uri) => {
        logChannel.appendLine('Command: copyToWorkspace triggered.');

        let shadowUri: vscode.Uri | undefined;
        let shadowSource: MergedItemSource | undefined;

        // Command can be triggered from palette (no arg) or context menu (TreeItem/Uri)
        if (shadowItem instanceof ShadowFileItem) {
            shadowUri = shadowItem.resourceUri;
            shadowSource = shadowItem.shadowSource;
            logChannel.appendLine(`Copying from shadow context menu: ${shadowUri?.fsPath} (Project: ${shadowSource?.projectName})`);
        } else if (shadowItem instanceof vscode.Uri) {
             // Allow triggering via URI, but need to find its shadow source info
             shadowUri = shadowItem;
             const currentProjects = getStoredProjects();
             shadowSource = currentProjects
                .map(p => ({ proj: p, relPath: path.relative(p.path, shadowUri!.fsPath) }))
                .filter(o => !o.relPath.startsWith('..') && !path.isAbsolute(o.relPath)) // Find project containing the URI
                .map(o => ({
                    projectName: o.proj.name,
                    projectPath: o.proj.path,
                    fullPath: shadowUri!.fsPath,
                    fileType: vscode.FileType.File // Assume file for now
                }))[0];

             if (shadowSource) {
                 logChannel.appendLine(`Copying from shadow URI: ${shadowUri?.fsPath} (Project: ${shadowSource?.projectName})`);
             } else {
                 logChannel.appendLine(`URI provided is not within any known shadow project: ${shadowItem.fsPath}`);
                 vscode.window.showErrorMessage('Selected item is not a file within a known shadow project.');
                 return;
             }
        } else {
            logChannel.appendLine('Copy command triggered without a valid shadow target file.');
            vscode.window.showInformationMessage('Please right-click a shadow file in the Shadow Projects view to copy.');
            return;
        }

        if (!shadowUri || !shadowSource) {
            logChannel.appendLine('Copy command missing necessary shadow file information.');
            vscode.window.showErrorMessage('Could not get shadow file details.');
            return;
        }

        const workspaceRoot = getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            logChannel.appendLine('No workspace root found for copy operation.');
            vscode.window.showWarningMessage('No workspace folder open to copy into.');
            return;
        }

         // Ensure it's a file, not a directory (for now)
         try {
            const stat = await fsPromises.stat(shadowUri.fsPath);
            if (!stat.isFile()) {
                logChannel.appendLine(`Attempted to copy a directory (not supported yet): ${shadowUri.fsPath}`);
                vscode.window.showInformationMessage('Copying directories is not yet supported. Please select a file.');
                return;
            }
        } catch (error: any) {
             logChannel.appendLine(`Error stating file ${shadowUri.fsPath}: ${error.message}`);
             vscode.window.showErrorMessage(`Could not access the file to copy: ${error.message}`);
             return;
        }

        const relativePath = path.relative(shadowSource.projectPath, shadowUri.fsPath);
        const targetWorkspacePath = path.join(workspaceRoot, relativePath);
        const targetWorkspaceUri = vscode.Uri.file(targetWorkspacePath);

        logChannel.appendLine(`Shadow path: ${shadowUri.fsPath}`);
        logChannel.appendLine(`Relative path: ${relativePath}`);
        logChannel.appendLine(`Target workspace path: ${targetWorkspacePath}`);

        try {
            // Check if target exists and confirm overwrite
            let proceed = true;
            try {
                await fsPromises.access(targetWorkspacePath);
                logChannel.appendLine(`Target file already exists in workspace: ${targetWorkspacePath}`);
                const confirmation = await vscode.window.showWarningMessage(
                    `File already exists in the workspace:\n${relativePath}\n\nOverwrite?`,
                    { modal: true },
                    'Overwrite'
                );
                if (confirmation !== 'Overwrite') {
                    proceed = false;
                    logChannel.appendLine('User cancelled overwrite.');
                }
            } catch (accessError: any) {
                 // ENOENT means file doesn't exist, which is good. Other errors are problems.
                 if (accessError.code !== 'ENOENT') {
                    throw accessError; // Re-throw other access errors
                 }
                 // File doesn't exist, proceed is already true
            }

            if (proceed) {
                // Ensure target directory exists
                const targetDir = path.dirname(targetWorkspacePath);
                await fsPromises.mkdir(targetDir, { recursive: true });
                logChannel.appendLine(`Ensured directory exists: ${targetDir}`);

                // Perform the copy
                await fsPromises.copyFile(shadowUri.fsPath, targetWorkspacePath);
                logChannel.appendLine(`File copied successfully to ${targetWorkspacePath}`);
                vscode.window.showInformationMessage(`File copied to workspace from "${shadowSource.projectName}".`);

                // Refresh the tree view
                if (treeDataProvider) {
                    treeDataProvider.refresh();
                }
            }
        } catch (error: any) {
            logChannel.appendLine(`Error copying file to workspace: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to copy file: ${error.message}`);
        }
    });

    // --- NEW COMMAND: Move Shadow File to Workspace ---
    const moveToWorkspace = vscode.commands.registerCommand('shadow-project.moveToWorkspace', async (shadowItem: ShadowFileItem | vscode.Uri) => {
        logChannel.appendLine('Command: moveToWorkspace triggered.');

        let shadowUri: vscode.Uri | undefined;
        let shadowSource: MergedItemSource | undefined;

        // Extract info (similar to copyToWorkspace)
        if (shadowItem instanceof ShadowFileItem) {
            shadowUri = shadowItem.resourceUri;
            shadowSource = shadowItem.shadowSource;
            logChannel.appendLine(`Moving from shadow context menu: ${shadowUri?.fsPath} (Project: ${shadowSource?.projectName})`);
        } else if (shadowItem instanceof vscode.Uri) {
             shadowUri = shadowItem;
             const currentProjects = getStoredProjects();
             shadowSource = currentProjects
                .map(p => ({ proj: p, relPath: path.relative(p.path, shadowUri!.fsPath) }))
                .filter(o => !o.relPath.startsWith('..') && !path.isAbsolute(o.relPath))
                .map(o => ({
                    projectName: o.proj.name,
                    projectPath: o.proj.path,
                    fullPath: shadowUri!.fsPath,
                    fileType: vscode.FileType.File // Assume file for now
                }))[0];
             if (shadowSource) {
                 logChannel.appendLine(`Moving from shadow URI: ${shadowUri?.fsPath} (Project: ${shadowSource?.projectName})`);
             } else {
                 logChannel.appendLine(`URI provided is not within any known shadow project: ${shadowItem.fsPath}`);
                 vscode.window.showErrorMessage('Selected item is not a file within a known shadow project.');
                 return;
             }
        } else {
            logChannel.appendLine('Move command triggered without a valid shadow target file.');
            vscode.window.showInformationMessage('Please right-click a shadow file in the Shadow Projects view to move.');
            return;
        }

        if (!shadowUri || !shadowSource) {
            logChannel.appendLine('Move command missing necessary shadow file information.');
            vscode.window.showErrorMessage('Could not get shadow file details.');
            return;
        }

        const workspaceRoot = getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            logChannel.appendLine('No workspace root found for move operation.');
            vscode.window.showWarningMessage('No workspace folder open to move into.');
            return;
        }

         // Ensure it's a file, not a directory (for now)
         try {
            const stat = await fsPromises.stat(shadowUri.fsPath);
            if (!stat.isFile()) {
                logChannel.appendLine(`Attempted to move a directory (not supported yet): ${shadowUri.fsPath}`);
                vscode.window.showInformationMessage('Moving directories is not yet supported. Please select a file.');
                return;
            }
        } catch (error: any) {
             logChannel.appendLine(`Error stating file ${shadowUri.fsPath}: ${error.message}`);
             vscode.window.showErrorMessage(`Could not access the file to move: ${error.message}`);
             return;
        }

        const relativePath = path.relative(shadowSource.projectPath, shadowUri.fsPath);
        const targetWorkspacePath = path.join(workspaceRoot, relativePath);

        logChannel.appendLine(`Shadow path: ${shadowUri.fsPath}`);
        logChannel.appendLine(`Relative path: ${relativePath}`);
        logChannel.appendLine(`Target workspace path: ${targetWorkspacePath}`);

        try {
            // Check if target exists and confirm overwrite
            let proceed = true;
            try {
                await fsPromises.access(targetWorkspacePath);
                logChannel.appendLine(`Target file already exists in workspace: ${targetWorkspacePath}`);
                const confirmation = await vscode.window.showWarningMessage(
                    `File already exists in the workspace:\n${relativePath}\n\nOverwrite?`,
                    { modal: true },
                    'Overwrite'
                );
                if (confirmation !== 'Overwrite') {
                    proceed = false;
                    logChannel.appendLine('User cancelled overwrite.');
                } else {
                    // If overwriting, delete the target first (rename won't overwrite across different mount points sometimes)
                    // Although rename *should* handle overwrite on the same filesystem. Let's try without delete first.
                    // await fsPromises.unlink(targetWorkspacePath);
                    // logChannel.appendLine(`Deleted existing target file for overwrite: ${targetWorkspacePath}`);
                }
            } catch (accessError: any) {
                 if (accessError.code !== 'ENOENT') throw accessError; // Re-throw other access errors
            }

            if (proceed) {
                // Ensure target directory exists
                const targetDir = path.dirname(targetWorkspacePath);
                await fsPromises.mkdir(targetDir, { recursive: true });
                logChannel.appendLine(`Ensured directory exists: ${targetDir}`);

                // Perform the move (rename)
                await fsPromises.rename(shadowUri.fsPath, targetWorkspacePath);
                logChannel.appendLine(`File moved successfully to ${targetWorkspacePath}`);
                vscode.window.showInformationMessage(`File moved to workspace from "${shadowSource.projectName}".`);

                // Refresh the tree view
                if (treeDataProvider) {
                    treeDataProvider.refresh();
                }
            }
        } catch (error: any) {
            logChannel.appendLine(`Error moving file to workspace: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to move file: ${error.message}`);
        }
    });


    // --- UPDATED COMMAND: Move Workspace/Shadow File to Another Shadow Project ---
    const moveToShadow = vscode.commands.registerCommand('shadow-project.moveToShadow', async (sourceItem: vscode.TreeItem | vscode.Uri | ShadowFileItem) => {
        logChannel.appendLine('Command: moveToShadow triggered.');
        let sourceUri: vscode.Uri | undefined;
        let sourceBasePath: string | undefined;
        let sourceShadowProjectName: string | undefined;

        const currentWorkspaceRoot = getCurrentWorkspaceRoot();

        // Extract info (similar logic to updated copyToShadow)
        if (sourceItem instanceof ShadowFileItem) {
            sourceUri = sourceItem.resourceUri;
            sourceBasePath = sourceItem.shadowSource.projectPath;
            sourceShadowProjectName = sourceItem.shadowSource.projectName;
            logChannel.appendLine(`Moving from shadow file context menu: ${sourceUri?.fsPath} (Source Project: ${sourceShadowProjectName})`);
        } else if (sourceItem instanceof vscode.TreeItem && sourceItem.resourceUri && sourceItem.contextValue === 'workspaceFile') {
            sourceUri = sourceItem.resourceUri;
            sourceBasePath = currentWorkspaceRoot;
            logChannel.appendLine(`Moving from workspace file context menu: ${sourceUri?.fsPath}`);
        } else if (sourceItem instanceof vscode.Uri) {
             if (currentWorkspaceRoot && sourceItem.fsPath.startsWith(currentWorkspaceRoot)) {
                sourceUri = sourceItem;
                sourceBasePath = currentWorkspaceRoot;
                logChannel.appendLine(`Moving from workspace URI: ${sourceUri?.fsPath}`);
            } else {
                const currentProjects = getStoredProjects();
                const foundShadow = currentProjects.find(p => sourceItem.fsPath.startsWith(p.path));
                if (foundShadow) {
                    sourceUri = sourceItem;
                    sourceBasePath = foundShadow.path;
                    sourceShadowProjectName = foundShadow.name;
                    logChannel.appendLine(`Moving from shadow URI: ${sourceUri?.fsPath} (Source Project: ${sourceShadowProjectName})`);
                } else {
                    logChannel.appendLine(`URI provided is not within the workspace or any known shadow project: ${sourceItem.fsPath}`);
                    vscode.window.showErrorMessage('Selected item is not a file within the workspace or a known shadow project.');
                    return;
                }
            }
        } else {
            logChannel.appendLine('Move command triggered without a valid source file.');
            vscode.window.showInformationMessage('Please right-click a file in the Shadow Projects view to move.');
            return;
        }
        if (!sourceUri || !sourceBasePath) {
            logChannel.appendLine('Move command missing necessary source file information (URI or BasePath).');
            vscode.window.showErrorMessage('Could not get source file details.');
            return;
        }

        // No longer need workspaceRoot check here
        // Ensure it's a file, not a directory (for now)
        try {
            const stat = await fsPromises.stat(sourceUri.fsPath);
            if (!stat.isFile()) {
                logChannel.appendLine(`Attempted to move a directory (not supported yet): ${sourceUri.fsPath}`);
                vscode.window.showInformationMessage('Moving directories is not yet supported. Please select a file.');
                return;
            }
        } catch (error: any) {
             logChannel.appendLine(`Error stating file ${sourceUri.fsPath}: ${error.message}`);
             vscode.window.showErrorMessage(`Could not access the file to move: ${error.message}`);
             return;
        }


        // Calculate relative path based on the determined sourceBasePath
        const relativePath = path.relative(sourceBasePath, sourceUri.fsPath);
        logChannel.appendLine(`Source path: ${sourceUri.fsPath}`);
        logChannel.appendLine(`Source base path: ${sourceBasePath}`);
        logChannel.appendLine(`Relative path: ${relativePath}`);

        const currentProjects = getStoredProjects();
        // Show Quick Pick to select target shadow project, filtering out the source project if applicable
        const targetProjects = currentProjects.filter(p => p.name !== sourceShadowProjectName);

         if (targetProjects.length === 0) {
             logChannel.appendLine('No other shadow projects available to move to.');
             vscode.window.showInformationMessage('No other shadow projects configured to move to.');
             return;
        }

        const items: vscode.QuickPickItem[] = targetProjects.map(proj => ({
            label: proj.name,
            description: proj.path,
            detail: `Move "${path.basename(sourceUri!.fsPath)}" to this project`
        }));

        const selectedItem = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select the target shadow project',
            title: `Move "${path.basename(sourceUri.fsPath)}" to Shadow Project`
        });

        if (selectedItem) {
            const selectedProject = targetProjects.find(proj => proj.name === selectedItem.label); // Find within filtered list
            if (selectedProject) {
                const targetShadowPath = path.join(selectedProject.path, relativePath);
                logChannel.appendLine(`User selected project "${selectedProject.name}". Target path: ${targetShadowPath}`);

                try {
                    // Check if target exists and confirm overwrite
                    let proceed = true;
                    try {
                        await fsPromises.access(targetShadowPath);
                        logChannel.appendLine(`Target file already exists: ${targetShadowPath}`);
                        const confirmation = await vscode.window.showWarningMessage(
                            `File already exists in shadow project "${selectedProject.name}":\n${relativePath}\n\nOverwrite?`,
                            { modal: true },
                            'Overwrite'
                        );
                        if (confirmation !== 'Overwrite') {
                            proceed = false;
                            logChannel.appendLine('User cancelled overwrite.');
                        } else {
                             // If overwriting, delete the target first (rename won't overwrite across different mount points sometimes)
                             // Let's try without delete first.
                            // await fsPromises.unlink(targetShadowPath);
                            // logChannel.appendLine(`Deleted existing target file for overwrite: ${targetShadowPath}`);
                        }
                    } catch (accessError: any) {
                        if (accessError.code !== 'ENOENT') throw accessError; // Re-throw other access errors
                    }

                    if (proceed) {
                        // Ensure target directory exists
                        const targetDir = path.dirname(targetShadowPath);
                        await fsPromises.mkdir(targetDir, { recursive: true });
                        logChannel.appendLine(`Ensured directory exists: ${targetDir}`);

                        // Perform the move (rename)
                        await fsPromises.rename(sourceUri.fsPath, targetShadowPath);
                        logChannel.appendLine(`File moved successfully to ${targetShadowPath}`);
                        vscode.window.showInformationMessage(`File moved to shadow project "${selectedProject.name}".`);

                        // Refresh the tree view
                        if (treeDataProvider) {
                            treeDataProvider.refresh();
                        }
                    }
                } catch (error: any) {
                    logChannel.appendLine(`Error moving file to shadow project: ${error.message}`);
                    vscode.window.showErrorMessage(`Failed to move file: ${error.message}`);
                }
            } else {
                logChannel.appendLine(`Could not find selected shadow project details for label: ${selectedItem.label}`);
                vscode.window.showErrorMessage('Could not find details for the selected shadow project.');
            }
        } else {
            logChannel.appendLine('User cancelled shadow project selection for move.');
        }
    });

    // --- NEW COMMAND: Refresh View ---
    const refreshView = vscode.commands.registerCommand('shadow-project.refreshView', () => {
        logChannel.appendLine('Command: refreshView triggered.');
        if (treeDataProvider) {
            treeDataProvider.refresh();
            logChannel.appendLine('Tree view refreshed.');
        } else {
            logChannel.appendLine('Refresh command triggered, but treeDataProvider is not available.');
            // Optionally show a message if the provider isn't ready, though it might be noise
            // vscode.window.showWarningMessage('Shadow Project view is not yet initialized.');
        }
    });



    context.subscriptions.push(
        addShadowProject,
        removeShadowProject,
        renameShadowProject,
        compareWithWorkspace,
        compareWithShadow,
        compareSelectedFiles,
        openItemInContainingProjectCommand,
        openShadowFileFromPath,
        copyToShadow,
        copyToWorkspace,
        refreshView,
        moveToWorkspace, // Register move commands
        moveToShadow
);

    // Watch for workspace folder changes to update the tree provider's root
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        logChannel.appendLine('Workspace folders changed, updating tree provider state.');
        // Update both root and shadow projects list from storage
        const latestProjects = getStoredProjects(); // Get latest list after change
        treeDataProvider.updateWorkspaceRoot(getCurrentWorkspaceRoot());
        treeDataProvider.updateShadowProjects(latestProjects);
    }));

    logChannel.appendLine(`Commands registered. Total subscriptions: ${context.subscriptions.length}`);
    logChannel.appendLine('ShadowProject extension activation complete (merged view).');
}

// --- Extension Deactivation ---
export function deactivate() {
    logChannel.appendLine('ShadowProject extension deactivated');
    // Cleanup logic if needed
}
