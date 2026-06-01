import * as vscode from 'vscode';

export async function insertResult(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await editor.edit(b => b.replace(editor.selection, text));
  } else {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Текст запроса скопирован в буфер обмена');
  }
}
