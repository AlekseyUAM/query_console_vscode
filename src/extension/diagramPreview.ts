import * as vscode from 'vscode';

const MERMAID_EXT_ID = 'bierner.markdown-mermaid';

/** Пишет markdown с mermaid-блоком во временный файл и открывает встроенное превью.
 *  Если расширение для рендера mermaid не установлено — предлагает установку. */
export async function openDiagram(
  context: vscode.ExtensionContext,
  kind: string,
  title: string,
  mermaid: string,
): Promise<void> {
  const md = `# ${title}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`;

  const dir = context.globalStorageUri;
  await vscode.workspace.fs.createDirectory(dir);
  const fileUri = vscode.Uri.joinPath(dir, `diagram-${kind}.md`);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(md, 'utf8'));

  if (!vscode.extensions.getExtension(MERMAID_EXT_ID)) {
    void vscode.window
      .showInformationMessage(
        'Для красивого отображения диаграммы установите расширение Markdown Preview Mermaid Support.',
        'Установить',
      )
      .then(choice => {
        if (choice === 'Установить') {
          void vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            MERMAID_EXT_ID,
          );
        }
      });
  }

  await vscode.commands.executeCommand('markdown.showPreview', fileUri);
}
