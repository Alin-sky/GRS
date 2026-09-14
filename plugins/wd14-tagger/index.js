/**
 * WD14 标签器插件（独立插件）
 *
 * 通过 HTTP 调用独立的 Python 标签服务（wd14/wd14_service.py），把动漫图片的
 * 结构化标签映射为审核风险，作为图片审核的辅助预筛通道。
 *
 * 自包含：client.js（HTTP 客户端）+ rules.js（标签映射）+ lib/linkage.js（联动策略），
 * 本文件只做「插件装配」：注册配置、提供服务、挂载审核钩子。
 *
 * ★ v2.0.0 变化：
 *   - 新增 manifest.json（由 plugin-scanner 扫描装载）
 *   - 新增 linkage 服务与 moderation:image:linkage 事件，把原先硬编码在
 *     src/moderator.js 的「WD14 提级」逻辑搬到这里（主流程不再认识 wd14）
 *   - 原有 4 项配置（enabled/host/scoreScale/generalThreshold）保持不变
 */
const { tagImage, healthCheck } = require('./client');
const { mapTagsToRisk } = require('./rules');
const { createLinkage, LINKAGE_DEFAULTS } = require('./lib/linkage');

// 插件配置项声明（前端「插件系统」卡片据此渲染阈值滑块等控件）
const CONFIG_SCHEMA = {
  name: 'wd14-tagger',
  title: 'WD14 动漫标签预筛',
  description: '通过 WD14 标签器识别动漫图片的裸足/大胸/泳装/色情等特征，作为审核辅助判据。联动策略决定它如何影响最终判定。',
  groups: [
    { id: 'basic', title: '基础配置', desc: '标签预筛的开关、服务地址与风险分数缩放。' },
    { id: 'linkage', title: '联动策略 · 模式与触发', desc: '决定何时触发与视觉模型的联动，以及动漫图判定方式。' },
    { id: 'fusion', title: '联动策略 · 冲突与融合', desc: 'WD14 与视觉模型结论冲突时的取舍，以及加权融合参数。' },
    { id: 'fallback', title: '联动策略 · 降级与熔断', desc: '标签服务不可用时的兜底行为、熔断阈值与批量预筛参数。' },
  ],
  fields: [
    // ─── 原有 4 项（v1.0.0 迁移，行为完全一致）───
    { key: 'enabled', type: 'boolean', label: '启用标签预筛', default: true, group: 'basic',
      desc: '关闭后完全不调用 WD14 标签服务，图片审核仍走视觉模型。' },
    { key: 'host', type: 'text', label: 'Python 服务地址', default: 'http://127.0.0.1:9898', group: 'basic',
      desc: 'WD14 独立 Python 标签服务的 HTTP 地址，默认本机 9898 端口。' },
    { key: 'scoreScale', type: 'slider', label: '风险分数缩放（整体松紧）', min: 0.5, max: 1.5, step: 0.1, default: 1.0, unit: '×', group: 'basic',
      desc: '整体缩放 WD14 输出的风险分数：小于 1 更宽松，大于 1 更严格。' },
    { key: 'generalThreshold', type: 'slider', label: '标签置信度阈值', min: 0.10, max: 0.70, step: 0.05, default: 0.35, unit: '', group: 'basic',
      desc: '低于该置信度的标签会被丢弃，用于过滤噪声标签。' },

    // ─── 联动策略：模式与触发 ───
    {
      key: 'linkage.mode', type: 'select', label: '联动模式', default: LINKAGE_DEFAULTS['linkage.mode'], group: 'linkage',
      desc: '联动模式：off 关闭 / annotate 只记标签不干预 / escalate 只提级 / escalate_deescalate 可提可降 / weighted 加权融合 / parallel_max 并行取高。',
      options: [
        { value: 'off', label: 'off 关闭（完全不调用）' },
        { value: 'annotate', label: 'annotate 观察期（只记标签不干预）' },
        { value: 'escalate', label: 'escalate 只提级（默认，等价旧行为）' },
        { value: 'escalate_deescalate', label: 'escalate_deescalate 可提可降' },
        { value: 'weighted', label: 'weighted 加权融合打分' },
        { value: 'parallel_max', label: 'parallel_max 并行取高' },
      ],
    },
    {
      key: 'linkage.trigger', type: 'select', label: '触发条件', default: LINKAGE_DEFAULTS['linkage.trigger'], group: 'linkage',
      desc: '何时触发联动：always 每次 / vl_uncertain 仅当视觉模型没把握 / wd14_critical 仅 critical 级命中 / wd14_hit 有任意命中。',
      options: [
        { value: 'always', label: 'always 每次都联动' },
        { value: 'vl_uncertain', label: 'vl_uncertain 仅当 VL 没把握' },
        { value: 'wd14_critical', label: 'wd14_critical 仅 critical 级命中' },
        { value: 'wd14_hit', label: 'wd14_hit 有任意命中' },
      ],
    },
    { key: 'linkage.uncertainBelow', type: 'slider', label: 'VL 不确定阈值', min: 0, max: 1, step: 0.05, default: LINKAGE_DEFAULTS['linkage.uncertainBelow'], group: 'linkage',
      desc: '视觉模型置信度低于该值时视为"没把握"，配合 vl_uncertain 触发条件使用。' },
    {
      key: 'linkage.scope', type: 'select', label: '适用范围', default: LINKAGE_DEFAULTS['linkage.scope'], group: 'linkage',
      desc: '联动适用范围：仅动漫图或全部图片。',
      options: [
        { value: 'anime_only', label: 'anime_only 仅动漫图' },
        { value: 'all', label: 'all 全部图片' },
      ],
    },
    {
      key: 'linkage.animeDetect', type: 'select', label: '动漫判定方式', default: LINKAGE_DEFAULTS['linkage.animeDetect'], group: 'linkage',
      desc: '如何判定图片是否为动漫图：角色置信度 / 有评级 / 通用二次元标签。',
      options: [
        { value: 'character_conf', label: 'character_conf 角色置信度' },
        { value: 'rating_present', label: 'rating_present 有评级' },
        { value: 'wd14_general', label: 'wd14_general 通用二次元标签' },
      ],
    },
    { key: 'linkage.animeThreshold', type: 'slider', label: '动漫判定阈值', min: 0.05, max: 0.9, step: 0.05, default: LINKAGE_DEFAULTS['linkage.animeThreshold'], group: 'linkage',
      desc: '动漫判定分数高于该值才视为动漫图。' },
    {
      key: 'linkage.onNonAnime', type: 'select', label: '非动漫图处理', default: LINKAGE_DEFAULTS['linkage.onNonAnime'], group: 'linkage',
      desc: '非动漫图处理：annotate 只记标签 / ignore 不调用（省一次 HTTP）。',
      options: [
        { value: 'annotate', label: 'annotate 只记标签' },
        { value: 'ignore', label: 'ignore 不调用（省一次 HTTP）' },
      ],
    },

    // ─── 联动策略：冲突与融合 ───
    {
      key: 'linkage.conflict', type: 'select', label: '冲突策略', default: LINKAGE_DEFAULTS['linkage.conflict'], group: 'fusion',
      desc: 'WD14 与视觉模型结论冲突时：max 取高 / vl_wins 视觉优先 / wd14_wins 标签器优先 / review 取高并转人工复核。',
      options: [
        { value: 'max', label: 'max 取较高者（默认）' },
        { value: 'vl_wins', label: 'vl_wins 视觉模型优先' },
        { value: 'wd14_wins', label: 'wd14_wins 标签器优先' },
        { value: 'review', label: 'review 取高并标记人工复核' },
      ],
    },
    { key: 'linkage.weightVl', type: 'slider', label: '融合权重 · 视觉模型', min: 0, max: 1, step: 0.05, default: LINKAGE_DEFAULTS['linkage.weightVl'], group: 'fusion',
      desc: '加权融合模式下视觉模型的权重（0~1），与标签器权重共同决定最终分数。' },
    { key: 'linkage.weightWd14', type: 'slider', label: '融合权重 · 标签器', min: 0, max: 1, step: 0.05, default: LINKAGE_DEFAULTS['linkage.weightWd14'], group: 'fusion',
      desc: '加权融合模式下 WD14 标签器的权重（0~1）。' },
    { key: 'linkage.scoreCap', type: 'number', label: '融合分数上限', min: 1, max: 100, default: LINKAGE_DEFAULTS['linkage.scoreCap'], group: 'fusion',
      desc: '融合后分数的上限，防止单通道把分数拉得过高。' },

    // ─── 联动策略：降级与熔断 ───
    {
      key: 'linkage.onWd14Down', type: 'select', label: '标签服务不可用时', default: LINKAGE_DEFAULTS['linkage.onWd14Down'], group: 'fallback',
      desc: '标签服务不可用时：skip 跳过联动 / fail_closed 提级并转人工 / fallback_vl 维持视觉模型判定。',
      options: [
        { value: 'skip', label: 'skip 跳过联动' },
        { value: 'fail_closed', label: 'fail_closed 提级并转人工' },
        { value: 'fallback_vl', label: 'fallback_vl 维持视觉模型判定' },
      ],
    },
    { key: 'linkage.circuitFail', type: 'number', label: '熔断阈值（连续失败次数）', min: 1, max: 20, default: LINKAGE_DEFAULTS['linkage.circuitFail'], group: 'fallback',
      desc: '连续失败达到该次数后打开熔断，暂时停止调用标签服务。' },
    { key: 'linkage.circuitCooldownSec', type: 'number', label: '熔断冷却（秒）', min: 10, max: 3600, default: LINKAGE_DEFAULTS['linkage.circuitCooldownSec'], group: 'fallback',
      desc: '熔断打开后的冷却时间，冷却结束后重新尝试调用标签服务。' },
    { key: 'linkage.batchSkipVl', type: 'boolean', label: '批量跳过视觉模型（只跑标签器）', default: LINKAGE_DEFAULTS['linkage.batchSkipVl'], group: 'fallback',
      desc: '批量任务中只跑 WD14 标签器、跳过视觉模型，用于快速预筛。' },
    { key: 'linkage.batchResizePx', type: 'number', label: '批量预筛分辨率（0=不缩放）', min: 0, max: 2048, default: LINKAGE_DEFAULTS['linkage.batchResizePx'], group: 'fallback',
      desc: '批量预筛时把图片缩放到该分辨率（0=不缩放）以提速。' },
    { key: 'linkage.timeoutMs', type: 'number', label: '请求超时（毫秒）', min: 1000, max: 60000, default: LINKAGE_DEFAULTS['linkage.timeoutMs'], group: 'fallback',
      desc: '单次调用标签服务的超时时间，超时按失败计。' },
    { key: 'linkage.concurrency', type: 'number', label: '标签器并发', min: 1, max: 8, default: LINKAGE_DEFAULTS['linkage.concurrency'], group: 'fallback',
      desc: '同时发往标签服务的最大并发请求数。' },
  ],
};

