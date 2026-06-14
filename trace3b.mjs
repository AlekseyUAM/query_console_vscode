import { parseBatch } from './src/core/query/sdblParser.ts';
import { buildYamlResolver } from './src/core/metadata/buildYamlResolver.ts';
import fs from 'fs';
const MAIN='/workspaces/query_console_vscode';
const resolver = buildYamlResolver(MAIN+'/tmp/parser_data/cf');
const d=JSON.parse(fs.readFileSync(MAIN+'/tmp/corpus-errors/CommonModules-УчетНДСУНФ-Ext-Module.bsl_10.txt.json','utf8'));
const b = parseBatch(d.исходныйТекстЗапроса, resolver);
function walk(node){ if(node.members){node.members.forEach(walk);return;} const m=node.model; if(m&&m.indexing){ console.log('idx fields=',JSON.stringify(m.indexing.indexes.map(i=>i.fields))); console.log('member0 alias resolution check: fields of THIS member=', JSON.stringify(m.fields.map(f=>({p:f.path,a:f.alias,t:f.tableId})))); } }
walk(b);
