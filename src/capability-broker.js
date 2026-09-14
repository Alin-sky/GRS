/**
 * 能力中介（src/capability-broker.js）
 *
 * ★ R2：核心只认识 broker，插件层只认识注入的 ctx。
 *   插件层启动时把 manifest 声明的能力注册到 broker；核心只查询「有无提供者」并调用
 *   broker 的语义化方法。plugins/ 目录清空 → broker 为空 → 返回空结果，
 *   主流程与「无插件」逐字节一致（PLG-01）。
 *
 * ★ 本文件**不 require 任何 plugin-* / cordis-* 模块**：与插件层的连接通过 setTransport()
 *   注入（由 src/plugin-runtime.js 完成）。核心 require 本文件永远不会拉起插件层。
 *
 * 设计依据：docs/architecture-2026-09-14.md §3.2（R1/R2/R3）
 */
const { CAPABILITIES, DEFAULT_MAX_OUTPUT_BYTES } = require('./host-api/contract');
const eventRegistry = require('./host-api/event-registry');
const gate = require('./host-api/plugin-gate');

/**
 * 能力注册表：capabilityId → { capabilityId, event, mode, pluginId, maxOutputBytes }
 * @type {Map<string, object>}
 */
const _capabilities = new Map();

/** 事件传输层（由 plugin-runtime 注入；未注入时为空实现） */
let _transport = {
  emitCollect: async () => [],
  emitFirst: async () => undefined,
};

/** 是否已被插件层接管 */
let _connected = false;

/**
 * 注入事件传输层（plugin-runtime 调用；核心不会调用）。
 * @param {{emitCollect: Function, emitFirst: Function, hasHandlers?: Function}} transport 传输实现
 */
function setTransport(transport) {
  if (!transport || typeof transport.emitCollect !== 'function' || typeof transport.emitFirst !== 'function') {
    throw new Error('能力中介传输层必须提供 emitCollect / emitFirst');
  }
  _transport = transport;
  _connected = true;
}

/** 是否已接入插件层（未接入时所有能力调用走空实现） */
function isConnected() {
  return _connected;
}

/**
 * 注册一项能力（幂等，重复注册覆盖）。
 * @param {string} pluginId 插件 id
 * @param {object} capability manifest.contributes.capabilities[i]
 * @returns {{ok: boolean, errors?: string[], event?: string}}
 */
