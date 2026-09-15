/**
 * 内置节点：阿里云内容安全（核心兼容垫片，src/flow/nodes/builtin-contentsafety.js）
 *
 * ★ 定位：v2.2.0 把内容安全从「核心硬编码调用」改为**下限层节点**（只升不降，
 *   复刻 v2.1.0 `applyContentSafetyResult`）。SDK 已惰性化并降级为 optionalDependencies，
 *   未安装时本节点返回 skipped（`missing-deps`），核心冷启动不受影响。
 *
 * ★ T04 将由 plugins/aliyun-content-safety 提供 `plugin.aliyun-content-safety.{text,image}`
 *   节点替代本垫片；本垫片保留以维持旧配置迁移后的默认拓扑可执行。
 */

'use strict';

const {
  moderateTextContentSafety, moderateImageContentSafety, getContentSafetyStatus,
} = require('../../content_safety');
const { loadConfig } = require('../../config');

/** 节点描述符。 */
const descriptor = {
  ref: 'builtin.contentSafety',
  title: '阿里云内容安全（下限层垫片）',
  desc: '迁移兼容用的下限层垫片：内部转发到插件 plugin.aliyun-content-safety.*，插件未启用时跳过；不在画布服务面板展示',
  icon: '🧿',
  modality: ['text', 'image'],
  output: 'ModerationVerdict',
  role: 'service',
  defaultCombine: 'branch',
  combineEditable: false,
  canParallel: true,
  multiInstance: false,
  // ★ 迁移生成的默认拓扑仍引用本 ref；隐藏以免与插件节点在面板上重复（同一能力只有一条路）
  hidden: true,
  params: [],
  defaultTimeoutMs: 10000,
  failurePolicyOptions: ['inherit', 'block', 'review'],
  costHint: 'paid-api',
};

/**
 * 就绪度：SDK 已安装且已配置 AccessKey。
 * @returns {{ready: boolean, reason: string, installHint: string}} 就绪度
 */
function readiness() {
  try {
    const status = getContentSafetyStatus();
    return {
      ready: status.ready === true,
      reason: status.ready ? '' : (status.reason || 'not-configured'),
      installHint: status.installHint || '',
    };
  } catch {
    return { ready: false, reason: 'missing-deps' };
  }
}

/**
 * 执行内容安全节点。
 * @param {object} runtime 运行时 { ctx, modality, nodeId }
 * @returns {Promise<object>} NodeResult
 */
async function run(runtime) {
  const started = Date.now();
  const status = getContentSafetyStatus();
  if (!status.ready) {
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: 'skipped', elapsedMs: Date.now() - started, failureType: null,
      skipReason: status.reason || 'not-configured', verdict: null, costHint: 'paid-api',
      message: `内容安全未就绪（${status.reason || 'not-configured'}）`,
    };
  }
  const config = loadConfig();
  let res;
  try {
    if (runtime.modality === 'image') {
      res = await moderateImageContentSafety((runtime.ctx.payload && runtime.ctx.payload.imageBase64) || '', (runtime.ctx.payload && runtime.ctx.payload.caption) || '');
    } else {
      res = await moderateTextContentSafety((runtime.ctx.payload && runtime.ctx.payload.text) || '');
    }
  } catch (err) {
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: 'failed', elapsedMs: Date.now() - started, failureType: 'network',
      skipReason: null, verdict: null, costHint: 'paid-api',
      message: `内容安全调用失败: ${err && err.message}`,
    };
  }
  void config;
  if (!res || res.skipped || !res.available) {
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: 'skipped', elapsedMs: Date.now() - started, failureType: null,
      skipReason: (res && res.reason) || 'not-configured', verdict: null, costHint: 'paid-api',
      message: '内容安全未就绪，已跳过',
    };
  }
  return {
    nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
    status: 'ok', elapsedMs: Date.now() - started, failureType: null, skipReason: null,
    verdict: {
      risk_level: res.risk_level || 'safe',
      action: null,
      categories: res.categories || [],
      category_scores: res.category_scores || {},
      confidence: Number.isFinite(res.confidence) ? res.confidence : 0,
      reason: '阿里云内容安全结果',
      suggestion: '',
    },
    contentSafetyResult: res,
    costHint: 'paid-api', message: '',
  };
}

module.exports = { descriptor, run, readiness };
