import * as vscode from 'vscode';

export interface SavedEditorState {
  document: vscode.TextDocument;
  selection: vscode.Selection;
}

export async function insertResult(text: string, saved?: SavedEditorState): Promise<void> {
  const targetEditor = saved
    ? vscode.window.visibleTextEditors.find(e => e.document === saved.document)
    : vscode.window.activeTextEditor;

  if (targetEditor) {
    const position = saved ? saved.selection : targetEditor.selection;
    await targetEditor.edit(b => b.replace(position, text));
    await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
  } else {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Текст запроса скопирован в буфер обмена');
  }
}
