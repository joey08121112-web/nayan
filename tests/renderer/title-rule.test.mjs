// 收录取标题规则（app/ui/title-rule.js）：与 main.rs short_title 同一组用例；扩展副本须与 App 版逻辑一致。
// 用法：node tests/renderer/title-rule.test.mjs   每条 PASS/FAIL 逐行打印，有 FAIL 时 exit 1。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { shortTitle } = require(path.join(REPO, 'app/ui/title-rule.js'));
let fail = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) fail++; };
const cases = [
  ['修复完成，全部回归通过。以下场景仍需人工再验收一次。', '修复完成，全部回归通过'],
  ['结构可以还原：  角色信息都在接口里。每块文字', '结构可以还原： 角色信息都在接口里'],
  ['仓库根目录有标准部署脚本：负责完成构建、替换安装目录里的应用，最后自动启动新版本', '仓库根目录有标准部署脚本：负责完成构建、替换安装目录里的应…'],
  ['当前可用的通道• ⌥S 小窗 → 收进后期', '当前可用的通道'],
  ['这三处界面修改加一个根因收尾，全部完成并且已经合入主分支（提交号 9f8e7d6）。', '这三处界面修改加一个根因收尾，全部完成并且已经合入主分支…'],
  ['1. 列表太窄，标题被挤成两行', '列表太窄，标题被挤成两行'],
  ['## Fix the login page so that users can reset passwords easily without email', 'Fix the login page so that users can reset passwords…'],
  ['\n\n# 英语老师\n正文', '英语老师'],
  ['这个界面的排版该怎么夸才自然呢？后面', '这个界面的排版该怎么夸才自然呢？'],
  ['e.g. this', 'e.g. this'],
  ['匕。', '匕。'],
];
for (const [input, want] of cases) { const got = shortTitle(input, '剪贴板内容'); check('T ' + JSON.stringify(input.slice(0, 16)), got === want, { got, want }); }
check('T 空白 → 兜底', shortTitle('   \n  ', '剪贴板内容') === '剪贴板内容');
const strip = (s) => s.replace(/^\/\*[\s\S]*?\*\//, '');
check('扩展副本逻辑与 App 版一致', strip(fs.readFileSync(path.join(REPO, 'extension/title-rule.js'), 'utf8')) === strip(fs.readFileSync(path.join(REPO, 'app/ui/title-rule.js'), 'utf8')));
process.exit(fail ? 1 : 0);
