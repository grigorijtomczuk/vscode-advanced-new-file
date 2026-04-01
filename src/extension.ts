import * as fs from 'node:fs';
import * as path from 'node:path';

import * as braces from 'braces';
import * as ignore from 'ignore';
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

type PathValidation =
  | { valid: true; normalized: string }
  | { valid: false; reason: 'empty' | 'invalid' };

declare module 'vscode' {
  interface QuickPickItem {
    option?: DirectoryOption;
    invalid?: boolean;
    directFileAbsolutePath?: string;
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
    return found.reverse();
  }
}

function flatten<T>(memo: T[], item: T[]): T[] {
  return memo.concat(item);
}

function isDirectFileInput(input: string): boolean {
  const normalized = path.normalize(input);
  const baseName = path.basename(normalized);
  if (!normalized || normalized.endsWith(path.sep)) return false;
  return baseName.includes('.') && baseName !== '.';
}

function validatePathInput(input: string): PathValidation {
  if (!input.trim()) return { valid: false, reason: 'empty' };
  const normalized = path.normalize(input);
  const isInvalid =
    normalized.split(path.sep).some((part) => ['.', '..'].includes(part)) ||
    normalized === path.sep;
  if (isInvalid) return { valid: false, reason: 'invalid' };
  return { valid: true, normalized };
}

function buildInvalidItem(
  reason: 'empty' | 'invalid',
  baseDisplay?: string,
): vscode.QuickPickItem {
  if (reason === 'empty')
    return {
      label: baseDisplay,
      detail: `Enter a filename or path to file relative to ${baseDisplay}`,
      alwaysShow: true,
      invalid: true,
    };
  return {
    label: 'Invalid path',
    detail: 'Enter a valid path within the workspace',
    iconPath: new vscode.ThemeIcon('error'),
    alwaysShow: true,
    invalid: true,
  };
}

function buildSyntheticItemOption(
  input: string,
  roots: WorkspaceRoot[],
): DirectoryOption {
  const normalized = path.normalize(input);
  const options = rootOptions(roots);
  const fallbackRoot = roots[0];
  const fallbackRootOption = options[0];

  if (fallbackRoot.multi) {
    const parts = normalized.split(path.sep);
    const remainder = parts.slice(1);
    const matchedRootOption =
      options.find((r) => r.displayText === parts[0]) || fallbackRootOption;
    return {
      displayText: path.join(matchedRootOption.displayText, normalized),
      fsLocation: {
        absolute: path.join(matchedRootOption.fsLocation.absolute, normalized),
        relative: path.join(...remainder),
      },
    };
  }

  return {
    displayText: path.join(fallbackRootOption.displayText, normalized),
    fsLocation: {
      absolute: path.join(fallbackRootOption.fsLocation.absolute, normalized),
      relative: normalized,
    },
  };
}

