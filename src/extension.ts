import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
                     finalTreeItems.push(new MergedDirectoryItem(itemName, allDirPaths));
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

    let treeDataProvider: MergedProjectsTreeDataProvider | undefined;
    let shadowTreeView: vscode.TreeView<vscode.TreeItem> | undefined; // Store the TreeView instance
    // Define view ID before the function that uses it
    const treeViewId = 'shadowProjectsMergedView'; // ID for the merged view in explorer

    const initializeOrUpdateTreeView = () => {
        currentShadowProjects = getStoredProjects();
        const currentWorkspaceRoot = getCurrentWorkspaceRoot();

        if (currentWorkspaceRoot || currentShadowProjects.length > 0) {
            if (treeDataProvider) {
                logChannel.appendLine('Updating existing merged tree view provider.');
                treeDataProvider.updateWorkspaceRoot(currentWorkspaceRoot); // Update root if changed
                treeDataProvider.updateShadowProjects(currentShadowProjects);
            } else {
                logChannel.appendLine('Registering new merged tree view provider.');
                treeDataProvider = new MergedProjectsTreeDataProvider(currentWorkspaceRoot, currentShadowProjects);
                // Create the TreeView with multi-select enabled
                shadowTreeView = vscode.window.createTreeView(treeViewId, { // Assign to stored variable
                    treeDataProvider: treeDataProvider,
                    canSelectMany: true // Enable multi-select
                });
                context.subscriptions.push(shadowTreeView); // Add the TreeView to subscriptions

                // Add the selection change listener to set context
                context.subscriptions.push(shadowTreeView.onDidChangeSelection(e => {
                    const selectionCount = e.selection.length;
                    logChannel.appendLine(`Selection changed. Count: ${selectionCount}`);
                    vscode.commands.executeCommand('setContext', 'shadowProject.selectionCount', selectionCount);
                }));

                // Initial context setting
                vscode.commands.executeCommand('setContext', 'shadowProject.selectionCount', 0);
            }
        } else {
            logChannel.appendLine('No workspace or shadow projects; merged view provider not registered/updated.');
            // If provider exists, maybe clear it? Or let VS Code handle empty view.
            // For now, just ensure it's not created/updated if nothing to show.
            if (treeDataProvider) {
                // How to properly unregister or clear? For now, refresh might show empty.
                treeDataProvider.updateWorkspaceRoot(undefined);
                treeDataProvider.updateShadowProjects([]);
                // Reset selection count context if view becomes empty/disabled
                vscode.commands.executeCommand('setContext', 'shadowProject.selectionCount', 0);
            }
        }
    };

    // Initial setup
    initializeOrUpdateTreeView();

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
                const updatedProjects = [...currentProjects, newProject];
                await updateStoredProjects(updatedProjects);
                logChannel.appendLine(`Added shadow project: ${JSON.stringify(newProject)}`);
                initializeOrUpdateTreeView(); // Update the view
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
            const updatedProjects = currentProjects.filter(p => p.name !== nameToRemove);
            await updateStoredProjects(updatedProjects);
            logChannel.appendLine(`Removed shadow project: ${nameToRemove}`);
            initializeOrUpdateTreeView(); // Update the view
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
            initializeOrUpdateTreeView(); // Update the view
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

        // Resolve the path
        // If the path came from a link provider, it's often absolute already.
        // If it's from word range, it might be relative.
        let resolvedPathForSearch = potentialPath; // Use the original potential path for searching relative to shadow roots
        let absolutePathForWorkspaceCheck = potentialPath;

        if (!path.isAbsolute(potentialPath)) {
            if (currentWorkspaceRoot) {
                absolutePathForWorkspaceCheck = path.resolve(currentWorkspaceRoot, potentialPath);
                logChannel.appendLine(`Resolved relative path for workspace check to: ${absolutePathForWorkspaceCheck}`);
                // Keep resolvedPathForSearch as the original relative path for shadow project checks
            } else {
                 logChannel.appendLine(`Cannot resolve relative path without workspace root: ${potentialPath}`);
                 vscode.window.showWarningMessage('Shadow Project: Cannot resolve relative path without an open workspace folder.');
                 return;
            }
        } else {
             // If it's absolute, use it directly for workspace check
             absolutePathForWorkspaceCheck = potentialPath;
             // For shadow project search, we still need the original form if it was intended relative
             // However, if it came from a link, it's likely absolute and intended as such.
             // If it came from word range and is absolute, treat it as absolute everywhere.
             // This logic assumes absolute paths found in text refer to the system root, not a shadow root.
        }


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
        const findResult = await findAndOpenFile(resolvedPathForSearch, currentWorkspaceRoot, currentProjects, workspaceIg, shadowIgs);

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
                        await shadowTreeView.reveal(itemToReveal, { select: true, focus: true, expand: true });
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
            vscode.window.showInformationMessage(`Shadow Project: Could not find '${potentialPath}' in workspace or shadow projects.`);
        }
    });

    context.subscriptions.push(
        addShadowProject,
        removeShadowProject,
        renameShadowProject,
        compareWithWorkspace,
        compareWithShadow,
        compareSelectedFiles,
        openItemInContainingProjectCommand, // Register the correctly named command
        openShadowFileFromPath // Add the new command here
    );

    // Watch for workspace folder changes to update the tree view
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        logChannel.appendLine('Workspace folders changed, re-initializing/updating merged tree view.');
        initializeOrUpdateTreeView();
    }));

    logChannel.appendLine(`Commands registered. Total subscriptions: ${context.subscriptions.length}`);
    logChannel.appendLine('ShadowProject extension activation complete (merged view).');
}

// --- Extension Deactivation ---
export function deactivate() {
    logChannel.appendLine('ShadowProject extension deactivated');
    // Cleanup logic if needed
}
