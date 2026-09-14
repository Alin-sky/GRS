/**
 * WD14 标签 → 审核风险映射规则
 * 标签名 → { level, score, label }
 * level: safe/low/medium/high/critical；score 为对应 pornographic 维度分数
 */
const TAG_RULES = {
  // 明确色情 → critical
  'nude':               { level: 'critical', score: 90, label: '裸露' },
  'completely_nude':    { level: 'critical', score: 95, label: '完全裸露' },
  'sex':                { level: 'critical', score: 95, label: '性行为' },
  'vaginal':            { level: 'critical', score: 95, label: '性行为' },
  'penis':              { level: 'critical', score: 95, label: '性器官' },
  'nipples':            { level: 'critical', score: 90, label: '乳头裸露' },
  'pussy':              { level: 'critical', score: 95, label: '性器官' },
  // 明显性暗示 / 挑逗 → high
  'spread_legs':        { level: 'high', score: 80, label: '张腿挑逗' },
  'no_panties':         { level: 'high', score: 80, label: '真空/未穿内裤' },
  'underwear_only':     { level: 'high', score: 75, label: '只穿内衣' },
  'ahegao':             { level: 'high', score: 78, label: '高潮脸(性暗示)' },
  // 敏感部位 / 特写 → medium
  'barefoot':           { level: 'medium', score: 62, label: '裸足' },
  'feet':               { level: 'medium', score: 60, label: '脚部' },
  'foot_focus':         { level: 'medium', score: 62, label: '脚部特写' },
  'armpit':             { level: 'medium', score: 60, label: '腋下' },
  'cleavage':           { level: 'medium', score: 60, label: '乳沟' },
  'large_breasts':      { level: 'medium', score: 58, label: '大胸' },
  'panties':            { level: 'medium', score: 58, label: '内裤露出' },
  'underwear':          { level: 'medium', score: 55, label: '内衣' },
  'thighs':             { level: 'medium', score: 55, label: '大腿特写' },
  // 暴露服饰 → low
  'swimsuit':           { level: 'low', score: 45, label: '泳装' },
  'bikini':             { level: 'low', score: 45, label: '比基尼' },
  'bunny_suit':         { level: 'low', score: 45, label: '兔女郎' },
  'lingerie':           { level: 'low', score: 45, label: '情趣内衣' },
  'micro_bikini':       { level: 'medium', score: 58, label: '超暴露泳装' },
};

// rating 评级 → 等级映射（get_wd14_tags 返回的 rating 字段）
const RATING_RULES = {
  explicit:     { level: 'critical', score: 90, label: 'explicit 评级' },
  questionable: { level: 'high', score: 70, label: 'questionable 评级' },
  sensitive:    { level: 'medium', score: 55, label: 'sensitive 评级' },
  general:      { level: null, score: 0, label: 'general 评级' },
};

const LEVEL_ORDER = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * 把 WD14 标签结果映射为审核风险。
 * @param {object} wd14Result - { available, rating, general }
 * @param {object} opts - { generalThreshold, scoreScale }
 * @returns { { available, hits, suggestedLevel, suggestedScore } }
 */
function mapTagsToRisk(wd14Result, opts = {}) {
  const generalThreshold = opts.generalThreshold ?? 0.35;
  const scoreScale = opts.scoreScale ?? 1.0;
  if (!wd14Result || !wd14Result.available) {
    return { available: false, hits: [], suggestedLevel: null, suggestedScore: 0 };
  }
  const hits = [];
  let worstLevel = 'safe';
  let worstScore = 0;
  const scale = (s) => Math.min(100, Math.round(s * scoreScale));

  // 1. rating 评级优先（取置信度最高的评级）
  const rating = wd14Result.rating || {};
  const ratingScores = Object.entries(rating).sort((a, b) => b[1] - a[1]);
  if (ratingScores.length > 0) {
    const [topRating, topScore] = ratingScores[0];
    const rule = RATING_RULES[topRating];
    if (rule && rule.level && topScore > 0.5) {
      hits.push({ tag: 'rating:' + topRating, level: rule.level, score: scale(rule.score), label: rule.label });
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[worstLevel]) {
        worstLevel = rule.level;
        worstScore = scale(rule.score);
      }
    }
  }

  // 2. 具体标签映射
  const general = wd14Result.general || {};
  for (const [tag, score] of Object.entries(general)) {
    const rule = TAG_RULES[tag];
    if (rule && score >= generalThreshold) {
      hits.push({ tag, level: rule.level, score: scale(rule.score), label: rule.label });
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[worstLevel]) {
        worstLevel = rule.level;
        worstScore = scale(rule.score);
      }
    }
  }

  return {
    available: true,
    rating: Object.keys(rating).reduce((acc, k) => { acc[k] = Math.round(rating[k] * 100); return acc; }, {}),
    hits,
    suggestedLevel: hits.length > 0 ? worstLevel : null,
    suggestedScore: worstScore,
  };
}

module.exports = { TAG_RULES, RATING_RULES, LEVEL_ORDER, mapTagsToRisk };
