//! HTML 收录（网页、Electron 应用里划词带回的富文本）转纯文本：给搜索、摘要、规则拆步、同题对比和 AI 整理用。
//! 只是读取时派生，信封里的原文一个字不动。不追求还原排版：块级元素断行、列表项加「- 」、
//! 表格同一行的单元格用「 | 」隔开、<pre> 里保留空白；<script>/<style>/<svg>/<button> 整块丢掉
//! （按钮里多是「复制代码」这类界面字，不是正文）。

const SKIP: [&str; 6] = ["script", "style", "svg", "button", "noscript", "template"];

pub fn to_plain(html: &str) -> String {
    let b = html.as_bytes();
    let lower = html.to_ascii_lowercase(); // 只改 ASCII，字节位置与原文一致
    let mut out = String::new();
    let mut i = 0;
    let mut pre = 0usize; // <pre> 嵌套深度
    let mut cells = 0usize; // 当前表格行已出现的单元格数
    let mut in_cell = false; // 单元格里的 <p>/<div> 不断行，否则一行表格会被拆散
    while i < b.len() {
        if b[i] == b'<' && is_tag_start(b, i) {
            if html[i..].starts_with("<!--") {
                i = html[i..].find("-->").map(|p| i + p + 3).unwrap_or(b.len());
                continue;
            }
            let end = match tag_end(b, i) {
                Some(e) => e,
                None => break, // 没闭合的半截标签：后面不当正文
            };
            let (name, closing) = tag_name(&html[i + 1..end]);
            i = end + 1;
            if name.is_empty() {
                continue; // <!doctype …> 之类
            }
            if !closing && SKIP.contains(&name.as_str()) {
                i = skip_block(&lower, i, &name);
                continue;
            }
            match name.as_str() {
                "br" => out.push('\n'),
                "pre" => {
                    if closing {
                        pre = pre.saturating_sub(1);
                    } else {
                        pre += 1;
                    }
                    block(&mut out, 2);
                }
                "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "ul" | "ol" | "hr" | "li" | "div"
                | "section" | "article" | "header" | "footer" | "figure" | "dt" | "dd" | "summary" | "details"
                    if in_cell =>
                {
                    if !out.is_empty() && !out.ends_with(|c: char| c.is_whitespace() || c == '|') {
                        out.push(' ');
                    }
                }
                "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "table" | "ul" | "ol" | "hr"
                | "section" | "article" | "header" | "footer" | "figure" => block(&mut out, 2),
                "div" | "dt" | "dd" | "summary" | "details" => block(&mut out, 1),
                "tr" => {
                    in_cell = false;
                    block(&mut out, 1);
                    cells = 0;
                }
                "li" => {
                    block(&mut out, 1);
                    if !closing {
                        out.push_str("- ");
                    }
                }
                "td" | "th" => {
                    in_cell = !closing;
                    if !closing {
                        if cells > 0 {
                            trim_spaces(&mut out);
                            out.push_str(" | ");
                        }
                        cells += 1;
                    }
                }
                _ => {}
            }
            continue;
        }
        let from = i + html[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1); // 跳过当前字符（可能是多字节汉字）
        let next = html[from..].find('<').map(|p| from + p).unwrap_or(b.len());
        push_text(&mut out, &html[i..next], pre > 0);
        i = next;
    }
    tidy(&out)
}

/// `<` 后面紧跟字母、`/` 或 `!` 才算标签；「a < b」这种按正文处理
fn is_tag_start(b: &[u8], i: usize) -> bool {
    b.get(i + 1).map(|c| c.is_ascii_alphabetic() || *c == b'/' || *c == b'!').unwrap_or(false)
}

/// 标签结束的 `>`（属性值引号里的 `>` 不算）
fn tag_end(b: &[u8], start: usize) -> Option<usize> {
    let mut q: Option<u8> = None;
    for (k, &c) in b.iter().enumerate().skip(start + 1) {
        match q {
            Some(qc) if c == qc => q = None,
            Some(_) => {}
            None if c == b'"' || c == b'\'' => q = Some(c),
            None if c == b'>' => return Some(k),
            None => {}
        }
    }
    None
}

fn tag_name(inner: &str) -> (String, bool) {
    let (closing, rest) = match inner.strip_prefix('/') {
        Some(r) => (true, r),
        None => (false, inner),
    };
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    (name.to_ascii_lowercase(), closing)
}

/// 跳过整块（含同名嵌套），返回结束标签之后的位置
fn skip_block(lower: &str, from: usize, name: &str) -> usize {
    let open = format!("<{}", name);
    let close = format!("</{}", name);
    let mut depth = 1usize;
    let mut pos = from;
    while depth > 0 {
        let o = lower[pos..].find(&open).map(|p| pos + p);
        let c = match lower[pos..].find(&close) {
            Some(p) => pos + p,
            None => return lower.len(),
        };
        match o {
            Some(o) if o < c && !lower.as_bytes().get(o + open.len()).map(|x| x.is_ascii_alphanumeric()).unwrap_or(false) => {
                depth += 1;
                pos = o + open.len();
            }
            Some(o) if o < c => pos = o + open.len(),
            _ => {
                depth -= 1;
                pos = lower[c..].find('>').map(|p| c + p + 1).unwrap_or(lower.len());
            }
        }
    }
    pos
}

