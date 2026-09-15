/**
 * 节点装配与调用分发（src/flow/nodes/index.js）
 *
 * - registerBuiltins()：把 3 个内置节点登记进 flow/registry（唯一数据源）。
 * - invokeNode()：执行器调用入口。内置节点本地执行；插件节点经 capability-broker 点对点调用。
 *
 * ★ 本模块是「核心 → 插件」的唯一合法通道（flow/executor → capability-broker）。
 */

'use strict';

const registry = require('../registry');
const broker = require('../../capability-broker');

const precheckNode = require('./builtin-precheck');
const localNode = require('./builtin-local');
const cloudNode = require('./builtin-cloud');
const contentSafetyNode = require('./builtin-contentsafety');

/** 内置节点集合（ref → { descriptor, run, readiness }）。 */
const BUILTINS = [precheckNode, localNode, cloudNode, contentSafetyNode];

/** 是否已登记内置节点。 */
let _registered = false;

/**
 * 登记内置节点（幂等）。
 * @returns {string[]} 已登记的 ref 列表
 */
function registerBuiltins() {
  if (_registered) return BUILTINS.map((b) => b.descriptor.ref);
  for (const mod of BUILTINS) {
    registry.registerBuiltin({
      ...mod.descriptor,
      readyFn: mod.readiness,
      run: mod.run,
    });
  }
  _registered = true;
  return BUILTINS.map((b) => b.descriptor.ref);
}

/**
 * 取内置节点的 run 函数。
 * @param {string} ref 节点 ref
 * @returns {Function|null} run 函数
 */
function builtinRunner(ref) {
  for (const mod of BUILTINS) {
    if (mod.descriptor.ref === ref) return mod.run;
  }
  return null;
}

/**
 * 执行一个插件判定节点（service 角色，点对点调用）。
 * @param {object} runtime 运行时
 * @param {object} descriptor 注册表描述符
 * @returns {Promise<object>} NodeResult
 */
async function runPluginJudge(runtime, descriptor) {
  const started = Date.now();
  const capability = descriptor.capability
    || (runtime.modality === 'image' ? 'image.verdict' : 'text.verdict');
  const request = {
    ref: descriptor.ref,
    params: runtime.params || {},
    payload: runtime.ctx.payload,
    modality: runtime.modality,
    work: runtime.ctx.work,
    meta: { strictness: runtime.strictness },
  };
  let verdict;
  try {
    verdict = await broker.invokeCall(capability, descriptor.owner, request);
  } catch (err) {
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: 'failed', elapsedMs: Date.now() - started,
      failureType: 'plugin_rejected', skipReason: null, verdict: null,
      costHint: descriptor.costHint || 'free',
      message: `插件调用异常: ${err && err.message}`,
    };
  }

  if (!verdict) {
    // 未就绪（依赖缺失 / 未配置）→ skipped；已就绪但无有效返回 → failed（plugin_rejected）
    const notReady = descriptor.ready !== true;
    return {
      nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
      status: notReady ? 'skipped' : 'failed',
      elapsedMs: Date.now() - started,
      failureType: notReady ? null : 'plugin_rejected',
      skipReason: notReady ? (descriptor.notReadyReason || 'missing-deps') : null,
      verdict: null,
      costHint: descriptor.costHint || 'free',
      message: notReady ? `插件未就绪：${descriptor.notReadyReason || 'missing-deps'}` : '插件返回值未通过 gate 校验',
    };
  }

  return {
    nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
    status: 'ok', elapsedMs: Date.now() - started,
    failureType: null, skipReason: null, verdict,
    costHint: descriptor.costHint || 'free', message: '',
  };
}

/**
 * 执行一个插件贡献节点（contribute 角色，collect 调用）。
 * 透传上游判定，并把标签写入工作上下文。
 * @param {object} runtime 运行时
 * @param {object} descriptor 注册表描述符
 * @returns {Promise<object>} NodeResult
 */
async function runPluginContribute(runtime, descriptor) {
  const started = Date.now();
  const capability = descriptor.capability || 'image.tag';
  const imageBase64 = (runtime.ctx.payload && runtime.ctx.payload.imageBase64) || '';
  let contributions = [];
  try {
    contributions = await broker.invokeCollect(capability, imageBase64);
  } catch {
    contributions = [];
  }
  const merged = { tags: [], labels: [] };
  for (const c of Array.isArray(contributions) ? contributions : []) {
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c.tags)) merged.tags.push(...c.tags);
    if (Array.isArray(c.labels)) merged.labels.push(...c.labels);
  }
  const added = runtime.ctx.mergeWork(merged);

  const upstream = runtime.upstream;
  const verdict = upstream && upstream.verdict ? { ...upstream.verdict } : null;
  return {
    nodeId: runtime.nodeId, ref: descriptor.ref, title: descriptor.title,
    status: verdict ? 'ok' : 'skipped',
    elapsedMs: Date.now() - started,
    failureType: null,
    skipReason: verdict ? null : 'not-configured',
    verdict,
    costHint: descriptor.costHint || 'free',
    message: added > 0 ? `写入 ${added} 个标签` : '无标签贡献',
    tags: merged.tags,
  };
}

/**
 * 执行一个节点（执行器唯一入口）。
 * @param {object} runtime 运行时
 * @returns {Promise<object>} NodeResult
 */
async function invokeNode(runtime) {
  const node = runtime.node;
  if (!node) throw new Error('invokeNode 缺少 node');
  const descriptor = registry.get(node.ref);

  if (node.type === 'contribute') {
    // 内置贡献节点（如单测桩）直接执行 run；插件贡献节点走 collect 调用
    if (descriptor && typeof descriptor._run === 'function') {
      return descriptor._run({ ...runtime, nodeId: node.id });
    }
    if (!descriptor) {
      return {
        nodeId: node.id, ref: node.ref, title: node.ref, status: 'skipped',
        elapsedMs: 0, failureType: null, skipReason: 'missing-deps', verdict: runtime.upstream ? runtime.upstream.verdict : null,
        costHint: 'free', message: '节点服务未注册（依赖缺失或插件已卸载）',
      };
    }
    return runPluginContribute(runtime, descriptor);
  }

  // service 节点：内置或插件
  if (descriptor && descriptor.kind === 'plugin') {
    return runPluginJudge(runtime, descriptor);
  }
  const runner = (descriptor && typeof descriptor._run === 'function')
    ? descriptor._run
    : builtinRunner(node.ref);
  if (!runner) {
    const notReady = descriptor ? descriptor.ready !== true : true;
    return {
      nodeId: node.id, ref: node.ref, title: node.ref,
      status: notReady ? 'skipped' : 'failed',
      elapsedMs: 0,
      failureType: notReady ? null : 'unknown',
      skipReason: notReady ? 'not-registered' : null,
      verdict: null, costHint: 'free',
      message: descriptor ? '节点服务未就绪' : '节点 ref 未在注册表',
    };
  }
  return runner({ ...runtime, nodeId: node.id });
}

module.exports = {
  BUILTINS,
  registerBuiltins,
  builtinRunner,
  invokeNode,
  runPluginJudge,
  runPluginContribute,
};
