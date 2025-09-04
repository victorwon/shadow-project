// Test file for the split window command
// This file contains various file paths that can be tested with the new command

// Place cursor on any of these paths and use:
// - Cmd+R (Ctrl+R) for normal open
// - Cmd+Shift+R (Ctrl+Shift+R) for split window open

// Test paths:
const relativePath = 'src/extension.ts';
const absolutePath = '/Users/vweng/Projects/ShadowProject/shadow-project/package.json';
const quotedPath = "README.md";
const nestedPath = 'src/test/extension.test.ts';

// You can also test with import statements:
import * as vscode from 'vscode';
// import { activate } from './extension';

console.log('Testing split window functionality');
