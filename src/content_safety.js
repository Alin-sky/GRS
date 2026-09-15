/**
 * 内容安全兼容垫片（src/content_safety.js）
 *
 * ★ v2.2.0 定位（架构 §8.1 步骤 ③）：阿里云内容安全的**客户端构造 / 响应归一化 / 缓存**
 *   已整体迁出到 `plugins/aliyun-content-safety/`。本文件退化为**兼容垫片**：
 *     - 保留三个既有导出（`getContentSafetyStatus` / `moderateTextContentSafety` /
 *       `moderateImageContentSafety`），保证 `src/server.js`、`src/moderator.js`、
 *       `src/comparator.js` 等既有调用点不被打断；
 *     - 内部改为**经 capability-broker → 插件节点**（`text.verdict` / `image.verdict`）；
 *     - **不再 require SDK、不再构造 client、不再持有缓存** → 插件禁用时核心零残留调用路径（PRD F15）。
 *
 * ★ 安全性质：插件未启用 / 未就绪时返回 `{available:false, skipped:true, reason}`，
 *   由调用方（moderator 的下限层叠加）按「只升不降」语义跳过，绝不因此放行。
 */

'use strict';

const { loadConfig, isValueSet } = require('./config');
const { logWarn } = require('./logger');
const capabilityBroker = require('./capability-broker');

/** 提供内容安全能力的插件 id（与 plugins/aliyun-content-safety/manifest.json 一致）。 */
const PLUGIN_ID = 'aliyun-content-safety';

/** 能力 → 插件节点 ref。 */
const NODE_REF = {
  text: `plugin.${PLUGIN_ID}.text`,
  image: `plugin.${PLUGIN_ID}.image`,
};

/** 内容安全配置（字段**未搬迁**，仍读 config.contentSafety.*）。 */
function getSafetyConfig() {
  return loadConfig().contentSafety || {};
}

/** 是否已启用且配好 AccessKey（占位符视为未配置）。 */
function isConfigured() {
  const safety = getSafetyConfig();
  return Boolean(safety.enabled && isValueSet(safety.accessKeyId) && isValueSet(safety.accessKeySecret));
}

/** 插件是否提供了内容安全能力（未启用 / 未装载 → false）。 */
function hasProvider() {
  return capabilityBroker.has('text.verdict') || capabilityBroker.has('image.verdict');
}

/**
 * SDK 是否已安装（仅用于状态展示；实际装载归属插件，核心不再 require）。
 * @returns {boolean} 是否已安装
 */
