/**
 * 官方错误码映射。
 * 依据：https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *
 * 设计原则：
 *  1. 保留原始 HTTP 状态、错误码与 request id，不做二次包装丢失信息
 *  2. 给出可执行的恢复动作，而不是含糊的「出错了」
 *  3. 明确区分「应用级上限」与「套餐总上限」——官方文档强调不可从错误码本身推断
 */

export const USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage';
export const ERRORS_DOC_URL = 'https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery';

/** Responses 层的结构化错误码 */
const RESPONSES_ERRORS = {
  subscription_sharing_user_not_eligible: {
    http: 403,
    title: '套餐用量对该账号/工作区不可用',
    action: '不要重试，也不要循环走 OAuth。请确认登录的是有 Plus/Pro 的账号与工作区。',
  },
  subscription_sharing_usage_limit_exceeded: {
    http: 429,
    title: '套餐用量已达上限',
    action: `暂停使用套餐的请求，并查看用量设置：${USAGE_SETTINGS_URL} 。注意：这可能是应用级每周上限，也可能是套餐总上限，仅凭该错误码无法判断，也无法推断重置时间。重新登录或反复重试都不会恢复额度。`,
  },
  subscription_sharing_usage_unavailable: {
    http: 503,
    title: '用量状态暂时无法查询',
    action: '保留凭据，稍后以有上限的退避重试。',
  },
  subscription_sharing_unsupported_capability: {
    http: 400,
    title: '请求了套餐不支持的输入/工具/模型',
    action: '检查 error.param 并移除不支持的字段、工具或模型，不要原样重试。',
  },
  subscription_sharing_route_not_supported: {
    http: 403,
    title: '该 HTTP 方法/端点不被支持',
    action: '本流程仅支持 POST /v1/responses。',
  },
  subscription_sharing_invalid_user: {
    http: 401,
    title: '订阅者身份无法验证',
    action: '保留 request id 排查凭据；确认被撤销或刷新失败后，请用户重新登录。',
  },
  chatpass_v2_scope_not_authorized: {
    http: 403,
    title: '授权上下文未授予该操作',
    action: '检查客户端与授权配置，不要重试或改用其他计费方式。',
  },
  chatpass_v2_invalid_authorization_context: {
    http: 403,
    title: '授权上下文无效',
    action: '检查客户端与授权配置，不要重试。',
  },
  subscription_sharing_user_unavailable: {
    http: 503,
    title: '用户/工作区信息暂时不可用',
    action: '保留凭据，稍后以有上限的退避重试。',
  },
};

/** 直接路由准入阶段（流未开始）的状态码 */
const ADMISSION_ERRORS = {
  401: { title: '身份或权限未被接受', action: '检查所选账号与已授予的 scope。' },
  403: { title: '策略或权限检查未通过', action: '可能是服务区域限制，请确认集成配置。' },
  503: { title: '直接路由不可用或未启用', action: '保留凭据，以有上限的退避重试。' },
};

/** 本地客户端侧错误（还没到上游就失败） */
const LOCAL_ERRORS = {
  not_connected: {
    http: 401,
    title: '尚未连接 ChatGPT',
    action: '请先在终端运行 `cpb login` 完成官方授权。',
  },
  no_plan_usage: {
    http: 403,
    title: '未授予 ChatGPT plan usage',
    action: '已登录但缺少 chatgpt.tokens.use.direct。请运行 `cpb login` 重新授权并勾选该权限。',
  },
};

/** 刷新令牌错误码 */
const REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/**
 * 把上游或本地错误整理成结构化结果。
 * @param {{httpStatus?:number, code?:string|null, message?:string|null, param?:string|null, requestId?:string|null, stage?:string}} input
 */
export function describeError(input = {}) {
  const { httpStatus = null, code = null, message = null, param = null, requestId = null, stage = null } = input;

  if (code && LOCAL_ERRORS[code]) {
    const local = LOCAL_ERRORS[code];
    return {
      code,
      httpStatus: local.http,
      upstreamHttpStatus: httpStatus ?? null,
      stage: stage || 'local',
      title: local.title,
      message,
      param,
      requestId,
      action: local.action,
      isUsageLimit: false,
    };
  }

  if (code && RESPONSES_ERRORS[code]) {
    const known = RESPONSES_ERRORS[code];
    return {
      code,
      // 重要：套餐上限等错误是在 HTTP 200 的事件流里返回的。
      // 对调用方必须回规范状态码（如 429），不能原样回 200。
      httpStatus: known.http,
      upstreamHttpStatus: httpStatus ?? null,
      stage,
      title: known.title,
      message,
      param,
      requestId,
      action: known.action,
      docUrl: ERRORS_DOC_URL,
      isUsageLimit: code === 'subscription_sharing_usage_limit_exceeded',
    };
  }

  if (code && REFRESH_ERRORS.has(code)) {
    return {
      code,
      httpStatus,
      stage: stage || 'refresh',
      title: '刷新令牌已失效',
      message,
      param,
      requestId,
      action: '清除失效凭据，并用已保存的 client_id 重新走一次 OAuth。',
      isUsageLimit: false,
    };
  }

  if (!code && httpStatus && ADMISSION_ERRORS[httpStatus]) {
    const known = ADMISSION_ERRORS[httpStatus];
    return {
      code: null,
      httpStatus,
      stage: stage || 'admission',
      title: known.title,
      message,
      param,
      requestId,
      action: known.action,
      isUsageLimit: false,
    };
  }

  return {
    code,
    httpStatus,
    stage,
    title: '未识别的错误',
    message,
    param,
    requestId,
    action: '请保留 HTTP 状态、响应体与 request id 后提交 issue。',
    isUsageLimit: false,
  };
}

/** 从一次 runInference 的结果里提取错误信息 */
export function fromInferenceResult(result) {
  if (result?.ok) return null;
  return describeError({
    httpStatus: result?.httpStatus ?? null,
    code: result?.errorType ?? null,
    message: result?.errorMessage ?? null,
    stage: 'responses',
  });
}

/** 面向命令行/日志的多行摘要 */
export function formatError(err) {
  const parts = [];
  if (err.httpStatus) parts.push(`HTTP ${err.httpStatus}`);
  if (err.code) parts.push(err.code);
  parts.push(err.title);
  const lines = [parts.join(' · ')];
  if (err.message) lines.push(`  ${err.message}`);
  if (err.action) lines.push(`  → ${err.action}`);
  return lines.join('\n');
}
