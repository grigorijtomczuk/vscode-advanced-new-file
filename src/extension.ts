import * as fs from 'node:fs';
import * as path from 'node:path';

import * as braces from 'braces';
import * as ignore from 'ignore';
import { compact, sortBy, startsWith } from 'lodash';
import * as mkdirp from 'mkdirp';
import * as vscode from 'vscode';
import { QuickPickItem, ViewColumn } from 'vscode';
import * as Cache from 'vscode-cache';

export interface FSLocation {
  relative: string;
  absolute: string;
}

export interface WorkspaceRoot {
  rootPath: string;
  baseName: string;
  multi: boolean;
}

export interface DirectoryOption {
  displayText: string;
  fsLocation: FSLocation;
}

declare module 'vscode' {
  interface QuickPickItem {
    option?: DirectoryOption;
  }
}

function isFolderDescriptor(filepath: string): boolean {
  return filepath.charAt(filepath.length - 1) === path.sep;
}

function walkupGitignores(dir: string, found: string[] = []): string[] {
  const gitignore = path.join(dir, '.gitignore');
  if (fs.existsSync(gitignore)) found.push(gitignore);

  const parentDir = path.resolve(dir, '..');
  const reachedSystemRoot = dir === parentDir;

  if (!reachedSystemRoot) {
    return walkupGitignores(parentDir, found);
  } else {
    return found;
  }
}

function flatten<T>(memo: T[], item: T[]): T[] {
  return memo.concat(item);
}

function buildIgnore(root: string) {
  const ig = ignore();

  const configFilesExclude = Object.assign(
    [],
    vscode.workspace.getConfiguration('advancedNewFile').get('exclude'),
    vscode.workspace.getConfiguration('files.exclude', vscode.Uri.file(root)),
  );
  const configIgnored = Object.keys(configFilesExclude).filter(
    (key) => configFilesExclude[key] === true,
  );
  ig.add(configIgnored.join('\n'));

  const gitignoreFiles = walkupGitignores(root);
  for (const file of gitignoreFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    ig.add(content);
  }

  return ig;
}

function directoriesSync(root: string): FSLocation[] {
  const ig = buildIgnore(root);

  const results = fs
    .globSync('**/', { cwd: root })
    .filter((rel) => rel !== '.')
    .filter((rel) => !ig.ignores(rel + '/'))
    .map((rel) => ({
      relative: path.join(path.sep, rel),
      absolute: path.join(root, rel),
    }));

  return results;
}

function convenienceOptions(
  roots: WorkspaceRoot[],
  cache: Cache,
): vscode.QuickPickItem[] {
  const config: string[] = vscode.workspace
    .getConfiguration('advancedNewFile')
    .get('convenienceOptions');

  const optionsByName = {
    last: [buildQuickPickItem(lastSelection(cache), '- last selection')],
    current: [
      buildQuickPickItem(currentEditorPathOption(roots), '- current file'),
    ],
    root: rootOptions(roots).map((o) =>
      buildQuickPickItem(o, '- workspace root'),
    ),
  };

  const options = config
    .map<vscode.QuickPickItem[]>((c) => optionsByName[c])
    .reduce(flatten<QuickPickItem>);

  return compact<vscode.QuickPickItem>(options);
}

async function subdirOptionsForRoot(
  root: WorkspaceRoot,
): Promise<DirectoryOption[]> {
  const dirs = await directories(root.rootPath);

  return dirs.map((dir: FSLocation): DirectoryOption => {
    const displayText = root.multi
      ? path.join(path.sep, root.baseName, dir.relative)
      : dir.relative;

    return {
      displayText,
      fsLocation: dir,
    };
  });
}

export function showQuickPick(
  choices: Promise<vscode.QuickPickItem[]>,
): Thenable<QuickPickItem> {
  return vscode.window.showQuickPick<vscode.QuickPickItem>(choices, {
    placeHolder: 'Select a base directory for the new file',
  });
}

export async function showInputBox(
  baseDirectory: DirectoryOption,
): Promise<string> {
  try {
    const input = await vscode.window.showInputBox({
      prompt: `Relative to ${baseDirectory.displayText}`,
      placeHolder: 'Filename or relative path to file',
    });

    return path.join(baseDirectory.fsLocation.absolute, input);
  } catch (e) {
    return;
  }
}

export function directories(root: string): Promise<FSLocation[]> {
  return new Promise((resolve, reject) => {
    const findDirectories = () => {
      try {
        resolve(directoriesSync(root));
      } catch (error) {
        reject(error);
      }
    };

    const delayToAllowVSCodeToRender = 1;
    setTimeout(findDirectories, delayToAllowVSCodeToRender);
  });
}

export function buildQuickPickItem(
  option: DirectoryOption,
  description: string = null,
): vscode.QuickPickItem {
  if (!option) return;

  return {
    label: option.displayText,
    description,
    option,
  };
}

export function currentEditorPath(): string {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) return;

  return path.dirname(activeEditor.document.fileName);
}

export function expandBraces(absolutePath: string): string[] {
  const shouldExpandBraces = vscode.workspace
    .getConfiguration('advancedNewFile')
    .get('expandBraces');

  if (!shouldExpandBraces) {
    return [absolutePath];
  }

  return braces.expand(absolutePath);
}

export function createFileOrFolder(absolutePath: string): void {
  const directoryToFile = path.dirname(absolutePath);

  if (!fs.existsSync(absolutePath)) {
    if (isFolderDescriptor(absolutePath)) {
      mkdirp.sync(absolutePath);
    } else {
      mkdirp.sync(directoryToFile);
      fs.appendFileSync(absolutePath, '');
    }
  }
}

