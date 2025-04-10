# Shadow Project Extension

This VSCode extension offers a merged files view, which combines files and folders from other project folders.

## Features

*   **Add Shadow Project**: (`shadow-project.addShadowProject`) Select a folder on your system to add as a "shadow project". You'll be prompted to give it a unique name.
*   **Remove Shadow Project**: (`shadow-project.removeShadowProject`) Choose an existing shadow project to remove from the list.
*   **Rename Shadow Project**: (`shadow-project.renameShadowProject`) Select an existing shadow project and provide a new name for it.
*   **Merged View**: Files and folders from your workspace and all added shadow projects are displayed together in the "Shadow Projects (Merged)" view in the Explorer pane. Files unique to shadow projects will have their shadow project name appended in the description. Multi-select is supported using Ctrl/Cmd or Shift keys. A refresh button (`$(refresh)`) is available in the view's title bar.
*   **Compare with Workspace**: Right-click on a single file originating from a shadow project in the Merged View and select "Compare with Workspace Copy" (`shadow-project.compareWithWorkspace`) to open a diff view against the file at the corresponding path in your main workspace (if it exists).
*   **Compare with Shadow**: Right-click on a single file originating from your workspace in the Merged View and select "Compare with Shadow Copy..." (`shadow-project.compareWithShadow`). If the file exists in only one shadow project, a diff view will open directly. If it exists in multiple shadow projects, you'll be prompted to choose which one to compare against.
*   **Compare Selected**: Select exactly two files within the Merged View (using Ctrl/Cmd + Click or Shift + Click), right-click on one of them, and choose "Compare Selected" (`shadow-project.compareSelectedFiles`) to open a diff view between those two specific files.
*   **Copy to Shadow Project**: Right-click a workspace file or a file from another shadow project and select "Copy to Shadow Project..." (`shadow-project.copyToShadow`). If only one other shadow project exists, the file will be copied directly. Otherwise, you'll be prompted to choose the destination shadow project. Overwrites require confirmation.
*   **Copy to Workspace**: Right-click a file originating from a shadow project and select "Copy to Workspace" (`shadow-project.copyToWorkspace`). The file will be copied to the corresponding path in your workspace. Overwrites require confirmation.
*   **Move to Shadow Project**: Right-click a workspace file or a file from another shadow project and select "Move to Shadow Project..." (`shadow-project.moveToShadow`). If only one other shadow project exists, the file will be moved directly. Otherwise, you'll be prompted to choose the destination shadow project. Overwrites require confirmation.
*   **Move to Workspace**: Right-click a file originating from a shadow project and select "Move to Workspace" (`shadow-project.moveToWorkspace`). The file will be moved to the corresponding path in your workspace. Overwrites require confirmation.
*   **Open Shadow File from Path**: (`shadow-project.openShadowFileFromPath`) Place your cursor on a relative file path within an open editor and press `Cmd+R` (macOS) or `Ctrl+R` (Windows/Linux) to open the corresponding file from any of the shadow projects or the workspace.
*   **Reveal Item in Explorer**: Right-click on a single file or folder in the Merged View and select "Reveal Item in Explorer" (`shadow-project.openItemInContainingProject`). This will reveal the actual file/folder in the standard VS Code Explorer, opening its containing folder if necessary.