function wd14Tagger(ctx) {
  // 注册配置（返回可读写配置对象，修改自动持久化）
  const config = ctx.config(CONFIG_SCHEMA);
  const linkage = createLinkage(() => config);

  // 提供服务，供其他插件/主流程注入
  ctx.provide('wd14', {
    tag: (img) => tagImage(img, config.host, config['linkage.timeoutMs']),
    health: () => healthCheck(config.host),
    mapToRisk: (r) => mapTagsToRisk(r, {
      generalThreshold: config.generalThreshold,
      scoreScale: config.scoreScale,
    }),
    schema: CONFIG_SCHEMA,
    config,
  });

  // 提供联动服务：主流程只认识「谁提供 linkage」，不认识 wd14（R-B37）
  ctx.provide('linkage', {
    name: 'wd14',
    resolve: (result, contributions) => linkage.resolve(result, contributions),
    isCircuitOpen: () => linkage.isCircuitOpen(),
    recordFailure: () => linkage.recordFailure(),
    stats: linkage.stats,
  });

  // 挂载图片审核标签钩子（收集模式）
  ctx.on('moderation:image:tag', async (imageBase64) => {
    if (!config.enabled) return { source: 'wd14', disabled: true };
    if (linkage.isCircuitOpen()) return { source: 'wd14', disabled: true, error: 'circuit_open' };
    const result = await tagImage(imageBase64, config.host, config['linkage.timeoutMs']);
    if (!result.available) {
      linkage.recordFailure();
      return { source: 'wd14', error: result.error };
    }
    const mapped = mapTagsToRisk(result, {
      generalThreshold: config.generalThreshold,
      scoreScale: config.scoreScale,
    });
    return {
      source: 'wd14',
      tags: { rating: result.rating, general: result.general, character: result.character },
      risk: { level: mapped.suggestedLevel, score: mapped.suggestedScore, hits: mapped.hits },
    };
  });

  // 挂载图片审核联动解析（短路模式：首个非空结果即最终判定）
  ctx.on('moderation:image:linkage', async (result, contributions) => linkage.resolve(result, contributions));

  // 供批量插件复用的配置读取入口（读方法，无需密码）
  ctx.rpc('wd14.config', () => ({
    enabled: config.enabled,
    host: config.host,
    batchSkipVl: config['linkage.batchSkipVl'],
    batchResizePx: config['linkage.batchResizePx'],
    concurrency: config['linkage.concurrency'],
    timeoutMs: config['linkage.timeoutMs'],
    scoreScale: config.scoreScale,
    generalThreshold: config.generalThreshold,
  }));
}

Object.defineProperty(wd14Tagger, 'name', { value: 'wd14-tagger', configurable: true });
wd14Tagger.description = 'WD14 动漫标签预筛（裸足/大胸/泳装/色情分级）+ 可配置联动策略';
wd14Tagger.version = '1.1.0';

module.exports = wd14Tagger;

module.exports.schema = CONFIG_SCHEMA;
module.exports.configSchema = CONFIG_SCHEMA;