export async function openFile(absolutePath: string): Promise<void> {
  if (isFolderDescriptor(absolutePath)) {
    const showInformationMessages = vscode.workspace
      .getConfiguration('advancedNewFile')
      .get('showInformationMessages', true);

    if (showInformationMessages) {
      vscode.window.showInformationMessage(`Folder created: ${absolutePath}`);
    }
  } else {
    const textDocument = await vscode.workspace.openTextDocument(absolutePath);

    if (textDocument) {
      const shouldExpandBraces = vscode.workspace
        .getConfiguration('advancedNewFile')
        .get('expandBraces');

      if (shouldExpandBraces) {
        vscode.window.showTextDocument(textDocument, { preview: false });
      } else {
        vscode.window.showTextDocument(textDocument, ViewColumn.Active);
      }
    }
  }
}

export function lastSelection(cache: Cache): DirectoryOption {
  if (!cache.has('last')) return;
  const value = cache.get('last');

  if (typeof value === 'object') {
    return value as DirectoryOption;
  } else {
    cache.forget('last');
    return;
  }
}

export function workspaceRoots(): WorkspaceRoot[] {
  if (vscode.workspace.workspaceFolders) {
    const multi = vscode.workspace.workspaceFolders.length > 1;

    return vscode.workspace.workspaceFolders.map((folder) => {
      return {
        rootPath: folder.uri.fsPath,
        baseName: folder.name || path.basename(folder.uri.fsPath),
        multi,
      };
    });
  } else if (vscode.workspace.rootPath) {
    return [
      {
        rootPath: vscode.workspace.rootPath,
        baseName: path.basename(vscode.workspace.rootPath),
        multi: false,
      },
    ];
  } else {
    return [];
  }
}

export function rootOptions(roots: WorkspaceRoot[]): DirectoryOption[] {
  return roots.map((root): DirectoryOption => {
    return {
      displayText: root.multi ? path.join(path.sep, root.baseName) : path.sep,
      fsLocation: {
        relative: path.sep,
        absolute: root.rootPath,
      },
    };
  });
}

export function currentEditorPathOption(
  roots: WorkspaceRoot[],
): DirectoryOption {
  const currentFilePath = currentEditorPath();
  const currentFileRoot =
    currentFilePath &&
    roots.find((r) => currentFilePath.indexOf(r.rootPath) === 0);

  if (!currentFileRoot) return;

  const rootMatcher = new RegExp(`^${currentFileRoot.rootPath}`);
  let relativeCurrentFilePath = currentFilePath.replace(rootMatcher, '');

  relativeCurrentFilePath =
    relativeCurrentFilePath === '' ? path.sep : relativeCurrentFilePath;

  const displayText = currentFileRoot.multi
    ? path.join(path.sep, currentFileRoot.baseName, relativeCurrentFilePath)
    : relativeCurrentFilePath;

  return {
    displayText,
    fsLocation: {
      relative: relativeCurrentFilePath,
      absolute: currentFilePath,
    },
  };
}

export async function dirQuickPickItems(
  roots: WorkspaceRoot[],
  cache: Cache,
): Promise<vscode.QuickPickItem[]> {
  const dirOptions = await Promise.all(
    roots.map(async (r) => await subdirOptionsForRoot(r)),
  );
  const quickPickItems = dirOptions
    .reduce(flatten)
    .map((o) => buildQuickPickItem(o));

  quickPickItems.unshift(...convenienceOptions(roots, cache));

  return quickPickItems;
}

export function cacheSelection(
  cache: Cache,
  dir: DirectoryOption,
  root: WorkspaceRoot,
) {
  cache.put('last', dir);

  const recentRoots = cache.get('recentRoots') || [];

  const rootIndex = recentRoots.indexOf(root.rootPath);
  if (rootIndex >= 0) recentRoots.splice(rootIndex, 1);

  recentRoots.unshift(root.rootPath);
  cache.put('recentRoots', recentRoots);
}

export function sortRoots(
  roots: WorkspaceRoot[],
  desiredOrder: string[],
): WorkspaceRoot[] {
  return sortBy(roots, (root) => {
    const desiredIndex = desiredOrder.indexOf(root.rootPath);
    return desiredIndex >= 0 ? desiredIndex : roots.length;
  });
}

export function rootForDir(
  roots: WorkspaceRoot[],
  dir: DirectoryOption,
): WorkspaceRoot {
  return roots.find((r) => startsWith(dir.fsLocation.absolute, r.rootPath));
}

export async function command(context: vscode.ExtensionContext) {
  const roots = workspaceRoots();

  if (roots.length > 0) {
    const cacheName = roots.map((r) => r.rootPath).join(';');
    const cache = new Cache(context, `workspace:${cacheName}`);

    const sortedRoots = sortRoots(roots, cache.get('recentRoots') || []);

    const dirSelection = await showQuickPick(
      dirQuickPickItems(sortedRoots, cache),
    );
    if (!dirSelection) return;
    const dir = dirSelection.option;

    const selectedRoot = rootForDir(roots, dir);
    cacheSelection(cache, dir, selectedRoot);

    const newFileInput = await showInputBox(dir);
    if (!newFileInput) return;

    const newFileArray = expandBraces(newFileInput);
    for (const newFile of newFileArray) {
      createFileOrFolder(newFile);
      await openFile(newFile);
    }
  } else {
    await vscode.window.showErrorMessage(
      "It doesn't look like you have a folder opened in your workspace. " +
        'Try opening a folder first.',
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'extension.advancedNewFile',
    () => command(context),
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
