/**
 * 发布前闸门（REPO-05）—— scripts/pre-publish-check.js
 *
 * 用法：
 *   node scripts/pre-publish-check.js                     # 扫描仓库（默认只扫「会被发布」的文件）
 *   node scripts/pre-publish-check.js --path=<dir>        # 只扫指定目录（可重复，用于自测）
 *   node scripts/pre-publish-check.js --json              # 机器可读输出
 *   node scripts/pre-publish-check.js --no-git            # 忽略 git，纯文件系统遍历
 *   node scripts/pre-publish-check.js --max-fail=warn     # 只让 error 级失败（默认即此）
 *
 * 检查项：
 *   SECRET   密钥/凭据特征（GitHub PAT / OpenAI-ish / 阿里云 AK / 私钥块 …）      → FAIL
 *   LOCALPATH 本机绝对路径（项目绝对路径、用户主目录、非系统盘符等）   → FAIL
 *   SENSITIVE 敏感/本地专属文件误入发布集（敏感词库、真实配置、审计记录、.env）  → FAIL
 *   LARGE     非必要大文件（> 100KB）                                             → WARN
 *   PLACEHOLDER 占位符残留（YOUR_xxx / CHANGE_ME）                                 → WARN
 *   DEBUG     调试残留（console.log 等）                                           → WARN
 *
 * 安全约定（硬性）：**只输出文件名 + 行号 + 规则 ID，绝不回显匹配到的内容本身**，
 * 避免把真实凭据或敏感词写进 CI 日志。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

/** 默认不扫描的目录名（发布集之外的运行时产物）。 */
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'logs', 'temp', 'tmp', 'dist', 'build',
  '.vscode', '.idea', 'coverage', '.cache',
  '.workbuddy', // 本地工具链产物（记忆/会话日志），不属于发布集
]);

/** 默认不扫描的相对路径前缀（运行时数据 / 本机专属）。 */
const IGNORED_PREFIXES = [
  'data/audit_records/',
  'data/uploads/',
  'data/injection_signals/',
  'data/comparisons/',   // 模型对比运行时产物（体积大且含历史原文）
  'config/default.json',
  'config/default.corrupt-',
];

/** 设计上就应当存在占位符的文件（示例配置），不产生占位符告警。 */
const PLACEHOLDER_ALLOWLIST = new Set([
  'config/default.example.json',
]);

/** 同一 (规则, 文件) 最多输出的命中条数，超出聚合成一行，避免刷屏。 */
const MAX_HITS_PER_FILE = 5;

/** 视为二进制的扩展名（含内容，不做正则扫描）。 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.zip', '.gz', '.7z', '.rar', '.pdf', '.mp4', '.mov', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.exe', '.dll', '.so', '.dylib',
  '.onnx', '.bin', '.safetensors', '.pt', '.db', '.sqlite',
]);

/** 大文件阈值（字节）。 */
const LARGE_FILE_BYTES = 100 * 1024;

