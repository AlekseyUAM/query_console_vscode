import * as vscode from 'vscode';
import { formatAsBslString } from '../core/query/sdblGenerator';

export interface SavedEditorState {
  document: vscode.TextDocument;
  selection: vscode.Selection;
  /** Символьные смещения `[start, end)` литерала запроса для замены при сохранении. */
  queryRange?: { start: number; end: number };
  /** Обернуть результат в строковый литерал 1С (`"…|…"`) перед заменой. */
  wrapAsBslString?: boolean;
}

export async function insertResult(text: string, saved?: SavedEditorState): Promise<void> {
  const targetEditor = saved
    ? vscode.window.visibleTextEditors.find(e => e.document === saved.document)
    : vscode.window.activeTextEditor;

  if (targetEditor) {
    const payload = saved?.wrapAsBslString ? formatAsBslString(text) : text;
    const range: vscode.Range = saved?.queryRange
      ? new vscode.Range(
          targetEditor.document.positionAt(saved.queryRange.start),
          targetEditor.document.positionAt(saved.queryRange.end)
        )
      : saved
        ? saved.selection
        : targetEditor.selection;
    await targetEditor.edit(b => b.replace(range, payload));
    await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
  } else {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Текст запроса скопирован в буфер обмена');
  }
}
