import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createPanel } from './panel';
import { resolveCfPath } from './resolveCfPath';
import { registerParseCommand } from './parseCommand';
import { planQueryConstructor } from './queryConstructorPlan';

let outputChannel: vscode.OutputChannel;

/** Резолвит путь к выгрузке конфигурации и логирует диагностику в канал вывода. */
function resolveCfPathWithLogging(): string {
  const config = vscode.workspace.getConfiguration('queryConsole');
  const setting = config.get<string>('metadataPath') ?? '';
  outputChannel.appendLine(`[1C Query] metadataPath setting: "${setting}"`);
  outputChannel.appendLine(`[1C Query] setting exists on disk: ${setting ? fs.existsSync(setting) : 'n/a'}`);
  const cfPath = resolveCfPath();
  outputChannel.appendLine(`[1C Query] resolved cfPath: "${cfPath}"`);
  outputChannel.show(true);
  return cfPath;
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('1C Query Constructor');

  const cmd = vscode.commands.registerCommand('1c.queryConstructor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Откройте .bsl файл');
      return;
    }
    const doc = editor.document;
    const offset = doc.offsetAt(editor.selection.active);
    const source = doc.getText();
    const plan = planQueryConstructor(source, offset);

    const cfPath = resolveCfPathWithLogging();

    if (plan.kind === 'open') {
      createPanel(
        context,
        cfPath,
        outputChannel,
        {
          document: doc,
          selection: editor.selection,
          queryRange: plan.queryRange,
          wrapAsBslString: true,
        },
        plan.queryText
      );
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      'Не найден текст запроса. Создать новый запрос?',
      { modal: true },
      'Да',
      'Нет'
    );
    if (answer !== 'Да') return;
    createPanel(context, cfPath, outputChannel, {
      document: doc,
      selection: editor.selection,
      queryRange: { start: offset, end: offset },
      wrapAsBslString: true,
    });
  });

  context.subscriptions.push(cmd, registerParseCommand(outputChannel), outputChannel);
}

export function deactivate(): void {}