/** 单文件内容扫描上限（超过则跳过正则扫描，仅做体积检查）。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// ── 规则 1：密钥/凭据特征 ──
// 注意：模式内的 'ghp_' 等字面量不会被自身命中（后面紧跟的是字符类而非 36 位字母数字）。
const SECRET_PATTERNS = [
  { id: 'SECRET/github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'SECRET/openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'SECRET/openai-svc', re: /\bsk-sp-[A-Za-z0-9]{20,}\b/ },
  { id: 'SECRET/aliyun-ak', re: /\bLTAI[A-Za-z0-9]{12,}\b/ },
  { id: 'SECRET/aws-akid', re: /\bAKIA[A-Z0-9]{12,}\b/ },
  { id: 'SECRET/private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'SECRET/slack-token', re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'SECRET/google-api', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
];

// ── 规则 2：本机绝对路径 ──
// 注意：源码里的 Windows 路径常被转义成双反斜杠（'C:\\foo\\bar'），
// 因此分隔符统一用 [\\/]{1,4} 匹配，否则会出现「文件里明明写了本机路径却检不出」的漏报。
const SEP = '[\\\\/]{1,4}';
const LOCAL_PATH_PATTERNS = [
  { id: 'LOCALPATH/win-botdir', re: new RegExp(`[A-Za-z]:${SEP}bot-moderation-cloud[^\\s"']*`) },
  { id: 'LOCALPATH/win-users', re: new RegExp(`[A-Za-z]:${SEP}Users${SEP}[A-Za-z0-9._-]+`) },
  { id: 'LOCALPATH/win-other-drive', re: new RegExp(`\\b[D-Zd-z]:${SEP}(?:llm|Users|users)${SEP}[A-Za-z0-9._-]+`) },
  { id: 'LOCALPATH/unix-home', re: /\/(?:home|Users)\/[a-z][a-z0-9._-]{2,}\/(?:projects|workspace|dev|src|llm|bot)/ },
];

// ── 规则 3：敏感/本地专属文件 ──
const SENSITIVE_FILE_PATTERNS = [
  { id: 'SENSITIVE/sensitive-words', re: /(^|\/)data\/sensitive_words\.json(\.bak)?$/i },
  { id: 'SENSITIVE/real-config', re: /(^|\/)config\/default\.json$/i },
  { id: 'SENSITIVE/env-file', re: /(^|\/)\.env(\.|$)/i },
  { id: 'SENSITIVE/audit-records', re: /(^|\/)data\/audit_records\//i },
  { id: 'SENSITIVE/logs', re: /(^|\/)logs\//i },
  { id: 'SENSITIVE/private-note', re: /待后续筛选|_私有|private[-_]notes/i },
  { id: 'SENSITIVE/github-upload-doc', re: /(^|\/)GITHUB_UPLOAD\.md$/i },
];

// ── 规则 4：占位符残留（WARN） ──
const PLACEHOLDER_PATTERNS = [
  { id: 'PLACEHOLDER/your-key', re: /\bYOUR_[A-Z0-9_]{3,}\b/ },
  { id: 'PLACEHOLDER/change-me', re: /\bCHANGE_ME\b/ },
];

// ── 规则 5：调试残留（WARN） ──
const DEBUG_PATTERNS = [
  { id: 'DEBUG/console-log', re: /^\s*console\.log\(/ },
  { id: 'DEBUG/todo-fixme', re: /\b(?:TODO|FIXME|XXX)\b/ },
];

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数列表
 * @returns {{paths: string[], json: boolean, useGit: boolean, maxFail: string}} 选项
 */
function parseArgs(argv) {
  const options = { paths: [], json: false, useGit: true, maxFail: 'error' };
  for (const arg of argv) {
    if (arg.startsWith('--path=')) options.paths.push(arg.slice('--path='.length));
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-git') options.useGit = false;
    else if (arg.startsWith('--max-fail=')) options.maxFail = arg.slice('--max-fail='.length);
  }
  return options;
}

/**
 * 是否应跳过该相对路径。
 * @param {string} relPath 相对路径（posix 风格）
 * @returns {boolean} 是否跳过
 */
