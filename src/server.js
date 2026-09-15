const path = require('path');
const express = require('express');
const { loadConfig, getCapabilities, getConflicts, isStartupBlocked } = require('./config');
const { moderateText, moderateImage, moderateImageLocal, moderate, healthCheck } = require('./moderator');
const { getRecentLogs } = require('./logger');
const { logInfo, logError, logWarn } = require('./logger');
const { chatRaw, chatStream, unloadModel } = require('./ollama');
const { reloadWordDb, loadWordDb, saveWordDb } = require('./precheck');
const { getSystemStats } = require('./system-stats');
const { listComparisons, getComparisonResult, getStatus: getComparisonStatus } = require('./comparator');
const { getAuditRecords, getAuditStats, getDetailedStats, listAuditDates, getDateStr } = require('./audit-store');
const { initScheduler, triggerManual, getSchedulerStatus, setComparisonEnabled } = require('./scheduler');
// ★ 插件层唯一入口（架构 §3.2 R1）：核心不再直接 require plugin-registry / plugin-host / plugin-config。
//   插件装配、路由代理、RPC 分发、插件配置全部由 src/plugin-runtime.js 一个门面提供；
//   审核链路的插件能力调用只经 src/capability-broker.js。
const pluginRuntime = require('./plugin-runtime');
const pluginHost = pluginRuntime.getHost();
const pluginConfig = pluginRuntime.getConfig();
const getScanner = () => pluginRuntime.getScanner();
const { startBatchScan, getTaskStatus, getTaskResults, getTaskImage, getTaskThumb, stopTask, listTasks, exportCsv, deleteTask, clearAllTasks, resumeOrphanedTasks, startExportByCategory, getExportStatus } = require('./batch-scan');
const { healthCheckCloud } = require('./qwen_cloud');
const { getContentSafetyStatus } = require('./content_safety');
const injectionAudit = require('./security/injection-audit');
// ★ v2.2.0 编排层（画布 UI 与插件对接的唯一后端接口）
const flowModule = require('./flow');
const flowMigrate = require('./flow/migrate');

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const busboy = require('busboy');
const config = loadConfig();
const app = express();

// ─── 全局异常兜底（长时间运行稳定性关键） ───
// 未捕获异常：记录日志后继续运行（审核请求无状态，单个异常不应拖垮整个服务）。
// 若短时间内连续大量异常，说明进程状态可能已损坏，主动退出交给看门狗重启。
let _fatalErrCount = 0;
let _fatalErrWindowAt = Date.now();
function recordFatalError(tag, err) {
  const now = Date.now();
  if (now - _fatalErrWindowAt > 60 * 1000) { _fatalErrCount = 0; _fatalErrWindowAt = now; }
  _fatalErrCount++;
  try {
    logError('server', `${tag}: ${err?.message || err}`, err?.stack);
  } catch { /* 日志自身异常也不能中断 */ }
  // 60 秒内连续 10 次未捕获异常 → 主动退出，交给看门狗自动重启
  if (_fatalErrCount >= 10) {
    try { logError('server', '连续异常过多，主动退出以触发自动重启'); } catch {}
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => recordFatalError('未捕获异常', err));
process.on('unhandledRejection', (reason) => recordFatalError('未处理的 Promise 拒绝', reason));

// ─── 公网访问密码保护 ───

// 会话 Token 存储（内存，服务重启后失效）
// Map<token, { createdAt: number, expiresAt: number, ip: string }>
const sessionTokens = new Map();
const SESSION_TOKEN_TTL = 4 * 60 * 60 * 1000; // 4 小时过期

// 清理过期 Token（每小时一次）
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessionTokens.entries()) {
    if (session.expiresAt < now) {
      sessionTokens.delete(token);
    }
  }
}, 60 * 60 * 1000);

function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

function getClientIp(req) {
  const peerIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  const trustedProxyIps = (config.server?.trustedProxyIps || []).map(normalizeIp);
  const forwardedFor = req.headers['x-forwarded-for'];

  // 仅当 TCP 对端在可信反向代理白名单时才接受 X-Forwarded-For，防止公网客户端伪造该头绕过认证。
  if (forwardedFor && trustedProxyIps.includes(peerIp)) {
    return normalizeIp(String(forwardedFor).split(',')[0]);
  }
  return peerIp;
}

function isLocalIp(ip) {
  // 本地回环地址
  if (['127.0.0.1', '::1', 'localhost'].includes(ip)) return true;
  // 局域网地址
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.') ||
      ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
      ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.') ||
      ip.startsWith('172.23.') || ip.startsWith('172.24.') || ip.startsWith('172.25.') ||
      ip.startsWith('172.26.') || ip.startsWith('172.27.') || ip.startsWith('172.28.') ||
      ip.startsWith('172.29.') || ip.startsWith('172.30.') || ip.startsWith('172.31.')) return true;
  return false;
}

function isLocalRequest(req) {
  return isLocalIp(getClientIp(req));
}

/**
 * 生成会话 Token
 * @param {string} ip - 客户端 IP
 * @returns {string} token
 */
function generateSessionToken(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessionTokens.set(token, {
    createdAt: now,
    expiresAt: now + SESSION_TOKEN_TTL,
    ip,
  });
  logInfo('server', `生成会话 Token: IP=${ip}, 有效期 ${SESSION_TOKEN_TTL / 3600000} 小时`);
  return token;
}

/**
 * 验证会话 Token
 * @param {string} token
 * @param {string} ip
 * @returns {boolean}
 */
function isValidSessionToken(token, ip) {
  if (!token) return false;
  const session = sessionTokens.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessionTokens.delete(token);
    return false;
  }
  // Token 绑定 IP，不同 IP 不能复用
  if (session.ip !== ip) return false;
  return true;
}

function requireAdminPassword(req, res, next) {
  // 本地访问免密码
  if (isLocalRequest(req)) return next();
  
  const clientIp = getClientIp(req);
  
  // 1. 检查会话 Token（优先）
  const token = req.headers['x-session-token'] || req.query.token || req.body?.token || '';
  if (isValidSessionToken(token, clientIp)) {
    return next();
  }
  
  // 2. 检查密码
  const adminPwd = config.adminPassword || config.wordDbPassword || '';
  if (!adminPwd) {
    logError('server', '公网访问需要密码,但未配置 adminPassword');
    return res.status(403).json({ error: '未配置管理员密码' });
  }
  
  const pwd = req.headers['x-admin-password'] || req.query.password || req.body?.password || '';
  if (pwd !== adminPwd) {
    logError('server', `公网访问密码验证失败: IP=${clientIp}`);
    return res.status(403).json({ error: '密码错误,无权修改配置' });
  }
  
  next();
}

app.use(express.json({ limit: config.server.maxRequestSize }));

// ─── 公网访问认证网关 ───
// 免认证白名单：审核 API、聊天 API、健康检查、密码验证、login.html 静态资源
const AUTH_WHITELIST = [
  '/health',
  '/api/moderate',
  '/api/moderate/text',
  '/api/moderate/image',
  '/api/chat-local',
  '/api/admin/verify-password',
  '/api/worddb/verify-password',
  '/api/models',
  '/login.html',
  '/favicon.ico',
];

function authGate(req, res, next) {
  // 本地访问免密码
  if (isLocalRequest(req)) return next();

  const clientIp = getClientIp(req);

  // 主页：允许访问（前端根据认证状态动态显示/隐藏功能）
  if (req.method === 'GET' && req.path === '/') {
    return next();
  }

  // 白名单路由直接放行
  for (const prefix of AUTH_WHITELIST) {
    if (req.path === prefix || req.path.startsWith(prefix + '?') || req.path.startsWith(prefix + '/')) {
      return next();
    }
  }

  // 静态文件（.js/.css/.png/.jpg 等）— 未认证时不暴露，防止爬虫获取前端代码
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
    const token = req.headers['x-session-token'] || req.query.token || '';
    if (!isValidSessionToken(token, clientIp)) {
      return res.status(401).json({ error: '未认证' });
    }
    return next();
  }

  // 其他所有请求需要验证
  const token = req.headers['x-session-token'] || req.query.token || '';
  if (isValidSessionToken(token, clientIp)) return next();

  // JSON API 返回 401
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('json')) {
    return res.status(401).json({ error: '未认证，请先验证管理员密码' });
  }

  // HTML 页面请求返回登录页
  return res.status(401).sendFile(path.join(__dirname, '..', 'public', 'login.html'));
}

app.use(authGate);
// HTML 页面禁止缓存：前端更新频繁，避免浏览器用旧版导致功能异常
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
if (config.server.cors) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password, X-Worddb-Password, X-Session-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// ─── 健康检查 ───
app.get('/health', async (req, res) => {
  const caps = getCapabilities();
  const ollamaStatus = caps.local.available ? await healthCheck() : { ok: false, skipped: true, reason: caps.local.reason || '本地通道未配置', models: [] };
  const isCloudOnly = config.moderationMode === 'cloud-only';
  const isCloudEnabled = isCloudOnly || (config.moderation.dualMode && config.qwenCloud?.enabled);

  let cloudStatus = { ok: false, skipped: !caps.cloud.available, disabled: !isCloudEnabled };
  if (isCloudEnabled) {
    try {
      // /health 是高频存活探测：只返回缓存状态，不触发新的云端 API 调用（避免浪费额度）
      cloudStatus = await healthCheckCloud({ useCacheOnly: true });
    } catch (err) {
      cloudStatus = { ok: false, error: err.message };
    }
  }

  // 服务进程存活即视为健康；「可选能力未配置」用 channels / degraded 字段表达，
  // 不能让看门狗或前端把「没配 Key」误判成服务崩溃而触发重启风暴。
  const anyChannelOk = ollamaStatus.ok || cloudStatus.ok;
  const overallOk = true;
  const contentSafetyStatus = getContentSafetyStatus();

  res.json({
    status: overallOk ? 'ok' : 'degraded',
    server: 'ok',
    mode: isCloudOnly ? 'cloud-only' : 'local',
    localAccess: isLocalRequest(req),
    dualMode: config.moderation.dualMode || false,
    ollama: isCloudOnly ? { ok: false, skipped: true, reason: 'cloud-only 模式未启用本地通道' } : ollamaStatus,
    cloud: cloudStatus,
    contentSafety: contentSafetyStatus,
    // 明确告知哪些可选通道未配置（供前端/运维判断，而不是靠猜）
    channels: {
      precheck: { available: true },
      local: { available: caps.local.available, reason: caps.local.reason },
      cloud: { available: caps.cloud.available, reason: caps.cloud.reason },
      contentSafety: { available: caps.contentSafety.available, reason: caps.contentSafety.reason },
    },
    degraded: !anyChannelOk,
    // 启动期选项冲突报告（架构 §4.2：缓存后在 /health 暴露，前端首屏展示）
    conflicts: getConflicts(),
    models: {
      text: config.ollama.textModel,
      vision: config.ollama.visionModel,
      cloud: isCloudEnabled ? (config.qwenCloud?.model || 'qwen-plus') : null,
    },
  });
});

