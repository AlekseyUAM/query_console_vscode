import Parser from 'web-tree-sitter';
import * as path from 'path';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

let _parser: Parser | null = null;

async function getParser(): Promise<Parser> {
  if (_parser) return _parser;
  await Parser.init({
    locateFile: (file: string) => path.join(FIXTURES, file),
  });
  const Lang = await Parser.Language.load(
    path.join(FIXTURES, 'tree-sitter-sdbl.wasm')
  );
  _parser = new Parser();
  _parser.setLanguage(Lang);
  return _parser;
}

export async function assertValidSdbl(text: string): Promise<void> {
  const parser = await getParser();
  const tree = parser.parse(text);
  if (tree.rootNode.hasError()) {
    throw new Error(
      `SDBL parse error in:\n${text}\n\nAST:\n${tree.rootNode.toString()}`
    );
  }
}