function shouldSkip(relPath) {
  const parts = relPath.split('/');
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  return IGNORED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * 列出待扫描文件（相对路径，posix 风格）。
 * 优先使用 git ls-files：语义即「会被发布的文件」，天然排除 gitignore 项。
 * @param {object} options 选项
 * @returns {{files: string[], source: string}} 文件列表与来源
 */
function listFiles(options) {
  if (options.paths.length > 0) {
    return { files: listByWalk(options.paths.map((p) => path.resolve(PROJECT_ROOT, p))), source: 'path-args' };
  }

  if (options.useGit) {
    try {
      const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const files = out.split('\0').filter(Boolean).map((f) => f.split(path.sep).join('/'));
      if (files.length > 0) return { files, source: 'git-ls-files' };
    } catch {
      // git 不可用 / 非仓库 → 回退文件系统遍历
    }
  }
  return { files: listByWalk([PROJECT_ROOT]), source: 'fs-walk' };
}

/**
 * 文件系统遍历（回退路径）。
 * @param {string[]} roots 根目录
 * @returns {string[]} 相对路径列表
 */
function listByWalk(roots) {
  const out = [];
  const visit = (absDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(PROJECT_ROOT, abs).split(path.sep).join('/');
      if (shouldSkip(rel)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  for (const root of roots) visit(root);
  return out;
}

/**
 * 逐行匹配规则，返回「只含文件与行号」的命中列表（不回显内容）。
 * @param {string} relPath 相对路径
 * @param {Array<{id: string, re: RegExp}>} patterns 规则
 * @returns {Array<{rule: string, file: string, line: number}>} 命中
 */
function scanLines(relPath, patterns) {
  const abs = path.join(PROJECT_ROOT, relPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  if (stat.size > MAX_SCAN_BYTES) return [];

  let text;
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return [];
  }
  if (text.indexOf('\u0000') !== -1) return []; // 二进制

  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      if (pattern.re.test(line)) hits.push({ rule: pattern.id, file: relPath, line: i + 1 });
    }
  }
  return hits;
}

/**
 * 主流程。
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  const { files, source } = listFiles(options);

  const findings = [];
  const add = (severity, rule, file, line, note) => {
    findings.push({ severity, rule, file, line: line || 0, note: note || '' });
  };

  for (const rel of files) {
    if (shouldSkip(rel)) continue;
    const ext = path.extname(rel).toLowerCase();

    // 体积
    let size = 0;
    try { size = fs.statSync(path.join(PROJECT_ROOT, rel)).size; } catch { /* ignore */ }
    if (size > LARGE_FILE_BYTES) {
      add('warn', 'LARGE/oversize', rel, 0, `${Math.round(size / 1024)}KB`);
    }

    // 敏感文件是否进入发布集
    if (options.paths.length === 0) {
      for (const pattern of SENSITIVE_FILE_PATTERNS) {
        if (pattern.re.test(rel)) add('error', pattern.id, rel, 0, 'must-not-be-published');
      }
    }

    if (BINARY_EXT.has(ext)) continue;

    for (const hit of scanLines(rel, SECRET_PATTERNS)) add('error', hit.rule, hit.file, hit.line, 'redacted');
    for (const hit of scanLines(rel, LOCAL_PATH_PATTERNS)) add('error', hit.rule, hit.file, hit.line, 'redacted');
    if (!PLACEHOLDER_ALLOWLIST.has(rel)) {
      for (const hit of scanLines(rel, PLACEHOLDER_PATTERNS)) add('warn', hit.rule, hit.file, hit.line, '');
    }
    for (const hit of scanLines(rel, DEBUG_PATTERNS)) add('warn', hit.rule, hit.file, hit.line, '');
  }

  // 真实计数与规则汇总必须在「去噪截断」之前统计，否则失败判定会被截断影响
  const allFindings = findings.slice();
  const rawErrorCount = findings.filter((f) => f.severity === 'error').length;
  const rawWarnCount = findings.filter((f) => f.severity === 'warn').length;

  // 同 (规则, 文件) 去噪：保留前 MAX_HITS_PER_FILE 条，其余聚合成一行
  const capped = [];
  const seen = new Map();
  for (const f of findings) {
    const key = `${f.rule}|${f.file}`;
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count < MAX_HITS_PER_FILE) capped.push(f);
    else if (count === MAX_HITS_PER_FILE) capped.push({ ...f, line: 0, note: '(+more hits in this file suppressed)' });
  }
  findings.length = 0;
  findings.push(...capped);

  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const failed = options.maxFail === 'error' ? rawErrorCount > 0 : (rawErrorCount + rawWarnCount) > 0;

  if (options.json) {
    console.log(JSON.stringify({
      source,
      scanned: files.length,
      failed,
      errors: rawErrorCount,
      warnings: rawWarnCount,
      shown: findings.length,
      findings,
    }, null, 2));
    process.exitCode = failed ? 1 : 0;
    return;
  }

  const line = '-'.repeat(96);
  console.log(line);
  console.log('GRS pre-publish check (REPO-05)');
  console.log(line);
  console.log(`source=${source}  scanned=${files.length}  errors=${rawErrorCount}  warnings=${rawWarnCount}`
    + (findings.length !== rawErrorCount + rawWarnCount ? `  shown=${findings.length}` : ''));
  console.log(line);

  if (findings.length === 0) {
    console.log('no findings');
  } else {
    console.log('SEV    RULE                          FILE:LINE');
    console.log(line);
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      console.log(
        f.severity.padEnd(7)
        + f.rule.padEnd(30)
        + loc.slice(0, 56).padEnd(57)
        + (f.note || ''),
      );
    }
  }

  // 规则级汇总（按真实计数，不受去噪截断影响）
  const byRule = new Map();
  for (const f of allFindings) {
    const key = `${f.severity}|${f.rule}`;
    const entry = byRule.get(key) || { severity: f.severity, rule: f.rule, hits: 0, files: new Set() };
    entry.hits += 1;
    entry.files.add(f.file);
    byRule.set(key, entry);
  }
  if (byRule.size > 0) {
    console.log('');
    console.log('SUMMARY BY RULE');
    console.log(line);
    console.log('SEV    RULE                                HITS   FILES');
    console.log(line);
    const sorted = [...byRule.values()].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1)
      || b.hits - a.hits || a.rule.localeCompare(b.rule));
    for (const entry of sorted) {
      console.log(entry.severity.padEnd(7) + entry.rule.padEnd(36)
        + String(entry.hits).padEnd(7) + entry.files.size);
    }
    console.log(line);
  }

  console.log('');
  console.log('NOTE: matched content is intentionally NOT printed (secrets / sensitive-word safety).');
  console.log(failed ? 'RESULT: FAIL (exit 1)' : 'RESULT: PASS (exit 0)');
  process.exitCode = failed ? 1 : 0;
}

main();