fn push_text(out: &mut String, raw: &str, keep_space: bool) {
    let t = decode_entities(raw);
    if keep_space {
        out.push_str(&t);
        return;
    }
    let mut s = String::with_capacity(t.len());
    let mut sp = false;
    for c in t.chars() {
        if c.is_whitespace() {
            sp = true;
        } else {
            if sp && !s.is_empty() {
                s.push(' ');
            }
            sp = false;
            s.push(c);
        }
    }
    if s.is_empty() {
        // 纯空白：只在两段文字之间留一个空格
        if sp && !out.is_empty() && !out.ends_with(|c: char| c.is_whitespace()) {
            out.push(' ');
        }
        return;
    }
    let lead = t.starts_with(|c: char| c.is_whitespace());
    if lead && !out.is_empty() && !out.ends_with(|c: char| c.is_whitespace()) {
        out.push(' ');
    }
    out.push_str(&s);
    if t.ends_with(|c: char| c.is_whitespace()) {
        out.push(' ');
    }
}

fn trim_spaces(out: &mut String) {
    while out.ends_with(' ') || out.ends_with('\t') {
        out.pop();
    }
}

/// 保证结尾至少有 n 个换行（开头不加）
fn block(out: &mut String, n: usize) {
    trim_spaces(out);
    if out.is_empty() {
        return;
    }
    let have = out.chars().rev().take_while(|&c| c == '\n').count();
    for _ in have..n {
        out.push('\n');
    }
}

fn tidy(s: &str) -> String {
    let mut lines: Vec<&str> = vec![];
    let mut blank = 0;
    for l in s.lines() {
        let l = l.trim_end();
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
            lines.push("");
        } else {
            blank = 0;
            lines.push(l);
        }
    }
    lines.join("\n").trim_matches('\n').to_string()
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        let tail = &rest[p..];
        let semi = tail[..tail.len().min(12)].find(';');
        let decoded = semi.and_then(|e| {
            let ent = &tail[1..e];
            let c = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            c.map(|c| (c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &tail[e + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::to_plain;

    #[test]
    fn inline_spans_and_code_block() {
        let h = "<meta charset='utf-8'><p><span>Rust </span><span>中常见的容器之一是 </span><code><span>VecDeque</span></code><span>。</span></p>\
                 <div><div><pre dir=\"ltr\"><code>pub fn sum_pair(a: i32, b: i32) -> i32 {\n    return a + b;\n}</code></pre></div></div>";
        assert_eq!(to_plain(h), "Rust 中常见的容器之一是 VecDeque。\n\npub fn sum_pair(a: i32, b: i32) -> i32 {\n    return a + b;\n}");
    }

    #[test]
    fn table_rows_become_lines() {
        let h = "<table><thead><tr><th scope=\"col\">#</th><th>问题</th><th>位置</th></tr></thead>\
                 <tbody><tr><td>1</td><td>标题太长</td><td>阅读页</td></tr>\n<tr>\n <td>2</td> <td>a &amp; b</td><td>&lt;侧栏&gt;</td></tr></tbody></table>";
        assert_eq!(to_plain(h), "# | 问题 | 位置\n1 | 标题太长 | 阅读页\n2 | a & b | <侧栏>");
    }

    #[test]
    fn lists_headings_and_chrome_dropped() {
        let h = "<h2>第一步</h2><style>.x{color:red}</style><ul><li>拉最新 main</li><li>构建 <b>App</b></li></ul>\
                 <div>python<button><svg><path d=\"M0\"/></svg>复制代码</button></div><script>alert(1)</script><!-- 注释 -->结尾&#20320;&#x597D;";
        assert_eq!(to_plain(h), "第一步\n\n- 拉最新 main\n- 构建 App\n\npython\n结尾你好");
    }

    #[test]
    fn paragraphs_inside_cells_stay_on_one_row() {
        let h = "<table><tbody><tr><th><p><span>阶段</span></p></th><th><p>时间</p></th></tr>\
                 <tr><td><p>1. Java 基础</p></td><td><p>第 1–4 周</p><p>每天两小时</p></td></tr></tbody></table><p>后记</p>";
        assert_eq!(to_plain(h), "阶段 | 时间\n1. Java 基础 | 第 1–4 周 每天两小时\n\n后记");
    }

    #[test]
    fn plain_text_and_stray_angle_kept() {
        assert_eq!(to_plain("a < b 且 c&d"), "a < b 且 c&d");
        assert_eq!(to_plain(""), "");
    }
}
