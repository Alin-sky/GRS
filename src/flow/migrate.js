/**
 * 旧配置 → 默认拓扑迁移（src/flow/migrate.js）
 *
 * 设计依据：GRS v2.2.0 架构 §10。
 *
 * 关键约束：
 *   - 权威来源：`config.moderation.reviewChannels`（顶层 `reviewChannels` 弃用，仅记迁移日志）
 *   - 幂等：已存在合法 flows 则跳过；结果写入 `config.moderation.flows.*`
 *   - **不删除任何旧字段**（dualMode / doubleCheck / reviewChannels / contentSafety.* 全保留），
 *     保证 `flows.enabled=false` 逃生时旧引擎仍能读
 *   - 迁移只引用**内置 ref**（迁移发生在插件扫描之前，不能引用插件节点，
 *     否则会产生 E004）；插件节点/终裁层由 src/flow/index.js `reconcileFinalizers` 在插件装载后补齐
 */

'use strict';

const { emptyFlow } = require('./schema');

/** 迁移日志码。 */
const MIGRATION_CODES = Object.freeze({
  M001: '已由 dualMode=true 生成默认并行拓扑',
  M002: '已由 cloud-only 生成纯云端拓扑',
  M003: '已生成单通道默认拓扑',
  M004: '已由 doubleCheck 生成双检拓扑（注意：category_scores 不再取均值，见 PRD Q3）',
  M005: '内容安全已启用，已并入下限层（只升不降）',
  M010: '检测到顶层 reviewChannels 与 moderation.reviewChannels 不一致，已以 moderation.reviewChannels 为准',
  M020: 'disputeStrategy=contentSafety 暂按 highest 处理（内容安全以独立节点接入的能力由插件提供）',
});

/**
 * 读取权威通道配置，并在两份 reviewChannels 不一致时产出告警日志。
 * @param {object} config 配置
 * @param {Array<object>} log 迁移日志（原地追加）
 * @returns {object} 权威通道配置
 */
function authoritativeChannels(config, log) {
  const authoritative = (config.moderation && config.moderation.reviewChannels) || { local: true, cloud: true, contentSafety: false, disputeStrategy: 'highest' };
  const legacyTop = config.reviewChannels;
  if (legacyTop && typeof legacyTop === 'object') {
    const mismatch = Object.keys(legacyTop).some((k) => k in authoritative && legacyTop[k] !== authoritative[k]);
    if (mismatch) log.push({ level: 'warn', code: 'M010', msg: MIGRATION_CODES.M010 });
  }
  return authoritative;
}

/**
 * 把 disputeStrategy 映射为合并策略。
 * @param {string} strategy disputeStrategy
 * @param {string} [modality] 模态
 * @param {Array<object>} log 迁移日志
 * @returns {{strategy: string, localPriority: number, cloudPriority: number}} 映射结果
 */
function mapDisputeStrategy(strategy, modality, log) {
  switch (strategy) {
    case 'lowest': return { strategy: 'lowest', localPriority: 0, cloudPriority: 0 };
    case 'local': return { strategy: 'priority', localPriority: 100, cloudPriority: 0 };
    case 'cloud': return { strategy: 'priority', localPriority: 0, cloudPriority: 100 };
    case 'contentSafety':
      log.push({ level: 'info', code: 'M020', msg: MIGRATION_CODES.M020 });
      return { strategy: 'highest', localPriority: 0, cloudPriority: 0 };
    case 'majority':
    case 'highest':
    default:
      return { strategy: 'highest', localPriority: 0, cloudPriority: 0 };
  }
}

/**
 * 迁移文本拓扑。
 * @param {object} config 配置
 * @param {Array<object>} log 迁移日志
 * @returns {object} 文本流程
 */
