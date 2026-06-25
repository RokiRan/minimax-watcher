#!/usr/bin/env node
/**
 * minimax-watcher
 *
 * 持续观察 MiniMax（CN 区域）token plan 的剩余量与重置时间。
 *  - 当使用率 ≥ 阈值（默认 98%，即剩余 < 2%）时，调用 NewAPI 接口停用该渠道。
 *  - 当重置时间到达后，调用 NewAPI 接口重新启用渠道。
 *
 * 用法：
 *   cp .env.example .env  →  编辑后填入真实值
 *   node watch.mjs
 *   node watch.mjs --once    # 只跑一轮就退出（用于调试 / cron）
 *
 * 设计原则：
 *   - 零运行时依赖。Node 18+ 自带 fetch / fs / timers。
 *   - 状态本地持久化（state.json），重启后能恢复上次决策，避免重复触发。
 *   - 决策幂等：脚本可重复执行，结果一致。
 *   - 错误分级 + 退避重试，绝不静默吞错。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// ---------- 常量 ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_ONCE = process.argv.includes('--once');

// ---------- .env 加载器（零依赖） ----------
function loadEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉可选的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 仅在尚未设置时填充（系统 env 优先）
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(resolve(__dirname, '.env'));

// ---------- 配置 ----------
const cfg = {
  // MiniMax / minimax coding_plan/remains 已在真实接口上验证过：
  //   GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains
  //   Authorization: Bearer <MINIMAX_API_KEY>
  //   响应：{ model_remains: [{ model_name,
  //                              current_interval_usage_count,
  //                              current_interval_total_count,
  //                              current_interval_remaining_percent,
  //                              end_time, ... }],
  //           base_resp: { status_code, status_msg } }
  // 下面这些都是默认值，按需用同名环境变量覆盖。
  //
  // 计分维度由 MINIMAX_USED_METRIC 决定：
  //   count             — 用 *_usage_count / *_total_count（旧行为）
  //   remaining_percent — 用 100 - *_remaining_percent（直接拿剩余百分比）
  minimax: {
    url: process.env.MINIMAX_QUERY_URL || 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    method: (process.env.MINIMAX_HTTP_METHOD || 'GET').toUpperCase(),
    authHeader: process.env.MINIMAX_AUTH_HEADER || 'Bearer',
    apiKey: process.env.MINIMAX_API_KEY || '',
    extraHeaders: parseJson(process.env.MINIMAX_EXTRA_HEADERS) || {},
    requestBody: parseJson(process.env.MINIMAX_REQUEST_BODY),
    mode: (process.env.MINIMAX_MODE || 'max_usage').toLowerCase(),
    usedMetric: (process.env.MINIMAX_USED_METRIC || 'remaining_percent').toLowerCase(),
    arrayPath: process.env.MINIMAX_ARRAY_PATH || 'model_remains',
    modelFilter: process.env.MINIMAX_MODEL_FILTER || 'general',
    usedField: process.env.MINIMAX_USED_FIELD || 'current_interval_usage_count',
    totalField: process.env.MINIMAX_TOTAL_FIELD || 'current_interval_total_count',
    remainPercentField: process.env.MINIMAX_REMAIN_PERCENT_FIELD || 'current_interval_remaining_percent',
    remainField: process.env.MINIMAX_REMAIN_FIELD || '',
    resetField: process.env.MINIMAX_RESET_FIELD || 'end_time',
    used: numberOrNull(process.env.MINIMAX_USED),
    total: numberOrNull(process.env.MINIMAX_TOTAL),
    remain: numberOrNull(process.env.MINIMAX_REMAIN),
  },
  newapi: {
    baseUrl: process.env.NEWAPI_BASE_URL || '',
    token: process.env.NEWAPI_ADMIN_TOKEN || '',
    channelId: numberOrNull(process.env.NEWAPI_CHANNEL_ID),
    statusEnabled: numberOrNull(process.env.NEWAPI_CHANNEL_STATUS_ENABLED) ?? 1,
    statusDisabled: numberOrNull(process.env.NEWAPI_CHANNEL_STATUS_DISABLED) ?? 0,
  },
  threshold: Number(process.env.USAGE_THRESHOLD ?? 98),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30 * 1000),
  abortDisableAfterMs: Number(process.env.ABORT_DISABLE_AFTER_MS ?? 0),
  enableLeadMs: Number(process.env.ENABLE_LEAD_MS ?? 0),
  stateFile: resolve(__dirname, process.env.STATE_FILE || './state.json'),
  logLevel: process.env.LOG_LEVEL || 'info',
  runOnce: RUN_ONCE || String(process.env.RUN_ONCE).toLowerCase() === 'true',
};

// ---------- 校验 ----------
function assertConfig() {
  const errs = [];
  if (!cfg.newapi.baseUrl) errs.push('NEWAPI_BASE_URL 未配置');
  if (!cfg.newapi.token) errs.push('NEWAPI_ADMIN_TOKEN 未配置');
  if (cfg.newapi.channelId == null) errs.push('NEWAPI_CHANNEL_ID 未配置');
  if (!cfg.minimax.apiKey) errs.push('MINIMAX_API_KEY 未配置');
  if (!cfg.minimax.url) {
    // 兜底：理论上有默认值不会走到这里
    errs.push('MINIMAX_QUERY_URL 未配置（默认值丢失，请检查脚本）');
  }
  if (errs.length) {
    for (const e of errs) log('error', e);
    if (cfg.runOnce) process.exit(1);
    throw new Error(errs.join('; '));
  }
}

// ---------- 日志 ----------
const LOG_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, msg, extra) {
  if (LOG_RANK[level] < LOG_RANK[cfg.logLevel]) return;
  const ts = new Date().toISOString();
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  // 单行结构化日志，方便后续接 Loki / journalctl
  process.stdout.write(`${ts} ${level.toUpperCase()} ${msg}${tail}\n`);
}

// ---------- 工具函数 ----------
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    log('warn', `无法解析 JSON：${text.slice(0, 80)}`, { err: e.message });
    return null;
  }
}

function numberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 按点号路径取值，例如 "base_resp.status_code" 或 "data.list[0].used"
 */
