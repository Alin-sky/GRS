const crypto = require('crypto');
const GreenClient = require('@alicloud/green20220302').default;
const models = require('@alicloud/green20220302/dist/models/model');
const { loadConfig, isValueSet } = require('./config');
const { logError, logInfo } = require('./logger');

const config = loadConfig();
let cachedClient = null;
let cachedClientKey = '';

// ─── 文本审核结果缓存（降本核心） ───
// 绿网文本审核按次计费，同一文本在短时间（QQ 复读/口令/广告、每日对比审核重放）内会重复调用。
// 对文本做 MD5 去重，24h 内相同内容直接复用上次结果，把「实时 2 服务 + 对比审核 2 服务」的重复计费压到 1 次。
const textCache = new Map(); // md5 -> { result, ts }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const CACHE_MAX = 20000; // LRU 上限，避免内存无限膨胀

function textMd5(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

function cacheGet(key) {
  const entry = textCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    textCache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(key, result) {
  if (textCache.size >= CACHE_MAX) {
    // 逐出最旧的一项（Map 迭代顺序即插入顺序）
    const oldestKey = textCache.keys().next().value;
    if (oldestKey !== undefined) textCache.delete(oldestKey);
  }
  textCache.set(key, { result, ts: Date.now() });
}

function clearTextCache() {
  const n = textCache.size;
  textCache.clear();
  return n;
}

const CATEGORY_MAP = {
  politics: 'political',
  political: 'political',
  porn: 'pornographic',
  pornography: 'pornographic',
  sexy: 'pornographic',
  ad: 'marketing',
  advertisement: 'marketing',
  spam: 'marketing',
  marketing: 'marketing',
  terrorism: 'violence',
  violent: 'violence',
  violence: 'violence',
  abuse: 'abuse',
  insult: 'abuse',
  harassment: 'abuse',
  contraband: 'illegal',
  illegal: 'illegal',
  gambling: 'gambling',
  fraud: 'gambling',
  privacy: 'privacy',
  personal: 'privacy',
  disgusting: 'grotesque',
  grotesque: 'grotesque',
};

function getSafetyConfig() {
  return config.contentSafety || {};
}

function isConfigured() {
  const safety = getSafetyConfig();
  // 占位符形态的 Key（如 YOUR_ALIBABA_CLOUD_ACCESS_KEY_ID）视为未配置：
  // 否则每次审核都会真打阿里云接口并返回 InvalidAccessKeyId，形成刷屏报错。
  return Boolean(safety.enabled && isValueSet(safety.accessKeyId) && isValueSet(safety.accessKeySecret));
}

function getStatus() {
  const safety = getSafetyConfig();
  const configured = Boolean(isValueSet(safety.accessKeyId) && isValueSet(safety.accessKeySecret));
  
  // 兼容旧配置：textService (单值) → textServices (数组)
  let textServices = [];
  if (Array.isArray(safety.textServices) && safety.textServices.length > 0) {
    textServices = safety.textServices.filter(Boolean);
  } else if (safety.textService) {
    textServices = [safety.textService];
  }
  
  return {
    enabled: safety.enabled === true,
    configured,
    ready: safety.enabled === true && configured,
    textEnabled: safety.textEnabled !== false,
    imageEnabled: safety.imageEnabled !== false,
    region: safety.region || 'cn-shanghai',
    endpoint: safety.endpoint || 'green-cip.cn-shanghai.aliyuncs.com',
    textServices,
    imageService: safety.imageService || 'query_security_check',
  };
}

function getClient() {
  const safety = getSafetyConfig();
  if (!isConfigured()) {
    throw new Error('阿里云内容安全未启用或 AccessKey 未配置');
  }

  const clientKey = [
    safety.accessKeyId,
    safety.region || 'cn-shanghai',
    safety.endpoint || 'green-cip.cn-shanghai.aliyuncs.com',
    safety.timeout || 10000,
  ].join('|');

  if (cachedClient && cachedClientKey === clientKey) return cachedClient;

  cachedClient = new GreenClient({
    accessKeyId: safety.accessKeyId,
    accessKeySecret: safety.accessKeySecret,
    regionId: safety.region || 'cn-shanghai',
    endpoint: safety.endpoint || 'green-cip.cn-shanghai.aliyuncs.com',
    connectTimeout: Math.min(Number(safety.timeout) || 10000, 3000),
    readTimeout: Number(safety.timeout) || 10000,
  });
  cachedClientKey = clientKey;
  return cachedClient;
}

function toPlain(value) {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectResultItems(value, items = [], visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return items;
  visited.add(value);

  const label = String(value.label || value.Label || '').toLowerCase();
  const suggestion = String(value.suggestion || value.Suggestion || '').toLowerCase();
  const level = String(value.level || value.Level || '').toLowerCase();
  const confidence = Number(value.confidence ?? value.Confidence);
  const description = value.description || value.Description || '';

  if (label || suggestion || level || Number.isFinite(confidence)) {
    items.push({ label, suggestion, level, confidence, description: String(description) });
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectResultItems(child, items, visited);
  }
  return items;
}

function normalizeContentSafetyResponse(response, channel, elapsedMs) {
  const body = toPlain(response?.body || response) || {};
  const code = Number(body.code ?? body.Code ?? response?.statusCode ?? 0);
  const message = body.message || body.Message || '';
  const requestId = body.requestId || body.RequestId || '';

  if (code !== 200) {
    throw new Error(`阿里云内容安全返回异常: code=${code || 'unknown'}, message=${message || 'unknown'}`);
  }

  const data = body.data || body.Data || {};
  const items = collectResultItems(data);
  const suggestions = items.map((item) => item.suggestion).filter(Boolean);
  const globalSuggestion = String(data.suggestion || data.Suggestion || '').toLowerCase();
  const suggestion = globalSuggestion === 'block' || suggestions.includes('block')
    ? 'block'
    : globalSuggestion === 'review' || suggestions.includes('review')
      ? 'review'
      : 'pass';

  const categoryScores = {};
  const categories = new Set();
  const matchedLabels = [];
  for (const item of items) {
    const category = CATEGORY_MAP[item.label];
    if (!category) continue;
    const score = Number.isFinite(item.confidence) ? Math.max(0, Math.min(100, Math.round(item.confidence))) : suggestion === 'block' ? 85 : 60;
    categoryScores[category] = Math.max(categoryScores[category] || 0, score);
    categories.add(category);
    matchedLabels.push({
      label: item.label,
      description: item.description || '',
      confidence: score,
      suggestion: item.suggestion || suggestion,
    });
  }

  // 服务建议拦截但未返回可映射标签时，保留为通用违法风险，防止审核结果被静默忽略。
  if (suggestion === 'block' && categories.size === 0) {
    categories.add('illegal');
    categoryScores.illegal = 85;
  }

  const riskLevel = suggestion === 'block' ? 'high' : suggestion === 'review' ? 'medium' : 'safe';
  const confidenceValues = matchedLabels.map((item) => item.confidence);
  const confidence = confidenceValues.length > 0
    ? Math.max(...confidenceValues) / 100
    : suggestion === 'pass' ? 1 : suggestion === 'review' ? 0.6 : 0.85;

  return {
    available: true,
    provider: 'aliyun-content-safety',
    channel,
    suggestion,
    risk_level: riskLevel,
    categories: Array.from(categories),
    category_scores: categoryScores,
    confidence,
    matched_labels: matchedLabels,
    request_id: requestId,
    elapsed_ms: elapsedMs,
  };
}

async function moderateTextContentSafety(text) {
  const status = getStatus();
  if (!status.ready || !status.textEnabled) {
    return { available: false, skipped: true, reason: !status.ready ? 'disabled_or_unconfigured' : 'text_disabled' };
  }

  const textServices = status.textServices.length > 0 ? status.textServices : ['comment_detection'];

  // 缓存命中：24h 内相同文本直接复用，省一次计费调用
  const cacheKey = textMd5(text);
  const cached = cacheGet(cacheKey);
  if (cached) {
    logInfo('content_safety', `文本审核缓存命中: suggestion=${cached.suggestion}, risk=${cached.risk_level}`);
    return { ...cached, cached: true, elapsed_ms: 0 };
  }

  const start = Date.now();

  if (textServices.length === 1) {
    // 单服务：直接调用
    try {
      const client = getClient();
      const request = new models.TextModerationRequest({
        service: textServices[0],
        serviceParameters: JSON.stringify({ content: text }),
      });
      const response = await client.textModeration(request);
      const result = normalizeContentSafetyResponse(response, 'text', Date.now() - start);
      result.services = textServices;
      cacheSet(cacheKey, result);
      logInfo('content_safety', `文本审核完成 [${textServices[0]}]: suggestion=${result.suggestion}, risk=${result.risk_level}, elapsed=${result.elapsed_ms}ms`);
      return result;
    } catch (err) {
      logError('content_safety', `文本审核失败 [${textServices[0]}]: ${err.message}`);
      return { available: false, error: err.message, channel: 'text', services: textServices, elapsed_ms: Date.now() - start };
    }
  }

  // 多服务：并行调用，合并结果
  const results = await Promise.allSettled(textServices.map(async (service) => {
    const client = getClient();
    const request = new models.TextModerationRequest({
      service,
      serviceParameters: JSON.stringify({ content: text }),
    });
    return await client.textModeration(request);
  }));

  const elapsed = Date.now() - start;
  const parsedResults = [];
  const errors = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      try {
        parsedResults.push(normalizeContentSafetyResponse(r.value, 'text', elapsed));
      } catch (err) {
        errors.push({ service: textServices[i], error: err.message });
      }
    } else {
      errors.push({ service: textServices[i], error: r.reason?.message || String(r.reason) });
    }
  }

  if (parsedResults.length === 0) {
    logError('content_safety', `所有文本审核服务均失败: ${errors.map(e => `${e.service}(${e.error})`).join('; ')}`);
    return { available: false, error: errors.map(e => e.error).join('; '), channel: 'text', services: textServices, elapsed_ms: elapsed };
  }

  // 合并多个服务结果：取最高风险、合并标签和分类
  const merged = mergeTextResults(parsedResults, textServices, elapsed);
  if (errors.length > 0) merged.partial_errors = errors;
  cacheSet(cacheKey, merged);
  logInfo('content_safety', `多服务文本审核完成 [${textServices.join(',')}]: suggestion=${merged.suggestion}, risk=${merged.risk_level}, services=${parsedResults.length}/${textServices.length}成功, elapsed=${elapsed}ms`);
  return merged;
}

function mergeTextResults(results, services, elapsed) {
  const suggestionOrder = { block: 3, review: 2, pass: 1 };
  const riskOrder = { critical: 4, high: 3, medium: 2, low: 1, safe: 0 };

  let maxSuggestion = 'pass';
  let maxRisk = 'safe';
  const categoryScores = {};
  const categories = new Set();
  const matchedLabels = [];
  const perService = [];

  for (const r of results) {
    perService.push({
      service: r.service || services[0],
      suggestion: r.suggestion,
      risk_level: r.risk_level,
      matched_labels: r.matched_labels || [],
    });

    if ((suggestionOrder[r.suggestion] || 0) > (suggestionOrder[maxSuggestion] || 0)) {
      maxSuggestion = r.suggestion;
    }
    if ((riskOrder[r.risk_level] || 0) > (riskOrder[maxRisk] || 0)) {
      maxRisk = r.risk_level;
    }
    for (const [cat, score] of Object.entries(r.category_scores || {})) {
      categoryScores[cat] = Math.max(categoryScores[cat] || 0, score);
    }
    for (const cat of (r.categories || [])) {
      categories.add(cat);
    }
    for (const label of (r.matched_labels || [])) {
      matchedLabels.push({ ...label, source_service: r.service || 'unknown' });
    }
  }

  const confidenceValues = matchedLabels.map((item) => item.confidence);
  const confidence = confidenceValues.length > 0
    ? Math.max(...confidenceValues) / 100
    : maxSuggestion === 'pass' ? 1 : maxSuggestion === 'review' ? 0.6 : 0.85;

  return {
    available: true,
    provider: 'aliyun-content-safety',
    channel: 'text',
    services,
    suggestion: maxSuggestion,
    risk_level: maxRisk,
    categories: Array.from(categories),
    category_scores: categoryScores,
    confidence,
    matched_labels: matchedLabels,
    per_service: perService,
    elapsed_ms: elapsed,
    merged: true,
  };
}

async function moderateImageContentSafety(imageBase64, text = '') {
  const status = getStatus();
  if (!status.ready || !status.imageEnabled) {
    return { available: false, skipped: true, reason: !status.ready ? 'disabled_or_unconfigured' : 'image_disabled' };
  }

  const start = Date.now();
  try {
    const client = getClient();
    // MultiModalGuardForBase64 为 Green/2022-03-02 官方同步 Base64 图片检测接口，避免为现有图片输入额外落盘或上传 OSS。
    const request = new models.MultiModalGuardForBase64Request({
      service: status.imageService,
      serviceParameters: JSON.stringify(text ? { content: text } : {}),
      imageBase64Str: imageBase64,
    });
    const response = await client.multiModalGuardForBase64(request);
    const result = normalizeContentSafetyResponse(response, 'image', Date.now() - start);
    logInfo('content_safety', `图片审核完成: suggestion=${result.suggestion}, risk=${result.risk_level}, elapsed=${result.elapsed_ms}ms`);
    return result;
  } catch (err) {
    logError('content_safety', `图片审核失败: ${err.message}`);
    return { available: false, error: err.message, channel: 'image', elapsed_ms: Date.now() - start };
  }
}

module.exports = {
  getContentSafetyStatus: getStatus,
  moderateTextContentSafety,
  moderateImageContentSafety,
  clearTextCache,
};