// ─── 插件系统状态（迁移到 plugin-scanner + cordis 桥接层） ───
app.get('/api/plugins', async (req, res) => {
  const plugins = getScanner().describe();
  // 标签服务健康检查（wd14 为可选能力：未显式禁用才探活，禁用时直接标记跳过）
  let wd14 = { status: 'down', skipped: true };
  const wd14Cfg = config.wd14 || {};
  if (wd14Cfg.enabled !== false) {
    try {
      const host = wd14Cfg.host || 'http://127.0.0.1:9898';
      const resp = await fetch(`${host}/health`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) wd14 = { status: 'ok', skipped: false, ...(await resp.json()) };
    } catch {
      wd14 = { status: 'down', skipped: false };
    }
  }
  res.json({
    plugins,
    wd14,
    configs: pluginConfig.describe(),
    host: pluginRuntime.getPhase() === 'ready' ? pluginRuntime.getHostStatus() : { phase: 'booting' },
  });
});

// 插件开关：启用/禁用（公网需密码）
app.post('/api/plugins/:id/toggle', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  const enabled = req.body?.enabled !== false;
  try {
    const out = enabled ? await getScanner().enable(id) : await getScanner().disable(id);
    if (!out.ok) return res.status(400).json({ error: out.error || '操作失败' });
    logInfo('server', `插件 ${id} 已${enabled ? '启用' : '禁用'}`);
    res.json({ success: true, id, enabled, status: out.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 插件重载（清 require 缓存后重新装载）（公网需密码）
app.post('/api/plugins/:id/reload', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  try {
    const out = await getScanner().reload(id);
    if (!out.ok) return res.status(400).json({ error: out.error || `插件 ${id} 重载失败` });
    res.json({ success: true, id, status: out.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 插件配置：获取全部插件的配置 schema + 当前值
app.get('/api/plugins/config', (req, res) => {
  res.json({ configs: pluginConfig.describe() });
});

// 插件配置：更新某插件单个配置项（公网需密码）
app.put('/api/plugins/config/:name', requireAdminPassword, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: '缺少 key' });
  try {
    const applied = pluginConfig.update(req.params.name, key, value);
    logInfo('server', `插件配置已更新: ${req.params.name}.${key} = ${applied}`);
    res.json({ success: true, key, value: applied });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 插件配置：批量更新（Schema 渲染器用，公网需密码）
app.put('/api/plugins/config', requireAdminPassword, (req, res) => {
  const { name, patch } = req.body || {};
  if (!name || !patch) return res.status(400).json({ error: '缺少 name 或 patch' });
  try {
    const applied = pluginConfig.updateMany(name, patch);
    res.json({ success: true, applied });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 卸载插件（移入 data/plugins-trash/<id>-<ts>/，公网需密码）
app.delete('/api/plugins/:id', requireAdminPassword, async (req, res) => {
  const id = req.params.id;
  try {
    const out = await getScanner().uninstall(id);
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ success: true, id, trash: out.trash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 本地文件夹导入（复制，源目录不变；公网需密码）
app.post('/api/plugins/import-local', requireAdminPassword, (req, res) => {
  const { path: srcPath } = req.body || {};
  if (!srcPath) return res.status(400).json({ error: '缺少 path' });
  const out = getScanner().importLocal(srcPath);
  if (!out.ok) return res.status(400).json({ error: out.error });
  logInfo('server', `本地导入插件成功: ${out.id}`);
  res.json({ success: true, id: out.id, risks: out.risks || [] });
});

// ZIP 导入（multipart，复用已有 busboy；公网需密码）
app.post('/api/plugins/import-zip', requireAdminPassword, (req, res) => {
  const bb = busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  let tmpPath = null;
  let done = false;
  const finish = (code, payload) => {
    if (done) return;
    done = true;
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    res.status(code).json(payload);
  };
  bb.on('file', (name, stream, info) => {
    const safeId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tmpPath = path.join(os.tmpdir(), `${safeId}.zip`);
    const ws = fs.createWriteStream(tmpPath);
    stream.pipe(ws);
    ws.on('close', async () => {
      const out = getScanner().importZip(tmpPath);
      if (!out.ok) return finish(400, { error: out.error });
      logInfo('server', `ZIP 导入插件成功: ${out.id}`);
      finish(200, { success: true, id: out.id, risks: out.risks || [] });
    });
    ws.on('error', (err) => finish(400, { error: `上传失败: ${err.message}` }));
    void info;
  });
  bb.on('error', (err) => finish(400, { error: `解析上传失败: ${err.message}` }));
  bb.on('close', () => { if (!tmpPath) finish(400, { error: '未收到文件' }); });
  req.pipe(bb);
});

// Git 导入（child_process.execFile，公网需密码）
app.post('/api/plugins/import-git', requireAdminPassword, async (req, res) => {
  const { url, ref, subdir } = req.body || {};
  if (!url) return res.status(400).json({ error: '缺少仓库地址' });
  try {
    const out = await getScanner().importGit(url, ref, subdir);
    if (!out.ok) return res.status(400).json({ error: out.error });
    logInfo('server', `Git 导入插件成功: ${out.id}`);
    res.json({ success: true, id: out.id, commitHash: out.commitHash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Git 更新（pull --ff-only，公网需密码）
app.post('/api/plugins/:id/update', requireAdminPassword, async (req, res) => {
  try {
    const out = await getScanner().update(req.params.id);
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ success: true, message: out.message, commitHash: out.commitHash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// git 可用性检测（前端据此置灰 git 导入入口）
app.get('/api/plugins/git-status', async (req, res) => {
  res.json(await getScanner().checkGit());
});

// ─── 可用模型列表 ───
app.get('/api/models', async (req, res) => {
  try {
    const ollamaStatus = await healthCheck();
    const installed = ollamaStatus.models || [];
    const available = config.ollama.availableModels || [];
    // 将配置的模型与 Ollama 已安装模型做交集，标记哪些已就绪
    const models = available.map((m) => ({
      ...m,
      installed: installed.some((i) => i === m.id || i.startsWith(m.id + ':')),
      isDefault: m.id === config.ollama.textModel,
    }));
    res.json({ defaultModel: config.ollama.textModel, models });
  } catch (err) {
    res.json({ defaultModel: config.ollama.textModel, models: [] });
  }
});

// ─── 本地模型管理 ───
const { getLocalModels, uploadModelFile, importModel, pullModel, deleteModel, setDefaultModel } = require('./model-manager');

// 获取本地模型列表
app.get('/api/local-models', async (req, res) => {
  try {
    const ollamaStatus = await healthCheck();
    const models = await getLocalModels();
    res.json({
      ollamaAvailable: ollamaStatus.ok,
      models,
      currentTextModel: config.ollama.textModel,
      currentVisionModel: config.ollama.visionModel,
    });
  } catch (err) {
    res.json({
      ollamaAvailable: false,
      models: [],
      error: err.message,
    });
  }
});

// 上传模型文件（原生流式处理，无需额外依赖）
app.post('/api/local-models/upload', requireAdminPassword, async (req, res) => {
  const filename = req.headers['x-filename'] || 'model.gguf';
  if (!filename.endsWith('.gguf')) {
    return res.status(400).json({ error: '只支持 GGUF 格式的模型文件' });
  }
  
  const destPath = path.join(__dirname, '..', 'models', filename);
  const modelsDir = path.join(__dirname, '..', 'models');
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
  
  const writeStream = fs.createWriteStream(destPath);
  let bytesWritten = 0;
  
  req.on('data', (chunk) => {
    bytesWritten += chunk.length;
  });
  
  req.pipe(writeStream);
  
  writeStream.on('finish', () => {
    logInfo('server', `模型文件已上传: ${filename} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ success: true, file: { filename, path: destPath, size: bytesWritten } });
  });
  
  writeStream.on('error', (err) => {
    logError('server', '上传模型文件失败', err.message);
    res.status(500).json({ error: '上传失败', message: err.message });
  });
});

// 导入模型到 Ollama
app.post('/api/local-models/import', requireAdminPassword, async (req, res) => {
  try {
    const { filename, modelName, modelType } = req.body;
    if (!filename || !modelName) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    
    const ggufPath = path.join(__dirname, '..', 'models', filename);
    if (!fs.existsSync(ggufPath)) {
      return res.status(404).json({ error: '模型文件不存在' });
    }
    
    await importModel(ggufPath, modelName, modelType || 'text');
    res.json({ success: true, modelName });
  } catch (err) {
    logError('server', '导入模型失败', err.message);
    res.status(500).json({ error: '导入失败', message: err.message });
  }
});

// 从 Ollama 仓库拉取官方模型
app.post('/api/local-models/pull', requireAdminPassword, async (req, res) => {
  try {
    const { modelName } = req.body;
    if (!modelName) {
      return res.status(400).json({ error: '缺少模型名称' });
    }
    await pullModel(modelName);
    res.json({ success: true, modelName });
  } catch (err) {
    logError('server', '拉取模型失败', err.message);
    res.status(500).json({ error: '拉取失败', message: err.message });
  }
});

// 删除本地模型
app.delete('/api/local-models/:name', requireAdminPassword, async (req, res) => {
  try {
    const modelName = req.params.name;
    const result = await deleteModel(modelName);
    res.json(result);
  } catch (err) {
    logError('server', '删除模型失败', err.message);
    res.status(500).json({ error: '删除失败', message: err.message });
  }
});

// 设置默认模型
app.put('/api/local-models/default', requireAdminPassword, async (req, res) => {
  try {
    const { modelName, modelType } = req.body;
    if (!modelName) {
      return res.status(400).json({ error: '缺少模型名称' });
    }
    
    setDefaultModel(modelName, modelType || 'text');
    res.json({ success: true });
  } catch (err) {
    logError('server', '设置默认模型失败', err.message);
    res.status(500).json({ error: '设置失败', message: err.message });
  }
});

// ─── 文本审核 ───
app.post('/api/moderate/text', async (req, res) => {
  try {
    const { text, userId, groupId, messageId, strictness, model } = req.body;

    if (!text) {
      return res.status(400).json({ error: '缺少 text 参数' });
    }

    const result = await moderateText(text, { userId, groupId, messageId }, { strictness, model });
    res.json(result);
  } catch (err) {
    logError('server', `文本审核接口错误: ${err.message}`);
    res.status(500).json({ error: '审核服务内部错误', message: err.message });
  }
});

// ─── 图片审核 ───
app.post('/api/moderate/image', async (req, res) => {
  try {
    const { image, text, userId, groupId, messageId, strictness } = req.body;

    if (!image) {
      return res.status(400).json({ error: '缺少 image 参数' });
    }

    // 去除 data:image/xxx;base64, 前缀
    const base64Data = image.includes(',') ? image.split(',')[1] : image;

    const result = await moderateImage(base64Data, text || '', { userId, groupId, messageId, strictness });
    res.json(result);
  } catch (err) {
    logError('server', `图片审核接口错误: ${err.message}`);
    res.status(500).json({ error: '审核服务内部错误', message: err.message });
  }
});

// ─── 综合审核（文本+图片） ───
app.post('/api/moderate', async (req, res) => {
  try {
    const { text, images, userId, groupId, messageId } = req.body;

    if (!text && (!images || images.length === 0)) {
      return res.status(400).json({ error: '至少提供 text 或 images 参数' });
    }

    // 清理图片 base64 前缀
    const cleanImages = (images || []).map((img) =>
      img.includes(',') ? img.split(',')[1] : img
    );

    const result = await moderate(text || '', cleanImages, { userId, groupId, messageId });
    res.json(result);
  } catch (err) {
    logError('server', `综合审核接口错误: ${err.message}`);
    res.status(500).json({ error: '审核服务内部错误', message: err.message });
  }
});

// ─── 查看最近审核日志 ───
app.get('/api/logs', (req, res) => {
  const count = parseInt(req.query.count, 10) || 50;
  const logs = getRecentLogs(Math.min(count, 500));
  res.json({ total: logs.length, logs });
});

// ─── 审核记录（含原始文本，来自 audit-store）───
app.get('/api/audit-records', (req, res) => {
  const dateStr = req.query.date || getDateStr();
  const records = getAuditRecords(dateStr);
  // 展平结构：把 result 和 meta 的字段提到顶层，方便前端消费
  const flat = records.map((r) => {
    const { result = {}, meta = {}, ...rest } = r;
    return { ...rest, ...result, ...meta };
  });
  res.json({ total: flat.length, date: dateStr, logs: flat });
});

// ─── 审核记录可用日期列表 ───
app.get('/api/audit-dates', (req, res) => {
  res.json({ dates: listAuditDates() });
});

// ─── 审核统计信息 ───
app.get('/api/audit-stats', (req, res) => {
  try {
    const today = getDateStr();
    const stats = getAuditStats(today);
    
    // 计算风险等级分布
    const riskDistribution = {
      safe: stats.by_risk?.safe || 0,
      low: stats.by_risk?.low || 0,
      medium: stats.by_risk?.medium || 0,
      high: stats.by_risk?.high || 0,
      critical: stats.by_risk?.critical || 0,
    };
    
    // 计算拦截率
    const blocked = stats.blocked || 0;
    const passed = stats.passed || 0;
    const total = stats.total || 0;
    const blockRate = total > 0 ? Math.round((blocked / total) * 100) : 0;
    
    res.json({
      date: today,
      total,
      passed,
      blocked,
      blockRate,
      riskDistribution,
      topCategories: Object.entries(stats.by_category || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, count]) => ({ category: cat, count })),
    });
  } catch (err) {
    res.status(500).json({ error: '获取审核统计失败', message: err.message });
  }
});

// ─── 详细统计面板（Token、耗时、7日趋势）───
app.get('/api/stats/summary', (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;
    const stats = getDetailedStats(Math.min(days, 30));
    // SEC-08：暴露提示词注入可疑计数（进程内累计，重启清零）
    stats.injection = injectionAudit.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: '获取统计失败', message: err.message });
  }
});

// ─── 审核分类说明 ───
app.get('/api/categories', (req, res) => {
  res.json(config.moderation.categories);
});

// ─── 阈值配置（获取/更新）───
app.get('/api/thresholds', (req, res) => {
  res.json({
    thresholds: config.moderation.thresholds || {},
    doubleCheck: config.moderation.doubleCheck || false,
    dualMode: config.moderation.dualMode || false,
    qwenCloud: {
      enabled: config.qwenCloud?.enabled || false,
      model: config.qwenCloud?.model || 'qwen-plus',
    },
  });
});

app.put('/api/thresholds', requireAdminPassword, (req, res) => {
  try {
    const { thresholds, doubleCheck, dualMode } = req.body;
    if (thresholds && typeof thresholds === 'object') {
      config.moderation.thresholds = thresholds;
    }
    if (typeof doubleCheck === 'boolean') {
      config.moderation.doubleCheck = doubleCheck;
    }
    if (typeof dualMode === 'boolean') {
      config.moderation.dualMode = dualMode;
      logInfo('server', `双审模式已${dualMode ? '启用' : '禁用'}`);
    }
    logInfo('server', `阈值配置已更新: doubleCheck=${config.moderation.doubleCheck}, dualMode=${config.moderation.dualMode}`);
    
    // 持久化到磁盘
    const { saveConfig } = require('./config');
    saveConfig();
    
    res.json({ 
      success: true, 
      thresholds: config.moderation.thresholds, 
      doubleCheck: config.moderation.doubleCheck,
      dualMode: config.moderation.dualMode
    });
  } catch (err) {
    res.status(500).json({ error: '更新阈值失败', message: err.message });
  }
});

// ─── 本地对话代理（仅前端对话 Tab 测试用，不暴露通用 Chat API）───
app.post('/api/chat-local', async (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    return res.status(400).json({ error: 'cloud-only 模式不支持本地模型对话' });
  }
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '缺少 messages 参数' });
    }
    if (messages.length > 20) {
      return res.status(400).json({ error: '消息数量超出限制（最多20条）' });
    }
    const model = config.ollama.textModel;
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      try {
        const full = await chatStream(model, messages, (piece) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
        });
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
      } catch (err) {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
      res.end();
      return;
    }
    const reply = await chatRaw(model, messages);
    res.json({ reply, model });
  } catch (err) {
    logError('server', `本地对话错误: ${err.message}`);
    res.status(500).json({ error: '对话服务内部错误', message: err.message });
  }
});

// ─── 手动卸载模型释放显存 ───
app.post('/api/unload', requireAdminPassword, async (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    return res.status(400).json({ error: 'cloud-only 模式不支持本地模型管理' });
  }
  try {
    const { model } = req.body;
    const targetModel = model || config.ollama.textModel;
    await unloadModel(targetModel);
    res.json({ success: true, message: `模型 ${targetModel} 已卸载，显存已释放` });
  } catch (err) {
    logError('server', `卸载模型失败: ${err.message}`);
    res.status(500).json({ error: '卸载模型失败', message: err.message });
  }
});

// ─── 敏感词库管理 ───
app.get('/api/worddb/status', (req, res) => {
  const { wordDb } = loadWordDb();
  const categories = wordDb.categories || {};
  const stats = {};
  let total = 0;
  for (const [catId, cat] of Object.entries(categories)) {
    const count = (cat.words || []).length;
    stats[catId] = { count, level: cat.level };
    total += count;
  }
  res.json({ total, categories: stats });
});

app.post('/api/worddb/reload', (req, res) => {
  try {
    const { wordDb } = reloadWordDb();
    const categories = wordDb.categories || {};
    const stats = {};
    let total = 0;
    for (const [catId, cat] of Object.entries(categories)) {
      const count = (cat.words || []).length;
      stats[catId] = { count, level: cat.level };
      total += count;
    }
    res.json({ success: true, total, categories: stats });
  } catch (err) {
    res.status(500).json({ error: '词库重载失败', message: err.message });
  }
});

// ─── 敏感词库编辑（需要密码）───
const WORDDB_PASSWORD = config.wordDbPassword || '';

// 密码验证中间件（本地访问免密码，公网需密码或会话 Token）
function requireWordDbPassword(req, res, next) {
  // 本地访问免密码
  if (isLocalRequest(req)) return next();

  const clientIp = getClientIp(req);

  // 1. 检查会话 Token（优先）
  const token = req.headers['x-session-token'] || req.query.token || req.body?.token || '';
  if (isValidSessionToken(token, clientIp)) {
    return next();
  }

  // 2. 检查密码
  const pwd = req.headers['x-worddb-password'] || req.headers['x-admin-password'] || req.body?.password || '';
  const adminPwd = config.adminPassword || WORDDB_PASSWORD || '';
  if (!adminPwd) return next(); // 未设置密码则放行
  if (pwd !== adminPwd && pwd !== WORDDB_PASSWORD) {
    return res.status(403).json({ error: '密码错误，无权修改词库' });
  }
  next();
}

// 验证密码（公网密码验证接口，验证成功后返回会话 Token）
app.post('/api/worddb/verify-password', (req, res) => {
  // 本地访问直接成功
  if (isLocalRequest(req)) {
    return res.json({ success: true, localAccess: true });
  }
  const pwd = req.body?.password || '';
  const adminPwd = config.adminPassword || WORDDB_PASSWORD || '';
  if (!adminPwd) {
    return res.json({ success: true, noPassword: true });
  }
  if (pwd !== adminPwd && pwd !== WORDDB_PASSWORD) {
    return res.status(403).json({ success: false, error: '密码错误' });
  }
  // 验证成功，返回会话 Token
  const clientIp = getClientIp(req);
  const sessionToken = generateSessionToken(clientIp);
  res.json({ success: true, sessionToken, expiresIn: SESSION_TOKEN_TTL });
});

// ─── 管理员密码验证（通用，验证成功后返回会话 Token）───
app.post('/api/admin/verify-password', (req, res) => {
  if (isLocalRequest(req)) {
    return res.json({ success: true, localAccess: true });
  }
  const pwd = req.body?.password || '';
  const adminPwd = config.adminPassword || config.wordDbPassword || '';
  if (!adminPwd) {
    return res.json({ success: true, noPassword: true });
  }
  if (pwd !== adminPwd) {
    return res.status(403).json({ success: false, error: '密码错误' });
  }
  // 验证成功，返回会话 Token
  const clientIp = getClientIp(req);
  const sessionToken = generateSessionToken(clientIp);
  res.json({ success: true, sessionToken, expiresIn: SESSION_TOKEN_TTL });
});

// ─── 检查当前认证状态（用于前端判断是否需要跳转登录页）───
app.post('/api/admin/check-auth', (req, res) => {
  if (isLocalRequest(req)) {
    return res.json({ authenticated: true, localAccess: true });
  }
  const clientIp = getClientIp(req);
  const token = req.headers['x-session-token'] || '';
  if (isValidSessionToken(token, clientIp)) {
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ authenticated: false, error: '未认证或会话已过期' });
});

// ─── 双审模式管理 ───
app.get('/api/dual-mode', (req, res) => {
  // API Key 脱敏：只显示前4位和后4位
  const apiKey = config.qwenCloud?.apiKey || process.env.DASHSCOPE_API_KEY || '';
  const tokenPlanApiKey = config.tokenPlan?.apiKey || '';
  const maskKey = (value) => value.length > 8
    ? value.substring(0, 4) + '****' + value.substring(value.length - 4)
    : value ? '****' : '';

  res.json({
    enabled: config.moderation.dualMode || false,
    qwenCloud: {
      enabled: config.qwenCloud?.enabled || false,
      billingSource: config.qwenCloud?.billingSource || 'dashscope',
      model: config.qwenCloud?.model || 'qwen-plus',
      visionModel: config.qwenCloud?.visionModel || 'qwen3.7-plus',
      visionEnabled: config.qwenCloud?.visionEnabled || false,
      endpoint: config.qwenCloud?.endpoint || '',
      hasApiKey: !!apiKey,
      maskedApiKey: maskKey(apiKey),
      timeout: config.qwenCloud?.timeout || 30000,
    },
    tokenPlan: {
      endpoint: config.tokenPlan?.endpoint || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      hasApiKey: !!tokenPlanApiKey,
      maskedApiKey: maskKey(tokenPlanApiKey),
      timeout: config.tokenPlan?.timeout || 60000,
    },
    availableModels: [
      // ─── Qwen 文本模型（按性价比排序） ───
      { id: 'qwen-flash', name: 'Qwen Flash', pricing: { input: 0.15, output: 1.5 }, icon: 'qwen', badge: '最低价', provider: 'qwen', note: '≤128K 首阶梯' },
      { id: 'qwen-turbo', name: 'Qwen Turbo', pricing: { input: 0.3, output: 0.6 }, icon: 'qwen', badge: '极速低价', provider: 'qwen', note: '非思考模式' },
      { id: 'qwen3.7-flash', name: 'Qwen 3.7 Flash', pricing: { input: 0.5, output: 2 }, icon: 'qwen', badge: '超低价', provider: 'qwen', note: '非思考模式' },
      { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash', pricing: { input: 1, output: 3 }, icon: 'qwen', badge: '新品低价', provider: 'qwen', note: '8/26 发布·已入 Token Plan' },
      { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', pricing: { input: 0.36, output: 2.9 }, icon: 'qwen', badge: '低价', provider: 'qwen', note: '≤256K 首阶梯' },
      { id: 'qwen3.5-flash', name: 'Qwen 3.5 Flash', pricing: { input: 0.2, output: 2 }, icon: 'qwen', badge: '低价', provider: 'qwen', note: '≤128K 首阶梯' },
      { id: 'qwen-plus', name: 'Qwen Plus', pricing: { input: 0.8, output: 2 }, icon: 'qwen', badge: '均衡', provider: 'qwen', note: '非思考 ≤128K' },
      { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus', pricing: { input: 0.8, output: 4.8 }, icon: 'qwen', badge: '性价比', provider: 'qwen', note: '≤128K 首阶梯' },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', pricing: { input: 2.5, output: 10 }, icon: 'qwen', badge: '推荐', provider: 'qwen', note: '非思考模式' },
      { id: 'qwen-long', name: 'Qwen Long', pricing: { input: 0.5, output: 2 }, icon: 'qwen', badge: '长文本', provider: 'qwen', note: '超长上下文' },
      { id: 'qwen-max', name: 'Qwen Max', pricing: { input: 2.4, output: 9.6 }, icon: 'qwen', badge: '精准', provider: 'qwen' },
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', pricing: { input: 12, output: 36 }, icon: 'qwen', badge: '旗舰', provider: 'qwen', note: '促销 ¥6/¥18' },
      { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', pricing: { input: 12, output: 36 }, icon: 'qwen', badge: '旗舰', provider: 'qwen', note: '1M 上下文' },
      { id: 'qwen3.8-max-preview', name: 'Qwen 3.8 Max Preview', pricing: { input: 12, output: 36 }, icon: 'qwen', badge: 'Token Plan', provider: 'qwen', note: '首发·Credits 抵扣·白天1折/夜间0.2折' },
      // ─── DeepSeek 系列（百炼平台，2026-08-17 起峰谷定价） ───
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', pricing: { input: 3, output: 9 }, icon: 'deepseek', badge: '低价', provider: 'deepseek', note: '峰谷：高峰3/9·空闲1.5/4.5' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', pricing: { input: 3, output: 9 }, icon: 'deepseek', badge: '视觉实验', provider: 'deepseek', note: '与 flash 同价' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', pricing: { input: 9, output: 27 }, icon: 'deepseek', badge: '旗舰', provider: 'deepseek', note: '峰谷：高峰9/27·空闲4.5/13.5' },
      // ─── 第三方模型 ───
      { id: 'glm-4.7', name: 'GLM 4.7', pricing: { input: 3, output: 14 }, icon: 'glm', badge: '智谱', provider: 'glm', note: '≤32K 首阶梯' },
      { id: 'glm-5', name: 'GLM 5', pricing: { input: 4, output: 18 }, icon: 'glm', badge: '智谱', provider: 'glm', note: '≤32K 首阶梯' },
      { id: 'glm-5.2', name: 'GLM 5.2', pricing: { input: 8, output: 28 }, icon: 'glm', badge: 'Token Plan', provider: 'glm', note: '1M 上下文' },
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', pricing: { input: 0.8, output: 2.8 }, icon: 'glm', badge: '超低价', provider: 'glm', note: '8/26 发布·≈GLM-5.3 1/10' },
      { id: 'mimo-v2.5', name: 'MiMo v2.5', pricing: { input: 1, output: 2 }, icon: 'glm', badge: '低价', provider: 'other', note: '小米·轻量低价' },
    ],
    availableVisionModels: [
      { id: 'qwen3-vl-flash', name: 'Qwen 3 VL Flash', pricing: { input: 0.15, output: 1.5 }, icon: 'qwen', provider: 'qwen', note: '≤32K 低价视觉' },
      { id: 'qwen-vl-plus', name: 'Qwen VL Plus', pricing: { input: 0.8, output: 2 }, icon: 'qwen', provider: 'qwen' },
      { id: 'qwen3-vl-plus', name: 'Qwen 3 VL Plus', pricing: { input: 1, output: 10 }, icon: 'qwen', provider: 'qwen', note: '≤32K' },
      { id: 'qwen-vl-max', name: 'Qwen VL Max', pricing: { input: 1.6, output: 4 }, icon: 'qwen', provider: 'qwen' },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus (推荐)', pricing: { input: 2.5, output: 10 }, icon: 'qwen', provider: 'qwen' },
    ],
  });
});

app.put('/api/dual-mode', requireAdminPassword, async (req, res) => {
  try {
    const {
      enabled, model, apiKey, endpoint, timeout, cloudEnabled, visionEnabled, visionModel,
      billingSource, tokenPlanApiKey, tokenPlanEndpoint, tokenPlanTimeout,
    } = req.body;

    if (typeof enabled === 'boolean') {
      config.moderation.dualMode = enabled;
      logInfo('server', `双审模式已${enabled ? '启用' : '禁用'}`);
    }
    if (!config.qwenCloud) config.qwenCloud = {};
    if (typeof cloudEnabled === 'boolean') {
      config.qwenCloud.enabled = cloudEnabled;
    }
    if (typeof visionEnabled === 'boolean') {
      config.qwenCloud.visionEnabled = visionEnabled;
    }
    if (model) {
      config.qwenCloud.model = model;
    }
    if (visionModel) {
      config.qwenCloud.visionModel = visionModel;
    }
    if (apiKey) {
      config.qwenCloud.apiKey = apiKey;
    }
    if (endpoint) {
      config.qwenCloud.endpoint = endpoint;
    }
    if (typeof timeout === 'number') {
      config.qwenCloud.timeout = timeout;
    }
    // 额度来源切换：token-plan（Credits 抵扣） vs dashscope（通用按量/节省计划）
    if (billingSource === 'token-plan' || billingSource === 'dashscope') {
      config.qwenCloud.billingSource = billingSource;
    }

    // ─── Token Plan 凭证 ───
    if (tokenPlanApiKey || tokenPlanEndpoint || typeof tokenPlanTimeout === 'number') {
      if (!config.tokenPlan) config.tokenPlan = {};
      if (tokenPlanApiKey) config.tokenPlan.apiKey = tokenPlanApiKey;
      if (tokenPlanEndpoint) config.tokenPlan.endpoint = tokenPlanEndpoint;
      if (typeof tokenPlanTimeout === 'number') config.tokenPlan.timeout = tokenPlanTimeout;
    }

    // ★ v2.2.0（F17）：dualMode 为派生视图——写操作重定向到拓扑
    regenerateFlows();
    const { saveConfig } = require('./config');
    saveConfig();

    logInfo('server', `双审配置已更新: dualMode=${config.moderation.dualMode}, cloud=${config.qwenCloud?.enabled}, billingSource=${config.qwenCloud?.billingSource}, model=${config.qwenCloud?.model}`);

    res.json({
      success: true,
      dualMode: config.moderation.dualMode,
      qwenCloud: {
        enabled: config.qwenCloud?.enabled || false,
        billingSource: config.qwenCloud?.billingSource || 'dashscope',
        visionEnabled: config.qwenCloud?.visionEnabled || false,
        model: config.qwenCloud?.model || 'qwen-plus',
        visionModel: config.qwenCloud?.visionModel || 'qwen3.7-plus',
        hasApiKey: !!(config.qwenCloud?.apiKey || process.env.DASHSCOPE_API_KEY),
      },
      tokenPlan: {
        endpoint: config.tokenPlan?.endpoint || '',
        hasApiKey: !!(config.tokenPlan?.apiKey),
      },
    });
  } catch (err) {
    res.status(500).json({ error: '更新双审配置失败', message: err.message });
  }
});

// ─── 阿里云内容安全状态（不返回 AccessKey）───
app.get('/api/content-safety/status', (req, res) => {
  res.json(getContentSafetyStatus());
});

// ─── 三审通道配置（v2.2.0：派生视图，读从拓扑反算，写重定向到拓扑）───
app.get('/api/review-channels', (req, res) => {
  res.json({
    ...(config.moderation.reviewChannels || { local: true, cloud: true, contentSafety: false, disputeStrategy: 'highest' }),
    contentSafetyStatus: getContentSafetyStatus(),
    // 拓扑派生摘要（供画布与旧面板同步显示）
    flows: describeFlows(),
  });
});

/**
 * 从拓扑反算旧的通道开关（派生视图，供 GET /api/review-channels 展示）。
 * @returns {object} 反算结果
 */
function describeFlows() {
  const out = {};
  for (const modality of ['text', 'image']) {
    const flow = flowModule.getFlow(config, modality);
    if (!flow) { out[modality] = { present: false }; continue; }
    const path = new Set();
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    const inputId = (nodes.find((n) => n && n.type === 'input') || {}).id;
    const outputId = (nodes.find((n) => n && n.type === 'output') || {}).id;
    const adj = new Map(); const radj = new Map();
    for (const n of nodes) if (n && n.id) { adj.set(n.id, []); radj.set(n.id, []); }
    for (const e of edges) if (adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).push(e.to); radj.get(e.to).push(e.from); }
    const walk = (start, g) => { const s = new Set(); const st = start ? [start] : []; while (st.length) { const id = st.pop(); if (s.has(id)) continue; s.add(id); for (const x of g.get(id) || []) st.push(x); } return s; };
    const fwd = walk(inputId, adj); const back = walk(outputId, radj);
    for (const id of fwd) if (back.has(id)) path.add(id);
    const connected = nodes.filter((n) => n && path.has(n.id)).map((n) => n.ref);
    const merge = nodes.find((n) => n && path.has(n.id) && n.type === 'merge');
    out[modality] = {
      present: true,
      revision: flow.revision,
      local: connected.includes('builtin.localModel'),
      cloud: connected.includes('builtin.cloudModel'),
      contentSafety: (flow.floors || []).some((f) => f.ref === 'builtin.contentSafety' && f.enabled !== false),
      strategy: merge ? merge.strategy : 'single',
      finalizers: (flow.finalizers || []).map((f) => f.ref),
    };
  }
  return out;
}

app.put('/api/review-channels', requireAdminPassword, (req, res) => {
  try {
    const { local, cloud, contentSafety, disputeStrategy } = req.body;
    if (!config.moderation.reviewChannels) config.moderation.reviewChannels = {};
    if (typeof local === 'boolean') config.moderation.reviewChannels.local = local;
    if (typeof cloud === 'boolean') config.moderation.reviewChannels.cloud = cloud;
    if (typeof contentSafety === 'boolean') config.moderation.reviewChannels.contentSafety = contentSafety;
    const validStrategies = ['highest', 'local', 'cloud', 'contentSafety', 'majority'];
    if (validStrategies.includes(disputeStrategy)) config.moderation.reviewChannels.disputeStrategy = disputeStrategy;
    // ★ v2.2.0（F17）：旧开关为派生视图——写操作重定向到拓扑，由拓扑重新生成
    regenerateFlows();
    const { saveConfig } = require('./config');
    saveConfig();
    logInfo('server', `三审通道已更新并重建拓扑: local=${config.moderation.reviewChannels.local}, cloud=${config.moderation.reviewChannels.cloud}, safety=${config.moderation.reviewChannels.contentSafety}, dispute=${config.moderation.reviewChannels.disputeStrategy}`);
    res.json({ success: true, ...config.moderation.reviewChannels });
  } catch (err) {
    res.status(500).json({ error: '更新三审配置失败', message: err.message });
  }
});

// ─── 阿里云内容安全配置（读写，需要管理员密码）───
app.get('/api/content-safety/config', (req, res) => {
  const s = (req, res) => {
    const cs = config.contentSafety || {};
    const maskKey = (v) => v && v.length > 8 ? v.substring(0, 4) + '****' + v.substring(v.length - 4) : v ? '****' : '';
    // 兼容旧配置：textService (单值) → textServices (数组)
    let textServices = [];
    if (Array.isArray(cs.textServices) && cs.textServices.length > 0) {
      textServices = cs.textServices.filter(Boolean);
    } else if (cs.textService) {
      textServices = [cs.textService];
    }
    res.json({
      enabled: cs.enabled || false,
      textEnabled: cs.textEnabled !== false,
      imageEnabled: cs.imageEnabled !== false,
      region: cs.region || 'cn-shanghai',
      endpoint: cs.endpoint || 'green-cip.cn-shanghai.aliyuncs.com',
      textServices,
      imageService: cs.imageService || 'query_security_check',
      timeout: cs.timeout && !isNaN(Number(cs.timeout)) ? Number(cs.timeout) : 10000,
      hasAccessKeyId: !!(cs.accessKeyId),
      maskedAccessKeyId: maskKey(cs.accessKeyId),
      hasAccessKeySecret: !!(cs.accessKeySecret),
      maskedAccessKeySecret: maskKey(cs.accessKeySecret),
      status: getContentSafetyStatus(),
    });
  };
  if (isLocalRequest(req)) { s(req, res); } else {
    const clientIp = getClientIp(req);
    const token = req.headers['x-session-token'] || req.query.token || '';
    if (isValidSessionToken(token, clientIp)) return s(req, res);
    return res.status(403).json({ error: '公网查看内容安全配置需要先验证管理员密码' });
  }
});

app.put('/api/content-safety/config', requireAdminPassword, (req, res) => {
  try {
    if (!config.contentSafety) config.contentSafety = {};
    const cs = config.contentSafety;
    const { enabled, textEnabled, imageEnabled, accessKeyId, accessKeySecret, region, endpoint, textServices, textService, imageService, timeout } = req.body;
    if (typeof enabled === 'boolean') cs.enabled = enabled;
    if (typeof textEnabled === 'boolean') cs.textEnabled = textEnabled;
    if (typeof imageEnabled === 'boolean') cs.imageEnabled = imageEnabled;
    if (accessKeyId) cs.accessKeyId = accessKeyId;
    if (accessKeySecret) cs.accessKeySecret = accessKeySecret;
    if (region) cs.region = region;
    if (endpoint) cs.endpoint = endpoint;
    if (Array.isArray(textServices) && textServices.length > 0) {
      cs.textServices = textServices.filter(s => typeof s === 'string' && s.trim());
    } else if (textService) {
      cs.textServices = [textService];
    }
    if (imageService) cs.imageService = imageService;
    if (typeof timeout === 'number' && !isNaN(timeout)) cs.timeout = timeout;
    const { saveConfig } = require('./config');
    saveConfig();
    logInfo('server', '阿里云内容安全配置已更新');
    res.json({ success: true, status: getContentSafetyStatus() });
  } catch (err) {
    res.status(500).json({ error: '更新内容安全配置失败', message: err.message });
  }
});

// 云端审核状态检查
app.get('/api/cloud/status', async (req, res) => {
  const cloudConfig = config.qwenCloud || {};
  const model = cloudConfig.model || 'qwen-plus';
  const isDeepSeek = model.toLowerCase().includes('deepseek');
  const hasApiKey = !!(cloudConfig.apiKey || process.env.DASHSCOPE_API_KEY);

  if (!hasApiKey) {
    return res.json({ ok: false, model, error: '当前模型的 API Key 未配置', enabled: cloudConfig.enabled || false });
  }

  try {
    const status = await healthCheckCloud();
    res.json({
      ...status,
      enabled: cloudConfig.enabled || false,
      model: cloudConfig.model || 'qwen-plus',
    });
  } catch (err) {
    res.json({ ok: false, error: err.message, enabled: cloudConfig.enabled || false });
  }
});

app.get('/api/worddb/full', (req, res) => {
  try {
    const { wordDb } = loadWordDb();
    res.json(wordDb);
  } catch (err) {
    res.status(500).json({ error: '读取词库失败', message: err.message });
  }
});

app.post('/api/worddb/save', requireWordDbPassword, (req, res) => {
  try {
    const newDb = req.body;
    if (!newDb || !newDb.categories) {
      return res.status(400).json({ error: '无效的词库格式' });
    }
    const { wordDb } = saveWordDb(newDb);
    const categories = wordDb.categories || {};
    const stats = {};
    let total = 0;
    for (const [catId, cat] of Object.entries(categories)) {
      const count = (cat.words || []).length;
      stats[catId] = { count, level: cat.level };
      total += count;
    }
    logInfo('server', `词库已保存: ${total} 个词, 热重载完成`);
    res.json({ success: true, total, categories: stats });
  } catch (err) {
    logError('server', `词库保存失败: ${err.message}`);
    res.status(500).json({ error: '词库保存失败', message: err.message });
  }
});

app.post('/api/worddb/add-word', requireWordDbPassword, (req, res) => {
  try {
    const { category, word } = req.body;
    if (!category || !word) {
      return res.status(400).json({ error: '缺少 category 或 word 参数' });
    }
    const { wordDb } = loadWordDb();
    if (!wordDb.categories[category]) {
      return res.status(404).json({ error: `分类 ${category} 不存在` });
    }
    if (!wordDb.categories[category].words) {
      wordDb.categories[category].words = [];
    }
    const trimmed = word.trim();
    if (wordDb.categories[category].words.includes(trimmed)) {
      return res.json({ success: true, message: '词条已存在', duplicate: true });
    }
    wordDb.categories[category].words.push(trimmed);
    const result = saveWordDb(wordDb);
    logInfo('server', `词库添加: [${category}] "${trimmed}"`);
    res.json({ success: true, total: result.wordDb.categories[category].words.length });
  } catch (err) {
    res.status(500).json({ error: '添加词条失败', message: err.message });
  }
});

app.post('/api/worddb/remove-word', requireWordDbPassword, (req, res) => {
  try {
    const { category, word } = req.body;
    if (!category || !word) {
      return res.status(400).json({ error: '缺少 category 或 word 参数' });
    }
    const { wordDb } = loadWordDb();
    if (!wordDb.categories[category]) {
      return res.status(404).json({ error: `分类 ${category} 不存在` });
    }
    wordDb.categories[category].words = (wordDb.categories[category].words || [])
      .filter(w => w !== word.trim());
    const result = saveWordDb(wordDb);
    logInfo('server', `词库删除: [${category}] "${word.trim()}"`);
    res.json({ success: true, total: result.wordDb.categories[category].words.length });
  } catch (err) {
    res.status(500).json({ error: '删除词条失败', message: err.message });
  }
});

app.post('/api/worddb/update-mappings', requireWordDbPassword, (req, res) => {
  try {
    const { type, mappings } = req.body;
    // type: 'fuzzy_chars' | 'split_chars' | 'number_map'
    if (!type || !mappings) {
      return res.status(400).json({ error: '缺少 type 或 mappings 参数' });
    }
    const { wordDb } = loadWordDb();
    if (!wordDb[type]) {
      return res.status(404).json({ error: `映射类型 ${type} 不存在` });
    }
    wordDb[type].mappings = mappings;
    saveWordDb(wordDb);
    logInfo('server', `映射表已更新: ${type}, ${Object.keys(mappings).length} 条`);
    res.json({ success: true, count: Object.keys(mappings).length });
  } catch (err) {
    res.status(500).json({ error: '更新映射失败', message: err.message });
  }
});

// ─── 显存占用和文本长度上限信息 ───
app.get('/api/vram-info', (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    return res.status(400).json({ error: 'cloud-only 模式不支持本地显存管理' });
  }
  const numCtx = config.ollama.options.num_ctx || 4096;
  const numPredict = config.ollama.options.num_predict || 512;

  // 审核 keep_alive 标签（0 表示立即释放，字符串如 "2m" 表示空闲保留时长）
  const modKeep = config.ollama.moderationKeepAlive;
  const moderationKeepAliveLabel = (modKeep === 0 || modKeep === '0')
    ? '0 (审核完立即释放)'
    : `${modKeep} (空闲后自动卸载，覆盖突发流量)`;

  // Qwen3-14B Q4_K_M 显存估算
  // 模型权重: ~8.2 GB (Q4_K_M 量化)
  // KV Cache: 每层 = num_ctx * 2(K&V) * num_kv_heads * head_dim * bytes_per_element
  // Qwen3-14B: 40层, head_dim=128, num_kv_heads=8 (GQA)
  // q8_0 量化: 1 byte/element (vs fp16 的 2 bytes/element, 省一半)
  const modelWeightGB = 8.2; // Q4_K_M 实测值
  const layers = 40;
  const kvHeads = 8;
  const headDim = 128;
  const kvQuant = config.ollama.options.cache_type_k || 'f16';
  const bytesPerElement = kvQuant.startsWith('q8') ? 1 : (kvQuant.startsWith('q4') ? 0.5 : 2); // q8_0=1B, q4_0=0.5B, f16=2B
  const kvCacheBytes = numCtx * 2 * kvHeads * headDim * bytesPerElement * layers;
  const kvCacheGB = kvCacheBytes / (1024 ** 3);

  const totalEstimateGB = modelWeightGB + kvCacheGB;

  // 文本长度上限估算
  // 中文约 1.5 token/字，英文约 0.25 token/词
  // 可用 token = num_ctx - system_prompt_tokens - num_predict
  // system prompt 约 800 tokens
  const systemPromptTokens = 800;
  const availableTokens = numCtx - systemPromptTokens - numPredict;
  const maxChineseChars = Math.floor(availableTokens / 1.5);
  const maxEnglishWords = Math.floor(availableTokens / 0.25);

  res.json({
    model: config.ollama.textModel,
    quantization: 'Q4_K_M',
    gpu: 'RTX 4070 Ti Super (16GB VRAM)',
    config: {
      num_ctx: numCtx,
      num_predict: numPredict,
      moderation_keep_alive: moderationKeepAliveLabel,
    },
    vram_estimate: {
      model_weight_gb: modelWeightGB.toFixed(2),
      kv_cache_gb: kvCacheGB.toFixed(2),
      total_estimate_gb: totalEstimateGB.toFixed(2),
      gpu_vram_gb: 16,
      headroom_gb: (16 - totalEstimateGB).toFixed(2),
      note: `估算值，实际占用取决于 Ollama 实现。KV Cache 为 ${kvQuant} 计算。`,
    },
    text_limits: {
      available_tokens: availableTokens,
      max_chinese_chars: maxChineseChars,
      max_english_words: maxEnglishWords,
      note: '中文约1.5 token/字，英文约0.25 token/词。已扣除 system prompt 和生成回复的 token。',
      formula: `可用token = num_ctx(${numCtx}) - system_prompt(${systemPromptTokens}) - num_predict(${numPredict}) = ${availableTokens}`,
    },
    keep_alive_strategy: {
      '审核调用': `keep_alive=${modKeep === 0 ? '0 (用完即卸)' : modKeep} — 审核后保留${modKeep === 0 ? '0' : modKeep}，覆盖突发流量，空闲后自动卸载`,
      '说明': `审核 keep_alive=${modKeep}：审核后短时保留避免频繁装卸，空闲后自动释放。切换审核模型时 Ollama 自动卸载旧模型。`,
    },
  });
});

// ─── 系统实时监控（CPU/GPU/内存/显存）───
app.get('/api/system-stats', async (req, res) => {
  if (config.moderationMode === 'cloud-only') {
    // cloud-only 模式无本地硬件监控，返回 200 + 标志，前端静默跳过（避免控制台 400 刷屏）
    return res.json({ available: false, cloudOnly: true, message: 'cloud-only 模式不支持本地硬件监控' });
  }
  try {
    const stats = await getSystemStats(config.ollama.host, config.ollama.textModel);
    res.json(stats);
  } catch (err) {
    logError('server', `系统监控接口错误: ${err.message}`);
    res.status(500).json({ error: '获取系统状态失败', message: err.message });
  }
});

// ─── 模型对比审核 ───

// 列出所有对比结果
app.get('/api/comparisons', (req, res) => {
  const list = listComparisons();
  res.json({ total: list.length, comparisons: list });
});

// 获取调度器状态
app.get('/api/comparisons/status', (req, res) => {
  res.json({
    scheduler: getSchedulerStatus(),
    comparison: getComparisonStatus(),
  });
});

// 设置对比审核开关（自定义是否每日自动运行）
app.put('/api/comparisons/toggle', requireAdminPassword, (req, res) => {
  const enabled = req.body.enabled === true;
  try {
    const result = setComparisonEnabled(enabled);
    res.json({ success: true, enabled: result });
  } catch (err) {
    logError('server', `切换对比审核开关失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 获取最新对比结果
app.get('/api/comparisons/latest', (req, res) => {
  const list = listComparisons();
  if (list.length === 0) {
    return res.status(404).json({ error: '暂无对比结果' });
  }
  const latest = list[0];
  const result = getComparisonResult(latest.date);
  res.json(result);
});

// 获取指定日期的对比结果
app.get('/api/comparisons/:date', (req, res) => {
  const { date } = req.params;
  const result = getComparisonResult(date);
  if (!result) {
    return res.status(404).json({ error: `未找到 ${date} 的对比结果` });
  }
  res.json(result);
});

// 手动触发对比审核
app.post('/api/comparisons/run', async (req, res) => {
  const { date } = req.body;
  try {
    logInfo('server', `手动触发对比审核${date ? ` (日期: ${date})` : ''}`);
    const result = await triggerManual(date);
    res.json({ success: true, summary: result.summary, date: result.date });
  } catch (err) {
    logError('server', `手动对比审核失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── 批量图片扫描 ───
// ★ 双轨兼容（6 个月）：batch-image-suite 插件就绪时优先转发到插件，
//   插件未启用/未就绪时回退内置 src/batch-scan.js，旧接口响应结构不变（R-A07 / R-A22）。
const BATCH_PLUGIN_ID = 'batch-image-suite';

/**
 * 尝试通过插件执行批量操作。
 * @param {string} method RPC 方法名
 * @param {object} params 参数
 * @returns {Promise<any|null>} 插件返回的结果，插件不可用返回 null
 */
async function batchViaPlugin(method, params) {
  try {
    if (pluginHost.getPhase() !== 'ready') return null;
    if (!pluginHost.isPluginOnline(BATCH_PLUGIN_ID)) return null;
    const out = await pluginHost.dispatchRpc(BATCH_PLUGIN_ID, method, params);
    return out.ok ? out.result : null;
  } catch {
    return null;
  }
}

// 启动批量扫描（公网需密码）
app.post('/api/batch/scan', requireAdminPassword, async (req, res) => {
  const { folderPath, recursive, strictness } = req.body;
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: '缺少文件夹路径' });
  }
  const viaPlugin = await batchViaPlugin('batch.scan', { folderPath, recursive: recursive !== false, strictness });
  if (viaPlugin && viaPlugin.task) {
    logInfo('server', `批量扫描任务已启动（插件）: ${viaPlugin.task.id}`);
    return res.json({ success: true, task: viaPlugin.task, via: 'plugin' });
  }
  try {
    const task = startBatchScan({ folderPath, recursive: recursive !== false, strictness });
    logInfo('server', `批量扫描任务已启动: ${task.id} (${task.folderPath}, strictness=${task.strictness})`);
    res.json({ success: true, task, via: 'builtin' });
  } catch (err) {
    logError('server', `启动批量扫描失败: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// 任务进度（含最近 5 条结果，供前端轮询）
app.get('/api/batch/status/:taskId', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.status', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const status = getTaskStatus(req.params.taskId);
  if (!status) return res.status(404).json({ error: '任务不存在' });
  res.json(status);
});

// 任务完整结果
app.get('/api/batch/results/:taskId', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.results', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const result = getTaskResults(req.params.taskId);
  if (!result) return res.status(404).json({ error: '任务不存在' });
  res.json(result);
});

// 停止任务（公网需密码）
app.post('/api/batch/stop/:taskId', requireAdminPassword, async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.stop', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const ok = stopTask(req.params.taskId);
  res.json({ success: ok });
});

// 任务列表（活跃 + 历史）
app.get('/api/batch/tasks', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.tasks', {});
  if (viaPlugin) return res.json(viaPlugin);
  res.json({ tasks: listTasks() });
});

// 删除单个扫描任务（公网需密码）
app.delete('/api/batch/task/:taskId', requireAdminPassword, async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.deleteTask', { taskId: req.params.taskId });
  if (viaPlugin) return res.json(viaPlugin);
  const ok = deleteTask(req.params.taskId);
  res.json({ success: ok, deleted: ok ? 1 : 0 });
});

// 清空全部扫描任务（公网需密码）
app.delete('/api/batch/tasks', requireAdminPassword, async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.clearTasks', {});
  if (viaPlugin) return res.json(viaPlugin);
  const count = clearAllTasks();
  res.json({ success: true, deleted: count });
});

// 导出 CSV
app.get('/api/batch/export/:taskId', (req, res) => {
  const csv = exportCsv(req.params.taskId);
  if (!csv) return res.status(404).json({ error: '任务不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="batch-scan-${req.params.taskId}.csv"`);
  res.send(csv);
});

// 按审核结果分类导出（写操作，公网需密码）
// body: { targetDir: string, levels?: string[], mode?: 'copy'|'move', keepFolders?: boolean }
app.post('/api/batch/export-category/:taskId', requireAdminPassword, async (req, res) => {
  try {
    const { targetDir, levels, mode, keepFolders } = req.body || {};
    if (!targetDir || typeof targetDir !== 'string') {
      return res.status(400).json({ error: '缺少 targetDir 参数' });
    }
    const viaPlugin = await batchViaPlugin('batch.exportCategory', {
      taskId: req.params.taskId, targetDir, levels, mode, keepFolders: !!keepFolders,
    });
    if (viaPlugin) return res.json(viaPlugin);
    const { jobId, total } = startExportByCategory(req.params.taskId, targetDir, { levels, mode, keepFolders: !!keepFolders });
    logInfo('server', `分类导出任务已启动: ${jobId}（源任务 ${req.params.taskId}，${total} 张，${mode || 'copy'}${keepFolders ? '，保留子文件夹' : ''}）`);
    res.json({ success: true, jobId, total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 分类导出进度查询
app.get('/api/batch/export-status/:jobId', async (req, res) => {
  const viaPlugin = await batchViaPlugin('batch.exportStatus', { jobId: req.params.jobId });
  if (viaPlugin) return res.json(viaPlugin);
  const job = getExportStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  res.json(job);
});

// 查看扫描结果中的原图（仅限任务结果里记录过的文件，防任意路径读取）
app.get('/api/batch/image/:taskId/:index', (req, res) => {
  const img = getTaskImage(req.params.taskId, req.params.index);
  if (!img) return res.status(404).json({ error: '图片不存在或已被移动/删除' });
  res.setHeader('Content-Type', img.contentType);
  res.sendFile(img.filePath);
});

// 查看扫描结果的缩略图（画廊用，避免加载 4K 原图导致卡顿）
// 带 LRU 内存缓存：同一任务+索引只解码一次
const thumbCache = new Map();
const THUMB_CACHE_MAX = 800;
app.get('/api/batch/thumb/:taskId/:index', async (req, res) => {
  const cacheKey = `${req.params.taskId}:${req.params.index}`;
  const hit = thumbCache.get(cacheKey);
  if (hit) {
    res.setHeader('Content-Type', hit.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(hit.buffer);
  }
  const thumb = await getTaskThumb(req.params.taskId, req.params.index);
  if (!thumb) return res.status(404).json({ error: '缩略图不可用' });
  // 简单 LRU：超出上限清最旧一半
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    const keys = [...thumbCache.keys()].slice(0, Math.floor(THUMB_CACHE_MAX / 2));
    for (const k of keys) thumbCache.delete(k);
  }
  thumbCache.set(cacheKey, thumb);
  res.setHeader('Content-Type', thumb.contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(thumb.buffer);
});

// ═══════════════════════════════════════════
// v2.2.0 审核流程（DAG 编排）API
// ═══════════════════════════════════════════

/** 能力/节点注册表快照（画布面板的唯一数据源）。 */
app.get('/api/flow/capabilities', async (req, res) => {
  const modality = req.query.modality && ['text', 'image'].includes(req.query.modality) ? req.query.modality : undefined;
  // 拉取前刷新一次插件就绪度（依据 manifest.readinessRpc），保证 ready/notReadyReason 实时
  try {
    const scanner = getScanner();
    if (scanner && typeof scanner.refreshAllReadiness === 'function') await scanner.refreshAllReadiness();
  } catch { /* 探测失败不影响快照返回 */ }
  res.json(flowModule.snapshot(modality));
});

/** 从旧开关重新生成拓扑（写重定向用）。 */
function regenerateFlows() {
  if (!config.moderation.flows) config.moderation.flows = { enabled: true };
  delete config.moderation.flows.text;
  delete config.moderation.flows.image;
  return flowMigrate.ensureFlows(config);
}

/** 校验并保存某模态流程。 */
app.put('/api/flow/:modality', requireAdminPassword, (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) {
    return res.status(400).json({ ok: false, errors: [{ code: 'E001_SCHEMA', message: 'modality 必须为 text|image' }] });
  }
  const flow = req.body && req.body.flow ? req.body.flow : req.body;
  const validation = flowModule.validateFlow(flow, flowModule.registry);
  if (!validation.ok) {
    // ★ 服务端是最终权威：有 error 则一行都不写
    return res.status(400).json({ ok: false, errors: validation.errors, warnings: validation.warnings });
  }
  if (!config.moderation.flows) config.moderation.flows = { enabled: true };
  const baseRevision = Number(req.body && req.body.baseRevision);
  const current = config.moderation.flows[modality];
  if (Number.isFinite(baseRevision) && current && Number.isFinite(current.revision) && baseRevision !== current.revision) {
    return res.status(409).json({ ok: false, error: '配置已被其他地方修改', currentRevision: current.revision });
  }
  const saved = { ...flow, modality, revision: (current && Number.isFinite(current.revision) ? current.revision : 0) + 1, updatedAt: new Date().toISOString(), meta: { note: '', sourceOfTruth: true } };
  config.moderation.flows[modality] = saved;
  const { saveConfig } = require('./config');
  saveConfig();
  logInfo('server', `审核流程(${modality})已保存 revision=${saved.revision}`);
  res.json({ ok: true, revision: saved.revision, warnings: validation.warnings });
});

/** 只校验不保存（前端即时提示，防抖调用）。 */
app.post('/api/flow/:modality/validate', (req, res) => {
  const flow = req.body && req.body.flow ? req.body.flow : req.body;
  const validation = flowModule.validateFlow(flow, flowModule.registry);
  res.json({ ok: validation.ok, errors: validation.errors, warnings: validation.warnings });
});

/** 读取某模态流程 + 校验结果。 */
app.get('/api/flow/:modality', (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) return res.status(400).json({ error: 'modality 必须为 text|image' });
  const flow = flowModule.getFlow(config, modality);
  if (!flow) return res.status(404).json({ error: `尚未生成 ${modality} 流程` });
  const validation = flowModule.validateFlow(flow, flowModule.registry);
  res.json({ ok: true, flow, errors: validation.errors, warnings: validation.warnings, enabled: flowModule.isEnabled(config) });
});

/** 试运行（dry-run）：用样例内容实跑，返回逐节点 trace（不落审计）。 */
app.post('/api/flow/:modality/dry-run', requireAdminPassword, async (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) return res.status(400).json({ error: 'modality 必须为 text|image' });
  const selected = flowModule.getValidFlow(config, modality);
  if (!selected.flow) {
    return res.status(400).json({ ok: false, error: '流程不合法，无法试运行', errors: selected.validation.errors });
  }
  const sample = (req.body && req.body.sample) || {};
  try {
    const result = modality === 'text'
      ? await moderateText(String(sample.text || ''), { skipAudit: true, dryRun: true }, {})
      : await moderateImage(String(sample.imageBase64 || ''), String(sample.caption || ''), { skipAudit: true, dryRun: true });
    res.json({ ok: true, verdict: result, node_traces: result.node_traces || [] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** 重置为默认拓扑（由旧开关重新迁移生成）。 */
app.post('/api/flow/:modality/reset', requireAdminPassword, (req, res) => {
  const modality = req.params.modality;
  if (!['text', 'image'].includes(modality)) return res.status(400).json({ error: 'modality 必须为 text|image' });
  try {
    regenerateFlows();
    const flow = flowModule.getFlow(config, modality);
    if (flow && !flowModule.isEnabled(config)) config.moderation.flows.enabled = true;
    const { saveConfig } = require('./config');
    saveConfig();
    res.json({ ok: true, flow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 复制拓扑（文本 → 图像，自动剔除模态不匹配节点）。 */
app.post('/api/flow/copy', requireAdminPassword, (req, res) => {
  const from = req.body && req.body.from;
  const to = req.body && req.body.to;
  if (!['text', 'image'].includes(from) || !['text', 'image'].includes(to)) {
    return res.status(400).json({ error: 'from/to 必须为 text|image' });
  }
  const src = flowModule.getFlow(config, from);
  if (!src) return res.status(404).json({ error: `源流程 ${from} 不存在` });
  const flowModuleRef = flowModule.registry;
  const nodes = (src.nodes || []).filter((n) => {
    if (!['service', 'contribute'].includes(n.type)) return true;
    const d = flowModuleRef.get(n.ref);
    return d ? d.modality.includes(to) : false;
  });
  const kept = new Set(nodes.map((n) => n.id));
  const edges = (src.edges || []).filter((e) => kept.has(e.from) && kept.has(e.to));
  const floors = (src.floors || []).filter((f) => {
    const d = flowModuleRef.get(f.ref);
    return !d || d.modality.includes(to);
  });
  res.json({ ok: true, flow: { ...src, modality: to, nodes, edges, floors, finalizers: to === 'image' ? (src.finalizers || []) : [] } });
});

// ─── Express 全局错误处理中间件（兜底：任何路由内抛出的异常都走这里，不崩服务） ───
app.use((err, req, res, next) => {
  // body 解析失败（如 JSON 格式错误）返回 400 而非崩溃
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: `请求体无效: ${err.message}` });
  }
  logError('server', `请求处理异常 ${req.method} ${req.path}: ${err.message}`, err.stack);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

// ─── 插件路由代理（★ 必须注册在 404 兜底之前） ───
// /api/p/:pid/*、/api/plugin-views、/api/plugins/host/status 常驻注册，listen 前即存在，
// 未就绪时返回 503 / {status:'booting'}，就绪后按注册表运行时分发（R-A03 / R-A04）。
pluginRuntime.registerRoutes(app, { requireAdmin: requireAdminPassword });

// 404 兜底（未匹配路由）
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: '接口不存在' });
  } else {
    res.status(404).send('Not Found');
  }
});

// ─── 启动服务 ───
const PORT = config.server.port;
const HOST = config.server.host;

// ─── 配置致命冲突闸门（架构 §4.1，resolution='block' 的组合拒绝启动）───
if (isStartupBlocked()) {
  for (const conflict of getConflicts().filter((c) => c.resolution === 'block')) {
    logError('server', `[config-block] [${conflict.id}] ${conflict.message} → ${conflict.fix}`);
  }
  logError('server', '存在致命配置冲突，已拒绝启动；修正 config/default.json 后重试');
  process.exit(1);
}

app.listen(PORT, HOST, async () => {
  const { logStartup } = require('./logger');
  
  const caps = getCapabilities();
  logStartup({
    url: `http://${HOST}:${PORT}`,
    mode: config.moderationMode === 'cloud-only' ? '云端轻量' : '本地完整',
    localModel: caps.local.available ? config.ollama.textModel : null,
    cloudModel: caps.cloud.available ? config.qwenCloud.model : null,
    contentSafety: caps.contentSafety.available,
    dualMode: config.moderation.dualMode,
  });

  // 可选能力未配置时给出一次性明确提示（而不是运行时反复报错）
  for (const [name, label] of [['local', '本地模型'], ['cloud', '云端大模型'], ['contentSafety', '内容安全']]) {
    if (!caps[name].available) {
      logWarn('server', `${label}通道未配置，已跳过 (${caps[name].reason})`);
    }
  }
  if (!caps.local.available && !caps.cloud.available && !caps.contentSafety.available) {
    logWarn('server', '当前无任何 AI 审核通道可用，服务以「敏感词预检」模式运行；配置任一通道后自动生效');
  }
  
  logInfo('server', 'API 文档:');
  logInfo('server', '  POST /api/moderate/text   - 文本审核');
  logInfo('server', '  POST /api/moderate/image  - 图片审核');
  logInfo('server', '  POST /api/moderate        - 综合审核（文本+图片）');
  logInfo('server', '  GET  /health              - 健康检查');
  logInfo('server', '  GET  /api/logs            - 查看审核日志');
  logInfo('server', '  GET  /api/categories      - 审核分类说明');
  logInfo('server', '  GET  /api/comparisons     - 模型对比结果');
  logInfo('server', '  GET  /api/dual-mode       - 双审模式状态');
  logInfo('server', '  GET  /api/content-safety/status - 阿里云内容安全状态');
  logInfo('server', '  PUT  /api/dual-mode       - 更新双审配置（公网需密码）');
  logInfo('server', '  POST /api/admin/verify-password - 验证管理员密码（返回会话 Token）');

  // 初始化定时对比审核调度器（每日凌晨3点）
  initScheduler();

  // 初始化插件系统（cordis 桥接 + 扫描 manifest + 装载已启用插件）
  // ★ 改为 await：插件抛异常不阻断主链路（内部已 try/catch），但必须等它 ready
  //   才能执行依赖插件的孤儿任务续扫与自动扫描（R-A04）。
  try {
    let sharp = null;
    try { sharp = require('sharp'); } catch { sharp = null; }
    await pluginRuntime.init({
      app,
      config,
      sharp,
      moderator: { moderateText, moderateImage, moderateImageLocal, moderate, healthCheck },
      vision: {
        chat: (model, systemPrompt, userContent, images = [], host = null) =>
          chatRaw(model, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent, images },
          ], host),
      },
    });
  } catch (err) {
    logError('server', `插件系统初始化失败（主审核链路不受影响）: ${err.message}`);
  }

  // ─── 崩溃恢复：续扫孤儿任务 + 自动扫描目录（必须在插件就绪之后） ───
  const batchCfg = config.batch || {};
  if (batchCfg.autoResume !== false) {
    const resumed = resumeOrphanedTasks();
    if (resumed > 0) {
      logInfo('server', `已恢复 ${resumed} 个未完成的扫描任务，自动续扫`);
    }
    // 若配置了自动扫描目录，且该目录没有进行中的任务，则自动启动扫描（含续扫）
    if (batchCfg.autoScanFolder) {
      const folder = batchCfg.autoScanFolder;
      const alreadyScanning = listTasks().some((t) =>
        t.folderPath === folder && (t.status === 'running' || t.status === 'scanning')
      );
      if (!alreadyScanning) {
        try {
          const task = startBatchScan({ folderPath: folder, recursive: true, strictness: batchCfg.autoScanStrictness || 'standard' });
          logInfo('server', `已自动启动扫描任务 ${task.id}: ${folder}（已完成部分将自动跳过）`);
        } catch (err) {
          logError('server', `自动扫描目录启动失败: ${err.message}`);
        }
      } else {
        logInfo('server', `目录已在扫描中，跳过自动启动: ${folder}`);
      }
    }
  }
});
