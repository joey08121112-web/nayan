// R9：当前/历史库门控与真实 MCP/sync 回收站过滤。仅合成库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { checkSchemaCompat } from '../../schema-gate.mjs';
import { REPO, rustInit, McpClient, toolText, freePort, startSync, makeRecorder } from '../ingestion/helpers.mjs';

const ix=process.argv.indexOf('--out');
const out=ix<0?fs.mkdtempSync(path.join(os.tmpdir(),'nayan-r9-external-out-')):path.resolve(process.argv[ix+1]);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nayan-r9-external-'));
const R=makeRecorder(out,'trash-external');
const edit=(db,sql)=>{const c=new DatabaseSync(db);c.exec(sql);c.close();};
const verdict=db=>{const r=spawnSync('cargo',['test','--offline','migrations::tests::driver_init_db','--','--nocapture'],{cwd:path.join(REPO,'app/src-tauri'),env:{...process.env,NAYAN_MIGRATION_INIT_DB:db},encoding:'utf8',timeout:120000});fs.appendFileSync(path.join(out,'rust-verdict.log'),r.stdout+r.stderr);return r.status===0;};
const gate=db=>{const c=new DatabaseSync(db);const v=c.prepare('PRAGMA user_version').get().user_version;const g=checkSchemaCompat(c,v);c.close();return g;};

for(const [name,sql] of [
  ['missing-column','DROP INDEX idx_suggestions_deleted_at; ALTER TABLE suggestions DROP COLUMN deleted_at;'],
  ['wrong-type',"DROP INDEX idx_suggestions_deleted_at; ALTER TABLE suggestions DROP COLUMN deleted_at; ALTER TABLE suggestions ADD COLUMN deleted_at INTEGER; CREATE INDEX idx_suggestions_deleted_at ON suggestions(deleted_at);"],
  ['missing-index','DROP INDEX idx_suggestions_deleted_at;'],
  ['wrong-index','DROP INDEX idx_suggestions_deleted_at; CREATE INDEX idx_suggestions_deleted_at ON suggestions(title);'],
  ['partial-index','DROP INDEX idx_suggestions_deleted_at; CREATE INDEX idx_suggestions_deleted_at ON suggestions(deleted_at) WHERE deleted_at IS NOT NULL;'],
  ['unique-index','DROP INDEX idx_suggestions_deleted_at; CREATE UNIQUE INDEX idx_suggestions_deleted_at ON suggestions(deleted_at);'],
]) {
  const db=rustInit(path.join(root,name+'.db'));edit(db,sql);
  const before=fs.readFileSync(db);const js=gate(db);const rust=verdict(db);
  R.rec(name+'：Rust / JS 都拒绝且数据库字节不变',!js.ok&&!rust&&before.equals(fs.readFileSync(db)),JSON.stringify(js));
}