function register(pluginId, capability) {
  const check = eventRegistry.validateCapability(capability);
  if (!check.ok) return check;
  const event = check.event;
  const def = eventRegistry.getEvent(event);
  _capabilities.set(capability.id, {
    capabilityId: capability.id,
    event,
    mode: def.mode,
    pluginId,
    maxOutputBytes: Number(capability.maxOutputBytes) > 0
      ? Number(capability.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES,
  });
  return { ok: true, event };
}

/**
 * 批量注册某插件的全部能力。
 * @param {string} pluginId 插件 id
 * @param {Array<object>} capabilities 能力声明列表
 * @returns {{ok: boolean, errors: string[], registered: string[]}}
 */
function registerAll(pluginId, capabilities) {
  const errors = [];
  const registered = [];
  for (const cap of Array.isArray(capabilities) ? capabilities : []) {
    const res = register(pluginId, cap);
    if (res.ok) registered.push(cap.id);
    else errors.push(...(res.errors || ['能力注册失败']));
  }
  return { ok: errors.length === 0, errors, registered };
}

/**
 * 摘除某插件的全部能力（插件禁用/卸载时调用）。
 * @param {string} pluginId 插件 id
 * @returns {string[]} 被摘除的能力 id
 */
function unregisterPlugin(pluginId) {
  const removed = [];
  for (const [id, entry] of _capabilities.entries()) {
    if (entry.pluginId === pluginId) {
      _capabilities.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/**
 * 是否至少有一个提供者。
 * @param {string} capabilityId 能力 id
 * @returns {boolean}
 */
function has(capabilityId) {
  return _capabilities.has(capabilityId);
}

/**
 * 列出能力提供者快照（供 /api/plugins 诊断，不暴露实现）。
 * @returns {Array<{capabilityId: string, event: string, mode: string, pluginId: string}>}
 */
function providers() {
  return [..._capabilities.values()].map(({ capabilityId, event, mode, pluginId }) => ({
    capabilityId, event, mode, pluginId,
  }));
}

/**
 * 解析能力对应的调用上下文：事件名 + gate 参数（体积上限取声明值，未声明用契约默认）。
 * @param {string} capabilityId 能力 id
 * @returns {{event: string, maxBytes: number, owner: string}|null}
 */
function resolveCall(capabilityId) {
  const event = eventRegistry.eventOfCapability(capabilityId);
  if (!event) return null;
  const declared = _capabilities.get(capabilityId);
  return {
    event,
    maxBytes: declared ? declared.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES,
    owner: declared ? declared.pluginId : '(未声明能力)',
  };
}

/** 插件层是否真的有人监听该事件（无人监听 → 核心走「无插件」快路径） */
function hasHandlers(event) {
  if (!_connected) return false;
  try {
    return _transport.hasHandlers ? _transport.hasHandlers(event) === true : true;
  } catch {
    return false;
  }
}

/**
 * 收集模式调用：并行执行全部处理器，逐条过 gate，非法条目丢弃并记 plugin_rejected。
 * 插件层未接入 / 无处理器 → 返回空数组（完全不触达插件层）。
 * @param {string} capabilityId 能力 id
 * @param {...any} args 传给钩子的参数
 * @returns {Promise<Array<any>>} 通过 gate 的返回值
 */
async function invokeCollect(capabilityId, ...args) {
  const call = resolveCall(capabilityId);
  if (!call || !hasHandlers(call.event)) return [];
  let raw;
  try {
    raw = await _transport.emitCollect(call.event, ...args);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const res = gate.gateOutput(call.event, item, { maxBytes: call.maxBytes, owner: call.owner });
    if (res.ok) out.push(res.value);
  }
  return out;
}

/**
 * 短路模式调用：首个非空返回值即结果，且必须过 gate；gate 失败视为「无结果」。
 * @param {string} capabilityId 能力 id
 * @param {...any} args 传给钩子的参数
 * @returns {Promise<any>} 通过 gate 的返回值，或 undefined
 */
async function invokeFirst(capabilityId, ...args) {
  const call = resolveCall(capabilityId);
  if (!call || !hasHandlers(call.event)) return undefined;
  let raw;
  try {
    raw = await _transport.emitFirst(call.event, ...args);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === null) return undefined;
  const res = gate.gateOutput(call.event, raw, {
    maxBytes: call.maxBytes,
    owner: call.owner,
    ctx: args[0] && typeof args[0] === 'object' ? args[0] : {},
  });
  if (!res.ok) return undefined;
  return res.value;
}

// ─── 核心面向的语义化 API（核心只调这些，不认识事件名） ───

/**
 * 收集图片标签贡献（供核心图片审核链路调用）。
 * 插件不存在 / 未就绪 / 全部被 gate 拒绝 → 返回空数组，核心行为与无插件一致。
 * @param {string} imageBase64 base64 图片
 * @returns {Promise<Array<object>>} 各插件的贡献
 */
async function collectImageTags(imageBase64) {
  try {
    return await invokeCollect(CAPABILITIES.IMAGE_TAG, imageBase64);
  } catch {
    return [];
  }
}

/**
 * 解析图片审核联动判定（短路模式，返回值过完整 validateVerdict）。
 * gate 失败 → 返回 undefined，核心回落原判定（PLG-02 / INJ-08）。
 * @param {object} result 当前审核判定
 * @param {Array<object>} contributions 标签贡献
 * @returns {Promise<object|undefined>} 融合后的判定，或 undefined
 */
async function resolveImageLinkage(result, contributions) {
  try {
    return await invokeFirst(CAPABILITIES.IMAGE_LINKAGE, result, contributions);
  } catch {
    return undefined;
  }
}

/** 供测试使用的状态重置 */
function _reset() {
  _capabilities.clear();
  _transport = { emitCollect: async () => [], emitFirst: async () => undefined };
  _connected = false;
}

module.exports = {
  setTransport,
  isConnected,
  register,
  registerAll,
  unregisterPlugin,
  has,
  providers,
  invokeCollect,
  invokeFirst,
  collectImageTags,
  resolveImageLinkage,
  _reset,
};
