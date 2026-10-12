# app/ui/vendor — 本地打包的渲染依赖（P1-T06/S01）

本目录是 **唯一** 的 rich 渲染依赖来源：全部为 npm 官方 registry tarball 内的发行文件，
版本锁定、随 `frontendDist(../ui)` 一并打进 App 包、运行期零网络、零远程脚本。
App 构建不依赖 npm install 拉取本目录（文件已入库）；更新依赖须整目录替换并更新本清单。

| 文件 | 包 | 版本（锁定） | 许可 | 来源（registry tarball 提取） |
|---|---|---|---|---|
| `markdown-it.umd.min.js` | markdown-it | **15.0.2** | MIT（见 `markdown-it.LICENSE`） | `https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.2.tgz` → `package/dist/browser/markdown-it.umd.min.js` |
| `purify.min.js` | dompurify | **3.4.16** | MPL-2.0 OR Apache-2.0 双许可（两份全文均在） | `https://registry.npmjs.org/dompurify/-/dompurify-3.4.16.tgz` → `package/dist/purify.min.js` |

## 选择取舍（2026-09-25 评定）

- **parser = markdown-it（而非 marked/commonmark/micromark）**：CommonMark 语义完整覆盖
  Matrix B 所需（ATX 标题、嵌套/有序列表含非 1 起始、围栏代码、引用、分隔线）；
  `html:false` 一开关即满足 S02（内嵌 HTML 转义为字面文本，绝不透传）；token 流带
  `map`（源行区间）与 fence `content`（原文精确内文），支撑 S04 源范围；UMD 单文件
  全自包含（零运行时依赖）；社区持续维护（15.x 现行线）。
- **sanitizer = DOMPurify（而非 sanitize-html/hast-util-sanitize）**：cure53 维护的事实标准；
  在真实 DOM（WKWebView）上做清洗而非字符串拼接；正向白名单（ALLOWED_TAGS/ATTR）+
  `ALLOWED_URI_REGEXP` 窄 scheme 校验与本批 S03 逐条对应；UMD 单文件零依赖；
  无 DOM 环境下 `isSupported=false` 显式不可用（天然回退开关，不假装成功）。
- 双层防线：markdown 路径 `html:false` 生成的 HTML 仍过一遍 DOMPurify 同白名单
  （纵深防御，不依赖单层正确性）。

## 完整性（供应链核验）

tarball 下载后先与 registry `dist.integrity`(sha512) 比对通过，再从中提取下述文件；
入库文件的 sha256 见批次证据 `batches/P1-B06/evidence/vendor-sha256.txt`。

```
markdown-it-15.0.2.tgz  sha512-q4IGxMv56jCqT4OCRCADBoDP3LO4MhmTXjFbphHPXs4g3j9Xg5RDnxqN8IF/3vIWEU+VCnUq+7JUg/cfy2E6Qw==  (verified)
dompurify-3.4.16.tgz    sha512-sqo+pNp3qRhCIpbgRi1y8Tgk27Bo2Ry7w0dC1NBeNTdZChWjz9Xb/KOoZbRP/R6pQZ80Qw8YhXw13hWWBbMRnQ==  (verified)
```

## 运行约定

两文件以经典 `<script src>` 先于 `rich-text.js` 加载，暴露全局 `markdownit` / `DOMPurify`。
加载失败/被 CSP 拦截/无 DOM 支持时，reader 一律回退 plain 投影显示源文本并给出原因
（绝不降级为字符串拼 HTML，绝不假装渲染成功）。