function getByPath(obj, path) {
  if (!path) return null;
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? null : acc[key]), obj);
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把任意时间值统一转换为 Unix 毫秒。
 *  - number 视为秒（如果 < 1e12）或毫秒
 *  - string 视为 ISO8601（也支持 "2026-06-26 12:34:56"）
 */
function toEpochMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    // 兼容 "YYYY-MM-DD HH:mm:ss" 形式
    const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)
      ? v.replace(' ', 'T')
      : v;
    const t = Date.parse(isoLike);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把 epoch ms 同时格式化成 UTC 和 Asia/Shanghai。
 * 输出形如："UTC 2026-06-25T21:00:00Z / 北京时间 2026-06-26 05:00:00 (Asia/Shanghai)"
 */
function formatTime(ms) {
  if (ms == null) return null;
  const utc = new Date(ms).toISOString();
  try {
    const sh = new Date(ms).toLocaleString('sv-SE', {
      timeZone: 'Asia/Shanghai',
    }); // YYYY-MM-DD HH:MM:SS，无 DST 干扰
    return `${utc} / 北京时间 ${sh.replace(' ', ' ')} (Asia/Shanghai)`;
  } catch {
    return utc;
  }
}

// ---------- 状态文件 ----------
function readState() {
  if (!existsSync(cfg.stateFile)) {
    return { channelKnownStatus: null, lastResetAt: null, lastDisableAt: null };
  }
  try {
    const data = JSON.parse(readFileSync(cfg.stateFile, 'utf8'));
    return {
      channelKnownStatus: data.channelKnownStatus ?? null,
      lastResetAt: data.lastResetAt ?? null,
      lastDisableAt: data.lastDisableAt ?? null,
    };
  } catch (e) {
    log('warn', '状态文件损坏，使用空状态', { err: e.message });
    return { channelKnownStatus: null, lastResetAt: null, lastDisableAt: null };
  }
}

function writeState(patch) {
  const prev = readState();
  const next = { ...prev, ...patch };
  try {
    writeFileSync(cfg.stateFile, JSON.stringify(next, null, 2));
  } catch (e) {
    log('error', '写入状态文件失败', { err: e.message });
  }
}

// ---------- MiniMax 查询 ----------
async function fetchMinimaxPlan() {
  const headers = {
    Accept: 'application/json',
    ...cfg.minimax.extraHeaders,
  };
  if (cfg.minimax.apiKey) {
    headers.Authorization = `${cfg.minimax.authHeader} ${cfg.minimax.apiKey}`;
  }
  const init = { method: cfg.minimax.method, headers };
  if (
    cfg.minimax.method === 'POST' &&
    cfg.minimax.requestBody !== null &&
    cfg.minimax.requestBody !== undefined
  ) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    init.body = JSON.stringify(cfg.minimax.requestBody);
  }

  const res = await fetch(cfg.minimax.url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MiniMax API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`MiniMax API 返回非 JSON：${text.slice(0, 200)}`);
  }
  return json;
}

