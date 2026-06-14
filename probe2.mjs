import { tokenize } from './src/core/query/sdblLexer.ts';
for (const s of ['ИНАЧЕ - X','ТОГДА -X','a - b','НЕ - X','(- X)','&P - X','X.Y - 5','МЕЖДУ -1 И 5']) {
  const t = tokenize(s).filter(x=>x.type!=='eof').map(x=>`${x.type}:${x.value}`);
  console.log(JSON.stringify(s), '=>', t.join(' | '));
}
