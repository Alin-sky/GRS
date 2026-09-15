/**
 * 编排层对外门面（src/flow/index.js）
 *
 * 供三类调用方使用（T03 画布 UI / T04 插件 / src/moderator.js）：
 *   - 注册表：registerBuiltins / snapshot
 *   - 校验：validateFlow
 *   - 执行：runFlow / runFinalizers
 *   - 迁移：ensureFlows / getFlow / reconcileFinalizers
 *
 * ★ 本模块是核心可依赖的稳定接口；画布 UI 与插件只通过它与编排层交互。
 */

'use strict';

const schema = require('./schema');
const risk = require('./risk');
const registry = require('./registry');
const validate = require('./validate');
const mergeEngine = require('./merge');
const executor = require('./executor');
const migrate = require('./migrate');
const context = require('./context');
const nodes = require('./nodes');

/** 确保内置节点已登记（幂等）。 */
function ensureBuiltins() {
  return nodes.registerBuiltins();
}

/**
 * 流程总开关是否启用。
 * @param {object} config 配置
 * @returns {boolean}
 */
function isEnabled(config) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return false;
  return flows.enabled !== false;
}

/**
 * 取某模态的流程定义（假定 ensureFlows 已执行）。
 * @param {object} config 配置
 * @param {'text'|'image'} modality 模态
 * @returns {object|null} 流程或 null
 */
function getFlow(config, modality) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return null;
  const flow = flows[modality];
  if (!flow || typeof flow !== 'object') return null;
  return flow;
}

/**
 * 取可用（通过校验）的流程；不合法返回 null（调用方应回退旧引擎）。
 * @param {object} config 配置
 * @param {'text'|'image'} modality 模态
 * @returns {{flow: object|null, validation: object}} 结果
 */
function getValidFlow(config, modality) {
  ensureBuiltins();
  const flow = getFlow(config, modality);
  if (!flow) return { flow: null, validation: { ok: false, errors: [{ code: 'E999', message: '流程未迁移' }], warnings: [] } };
  const validation = validate.validateFlow(flow, registry);
  return { flow: validation.ok ? flow : null, validation };
}

/**
 * 插件装载后补齐终裁层（坑①：把 wd14 linkage 显式化到拓扑里）。
 * 仅在 `finalizers` 为空且注册表存在 finalize 角色时补齐，幂等。
 * @param {object} config 配置（原地修改）
 * @returns {{changed: boolean, added: string[]}} 结果
 */
function reconcileFinalizers(config) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows || !flows.image) return { changed: false, added: [] };
  const image = flows.image;
  const existing = Array.isArray(image.finalizers) ? image.finalizers : [];
  if (existing.length > 0) return { changed: false, added: [] };
  const registered = registry.listFinalizers('image');
  if (registered.length === 0) return { changed: false, added: [] };
  image.finalizers = registered.map((f) => ({
    ref: f.ref,
    enabled: f.enabled !== false,
    title: f.title || f.ref,
    source: f.owner || '',
    params: {},
  }));
  return { changed: true, added: registered.map((f) => f.ref) };
}

/**
 * 能力/节点快照（GET /api/flow/capabilities 的唯一数据源）。
 * @param {'text'|'image'} [modality] 模态
 * @returns {object} 快照
 */
function snapshot(modality) {
  ensureBuiltins();
  return registry.snapshot(modality);
}

/**
 * 执行流程。
 * @param {object} flow 流程
 * @param {object} input 输入载荷
 * @param {object} opts 选项
 * @returns {Promise<object>} 执行结果
 */
async function runFlow(flow, input, opts) {
  ensureBuiltins();
  return executor.runFlow(flow, input, opts);
}

module.exports = {
  // 子模块
  schema,
  risk,
  registry,
  validate,
  merge: mergeEngine,
  executor,
  migrate,
  context,
  nodes,
  // 语义接口
  ensureBuiltins,
  isEnabled,
  getFlow,
  getValidFlow,
  reconcileFinalizers,
  snapshot,
  runFlow,
  runFinalizers: executor.runFinalizers,
  validateFlow: validate.validateFlow,
  ensureFlows: migrate.ensureFlows,
};