/**
 * 从 MiniMax 响应中解析 (used, total, resetAtMs)。
 *
 * 两种模式：
 *   - single：单对象，按 MINIMAX_USED/TOTAL/REMAIN_FIELD 直接取值（旧行为）
 *   - max_usage：遍历数组（MINIMAX_ARRAY_PATH），找 used/total 比值最大的元素；
 *                resetAtMs 取所有元素的最小 end_time（最早结束）。
 *                可选 MINIMAX_MODEL_FILTER 限定只统计指定 model_name 的元素。
 *
 * 字段来源优先级：显式 MINIMAX_USED / _TOTAL / _REMAIN > dot-path 字段。
 */
function parsePlan(json) {
  if (cfg.minimax.mode === 'max_usage') {
    return parseMaxUsage(json);
  }
  return parseSingle(json);
}

function parseSingle(json) {
  let used = cfg.minimax.used ?? toNumber(getByPath(json, cfg.minimax.usedField));
  let total = cfg.minimax.total ?? toNumber(getByPath(json, cfg.minimax.totalField));
  let remain =
    cfg.minimax.remain ?? toNumber(getByPath(json, cfg.minimax.remainField));
  let resetAtMs = toEpochMs(getByPath(json, cfg.minimax.resetField));

  if (remain != null && total != null && used == null) {
    used = Math.max(0, total - remain);
  }
  if (used != null && remain != null && total == null) {
    total = used + remain;
  }
  if (used != null && total != null && remain == null) {
    remain = Math.max(0, total - used);
  }

  const usagePct =
    used != null && total != null && total > 0 ? (used / total) * 100 : null;

  return { used, total, remain, usagePct, resetAtMs, raw: json };
}

function parseMaxUsage(json) {
  const list = getByPath(json, cfg.minimax.arrayPath);
  if (!Array.isArray(list) || list.length === 0) {
    log('warn', 'max_usage 模式下未找到数组', { arrayPath: cfg.minimax.arrayPath });
    return { used: null, total: null, remain: null, usagePct: null, resetAtMs: null, raw: json, breakdown: [] };
  }

  const filter = cfg.minimax.modelFilter;
  const metric = cfg.minimax.usedMetric;
  const breakdown = [];
  let bestUsedPct = null;
  let bestResetAtMs = null;
  let earliestResetAtMs = null;

  for (const item of list) {
    if (filter && getByPath(item, 'model_name') !== filter) continue;
    const modelName = getByPath(item, 'model_name');
    const resetAtMs = toEpochMs(getByPath(item, cfg.minimax.resetField));

    let usedPct = null;
    let detail = {};

    if (metric === 'remaining_percent') {
      const rem = toNumber(getByPath(item, cfg.minimax.remainPercentField));
      if (rem != null && rem >= 0 && rem <= 100) {
        usedPct = 100 - rem;
        detail = { remainingPercent: rem };
      } else {
        detail = { remainingPercent: rem, skippedReason: 'invalid_percent' };
      }
    } else {
      // 'count'：已用次数 / 总配额
      const used = toNumber(getByPath(item, cfg.minimax.usedField));
      const total = toNumber(getByPath(item, cfg.minimax.totalField));
      if (used != null && total != null && total > 0) {
        usedPct = (used / total) * 100;
        detail = { used, total };
      } else {
        detail = { used, total, skippedReason: 'zero_total' };
      }
    }

    if (usedPct != null) {
      breakdown.push({ modelName, usedPct, resetAtMs, ...detail });
      if (bestUsedPct == null || usedPct > bestUsedPct) {
        bestUsedPct = usedPct;
        // reset 时间随"瓶颈模型"绑定
        bestResetAtMs = resetAtMs;
      }
    } else {
      breakdown.push({ modelName, usedPct: null, resetAtMs, skipped: true, ...detail });
    }

    if (resetAtMs != null && (earliestResetAtMs == null || resetAtMs < earliestResetAtMs)) {
      earliestResetAtMs = resetAtMs;
    }
  }

  return {
    used: null,
    total: null,
    remain: null,
    usagePct: bestUsedPct,
    resetAtMs: bestResetAtMs,
    raw: json,
    breakdown,
    _earliestResetForLog: earliestResetAtMs,
  };
}