function buildSyntheticItem(
  input: string,
  roots: WorkspaceRoot[],
): vscode.QuickPickItem {
  const result = validatePathInput(input);
  if (result.valid === false) return buildInvalidItem(result.reason);

  const { normalized } = result;
  const directFile = isDirectFileInput(normalized);
  const option = buildSyntheticItemOption(normalized, roots);
  const icon = new vscode.ThemeIcon(directFile ? 'new-file' : 'new-folder');
  const detail = directFile
    ? 'Press Enter to create a new file (append "/" to create a directory instead)'
    : 'Press Enter to create a new directory (append "." to create a file instead)';

  const item = buildQuickPickItem(option, icon);
  item.detail = detail;
  item.alwaysShow = true;

  if (directFile) item.directFileAbsolutePath = option.fsLocation.absolute;

  return item;
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

  const normalFolders = fs.globSync('**/', { cwd: root });
  const dotFolders = fs.globSync('**/.*/', { cwd: root });

  const results = [...normalFolders, ...dotFolders]
    .filter((rel) => rel !== '.')
    .filter((rel) => !ig.ignores(rel + '/'))
    .map((rel) => ({
      absolute: path.join(root, rel),
      relative: rel,
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
    last: [
      buildQuickPickItem(
        lastSelection(cache),
        new vscode.ThemeIcon('folder-library'),
        '— last selection',
      ),
    ],
    current: [
      buildQuickPickItem(
        currentEditorPathOption(roots),
        new vscode.ThemeIcon('folder-active'),
        '— current file',
      ),
    ],
    root: rootOptions(roots).map((o) =>
      buildQuickPickItem(
        o,
        new vscode.ThemeIcon('root-folder'),
        '— workspace root',
      ),
    ),
  };

  const options = config
    .map<vscode.QuickPickItem[]>((c) => optionsByName[c])
    .reduce(flatten<QuickPickItem>)
    .filter(Boolean);

  return options;
}

async function subdirOptionsForRoot(
  root: WorkspaceRoot,
): Promise<DirectoryOption[]> {
  const dirs = await directories(root.rootPath);

  return dirs.map((dir: FSLocation): DirectoryOption => {
    const displayText = root.multi
      ? path.join(root.baseName, dir.relative)
      : path.join(path.sep, dir.relative);

    return {
      displayText,
      fsLocation: dir,
    };
  });
}

export function showBasePathQuickPick(
  choices: Promise<vscode.QuickPickItem[]>,
  roots: WorkspaceRoot[],
): Thenable<vscode.QuickPickItem | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();

  const initItem: vscode.QuickPickItem = {
    label: '$(loading~spin) Scanning workspace directories...',
    alwaysShow: true,
    invalid: true,
  };

  qp.enabled = false;
  qp.placeholder = 'Select a base directory for the new file';
  qp.items = [initItem];

  qp.show();

  return new Promise((resolve) => {
    let allItems: vscode.QuickPickItem[] = [];

    choices.then((items) => {
      allItems = items;
      qp.items = items;
      qp.enabled = true;
    });

    qp.onDidChangeValue((value) => {
      const filteredItems = allItems.filter((item) =>
        item.label.toLowerCase().includes(value.toLowerCase()),
      );
      qp.items = filteredItems.length
        ? filteredItems
        : [buildSyntheticItem(value, roots)];
    });

    qp.onDidAccept(() => {
      const selection = qp.selectedItems[0];
      if (selection.invalid) return;
      qp.hide();
      resolve(selection);
    });

    qp.onDidHide(() => {
      qp.dispose();
      resolve(undefined);
    });
  });
}

export async function showNewItemQuickPick(
  baseDirectory: DirectoryOption,
): Promise<string> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  const baseAbsolute = baseDirectory.fsLocation.absolute;
  const baseRelative = baseDirectory.fsLocation.relative;
  const baseDisplay = baseDirectory.displayText;

  const buildItem = (value: string): vscode.QuickPickItem => {
    const result = validatePathInput(value);
    if (result.valid === false)
      return buildInvalidItem(result.reason, baseDisplay);

    const { normalized } = result;
    const isDirectoryInput = normalized.endsWith(path.sep);

    const icon = new vscode.ThemeIcon(
      isDirectoryInput ? 'new-folder' : 'new-file',
    );
    const option = {
      displayText: path.join(baseDisplay, normalized),
      fsLocation: {
        absolute: path.join(baseAbsolute, normalized),
        relative: path.join(baseRelative, normalized),
      },
    };

    const item = buildQuickPickItem(option, icon);
    item.detail = isDirectoryInput
      ? 'Press Enter to create a new directory'
      : 'Press Enter to create a new file (append "/" to create a directory instead)';
    item.alwaysShow = true;

    return item;
  };

  const updateItem = (value: string) => {
    qp.items = [buildItem(value)];
  };

  updateItem('');
  qp.placeholder = 'Filename or path to file';
  qp.show();

  return new Promise((resolve) => {
    qp.onDidChangeValue(updateItem);

    qp.onDidAccept(() => {
      const selection = qp.selectedItems[0];
      if (selection.invalid) return;
      qp.hide();
      resolve(selection.option.fsLocation.absolute);
    });

    qp.onDidHide(() => {
      qp.dispose();
      resolve(undefined);
    });
  });
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
  icon?: vscode.ThemeIcon,
  description?: string,
): vscode.QuickPickItem {
  if (!option) return;
  return {
    label: option.displayText,
    iconPath: icon || new vscode.ThemeIcon('folder'),
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
      displayText: root.multi ? root.baseName : path.sep,
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
  return [...roots].sort((a, b) => {
    const aIndex = desiredOrder.indexOf(a.rootPath);
    const bIndex = desiredOrder.indexOf(b.rootPath);

    const aSort = aIndex >= 0 ? aIndex : roots.length;
    const bSort = bIndex >= 0 ? bIndex : roots.length;

    return aSort - bSort;
  });
}

export function rootForDir(
  roots: WorkspaceRoot[],
  dir: DirectoryOption,
): WorkspaceRoot {
  return roots.find((r) => dir.fsLocation.absolute.startsWith(r.rootPath));
}

export async function command(context: vscode.ExtensionContext) {
  const roots = workspaceRoots();

  if (roots.length > 0) {
    const cacheName = roots.map((r) => r.rootPath).join(';');
    const cache = new Cache(context, `workspace:${cacheName}`);

    const sortedRoots = sortRoots(roots, cache.get('recentRoots') || []);

    const dirSelection = await showBasePathQuickPick(
      dirQuickPickItems(sortedRoots, cache),
      sortedRoots,
    );

    if (!dirSelection) return;
    const dir = dirSelection.option;

    const selectedRoot = rootForDir(roots, dir);
    if (selectedRoot && !dirSelection.directFileAbsolutePath) {
      cacheSelection(cache, dir, selectedRoot);
    }

    const newFileInput =
      dirSelection.directFileAbsolutePath || (await showNewItemQuickPick(dir));
    if (!newFileInput) return;

    const newFileArray = expandBraces(newFileInput);
    for (const newFile of newFileArray) {
      createFileOrFolder(newFile);
      await openFile(newFile);
    }
  } else {
    await vscode.window.showErrorMessage(
      "It doesn't look like you have a directory opened in your workspace. Try opening a directory first.",
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
