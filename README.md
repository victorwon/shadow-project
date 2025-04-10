# Shadow Project Extension

This VSCode extension offers a merged files view, which combines files and folders from other project folders.

## Features

*   **Add Shadow Project**: (`shadow-project.addShadowProject`) Select a folder on your system to add as a "shadow project". You'll be prompted to give it a unique name.
*   **Remove Shadow Project**: (`shadow-project.removeShadowProject`) Choose an existing shadow project to remove from the list.
*   **Rename Shadow Project**: (`shadow-project.renameShadowProject`) Select an existing shadow project and provide a new name for it.
*   **Merged View**: Files and folders from your workspace and all added shadow projects are displayed together in the "Shadow Projects (Merged)" view in the Explorer pane. Files unique to shadow projects will have their shadow project name appended in the description. Multi-select is supported using Ctrl/Cmd or Shift keys.
*   **Compare with Workspace**: Right-click on a single file originating from a shadow project in the Merged View and select "Compare with Workspace Copy" (`shadow-project.compareWithWorkspace`) to open a diff view against the file at the corresponding path in your main workspace (if it exists).
*   **Compare with Shadow**: Right-click on a single file originating from your workspace in the Merged View and select "Compare with Shadow Copy..." (`shadow-project.compareWithShadow`). If the file exists in only one shadow project, a diff view will open directly. If it exists in multiple shadow projects, you'll be prompted to choose which one to compare against.
*   **Compare Selected**: Select exactly two files within the Merged View (using Ctrl/Cmd + Click or Shift + Click), right-click on one of them, and choose "Compare Selected" (`shadow-project.compareSelectedFiles`) to open a diff view between those two specific files.
*   **Open Item in Containing Project**: Right-click on a single file or folder in the Merged View and select "Open Item in Containing Project" (`shadow-project.openItemInContainingProject`). This will open the containing project folder (either the current workspace or the relevant shadow project) in a new VS Code window.
    *   **Note:** Due to VS Code API limitations, it is not possible to automatically open the *specific selected file* within the newly opened project window. Only the project folder itself will be opened.