function migrateTextFlow(config, log) {
  const ch = authoritativeChannels(config, log);
  const cs = config.contentSafety || {};
  const isCloudOnly = config.moderationMode === 'cloud-only';
  const dual = !isCloudOnly
    && ch.local !== false
    && ch.cloud !== false
    && config.moderation.dualMode === true
    && config.qwenCloud && config.qwenCloud.enabled === true;
  const doubleCheck = !isCloudOnly && !dual && config.moderation.doubleCheck === true;

  const flow = emptyFlow('text');
  flow.revision = 1;
  flow.floors = [{
    id: 'pc', ref: 'builtin.precheck', params: {}, timeoutMs: 3000, enabled: true, deletable: true,
    deleteWarning: '删除后敏感词库不再参与判定，且零配置场景下将失去唯一兜底',
  }];
  if (ch.contentSafety === true && cs.enabled === true && cs.textEnabled !== false) {
    flow.floors.push({ id: 'cs', ref: 'builtin.contentSafety', params: {}, timeoutMs: 10000, enabled: true, deletable: true });
    log.push({ level: 'info', code: 'M005', msg: MIGRATION_CODES.M005 });
  }

  const nodes = [{ id: 'in', type: 'input', position: { x: 320, y: 40 } }];
  const edges = [];
  const loc = { id: 'loc', type: 'service', ref: 'builtin.localModel', params: { model: '', useSafeguardPrompt: false }, failurePolicy: 'inherit', timeoutMs: 60000, position: { x: 160, y: 220 } };
  const cld = { id: 'cld', type: 'service', ref: 'builtin.cloudModel', params: { vision: false }, failurePolicy: 'inherit', timeoutMs: 30000, position: { x: 480, y: 220 } };
  nodes.push(loc, cld);

  let edgeSeq = 0;
  const addEdge = (from, to, priority) => {
    edgeSeq += 1;
    const e = { id: `e${edgeSeq}`, from, to };
    if (Number.isFinite(priority)) e.priority = priority;
    edges.push(e);
  };

  if (doubleCheck) {
    // 双检：本地 #1 / 本地 #2 并行汇聚（⚠️ 不再对 category_scores 取均值）
    loc.id = 'loc1';
    loc.position = { x: 160, y: 220 };
    const loc2 = { id: 'loc2', type: 'service', ref: 'builtin.localModel', params: { model: '', useSafeguardPrompt: false }, failurePolicy: 'inherit', timeoutMs: 60000, position: { x: 480, y: 220 } };
    nodes.length = 1;
    nodes.push(loc, loc2);
    const mg = { id: 'mg', type: 'merge', strategy: 'highest', categoriesMerge: 'winner', branchOrder: ['loc1', 'loc2'], timeoutMs: 1000, position: { x: 320, y: 360 } };
    nodes.push(mg, { id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'loc1');
    addEdge('in', 'loc2');
    addEdge('loc1', 'mg', 0);
    addEdge('loc2', 'mg', 0);
    addEdge('mg', 'out');
    log.push({ level: 'warn', code: 'M004', msg: MIGRATION_CODES.M004 });
    // 未使用的云端节点保留为孤立节点（warn）；插在 loc1 之后便于画布观感
    cld.id = 'cld_cloud';
    nodes.splice(2, 0, cld);
    flow.nodes = nodes;
    flow.edges = edges;
    return flow;
  }

  const map = mapDisputeStrategy(ch.disputeStrategy || 'highest', 'text', log);

  let connected;
  if (dual) {
    connected = 'dual';
    log.push({ level: 'info', code: 'M001', msg: MIGRATION_CODES.M001 });
  } else if (isCloudOnly) {
    connected = 'cloud';
    log.push({ level: 'info', code: 'M002', msg: MIGRATION_CODES.M002 });
  } else if (ch.local === false) {
    connected = 'cloud';
    log.push({ level: 'info', code: 'M003', msg: MIGRATION_CODES.M003 });
  } else {
    connected = 'local';
    log.push({ level: 'info', code: 'M003', msg: MIGRATION_CODES.M003 });
  }

  if (connected === 'dual') {
    const mg = {
      id: 'mg', type: 'merge', strategy: map.strategy, categoriesMerge: 'winner',
      branchOrder: ['loc', 'cld'], timeoutMs: 1000, position: { x: 320, y: 360 },
    };
    nodes.push(mg, { id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'loc');
    addEdge('in', 'cld');
    addEdge('loc', 'mg', map.localPriority);
    addEdge('cld', 'mg', map.cloudPriority);
    addEdge('mg', 'out');
  } else if (connected === 'cloud') {
    // 云端单通道：loc 保留但孤立
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'cld');
    addEdge('cld', 'out');
  } else {
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 480 } });
    addEdge('in', 'loc');
    addEdge('loc', 'out');
  }

  flow.nodes = nodes;
  flow.edges = edges;
  return flow;
}

/**
 * 迁移图像拓扑。
 * @param {object} config 配置
 * @param {Array<object>} log 迁移日志
 * @returns {object} 图像流程
 */
function migrateImageFlow(config, log) {
  const ch = authoritativeChannels(config, log);
  const cs = config.contentSafety || {};
  const isCloudOnly = config.moderationMode === 'cloud-only';
  const qc = config.qwenCloud || {};
  const useCloudVision = isCloudOnly || (config.moderation.dualMode === true && qc.enabled === true && qc.visionEnabled === true);

  const flow = emptyFlow('image');
  flow.revision = 1;
  flow.floors = [];
  if (ch.contentSafety === true && cs.enabled === true && cs.imageEnabled !== false) {
    flow.floors.push({ id: 'cs', ref: 'builtin.contentSafety', params: {}, timeoutMs: 10000, enabled: true, deletable: true });
  }

  const nodes = [{ id: 'in', type: 'input', position: { x: 320, y: 40 } }];
  const edges = [];
  const loc = { id: 'vl', type: 'service', ref: 'builtin.localModel', params: { vision: true }, failurePolicy: 'inherit', timeoutMs: 60000, position: { x: 160, y: 260 } };
  const cld = { id: 'cld', type: 'service', ref: 'builtin.cloudModel', params: { vision: true }, failurePolicy: 'inherit', timeoutMs: 30000, position: { x: 480, y: 260 } };
  nodes.push(loc, cld);

  let edgeSeq = 0;
  const addEdge = (from, to, priority) => {
    edgeSeq += 1;
    const e = { id: `e${edgeSeq}`, from, to };
    if (Number.isFinite(priority)) e.priority = priority;
    edges.push(e);
  };

  if (useCloudVision && ch.local !== false) {
    nodes.push(
      { id: 'mg', type: 'merge', strategy: 'highest', categoriesMerge: 'winner', branchOrder: ['vl', 'cld'], timeoutMs: 1000, position: { x: 320, y: 400 } },
      { id: 'out', type: 'output', position: { x: 320, y: 500 } },
    );
    addEdge('in', 'vl');
    addEdge('in', 'cld');
    addEdge('vl', 'mg', 10);
    addEdge('cld', 'mg', 20);
    addEdge('mg', 'out');
  } else if (useCloudVision) {
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 500 } });
    addEdge('in', 'cld');
    addEdge('cld', 'out');
  } else {
    nodes.push({ id: 'out', type: 'output', position: { x: 320, y: 500 } });
    addEdge('in', 'vl');
    addEdge('vl', 'out');
  }

  flow.nodes = nodes;
  flow.edges = edges;
  // finalizers 留空，由 src/flow/index.js#reconcileFinalizers 在插件装载后补齐（坑①显式化）
  flow.finalizers = [];
  return flow;
}

