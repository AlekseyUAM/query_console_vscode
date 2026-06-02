import * as vscode from 'vscode';
import * as path from 'path';
import { resolveCfPath } from './resolveCfPath';
import { parseConfiguration } from '../core/metadata/parser/parseConfiguration';

export function registerParseCommand(channel: vscode.OutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('1c.parseMetadata', () => {
    const cfPath = resolveCfPath();
    if (!cfPath) {
      vscode.window.showWarningMessage(
        'Не найдена выгрузка конфигурации (cf). Укажите путь в настройке queryConsole.metadataPath'
      );
      return;
    }
    const config = vscode.workspace.getConfiguration('queryConsole');
    const outSetting = config.get<string>('parserOutputPath') || 'tmp/parser_data';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const outPath = path.isAbsolute(outSetting) ? outSetting : path.join(root, outSetting);

    channel.appendLine(`[1C Query] Парсинг метаданных: ${cfPath} → ${outPath}`);
    channel.show(true);
    try {
      const s = parseConfiguration(cfPath, outPath);
      const c = s.counts;
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      channel.appendLine(
        `[1C Query] Справочники: ${c['Справочник'] || 0} Документы: ${c['Документ'] || 0} ` +
          `Константы: ${c['Константа'] || 0} Перечисления: ${c['Перечисление'] || 0}; пропущено: ${s.skipped}`
      );
      vscode.window.showInformationMessage(`Распарсено объектов: ${total}. → ${s.outCfDir}`);
    } catch (e) {
      channel.appendLine(`[1C Query] Ошибка парсинга: ${e}`);
      vscode.window.showErrorMessage(`Ошибка парсинга метаданных: ${e}`);
    }
  });
}