// ---------- NewAPI 渠道管理 ----------
async function updateChannelStatus(newStatus, reason) {
  const url = `${cfg.newapi.baseUrl.replace(/\/+$/, '')}/api/channel/`;
  // one-api UpdateChannel 接收完整 channel 对象；最小必要字段：id + status
  // 同时带上 name / type 防止某些 fork 校验失败（占位 unknown，由后端忽略）
  const body = {
    id: cfg.newapi.channelId,
    status: newStatus,
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.newapi.token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NewAPI HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (json && typeof json === 'object' && 'success' in json && !json.success) {
    throw new Error(`NewAPI 返回 success=false: ${JSON.stringify(json).slice(0, 200)}`);
  }
  log('info', `NewAPI 渠道状态已更新`, {
    channelId: cfg.newapi.channelId,
    newStatus,
    reason,
  });
  writeState({
    channelKnownStatus: newStatus,
    lastDisableAt: newStatus === cfg.newapi.statusDisabled ? Date.now() : null,
  });
  return json;
}

// ---------- 决策 ----------
function decide(plan, state, nowMs) {
  const { usagePct, resetAtMs } = plan;
  if (usagePct == null) {
    return {
      action: 'skip',
      reason: '无法计算使用率（缺少 used/total 或 remaining_percent）',
    };
  }
  if (usagePct >= cfg.threshold) {
    if (state.channelKnownStatus === cfg.newapi.statusDisabled) {
      return {
        action: 'noop',
        reason: `用量 ${usagePct.toFixed(2)}% ≥ 阈值 ${cfg.threshold}%，但渠道已停用`,
        usagePct,
      };
    }
    if (
      cfg.abortDisableAfterMs > 0 &&
      state.lastDisableAt != null &&
      nowMs - state.lastDisableAt > cfg.abortDisableAfterMs
    ) {
      return {
        action: 'skip',
        reason: `用量 ${usagePct.toFixed(2)}% 已超阈值，但已超过放弃时长，跳过停用`,
        usagePct,
      };
    }
    return {
      action: 'disable',
      reason: `用量 ${usagePct.toFixed(2)}% ≥ 阈值 ${cfg.threshold}%`,
      usagePct,
      resetAtMs,
    };
  }

  if (
    state.channelKnownStatus === cfg.newapi.statusDisabled &&
    resetAtMs != null &&
    nowMs >= resetAtMs - cfg.enableLeadMs
  ) {
    return {
      action: 'enable',
      reason: `已到重置时间（${formatTime(resetAtMs)}）`,
      usagePct,
      resetAtMs,
    };
  }

  return {
    action: 'noop',
    reason: `用量 ${usagePct.toFixed(2)}% < 阈值 ${cfg.threshold}%，无需动作`,
    usagePct,
  };
}

// ---------- 单轮执行 ----------
async function tick() {
  const state = readState();
  const nowMs = Date.now();

  let plan;
  try {
    const json = await fetchMinimaxPlan();
    plan = parsePlan(json);
  } catch (e) {
    log('error', '查询 MiniMax 用量失败', { err: e.message });
    return;
  }

  log('info', '查询结果', {
    usagePct: plan.usagePct != null ? Number(plan.usagePct.toFixed(2)) : null,
    remainingPercent:
      plan.usagePct != null ? Number((100 - plan.usagePct).toFixed(2)) : null,
    resetAt: formatTime(plan.resetAtMs),
    metric: cfg.minimax.usedMetric,
    modelFilter: cfg.minimax.modelFilter || '(all)',
  });
  if (plan.breakdown && cfg.logLevel === 'debug') {
    log('debug', '按模型明细', { breakdown: plan.breakdown });
  }

  const decision = decide(plan, state, nowMs);
  log('info', `决策：${decision.action}`, { reason: decision.reason });

  // 记录最近一次 reset 时间，便于排查
  if (plan.resetAtMs && plan.resetAtMs !== state.lastResetAt) {
    writeState({ lastResetAt: plan.resetAtMs });
  }

  if (decision.action === 'disable') {
    try {
      await updateChannelStatus(cfg.newapi.statusDisabled, decision.reason);
    } catch (e) {
      log('error', '停用渠道失败', { err: e.message });
    }
  } else if (decision.action === 'enable') {
    try {
      await updateChannelStatus(cfg.newapi.statusEnabled, decision.reason);
    } catch (e) {
      log('error', '启用渠道失败', { err: e.message });
    }
  }
}

// ---------- 主循环 ----------
let stopping = false;
async function main() {
  assertConfig();
  log('info', 'minimax-watcher 启动', {
    threshold: cfg.threshold,
    pollIntervalMs: cfg.pollIntervalMs,
    channelId: cfg.newapi.channelId,
    runOnce: cfg.runOnce,
  });

  while (!stopping) {
    await tick();
    if (cfg.runOnce) break;
    // 优雅地响应 Ctrl+C：把等待也变成可中断
    await new Promise((resolveWait) => {
      const t = setTimeout(resolveWait, cfg.pollIntervalMs);
      const abort = () => {
        clearTimeout(t);
        resolveWait();
      };
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
    });
  }
  log('info', 'minimax-watcher 退出');
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('warn', `收到 ${signal}，准备退出`);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log('error', '未处理的 Promise 拒绝', { err: String(err) });
});

main().catch((e) => {
  log('error', '致命错误', { err: e.message, stack: e.stack });
  process.exit(1);
});