/**
 * 计算「旧开关签名」：拓扑是由这些开关迁移生成的，签名变化 ⇒ 拓扑已陈旧。
 * @param {object} config 配置
 * @returns {object} 签名
 */
function flowSignature(config) {
  const ch = (config && config.moderation && config.moderation.reviewChannels) || {};
  const cs = (config && config.contentSafety) || {};
  const qc = (config && config.qwenCloud) || {};
  return {
    moderationMode: (config && config.moderationMode) || 'local',
    dualMode: (config && config.moderation && config.moderation.dualMode) === true,
    doubleCheck: (config && config.moderation && config.moderation.doubleCheck) === true,
    local: ch.local !== false,
    cloud: ch.cloud !== false,
    contentSafety: ch.contentSafety === true,
    disputeStrategy: ch.disputeStrategy || 'highest',
    csEnabled: cs.enabled === true,
    csTextEnabled: cs.textEnabled !== false,
    csImageEnabled: cs.imageEnabled !== false,
    cloudEnabled: qc.enabled === true,
    cloudVisionEnabled: qc.visionEnabled === true,
  };
}

/**
 * 稳定序列化（键排序）。
 * @param {object} value 值
 * @returns {string} 序列化结果
 */
function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

/**
 * 若拓扑相对当前旧开关已陈旧（例如运行期直接改了 moderationMode / reviewChannels），
 * 则以当前开关重新生成拓扑（仅内存，不落盘）。幂等：签名一致时不做任何事。
 * @param {object} config 配置（原地修改）
 * @returns {{regenerated: boolean, reason: string}} 结果
 */
function syncIfStale(config) {
  const flows = config && config.moderation && config.moderation.flows;
  if (!flows) return { regenerated: false, reason: 'no-flows' };
  const recorded = config._migration && config._migration.v22 && config._migration.v22.from;
  const current = flowSignature(config);
  if (recorded && stableStringify(recorded) === stableStringify(current)) {
    return { regenerated: false, reason: 'in-sync' };
  }
  // 陈旧：以当前开关重建（保留 enabled 开关）
  const enabled = flows.enabled !== false;
  delete flows.text;
  delete flows.image;
  ensureFlows(config);
  config.moderation.flows.enabled = enabled;
  return { regenerated: true, reason: 'stale-signature' };
}

/**
 * 确保 config.moderation.flows 存在且合法（幂等）。
 * @param {object} config 配置（原地修改）
 * @returns {{migrated: boolean, log: Array<object>}} 迁移结果
 */
function ensureFlows(config) {
  const log = [];
  if (!config || typeof config !== 'object') return { migrated: false, log };
  if (!config.moderation) config.moderation = {};
  const existing = config.moderation.flows && typeof config.moderation.flows === 'object' ? config.moderation.flows : {};

  const textOk = existing.text && existing.text.schemaVersion === 1 && Array.isArray(existing.text.nodes) && existing.text.nodes.length > 0;
  const imageOk = existing.image && existing.image.schemaVersion === 1 && Array.isArray(existing.image.nodes) && existing.image.nodes.length > 0;
  if (textOk && imageOk) return { migrated: false, log };

  const text = textOk ? existing.text : migrateTextFlow(config, log);
  const image = imageOk ? existing.image : migrateImageFlow(config, log);

  config.moderation.flows = {
    enabled: existing.enabled !== false,
    text,
    image,
  };
  config._migration = config._migration || {};
  config._migration.v22 = {
    at: new Date().toISOString(),
    from: flowSignature(config),
    log,
  };
  return { migrated: true, log };
}

module.exports = {
  MIGRATION_CODES,
  authoritativeChannels,
  mapDisputeStrategy,
  migrateTextFlow,
  migrateImageFlow,
  flowSignature,
  stableStringify,
  syncIfStale,
  ensureFlows,
};
