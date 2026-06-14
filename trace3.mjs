import { parseBatch } from './src/core/query/sdblParser.ts';
import { buildYamlResolver } from './src/core/metadata/buildYamlResolver.ts';
import fs from 'fs';
const MAIN='/workspaces/query_console_vscode';
const resolver = buildYamlResolver(MAIN+'/tmp/parser_data/cf');
const d=JSON.parse(fs.readFileSync(MAIN+'/tmp/corpus-errors/CommonModules-УчетНДСУНФ-Ext-Module.bsl_10.txt.json','utf8'));
const b = parseBatch(d.исходныйТекстЗапроса, resolver);
// find the createTemp model for СписокСчетовФактур
function walk(node, depth){
  if (node.members){ node.members.forEach(m=>walk(m,depth+1)); return; }
  const m=node.model;
  if(!m) return;
  // is this the СписокСчетовФактур temp?
  const tmp = m.tempName || m.intoTable || m.placeInto;
  // print model summary
  const idx = m.indexing;
  if (idx) {
    console.log('--- model queryType=', m.queryType, 'into=', JSON.stringify(Object.keys(m).filter(k=>/temp|into|place/i.test(k)).map(k=>[k,m[k]])));
    console.log('  fields=', JSON.stringify(m.fields));
    console.log('  trailingFields=', JSON.stringify(m.trailingFields));
    console.log('  indexing=', JSON.stringify(idx));
    console.log('  tables=', JSON.stringify(m.tables.map(t=>({id:t.id,fullName:t.fullName,alias:t.alias}))));
  }
}
walk(b,0);