function isSdkInstalled() {
  try {
    require.resolve('@alicloud/green20220302', { paths: [__dirname] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 内容安全状态（供 GET /api/content-safety/status 与画布置灰使用）。
 * @returns {object} 状态
 */
function getStatus() {
  const safety = getSafetyConfig();
  const configured = Boolean(isValueSet(safety.accessKeyId) && isValueSet(safety.accessKeySecret));
  const installed = isSdkInstalled();
  const pluginAvailable = hasProvider();

  let textServices = [];
  if (Array.isArray(safety.textServices) && safety.textServices.length > 0) {
    textServices = safety.textServices.filter(Boolean);
  } else if (safety.textService) {
    textServices = [safety.textService];
  }

  // 状态优先级：invalid > missing-deps > not-configured > disabled > ready
  let reason = '';
  if (!pluginAvailable) reason = 'plugin_disabled';
  else if (!installed) reason = 'missing-deps';
  else if (!configured) reason = 'not-configured';
  else if (safety.enabled !== true) reason = 'disabled';

  return {
    enabled: safety.enabled === true,
    configured,
    installed,
    pluginAvailable,
    ready: safety.enabled === true && configured && pluginAvailable,
    reason,
    installHint: installed ? '' : 'npm i @alicloud/green20220302',
    textEnabled: safety.textEnabled !== false,
    imageEnabled: safety.imageEnabled !== false,
    region: safety.region || 'cn-shanghai',
    endpoint: safety.endpoint || 'cn-shanghai',
    textServices,
    imageService: safety.imageService || 'query_security_check',
  };
}

/**
 * 经 broker 调用内容安全插件节点。
 * @param {'text'|'image'} modality 模态
 * @param {object} payload 载荷（{text} 或 {imageBase64, caption}）
 * @returns {Promise<object|null>} 插件判定（ModerationVerdict）或 null
 */
async function invokePluginNode(modality, payload) {
  const capability = modality === 'image' ? 'image.verdict' : 'text.verdict';
  if (!capabilityBroker.hasOwner(capability, PLUGIN_ID)) return null;
  const request = {
    ref: NODE_REF[modality],
    params: {},
    payload,
    modality,
    work: { tags: [], labels: [], evidence: [] },
    meta: {},
  };
  try {
    return await capabilityBroker.invokeCall(capability, PLUGIN_ID, request);
  } catch (err) {
    logWarn('content_safety', `内容安全插件调用异常: ${err && err.message}`);
    return null;
  }
}

/**
 * 把插件返回的 ModerationVerdict 投影回 v2.1.0 的 contentSafetyResult 形状，
 * 供 moderator 的 `applyContentSafetyResult`（只升不降）沿用，确保行为等价。
 * @param {object} verdict 插件判定
 * @returns {object} contentSafetyResult
 */
function verdictToLegacy(verdict) {
  const level = verdict.risk_level;
  const suggestion = (level === 'high' || level === 'critical')
    ? 'block'
    : (level === 'medium' || level === 'review') ? 'review' : 'pass';
  return {
    available: true,
    provider: 'aliyun-content-safety',
    suggestion,
    risk_level: level,
    categories: Array.isArray(verdict.categories) ? verdict.categories : [],
    category_scores: verdict.category_scores || {},
    confidence: Number.isFinite(verdict.confidence) ? verdict.confidence : 0.8,
    matched_labels: [],
    reason: verdict.reason || '',
  };
}

/**
 * 构造「未就绪」结果（跳过语义，绝不视为 safe）。
 * @param {object} status 状态
 * @param {boolean} textEnabled 该模态是否开启
 * @returns {object} 跳过结果
 */
function skipResult(status, textEnabled) {
  const reason = !status.pluginAvailable ? 'plugin_disabled'
    : !status.ready ? 'disabled_or_unconfigured'
      : (textEnabled ? 'unavailable' : 'modal_disabled');
  return { available: false, skipped: true, reason };
}

/**
 * 文本内容安全审核（经插件）。
 * @param {string} text 文本
 * @returns {Promise<object>} contentSafetyResult
 */
async function moderateTextContentSafety(text) {
  const status = getStatus();
  if (!status.ready || !status.textEnabled) return skipResult(status, status.textEnabled);
  const verdict = await invokePluginNode('text', { text });
  if (!verdict) return { available: false, skipped: true, reason: 'plugin_disabled' };
  return verdictToLegacy(verdict);
}

/**
 * 图片内容安全审核（经插件）。
 * @param {string} imageBase64 base64 图片
 * @param {string} [text] 附带文本
 * @returns {Promise<object>} contentSafetyResult
 */
async function moderateImageContentSafety(imageBase64, text = '') {
  const status = getStatus();
  if (!status.ready || !status.imageEnabled) return skipResult(status, status.imageEnabled);
  const verdict = await invokePluginNode('image', { imageBase64, caption: text });
  if (!verdict) return { available: false, skipped: true, reason: 'plugin_disabled' };
  return verdictToLegacy(verdict);
}

/**
 * 兼容保留：文本缓存已迁至插件内部，此处为无操作。
 * @returns {number} 固定返回 0
 */
function clearTextCache() {
  return 0;
}

module.exports = {
  getContentSafetyStatus: getStatus,
  isSdkInstalled,
  isConfigured,
  hasProvider,
  moderateTextContentSafety,
  moderateImageContentSafety,
  clearTextCache,
};
