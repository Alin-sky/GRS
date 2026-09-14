/**
 * 宿主 API 契约（src/host-api/contract.js）
 *
 * ★ 本文件是**核心与插件层之间唯一的共享面**，不含任何运行时逻辑，只有常量与纯判定。
 *   核心（moderator / server）与插件层（cordis-bridge / plugin-host / 插件）双向可见，
 *   但**谁都不允许通过它反向 require 对方内部模块**（由 scripts/lint-plugin-boundary.js 静态把关）。
 *
 * 设计依据：docs/architecture-2026-09-14.md §3.3 / §3.4
 *   - HOST_API_VERSION：manifest.hostApi 必须与之匹配，否则拒绝装载
 *   - PERMISSIONS：插件可声明的权限枚举（v1.0 起移除 host:app）
 *   - INJECT_PERMISSIONS：services.injects ↔ permissions 一致性校验表（修 C18）
 *   - CONFIG_DENY_KEYS：注入插件的 config 投影必须剔除的密钥字段（修 C11/C12）
 */

/** 宿主 API 契约版本（插件 manifest.hostApi 需与之相等） */
const HOST_API_VERSION = '1.0';

/** 宿主程序版本（与 package.json 一致，用于 manifest.host.minVersion 校验） */
const HOST_VERSION = '2.0.0';

/**
 * 插件可声明的权限枚举。
 * ★ v1.0 起移除 'host:app'：插件不得再直接拿到 Express 实例，需要挂载接口请走 ctx.rpc。
 */
const PERMISSIONS = Object.freeze([
  'fs:read',
  'fs:write',
  'net:local',
  'rpc',
  'assets',
  'spawn:git',
  'moderation:use',
  'vision:use',
  'sharp:use',
]);

/** 权限枚举集合（便于 O(1) 判定） */
const PERMISSION_SET = new Set(PERMISSIONS);

/** 历史权限：仍被 manifest 声明时报「未知权限」并拒绝装载（含明确迁移提示） */
const REMOVED_PERMISSIONS = Object.freeze({
  'host:app': '宿主已从契约移除 host:app（v1.0）；插件不得直接挂载 Express 路由，请改用 ctx.rpc 注册接口',
});

/**
 * services.injects 每一项所需权限。
 * - 未列出的注入项（config / logger / projectRoot）无需权限；
 * - 值为 null 表示无需权限。
 */
const INJECT_PERMISSIONS = Object.freeze({
  config: null,
  logger: null,
  projectRoot: null,
  fs: 'fs:read',
  moderator: 'moderation:use',
  vision: 'vision:use',
  sharp: 'sharp:use',
});

/** 宿主注入的服务键全集（插件 inject 超出此集合视为契约外的自研服务，逐个放行） */
const HOST_SERVICE_KEYS = Object.freeze(Object.keys(INJECT_PERMISSIONS));

/**
 * 注入插件前必须剔除的 config 字段名（大小写不敏感，递归匹配）。
 * 覆盖 adminPassword / wordDbPassword / *.apiKey / accessKeySecret 等（§3.2 R4）。
 */
const CONFIG_DENY_KEYS = Object.freeze([
  'adminpassword',
  'worddbpassword',
  'password',
  'apikey',
  'apisecret',
  'accesskeyid',
  'accesskeysecret',
  'secretkey',
  'secret',
  'token',
]);

/** 脱敏后的占位值（保留字段形状，便于插件判断「未配置」） */
const CONFIG_REDACTED = '***';

/** 能力标识（manifest.contributes.capabilities[].id） */
const CAPABILITIES = Object.freeze({
  /** 收集模式：图片标签贡献 */
  IMAGE_TAG: 'image.tag',
  /** 短路模式：图片审核联动判定 */
  IMAGE_LINKAGE: 'image.linkage',
});

/** 能力的输出 schema 名（对应 plugin-gate 中的校验器） */
const OUTPUT_SCHEMAS = Object.freeze({
  MODERATION_TAG_CONTRIBUTION: 'ModerationTagContribution',
  MODERATION_VERDICT: 'ModerationVerdict',
});

/** 单次钩子返回值字节上限（manifest.integrity.maxOutputBytes 可覆盖） */
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

/**
 * 判定权限是否在契约内。
 * @param {string} permission 权限名
 * @returns {boolean}
 */
function isKnownPermission(permission) {
  return PERMISSION_SET.has(permission);
}

/**
 * 校验 services.injects 是否被 permissions 覆盖。
 * @param {string[]} injects manifest.services.injects
 * @param {string[]} permissions manifest.permissions
 * @returns {{ok: boolean, errors: string[]}} 校验结果
 */
function validateInjects(injects, permissions) {
  const errors = [];
  const list = Array.isArray(injects) ? injects : [];
  const granted = new Set(Array.isArray(permissions) ? permissions : []);
  for (const key of list) {
    if (!Object.prototype.hasOwnProperty.call(INJECT_PERMISSIONS, key)) continue; // 插件自定义服务，由 provide 侧保证
    const need = INJECT_PERMISSIONS[key];
    if (!need) continue;
    if (!granted.has(need)) {
      errors.push(`services.injects 含 '${key}'，但 permissions 未声明其所需权限 '${need}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 manifest.hostApi 与当前契约版本是否兼容。
 * 缺省视为兼容（v1 插件无 hostApi 字段时按 1.0 处理）。
 * @param {string|undefined} hostApi manifest.hostApi
 * @returns {{ok: boolean, error?: string}}
 */
function validateHostApi(hostApi) {
  if (hostApi === undefined || hostApi === null || hostApi === '') return { ok: true };
  if (String(hostApi) === HOST_API_VERSION) return { ok: true };
  return {
    ok: false,
    error: `插件宿主 API 版本不匹配：要求 ${hostApi}，当前宿主提供 ${HOST_API_VERSION}`,
  };
}

/** 是否为密钥字段名 */
function isDeniedConfigKey(key) {
  return CONFIG_DENY_KEYS.includes(String(key).toLowerCase());
}

module.exports = {
  HOST_API_VERSION,
  HOST_VERSION,
  PERMISSIONS,
  PERMISSION_SET,
  REMOVED_PERMISSIONS,
  INJECT_PERMISSIONS,
  HOST_SERVICE_KEYS,
  CONFIG_DENY_KEYS,
  CONFIG_REDACTED,
  CAPABILITIES,
  OUTPUT_SCHEMAS,
  DEFAULT_MAX_OUTPUT_BYTES,
  isKnownPermission,
  validateInjects,
  validateHostApi,
  isDeniedConfigKey,
};