for(const version of [2,3,4,5]) {
  const db=rustInit(path.join(root,'v'+version+'.db'));
  // R12：Rust 建库为 v5（多一列 ai_extras）；更早的版本先去掉它
  if(version<5)edit(db,'ALTER TABLE suggestions DROP COLUMN ai_extras; PRAGMA user_version=4;');
  if(version<4)edit(db,'DROP INDEX idx_suggestions_deleted_at; ALTER TABLE suggestions DROP COLUMN deleted_at; PRAGMA user_version='+version+';');
  if(version===2)edit(db,'ALTER TABLE suggestions DROP COLUMN compare_group_id; ALTER TABLE suggestions DROP COLUMN remind_on; ALTER TABLE suggestions DROP COLUMN wait_note; ALTER TABLE suggestions DROP COLUMN list_id; DROP TABLE lists; DROP TABLE compare_groups; DROP TABLE compare_points;');
  R.rec('v'+version+' 合法旧/新库 JS 兼容',gate(db).ok,'schema gate');
  if(version>=4)edit(db,"INSERT INTO suggestions(title,workspace,status,deleted_at) VALUES ('隐藏测试条目','/fake/trash','inbox','2030-01-01T00:00:00Z'),('可见测试条目','/fake/live','inbox',NULL);");
  const cli=new McpClient(db);let sync;
  try {
    await cli.initialize('r9-test');
    const add=toolText(await cli.tool('add_suggestion',{title:'MCP 新条目',quote:'正文',...(version>=3?{list:'后期',wait:'2030-01-01 再看'}:{})}));
    R.rec('v'+version+' MCP 保持写入/清单兼容',!add.startsWith('ERROR')&&add.includes('id='),add);
    const text=toolText(await cli.tool('list_suggestions',{}));
    if(version>=4)R.rec('v'+version+' MCP 默认列表隐藏回收站',text.includes('可见测试条目')&&!text.includes('隐藏测试条目'),text);
    const port=await freePort();sync=await startSync(db,port);
    const rows=await fetch('http://127.0.0.1:'+port+'/api/suggestions').then(r=>r.json());
    R.rec('v'+version+' sync 可读',Array.isArray(rows)&&rows.some(r=>r.title==='MCP 新条目'),JSON.stringify(rows.map(r=>r.title)));
    if(version>=4){
      R.rec('v'+version+' sync 默认列表隐藏回收站',rows.some(r=>r.title==='可见测试条目')&&!rows.some(r=>r.title==='隐藏测试条目'),'GET /api/suggestions');
      const projects=await fetch('http://127.0.0.1:'+port+'/api/projects').then(r=>r.json());
      R.rec('v'+version+' sync 项目计数隐藏回收站',!projects.some(r=>r.name==='/fake/trash'),'GET /api/projects');
      const c=new DatabaseSync(db);R.rec('v'+version+' 外部服务没有迁移或清理回收站',c.prepare('PRAGMA user_version').get().user_version===version&&c.prepare('SELECT COUNT(*) n FROM suggestions WHERE deleted_at IS NOT NULL').get().n===1,'v'+version+' / trash 1');c.close();
    }
  }finally{cli.kill();if(sync)sync.p.kill('SIGTERM');}
}
// R10/C4：服务在 v3 启动并查询过，随后由 Rust 权威迁移到当前版本（R12 起为 v5）；不重启进程。
{
  const db=rustInit(path.join(root,'live-upgrade.db'));
  edit(db,"ALTER TABLE suggestions DROP COLUMN ai_extras; DROP INDEX idx_suggestions_deleted_at; ALTER TABLE suggestions DROP COLUMN deleted_at; PRAGMA user_version=3; INSERT INTO suggestions(title,workspace,status) VALUES ('升级后应隐藏','/fake/upgrade-trash','inbox'),('升级后仍可见','/fake/upgrade-live','inbox');");
  const cli=new McpClient(db);let sync;
  try {
    await cli.initialize('r10-upgrade-test');
    const port=await freePort();sync=await startSync(db,port);
    const base='http://127.0.0.1:'+port;
    const first=toolText(await cli.tool('list_suggestions',{}));
    const initial=await fetch(base+'/api/suggestions').then(r=>r.json());
    R.rec('v3 启动的 MCP / sync 先查询成功',first.includes('升级后应隐藏')&&initial.some(r=>r.title==='升级后应隐藏'),'两个进程均在迁移前完成列表查询');
    const pids=[cli.p.pid,sync.p.pid];
    rustInit(db); // 真实 App 使用的 Rust open_and_migrate 驱动，外部服务不升级库。
    edit(db,"UPDATE suggestions SET deleted_at='2030-01-01T00:00:00Z' WHERE title='升级后应隐藏';");
    for(const status of ['open','inbox']) {
      const text=toolText(await cli.tool('list_suggestions',{status}));
      R.rec('热升级后 MCP '+status+' 隐藏回收站',text.includes('升级后仍可见')&&!text.includes('升级后应隐藏'),text);
    }
    for(const suffix of ['', '?status=inbox']) {
      const rows=await fetch(base+'/api/suggestions'+suffix).then(r=>r.json());
      R.rec('热升级后 sync '+(suffix||'默认')+' 隐藏回收站',Array.isArray(rows)&&rows.some(r=>r.title==='升级后仍可见')&&!rows.some(r=>r.title==='升级后应隐藏'),JSON.stringify(rows));
    }
    const projects=await fetch(base+'/api/projects').then(r=>r.json());
    R.rec('热升级后 sync 项目计数隐藏回收站',projects.some(r=>r.name==='/fake/upgrade-live'&&r.count===1)&&!projects.some(r=>r.name==='/fake/upgrade-trash'),JSON.stringify(projects));
    const c=new DatabaseSync(db);
    R.rec('热升级后服务未重启、未清理回收站',cli.p.pid===pids[0]&&sync.p.pid===pids[1]&&cli.p.exitCode===null&&sync.p.exitCode===null&&c.prepare('PRAGMA user_version').get().user_version===5&&c.prepare('SELECT COUNT(*) n FROM suggestions WHERE deleted_at IS NOT NULL').get().n===1,'原进程 / v5 / trash 1');
    c.close();
  }finally{cli.kill();if(sync)sync.p.kill('SIGTERM');}
}
// R11：MCP 单条 / 批量与 sync 的结构化重试，命中「最近删除」里的行 → 恢复同一行，不新增、不覆盖。
{
  const db=rustInit(path.join(root,'retry-trash.db'));
  const env=(rid,text)=>({request_id:rid,format:'plain',original:{kind:'text',text}});
  const cli=new McpClient(db);let sync;
  try {
    await cli.initialize('r11-retry-test');
    const port=await freePort();sync=await startSync(db,port);
    const base='http://127.0.0.1:'+port;
    toolText(await cli.tool('add_suggestion',{title:'单条原标题',content:env('r11-mcp-one','单条原文')}));
    toolText(await cli.tool('add_suggestions',{items:[{title:'批量原标题',content:env('r11-mcp-batch','批量原文')}]}));
    await fetch(base+'/api/suggestions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'扩展原标题',content:env('r11-sync','扩展原文')})}).then(r=>r.json());
    edit(db,"UPDATE suggestions SET deleted_at='2030-01-01T00:00:00Z';");
    const one=toolText(await cli.tool('add_suggestion',{title:'不应覆盖',content:env('r11-mcp-one','不应覆盖')}));
    const batch=toolText(await cli.tool('add_suggestions',{items:[{title:'不应覆盖',content:env('r11-mcp-batch','不应覆盖')}]}));
    const row=await fetch(base+'/api/suggestions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'不应覆盖',content:env('r11-sync','不应覆盖')})}).then(r=>r.json());
    R.rec('MCP 单条重试恢复最近删除',one.includes('duplicate=true')&&one.includes('已从最近删除恢复'),one);
    R.rec('MCP 批量重试恢复最近删除',batch.includes('duplicate=true')&&batch.includes('已从最近删除恢复'),batch);
    R.rec('sync 重试恢复最近删除并返回同一行',row.duplicate===true&&row.deleted_at===null&&row.title==='扩展原标题',JSON.stringify(row));
    const c=new DatabaseSync(db);
    const rows=c.prepare('SELECT title,deleted_at FROM suggestions ORDER BY id').all();
    R.rec('三条都恢复、没有新增、原标题未覆盖',rows.length===3&&rows.every(r=>r.deleted_at===null)&&rows.map(r=>r.title).join('|')==='单条原标题|批量原标题|扩展原标题',JSON.stringify(rows));
    c.close();
    const again=toolText(await cli.tool('add_suggestion',{title:'不应覆盖',content:env('r11-mcp-one','不应覆盖')}));
    R.rec('未删除时重试仍只是幂等返回',again.includes('duplicate=true')&&!again.includes('恢复'),again);
  }finally{cli.kill();if(sync)sync.p.kill('SIGTERM');}
}
process.exitCode=R.finish()?1:0;
console.log('合成库保留于 '+root);
