import { sendPushNotification } from '@mmmike/web-push/send';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS
    }
  });
}

function latestTimestamp(...values) {
  return values.reduce((latest, value) => {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
}

function autoReplyIntervalMs(value) {
  const minutes = Number(value || 60);
  return Math.max(5, Number.isFinite(minutes) ? minutes : 60) * 60 * 1000;
}

function checkAuth(request, env) {
  // The API must fail closed: an unset token must never make the Worker public.
  if (typeof env.BACKEND_TOKEN !== 'string' || !env.BACKEND_TOKEN.trim()) return false;

  const auth = request.headers.get('Authorization') || '';

  return auth === `Bearer ${env.BACKEND_TOKEN.trim()}`;
}

// ===================== 存储布局（v2）=====================
// Durable Object（SQLite 版）单个值（key + value）上限 2 MB。
// 旧版把所有东西塞进同一个 key（data），任务记录和自动回复历史越积越多，
// 超过 2 MB 后所有写入都会失败。现在拆开存，每个值都很小：
//   meta                  订阅、聊天设置、未读消息、AI 设置
//   body:<chatId>:<n>     开了自动回复的聊天的请求内容（已裁剪，按块存）
//   job:<jobId>           AI 任务的状态与回复
//   jobreq:<jobId>:<n>    AI 任务的请求内容（按块存，任务结束就删除）
// 旧版的 data 会在第一次访问时自动迁移。
const STORAGE_CHUNK_CHARS = 400000; // 每块字符数，远低于 2 MB（中文按 3 字节算也只有约 1.2 MB）
const MAX_JOBS = 100; // 最多保留的 AI 任务记录
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 任务记录保留时间
const MAX_PENDING_MESSAGES = 100; // 未读消息最多条数
const MAX_PENDING_CHARS = 600000; // 未读消息总字数上限
const AUTO_REPLY_MAX_MESSAGES = 80; // 自动回复保留的非 system 消息条数
const AUTO_REPLY_MAX_CHARS = 400000; // 自动回复请求内容总字数上限

function emptyMeta() {
  return {
    v: 2,
    subscriptions: [],
    chats: {},
    proactive: {},
    pendingMessages: [],
    aiConfig: null,
    jobs: {}
  };
}

function normalizeMeta(meta) {
  const base = emptyMeta();
  const result = { ...base, ...(meta || {}) };
  result.subscriptions = Array.isArray(result.subscriptions) ? result.subscriptions : [];
  result.chats = result.chats && typeof result.chats === 'object' ? result.chats : {};
  result.proactive = result.proactive && typeof result.proactive === 'object' ? result.proactive : {};
  result.pendingMessages = Array.isArray(result.pendingMessages) ? result.pendingMessages : [];
  result.jobs = result.jobs && typeof result.jobs === 'object' ? result.jobs : {};
  return result;
}

function subscriptionEndpoint(item) {
  return item?.subscription?.endpoint || item?.endpoint || '';
}

function bodyKey(chatId) {
  return `body:${String(chatId).slice(0, 300)}`;
}

function jobKey(jobId) {
  return `job:${jobId}`;
}

function jobRequestKey(jobId) {
  return `jobreq:${jobId}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 限制未读消息的条数和总量，只丢最旧的。
function limitPendingMessages(list) {
  let messages = (Array.isArray(list) ? list : []).slice(-MAX_PENDING_MESSAGES);
  while (messages.length > 1 && JSON.stringify(messages).length > MAX_PENDING_CHARS) {
    messages = messages.slice(1);
  }
  return messages;
}

// 裁剪自动回复要保存的请求内容：
// 1. 图片只在当次对话需要，主动消息用不到，换成文字占位，避免体积暴增；
// 2. 所有 system 消息都保留（人设、世界书、CoT 指令等），其余只留最近的若干条；
// 3. 仍然太大时继续丢掉最旧的对话，至少保留最后几条。
function trimAutoReplyBody(body) {
  if (!body || !Array.isArray(body.messages)) return body;

  let messages = body.messages.map(message => {
    if (message && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map(part =>
          part && part.type === 'image_url' ? { type: 'text', text: '[图片已省略]' } : part
        )
      };
    }
    return message;
  });

  const keep = new Set();
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'system') {
      keep.add(i);
    } else if (kept < AUTO_REPLY_MAX_MESSAGES) {
      keep.add(i);
      kept++;
    }
  }
  messages = messages.filter((_, index) => keep.has(index));

  const conversationCount = () => messages.filter(message => message?.role !== 'system').length;
  while (JSON.stringify(messages).length > AUTO_REPLY_MAX_CHARS && conversationCount() > 4) {
    messages.splice(messages.findIndex(message => message?.role !== 'system'), 1);
  }

  // 对话部分不要以 assistant 开头（部分 API 要求第一条是 user）。
  const first = messages.findIndex(message => message?.role !== 'system');
  if (first !== -1 && messages[first]?.role === 'assistant' && conversationCount() > 1) {
    messages.splice(first, 1);
  }

  return { ...body, messages };
}

// ===== 安静时段 =====
// qh = { enabled, start:'HH:MM', end:'HH:MM', timezone:'Asia/Shanghai' }；start > end 表示跨天。
function quietMinutes(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return fallback;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : fallback;
}

// 返回 { start, end, tz }；未启用或设置无效时返回 null（无效时区视为 UTC）。
function parseQuietHours(qh) {
  if (!qh || !qh.enabled) return null;
  const start = quietMinutes(qh.start, 0);
  const end = quietMinutes(qh.end, 480);
  if (start === end) return null;
  let tz = typeof qh.timezone === 'string' && qh.timezone ? qh.timezone : 'UTC';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { tz = 'UTC'; }
  return { start, end, tz };
}

function localMinutes(tz, t) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(t));
  return Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value);
}

function isQuietAt(qh, t) {
  const q = parseQuietHours(qh);
  if (!q) return false;
  const m = localMinutes(q.tz, t);
  return q.start < q.end ? (m >= q.start && m < q.end) : (m >= q.start || m < q.end);
}

// 若 t 落在安静时段内，返回该时段结束的时间；否则原样返回 t。
function skipQuiet(qh, t) {
  const q = parseQuietHours(qh);
  if (!q || !isQuietAt(qh, t)) return t;
  const m = localMinutes(q.tz, t);
  const remain = ((q.end - m) + 1440) % 1440 || 1440;
  return t - (t % 60000) + remain * 60000;
}

// 下一次 alarm 的时间；没有需要排程的聊天时返回 null。
function computeNextAlarm(meta, now = Date.now()) {
  let next = 0;
  for (const chat of Object.values(meta.chats || {})) {
    const ar = chat.autoReply;
    if (!ar || !ar.enabled || !(chat.bodyParts > 0)) continue;
    let at = (latestTimestamp(ar.lastTriggerTime, chat.lastUserMessageAt) || now) + autoReplyIntervalMs(ar.interval);
    // 落在安静时段内就顺延到时段结束（已过期的按当前时间判断）
    { const probe = Math.max(at, now); const shifted = skipQuiet(ar.quietHours, probe); if (shifted !== probe) at = shifted; }
    if (!next || at < next) next = at;
  }
  return next || null;
}

// 返回给 App 查询的任务信息：不含请求内容和 API Key。
function publicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    error: job.error,
    response: job.response,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    chatId: job.chatId,
    chatType: job.chatType
  };
}

export class BackgroundBackend {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // ---------- 大对象：按块存取，避免单个值超过 2 MB ----------

  async putBig(key, value) {
    const text = JSON.stringify(value === undefined ? null : value);
    const entries = {};
    let parts = 0;
    let start = 0;
    do {
      let end = Math.min(text.length, start + STORAGE_CHUNK_CHARS);
      // 不要把一个 emoji（代理对）切成两半。
      if (end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end++;
      }
      entries[`${key}:${parts}`] = text.slice(start, end);
      parts++;
      start = end;
    } while (start < text.length);
    await this.state.storage.put(entries);
    return parts;
  }

  async getBig(key, parts) {
    if (!(parts > 0)) return null;
    const keys = Array.from({ length: parts }, (_, index) => `${key}:${index}`);
    const stored = await this.state.storage.get(keys);
    let text = '';
    for (const part of keys) {
      const piece = stored.get(part);
      if (typeof piece !== 'string') throw new Error(`存储数据不完整：${part}`);
      text += piece;
    }
    return JSON.parse(text);
  }

  async deleteBig(key, parts) {
    if (!(parts > 0)) return;
    const keys = Array.from({ length: parts }, (_, index) => `${key}:${index}`);
    await this.state.storage.delete(keys);
  }

  // ---------- meta ----------

  async loadMeta() {
    const stored = await this.state.storage.get('meta');
    if (stored) return normalizeMeta(stored);
    const legacy = await this.state.storage.get('data');
    if (legacy) return this.migrateLegacy(legacy);
    return emptyMeta();
  }

  async saveMeta(meta) {
    await this.state.storage.put('meta', meta);
  }

  // 把旧版单个 data 拆成新布局。可重复执行：最后才写 meta 并删除 data。
  async migrateLegacy(legacy) {
    const meta = emptyMeta();
    meta.subscriptions = Array.isArray(legacy.subscriptions) ? legacy.subscriptions : [];
    meta.proactive = legacy.proactive || {};
    meta.aiConfig = legacy.aiConfig || null;
    meta.pendingMessages = limitPendingMessages(legacy.pendingMessages);

    for (const [chatId, chat] of Object.entries(legacy.chats || {})) {
      const { requestBody, ...rest } = chat || {};
      meta.chats[chatId] = { ...rest, bodyParts: 0, bodyRev: 0 };
      if (requestBody && rest.autoReply?.enabled) {
        meta.chats[chatId].bodyParts = await this.putBig(bodyKey(chatId), trimAutoReplyBody(requestBody));
      }
    }

    const jobs = Object.entries(legacy.aiJobs || {})
      .sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0))
      .slice(0, MAX_JOBS);
    for (const [jobId, job] of jobs) {
      const { requestBody, ...rest } = job || {};
      rest.jobId = rest.jobId || jobId;
      rest.reqParts = 0;
      if (rest.status === 'queued' || rest.status === 'processing') {
        // 还没处理完的任务保留请求内容，让队列继续完成。
        rest.reqParts = await this.putBig(jobRequestKey(jobId), requestBody || {});
      } else {
        // 已结束的任务不再需要请求内容和 API Key。
        delete rest.aiConfig;
      }
      await this.state.storage.put(jobKey(jobId), rest);
      meta.jobs[jobId] = Number(rest.createdAt || 0);
    }

    await this.saveMeta(meta);
    await this.state.storage.delete('data');
    return meta;
  }

  // 删除过期或超出数量的任务记录（连同请求内容）。
  async pruneJobs(meta, keepRoom = 1) {
    const now = Date.now();
    const entries = Object.entries(meta.jobs).sort((a, b) => b[1] - a[1]);
    const removeIds = [];
    entries.forEach(([jobId, createdAt], index) => {
      if (now - createdAt > JOB_TTL_MS || index >= MAX_JOBS - keepRoom) removeIds.push(jobId);
    });
    for (const jobId of removeIds) {
      const job = await this.state.storage.get(jobKey(jobId));
      await this.deleteBig(jobRequestKey(jobId), job?.reqParts || 0);
      await this.state.storage.delete(jobKey(jobId));
      delete meta.jobs[jobId];
    }
  }

  // 依次发送一批通知；返回被判定失效、应从订阅里移除的 endpoint。
  async pushAll(subscriptions, payloads, stats = null) {
    let current = subscriptions || [];
    for (let index = 0; index < payloads.length; index++) {
      if (index > 0) await sleep(350);
      current = await sendToAll(this.env, current, payloads[index], stats);
    }
    const kept = new Set(current.map(subscriptionEndpoint));
    return new Set((subscriptions || []).map(subscriptionEndpoint).filter(endpoint => !kept.has(endpoint)));
  }

  // 发送通知期间别的请求可能已改过订阅，所以重新读取后只删除失效的那几条。
  async removeSubscriptions(removed) {
    if (!removed || !removed.size) return;
    const meta = await this.loadMeta();
    const before = meta.subscriptions.length;
    meta.subscriptions = meta.subscriptions.filter(item => !removed.has(subscriptionEndpoint(item)));
    if (meta.subscriptions.length !== before) await this.saveMeta(meta);
  }

  async setAlarmIfChanged(timestamp) {
    const currentAlarm = await this.state.storage.getAlarm();
    if (timestamp == null) {
      if (currentAlarm !== null) await this.state.storage.deleteAlarm();
      return;
    }
    if (currentAlarm !== timestamp) {
      await this.state.storage.setAlarm(timestamp);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/__internal/jobs/create' && request.method === 'POST') {
      const body = await request.json();
      if (await this.state.storage.get(jobKey(body.jobId))) return json({ ok: true, existing: true });
      const meta = await this.loadMeta();
      await this.pruneJobs(meta);
      const reqParts = await this.putBig(jobRequestKey(body.jobId), body.requestBody || {});
      const createdAt = Date.now();
      await this.state.storage.put(jobKey(body.jobId), {
        jobId: body.jobId, status: 'queued', createdAt, aiConfig: body.aiConfig, reqParts,
        chatId: body.chatId || '', chatType: body.chatType || 'private',
        chatName: String(body.chatName || meta.chats?.[body.chatId]?.remarkName || meta.chats?.[body.chatId]?.realName || '').slice(0, 120),
        chatStatusRegex: String(body.chatStatusRegex || meta.chats?.[body.chatId]?.statusRegex || '').slice(0, 500),
        appUrl: body.appUrl || './'
      });
      meta.jobs[body.jobId] = createdAt;
      await this.saveMeta(meta);
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/read' && request.method === 'GET') {
      const job = await this.state.storage.get(jobKey(url.searchParams.get('jobId')));
      return job ? json({ ok: true, job: publicJob(job) }) : json({ error: 'Job not found' }, 404);
    }

    if (url.pathname === '/__internal/jobs/claim' && request.method === 'POST') {
      const body = await request.json();
      const job = await this.state.storage.get(jobKey(body.jobId));
      if (!job || (job.status !== 'queued' && !(job.status === 'processing' && Date.now() - Number(job.startedAt || 0) > 14 * 60 * 1000))) return json({ ok: false });
      const requestBody = (await this.getBig(jobRequestKey(body.jobId), job.reqParts)) || {};
      job.status = 'processing';
      job.startedAt = Date.now();
      await this.state.storage.put(jobKey(body.jobId), job);
      return json({ ok: true, job: { ...job, requestBody } });
    }

    if (url.pathname === '/__internal/jobs/requeue' && request.method === 'POST') {
      const body = await request.json();
      const job = await this.state.storage.get(jobKey(body.jobId));
      if (job?.status === 'processing') {
        job.status = 'queued';
        delete job.startedAt;
        await this.state.storage.put(jobKey(body.jobId), job);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/complete' && request.method === 'POST') {
      const body = await request.json();
      const job = await this.state.storage.get(jobKey(body.jobId));
      if (!job) return json({ error: 'Job not found' }, 404);
      // 用户已取消：丢弃结果，不保存回复、不推送通知。
      if (job.status === 'cancelled') return json({ ok: true, cancelled: true });
      const requestParts = job.reqParts || 0;
      job.status = body.error ? 'failed' : 'completed';
      job.updatedAt = Date.now();
      // 任务结束后请求内容和 API Key 都不再需要，立刻清掉。
      delete job.aiConfig;
      job.reqParts = 0;
      if (body.error) job.error = String(body.error).slice(0, 1500);
      else job.response = body.response;
      await this.state.storage.put(jobKey(body.jobId), job);
      await this.deleteBig(jobRequestKey(body.jobId), requestParts);

      const content = body.error ? '' : body.response?.choices?.[0]?.message?.content;
      if (content) {
        // 先保存回复再发 Push，这样从通知点进 App 时可以马上拉到这条消息。
        const meta = await this.loadMeta();
        meta.pendingMessages.push({ id: body.jobId, chatId: job.chatId, chatType: job.chatType,
          role: 'assistant', content: String(content), timestamp: job.updatedAt });
        meta.pendingMessages = limitPendingMessages(meta.pendingMessages);
        await this.saveMeta(meta);

        const notificationMessages = splitNotificationMessages(content, job.chatStatusRegex || meta.chats?.[job.chatId]?.statusRegex || '');
        const title = job.chatName || meta.chats?.[job.chatId]?.remarkName || meta.chats?.[job.chatId]?.realName || '新消息';
        const removed = await this.pushAll(meta.subscriptions, notificationMessages.map((text, index) => ({
          title,
          body: text,
          tag: `uwu-${job.jobId || body.jobId}-${index}`,
          url: job.appUrl,
          chatId: job.chatId, chatType: job.chatType
        })));
        await this.removeSubscriptions(removed);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/cancel' && request.method === 'POST') {
      const body = await request.json();
      const meta = await this.loadMeta();
      const job = await this.state.storage.get(jobKey(body.jobId));
      const reqParts = job?.reqParts || 0;
      // 任务可能还没送达（留下已取消标记），也可能排队中/处理中/已完成但 App 还没拿到。
      const next = { ...(job || {}), jobId: body.jobId, status: 'cancelled', updatedAt: Date.now(), reqParts: 0 };
      delete next.aiConfig;
      delete next.response;
      await this.state.storage.put(jobKey(body.jobId), next);
      if (reqParts) await this.deleteBig(jobRequestKey(body.jobId), reqParts);
      meta.jobs[body.jobId] = meta.jobs[body.jobId] || next.updatedAt;
      const remaining = meta.pendingMessages.filter(item => item.id !== body.jobId);
      if (remaining.length !== meta.pendingMessages.length) meta.pendingMessages = remaining;
      await this.saveMeta(meta);
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/ack' && request.method === 'POST') {
      const body = await request.json();
      const meta = await this.loadMeta();
      const remainingMessages = meta.pendingMessages.filter(item => item.id !== body.jobId);
      if (remainingMessages.length !== meta.pendingMessages.length) {
        meta.pendingMessages = remainingMessages;
        await this.saveMeta(meta);
      }
      // App 已经拿到回复，任务里的回复内容不用再留着，只保留状态。
      const job = await this.state.storage.get(jobKey(body.jobId));
      if (job && job.response !== undefined) {
        delete job.response;
        await this.state.storage.put(jobKey(body.jobId), job);
      }
      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/push/register' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const meta = await this.loadMeta();

      meta.subscriptions = meta.subscriptions
        .filter(
          item =>
            subscriptionEndpoint(item) !==
            body.subscription?.endpoint
        );

      if (body.subscription) {
        meta.subscriptions.push({
          subscription: body.subscription,
          appUrl: body.appUrl || './',
          timezone: body.timezone || 'UTC'
        });
      }

      await this.saveMeta(meta);

      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/messages/pull' &&
      request.method === 'GET'
    ) {
      const meta = await this.loadMeta();

      return json({
        ok: true,
        messages: meta.pendingMessages
      });
    }

    if (url.pathname === '/v1/messages/ack' && request.method === 'POST') {
      const body = await request.json();
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (ids.size) {
        const meta = await this.loadMeta();
        const remainingMessages = meta.pendingMessages.filter(item => !ids.has(String(item.id)));
        if (remainingMessages.length !== meta.pendingMessages.length) {
          meta.pendingMessages = remainingMessages;
          await this.saveMeta(meta);
        }
      }
      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/push/test' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const meta = await this.loadMeta();
      if (!meta.subscriptions.length) return json({ error: '这台设备还没有注册后台通知' }, 400);
      const pushStats = { sent: 0, failed: 0, errors: [] };
      const removed = await this.pushAll(
        meta.subscriptions,
        [{
          title: body.title || '后台通知',
          body: body.body || '后台通知测试成功',
          url: body.url || './'
        }],
        pushStats
      );
      await this.removeSubscriptions(removed);

      if (!pushStats.sent) return json({
        error: `推送发送失败（失败数：${pushStats.failed}）`,
        failures: pushStats.errors.slice(0, 5)
      }, 502);

      return json({ ok: true, sent: pushStats.sent, subscriptions: meta.subscriptions.length - removed.size });
    }

    // 保存当前应用中的 AI API 设置。
    if (
      url.pathname === '/v1/ai/config' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const meta = await this.loadMeta();
      const ai = body.aiConfig || {};

      if (
        !ai.url ||
        !ai.key ||
        !ai.model
      ) {
        return json(
          {
            error:
              'AI API 配置不完整，请先设置 API 地址、密钥和模型'
          },
          400
        );
      }

      const nextAiConfig = {
        provider: String(
          ai.provider || 'newapi'
        ),
        url: String(ai.url).trim(),
        key: String(ai.key).trim(),
        model: String(ai.model).trim()
      };

      if (JSON.stringify(meta.aiConfig) !== JSON.stringify(nextAiConfig)) {
        meta.aiConfig = nextAiConfig;
        await this.saveMeta(meta);
      }

      return json({
        ok: true,
        synced: true
      });
    }

    if (
      url.pathname === '/v1/sync' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const meta = await this.loadMeta();
      let metaChanged = false;

      if (
        body.aiConfig?.url &&
        body.aiConfig?.key &&
        body.aiConfig?.model
      ) {
        const nextAiConfig = {
          provider: String(
            body.aiConfig.provider || 'newapi'
          ),
          url: String(body.aiConfig.url).trim(),
          key: String(body.aiConfig.key).trim(),
          model: String(body.aiConfig.model).trim()
        };
        if (JSON.stringify(meta.aiConfig) !== JSON.stringify(nextAiConfig)) {
          meta.aiConfig = nextAiConfig;
          metaChanged = true;
        }
      }

      const previousChat = meta.chats[body.chatId] || {};
      const autoReply = body.autoReply || previousChat.autoReply || {
        enabled: false
      };
      const nextChat = {
        chatType:
          body.chatType || 'private',
        realName:
          body.realName || '',
        remarkName:
          body.remarkName || body.realName || '',
        statusRegex:
          String(body.chatStatusRegex || '').slice(0, 500),
        myName:
          body.myName || '用户',
        autoReply,
        lastUserMessageAt: autoReply.enabled
          ? Date.now()
          : Number(previousChat.lastUserMessageAt || 0),
        appUrl:
          body.appUrl || './',
        bodyParts: previousChat.bodyParts || 0,
        bodyRev: previousChat.bodyRev || 0
      };

      // 只有开了 Worker 自动回复的聊天才需要保存请求内容（并裁剪体积）；
      // 普通回复不需要，关闭自动回复时顺便清掉。
      if (autoReply.enabled) {
        if (body.requestBody) {
          const parts = await this.putBig(bodyKey(body.chatId), trimAutoReplyBody(body.requestBody));
          if (parts < nextChat.bodyParts) {
            const keys = Array.from({ length: nextChat.bodyParts - parts }, (_, i) => `${bodyKey(body.chatId)}:${parts + i}`);
            await this.state.storage.delete(keys);
          }
          nextChat.bodyParts = parts;
          nextChat.bodyRev = (previousChat.bodyRev || 0) + 1;
        }
      } else if (nextChat.bodyParts > 0) {
        await this.deleteBig(bodyKey(body.chatId), nextChat.bodyParts);
        nextChat.bodyParts = 0;
        nextChat.bodyRev = (previousChat.bodyRev || 0) + 1;
      }

      if (JSON.stringify(previousChat) !== JSON.stringify(nextChat)) {
        meta.chats[body.chatId] = nextChat;
        metaChanged = true;
      }
      if (metaChanged) await this.saveMeta(meta);

      await this.setAlarmIfChanged(computeNextAlarm(meta));

      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/proactive/sync' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const meta = await this.loadMeta();

      const proactiveSettings = body.chats || {};
      if (JSON.stringify(meta.proactive || {}) !== JSON.stringify(proactiveSettings)) {
        meta.proactive = proactiveSettings;
        await this.saveMeta(meta);
      }

      return json({ ok: true });
    }

    if (url.pathname === '/v1/backend/disable' && request.method === 'POST') {
      const meta = await this.loadMeta();
      let changed = Object.keys(meta.proactive || {}).length > 0;
      meta.proactive = {};
      for (const [chatId, chat] of Object.entries(meta.chats)) {
        if (chat.autoReply?.enabled || chat.bodyParts > 0) changed = true;
        if (chat.autoReply) chat.autoReply.enabled = false;
        if (chat.bodyParts > 0) {
          await this.deleteBig(bodyKey(chatId), chat.bodyParts);
          chat.bodyParts = 0;
          chat.bodyRev = (chat.bodyRev || 0) + 1;
        }
      }
      if (changed) await this.saveMeta(meta);
      await this.setAlarmIfChanged(null);
      return json({ ok: true, stopped: true });
    }

    if (
      url.pathname === '/v1/ai' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const meta = await this.loadMeta();

      // 每次请求都同步最新的 API 设置，支持用户随时切换 API。
      if (
        body.aiConfig?.url &&
        body.aiConfig?.key &&
        body.aiConfig?.model
      ) {
        meta.aiConfig = {
          provider: String(
            body.aiConfig.provider ||
              'newapi'
          ),
          url: String(
            body.aiConfig.url
          ).trim(),
          key: String(
            body.aiConfig.key
          ).trim(),
          model: String(
            body.aiConfig.model
          ).trim()
        };

        await this.saveMeta(meta);
      }

      if (
        !meta.aiConfig?.url ||
        !meta.aiConfig?.key ||
        !meta.aiConfig?.model
      ) {
        return json(
          {
            error:
              '尚未同步 AI API 设置'
          },
          400
        );
      }

      const response = await callAI(
        meta.aiConfig,
        body.requestBody || {}
      );

      return json({
        response
      });
    }

    return json(
      {
        error: 'Not found'
      },
      404
    );
  }

  async alarm() {
    const meta = await this.loadMeta();
    const now = Date.now();
    // 每个到期聊天的处理结果。AI 调用和推送要等很久，期间别的请求可能已改过 meta，
    // 所以结果先收集起来，最后重新读取 meta 再合并，避免用旧数据覆盖新数据。
    const results = [];

    for (
      const [chatId, chat] of Object.entries(
        meta.chats
      )
    ) {
      const ar = chat.autoReply;

      if (
        !ar ||
        !ar.enabled ||
        !(chat.bodyParts > 0)
      ) {
        continue;
      }

      const interval = autoReplyIntervalMs(ar.interval);

      const last = latestTimestamp(ar.lastTriggerTime, chat.lastUserMessageAt) || now;

      const dueAt =
        last + interval;

      if (dueAt > now) continue;

      // 安静时段：不调用 AI、不推送、不更新触发时间，等时段结束后由 computeNextAlarm 重新排程。
      if (isQuietAt(ar.quietHours, now)) continue;

      const result = {
        chatId,
        bodyRev: chat.bodyRev || 0,
        newBodyParts: 0,
        message: null,
        removed: new Set()
      };
      results.push(result);

      try {
        if (
          !meta.aiConfig?.url ||
          !meta.aiConfig?.key ||
          !meta.aiConfig?.model
        ) {
          console.warn(
            '[BackgroundBackend] 未配置 AI API，跳过主动消息'
          );
        } else {
          const body = await this.getBig(bodyKey(chatId), chat.bodyParts);

          // 不能 continue：那样会跳过「更新触发时间」和「排下一次 alarm」，
          // 这个聊天就再也不会被排程，主动消息会悄悄停掉。
          // 抛出错误交给下方 catch 记录，然后照常排下一次。
          if (!body || !Array.isArray(body.messages)) {
            throw new Error('requestBody.messages 格式无效，已跳过本次主动消息');
          }

          body.stream = false;

          body.messages.push({
            role: 'user',
            content:
              `[系统通知：我已经有一段时间没有和你互动了，请以${chat.realName || '角色'}的身份主动延续之前的对话、发起新话题，或对时间流逝做出反应。]`
          });

          const response = await callAI(meta.aiConfig, body);

          const text =
            response
              ?.choices?.[0]
              ?.message
              ?.content || '';

          if (text) {
            body.messages.push({
              role: 'assistant',
              content: text
            });

            // 保存裁剪后的对话，历史不会无限变长。
            result.newBody = trimAutoReplyBody(body);

            result.message = {
              id:
                `background_${Date.now()}_${Math.random()
                  .toString(36)
                  .slice(2, 8)}`,
              chatId,
              chatType:
                chat.chatType ||
                'private',
              role: 'assistant',
              content: text,
              timestamp: now
            };

            const notificationMessages = splitNotificationMessages(text, chat.statusRegex || '');
            result.removed = await this.pushAll(
              meta.subscriptions,
              notificationMessages.map((notificationText, index) => ({
                title: chat.remarkName || chat.realName || '新消息',
                body: notificationText,
                tag: `uwu-${chatId}-${now}-${index}`,
                chatId,
                chatType: chat.chatType || 'private',
                url: chat.appUrl || './'
              }))
            );
          }
        }
      } catch (error) {
        console.error(
          '[BackgroundBackend] 主动消息失败',
          chatId,
          error
        );
      }
    }

    if (results.length) {
      const fresh = await this.loadMeta();
      let changed = false;
      const removed = new Set();

      for (const result of results) {
        const freshChat = fresh.chats[result.chatId];
        if (!freshChat) continue;

        // 保存对话内容。若期间用户又同步过（bodyRev 变了），以用户最新的为准，不覆盖。
        if (result.newBody && (freshChat.bodyRev || 0) === result.bodyRev && freshChat.autoReply?.enabled) {
          try {
            const parts = await this.putBig(bodyKey(result.chatId), result.newBody);
            if (parts < (freshChat.bodyParts || 0)) {
              const keys = Array.from({ length: freshChat.bodyParts - parts }, (_, i) => `${bodyKey(result.chatId)}:${parts + i}`);
              await this.state.storage.delete(keys);
            }
            freshChat.bodyParts = parts;
            freshChat.bodyRev = result.bodyRev + 1;
          } catch (error) {
            console.error('[BackgroundBackend] 保存主动消息对话失败', result.chatId, error);
          }
        }

        if (freshChat.autoReply) freshChat.autoReply.lastTriggerTime = now;
        if (result.message) {
          fresh.pendingMessages.push(result.message);
          fresh.pendingMessages = limitPendingMessages(fresh.pendingMessages);
        }
        for (const endpoint of result.removed) removed.add(endpoint);
        changed = true;
      }

      if (removed.size) {
        fresh.subscriptions = fresh.subscriptions.filter(item => !removed.has(subscriptionEndpoint(item)));
        changed = true;
      }
      if (changed) await this.saveMeta(fresh);
      await this.setAlarmIfChanged(computeNextAlarm(fresh, now));
      return;
    }

    await this.setAlarmIfChanged(computeNextAlarm(meta, now));
  }
}

async function callAI(
  aiConfig,
  requestBody
) {
  if (
    !aiConfig?.url ||
    !aiConfig?.key ||
    !aiConfig?.model
  ) {
    throw new Error(
      '尚未同步 AI API 设置'
    );
  }

  const rawBase = String(aiConfig.url).trim().replace(/\/$/, '');
  let endpoint = rawBase;

  // 支持用户填写：域名、/v1、/v1/chat/completions 三种常见格式。
  if (!/\/v1\/chat\/completions$/i.test(endpoint)) {
    endpoint = /\/v1$/i.test(endpoint)
      ? `${endpoint}/chat/completions`
      : `${endpoint}/v1/chat/completions`;
  }

  let response;
  try {
    response = await fetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          Authorization:
            `Bearer ${aiConfig.key}`
        },
        body: JSON.stringify({
          ...requestBody,
          model:
            requestBody.model ||
            aiConfig.model,
          stream: false
        })
      }
    );
  } catch (error) {
    const name = error?.name || 'Error';
    const message = error?.message || String(error);
    throw new Error(
      `AI 网络请求失败 [${name}] ${message}；请求地址：${endpoint}`
    );
  }

  const responseText = await response.text();

  if (!response.ok) {
    let detail = responseText;
    try {
      const parsed = JSON.parse(responseText);
      detail =
        parsed?.error?.message ||
        parsed?.error ||
        parsed?.message ||
        parsed?.detail ||
        responseText;
    } catch (_) {
      // 保留原始文本。
    }

    throw new Error(
      `AI ${response.status}: ${String(detail || '无响应内容').slice(0, 1500)}；请求地址：${endpoint}`
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (_) {
    throw new Error(
      `AI 返回的数据不是有效 JSON：${responseText.slice(0, 1000)}`
    );
  }
}

function splitNotificationMessages(text, statusRegex = '') {
  let visible = String(text || '').trim();
  if (/<\/thinking>/i.test(visible) && !/^\s*<thinking>/i.test(visible)) visible = `<thinking>${visible}`;
  const lastThinkingEnd = visible.toLowerCase().lastIndexOf('</thinking>');
  if (lastThinkingEnd >= 0) visible = visible.slice(lastThinkingEnd + '</thinking>'.length);
  visible = visible.replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '');

  // Remove the chat's configured status-panel block, when UwU supplied its regex.
  if (statusRegex) {
    try {
      let source = String(statusRegex).trim();
      let flags = 'g';
      const slashForm = source.match(/^\/(.*)\/([dgimsuvy]*)$/s);
      if (slashForm) { source = slashForm[1]; flags = slashForm[2].includes('g') ? slashForm[2] : `${slashForm[2]}g`; }
      visible = visible.replace(new RegExp(source, flags), '');
    } catch (error) {
      console.warn('[BackgroundBackend] 状态栏正则无效，改用默认过滤', error);
    }
  }

  const segments = [...visible.matchAll(/\[([^\]\r\n]+)\]/g)].map(match => match[1].trim());
  const messages = [];
  for (const segment of segments) {
    if (/更新状态为|system(?:-display)?\s*:/i.test(segment)) continue;
    if (/已接收礼物|(?:接收|退回).*转账|(?:同意|拒绝).*代付/.test(segment)) continue;

    const payloadMatch = segment.match(/[：:]([\s\S]*)$/);
    const payload = payloadMatch ? payloadMatch[1].trim() : '';
    if (/的表情包[：:]/.test(segment) && payload) {
      messages.push(`发送了表情包：${payload}`);
    } else if (/的消息[：:]|并回复[：:]|的语音[：:]|发来的照片\/视频[：:]|的转账[：:]|送来的礼物[：:]/.test(segment) && payload) {
      messages.push(payload);
    } else if (/撤回了一条消息[：:]/.test(segment) && payload) {
      messages.push(`撤回消息：${payload}`);
    } else if (segment && !/更新状态为/.test(segment)) {
      // Preserve other user-facing bracket messages, including future UwU formats.
      messages.push(segment.slice(0, 360));
    }
  }

  if (!messages.length && !segments.length) {
    const lines = visible.replace(/<[^>]*>/g, '').trim().split(/\s*\r?\n+\s*/).map(line => line.trim()).filter(Boolean);
    messages.push(...lines);
  }

  return messages
    .map(message => message.replace(/\s+/g, ' ').trim().slice(0, 360))
    .filter(Boolean)
    .slice(0, 8);
}

async function sendToAll(
  env,
  subscriptions,
  payload,
  stats = null
) {
  const valid = [];

  for (
    const item of subscriptions || []
  ) {
    try {
      await sendPushNotification(
        item.subscription || item,
        payload,
        {
          subject:
            env.VAPID_SUBJECT,
          publicKey:
            env.VAPID_PUBLIC_KEY,
          privateKey:
            env.VAPID_PRIVATE_KEY,
          ttl: 3600
        }
      );

      if (stats) stats.sent++;
      valid.push(item);
    } catch (error) {
      if (stats) stats.failed++;
      if (stats?.errors && stats.errors.length < 5) {
        stats.errors.push({
          statusCode: Number(error?.statusCode || error?.status || 0) || null,
          message: String(error?.message || error || '未知推送错误').slice(0, 240),
          reason: String(error?.body || '').slice(0, 240)
        });
      }
      console.warn(
        '[BackgroundBackend] 推送失败',
        error
      );

      if (
        !String(
          error?.message || ''
        ).match(
          /404|410|expired|gone/i
        )
      ) {
        valid.push(item);
      }
    }
  }

  return valid;
}

function createSetupPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>后台消息服务设置</title>
<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  max-width: 760px;
  margin: 0 auto;
  padding: 24px;
  line-height: 1.6;
  background: #f6f7f9;
  color: #222;
}
.card {
  background: #fff;
  border-radius: 16px;
  padding: 20px;
  margin: 16px 0;
  box-shadow: 0 2px 12px #0000000d;
}
h1 { font-size: 24px; }
h2 { font-size: 18px; }
button {
  border: 0;
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 15px;
  cursor: pointer;
  background: #1677ff;
  color: #fff;
}
label {
  display: block;
  font-weight: 600;
  margin-top: 14px;
}
textarea,
input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 6px;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font: 14px monospace;
}
textarea {
  min-height: 80px;
  resize: vertical;
}
.note {
  color: #666;
  font-size: 14px;
}
.warning {
  background: #fff4e5;
  padding: 12px;
  border-radius: 10px;
  color: #8a5300;
}
</style>
</head>

<body>
<h1>后台消息服务设置</h1>

<div class="card">
  <h2>生成 Web Push 密钥</h2>

  <p>
    点击下面的按钮，在当前浏览器本地生成一组 VAPID 密钥。
  </p>

  <p class="warning">
    私钥只在当前浏览器中生成，不会上传到此服务器。
    请妥善保存私钥。
  </p>

  <button id="generate">
    生成 VAPID 密钥
  </button>
</div>

<div class="card">
  <label>VAPID_PUBLIC_KEY</label>
  <textarea id="publicKey" readonly></textarea>

  <label>VAPID_PRIVATE_KEY</label>
  <textarea id="privateKey" readonly></textarea>

  <label>VAPID_SUBJECT</label>
  <input
    id="subject"
    value="mailto:your-email@example.com"
  >

  <p class="note">
    将这三个值分别添加到 Cloudflare Worker 的
    Settings → Variables and Secrets。
  </p>

  <p class="note">
    VAPID_PUBLIC_KEY 使用普通 Variable；
    VAPID_PRIVATE_KEY 使用 Secret；
    VAPID_SUBJECT 使用普通 Variable。
  </p>
</div>

<script>
function base64url(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\\+/g, '-')
    .replace(/\\//g, '_')
    .replace(/=+$/g, '');
}

function concatBytes(a, b) {
  const result = new Uint8Array(
    a.length + b.length
  );

  result.set(a, 0);
  result.set(b, a.length);

  return result;
}

document.getElementById('generate').onclick = async () => {
  try {
    const pair =
      await crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        true,
        ['sign', 'verify']
      );

    const publicKey =
      new Uint8Array(
        await crypto.subtle.exportKey(
          'raw',
          pair.publicKey
        )
      );

    const privateJwk =
      await crypto.subtle.exportKey(
        'jwk',
        pair.privateKey
      );

    if (!privateJwk.d) {
      throw new Error('无法读取私钥');
    }

    document.getElementById(
      'publicKey'
    ).value = base64url(publicKey);

    document.getElementById(
      'privateKey'
    ).value = privateJwk.d;

    document.getElementById(
      'generate'
    ).textContent = '已生成，可重新生成';

  } catch (error) {
    alert(
      '生成失败：' + error.message
    );
  }
};
</script>

</body>
</html>`;
}

export default {
  async fetch(request, env) {
    if (
      request.method === 'OPTIONS'
    ) {
      return new Response('', {
        headers: CORS
      });
    }

    const url =
      new URL(request.url);

    if (
      url.pathname === '/setup' &&
      request.method === 'GET'
    ) {
      return new Response(
        createSetupPage(),
        {
          headers: {
            'Content-Type':
              'text/html; charset=UTF-8',
            ...CORS
          }
        }
      );
    }

    if (
      !checkAuth(request, env)
    ) {
      return json(
        {
          error:
            'Unauthorized'
        },
        401
      );
    }

    if (
      url.pathname ===
      '/v1/health'
    ) {
      return json({
        ok: true,
        version:
          'Background Message Backend 1.0'
      });
    }

    if (
      url.pathname ===
      '/v1/push/config'
    ) {
      return json({
        publicKey:
          env.VAPID_PUBLIC_KEY ||
          ''
      });
    }

    if (url.pathname.startsWith('/__internal/')) return json({ error: 'Not found' }, 404);

    if (url.pathname === '/v1/ai/submit' && request.method === 'POST') {
      if (!env.AI_QUEUE) return json({ error: 'AI_QUEUE 尚未設定；請先建立並綁定 Cloudflare Queue' }, 503);
      try {
        const body = await request.json();
        const ai = body.aiConfig || {};
        if (!body.userId || !ai.url || !ai.key || !ai.model) return json({ error: '缺少 userId 或 AI API 設定' }, 400);
        const jobId = String(body.jobId || crypto.randomUUID());
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(jobId)) return json({ error: '无效的 jobId' }, 400);
        const stub = env.BACKGROUND_BACKEND.get(env.BACKGROUND_BACKEND.idFromName(String(body.userId)));
        const saved = await stub.fetch('https://internal/__internal/jobs/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, aiConfig: { provider: String(ai.provider || 'newapi'), url: String(ai.url).trim(),
            key: String(ai.key).trim(), model: String(ai.model).trim() }, requestBody: body.requestBody || {},
            chatId: body.chatId || '', chatType: body.chatType || 'private', chatName: body.chatName || '',
            chatStatusRegex: body.chatStatusRegex || '', appUrl: body.appUrl || './' })
        });
        if (!saved.ok) throw new Error('无法保存后台任务');
        try {
          await env.AI_QUEUE.send({ userId: String(body.userId), jobId });
        } catch (error) {
          await stub.fetch('https://internal/__internal/jobs/complete', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, error: `任务排队失败：${error?.message || error}` }) });
          throw error;
        }
        return json({ ok: true, jobId, status: 'queued' }, 202);
      } catch (error) {
        console.error('[BackgroundBackend] AI submit failed', error);
        return json({ error: `无法建立后台 AI 任务：${error?.message || error}` }, 500);
      }
    }

    const jobMatch = url.pathname.match(/^\/v1\/ai\/jobs\/([a-zA-Z0-9_-]{8,80})$/);
    if (jobMatch && request.method === 'GET') {
      const userId = url.searchParams.get('userId');
      if (!userId) return json({ error: '缺少 userId' }, 400);
      const stub = env.BACKGROUND_BACKEND.get(env.BACKGROUND_BACKEND.idFromName(String(userId)));
      return stub.fetch(`https://internal/__internal/jobs/read?jobId=${encodeURIComponent(jobMatch[1])}`);
    }
    if (jobMatch && request.method === 'POST' && url.searchParams.get('action') === 'cancel') {
      const body = await request.json();
      if (!body.userId) return json({ error: '缺少 userId' }, 400);
      const stub = env.BACKGROUND_BACKEND.get(env.BACKGROUND_BACKEND.idFromName(String(body.userId)));
      return stub.fetch('https://internal/__internal/jobs/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobMatch[1] }) });
    }
    if (jobMatch && request.method === 'POST' && url.searchParams.get('action') === 'ack') {
      const body = await request.json();
      if (!body.userId) return json({ error: '缺少 userId' }, 400);
      const stub = env.BACKGROUND_BACKEND.get(env.BACKGROUND_BACKEND.idFromName(String(body.userId)));
      return stub.fetch('https://internal/__internal/jobs/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobMatch[1] }) });
    }

    // AI 请求不再经过 Durable Object。
    // UwU 每次请求都会把当前正在使用的 AI API 设置一并传过来，
    // 因此这里可以直接由 Worker 调用 AI API。
    // 这样可避免 iOS Safari 在 Durable Object -> Worker 异常链路中
    // 将真实错误吞掉并只显示 TypeError: Load failed。
    if (
      url.pathname === '/v1/ai' &&
      request.method === 'POST'
    ) {
      try {
        const body = await request.json();
        const ai = body.aiConfig || {};

        if (!ai.url || !ai.key || !ai.model) {
          return json(
            { error: '尚未同步 AI API 设置' },
            400
          );
        }

        const aiConfig = {
          provider: String(ai.provider || 'newapi').trim(),
          url: String(ai.url).trim(),
          key: String(ai.key).trim(),
          model: String(ai.model).trim()
        };

        const response = await callAI(
          aiConfig,
          body.requestBody || {}
        );

        return json({ response });
      } catch (error) {
        const name = error?.name || 'Error';
        const message = error?.message || String(error);

        console.error(
          '[BackgroundBackend] /v1/ai 请求失败',
          error
        );

        return json(
          {
            error: `后台 AI 请求失败 [${name}] ${message}`
          },
          502
        );
      }
    }

    const clone =
      request.clone();

    const incoming =
      request.method === 'POST'
        ? await clone
            .json()
            .catch(() => ({}))
        : {};

    const userId =
      incoming.userId ||
      url.searchParams.get(
        'userId'
      ) ||
      'default';

    const id =
      env.BACKGROUND_BACKEND.idFromName(
        String(userId)
      );

    const stub =
      env.BACKGROUND_BACKEND.get(
        id
      );

    try {
      return await stub.fetch(
        new Request(request, {
          body:
            request.method === 'POST'
              ? JSON.stringify(
                  incoming
                )
              : undefined
        })
      );
    } catch (error) {
      // 关键：避免 iOS Safari 只收到 TypeError: Load failed。
      // Durable Object / Worker 的任何未捕获错误都统一转成带 CORS 的 JSON。
      const name = error?.name || 'Error';
      const message = error?.message || String(error);
      console.error(
        '[BackgroundBackend] 未捕获请求错误',
        error
      );
      return json(
        {
          error: `后台服务内部错误 [${name}] ${message}`,
          path: url.pathname
        },
        500
      );
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { userId, jobId } = message.body || {};
      if (!userId || !jobId) { message.ack(); continue; }
      const stub = env.BACKGROUND_BACKEND.get(env.BACKGROUND_BACKEND.idFromName(String(userId)));
      try {
        const claimed = await stub.fetch('https://internal/__internal/jobs/claim', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) });
        if (!claimed.ok) { message.ack(); continue; }
        const { ok, job } = await claimed.json();
        if (!ok || !job) { message.ack(); continue; }
        const response = await callAI(job.aiConfig, job.requestBody || {});
        await stub.fetch('https://internal/__internal/jobs/complete', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, response }) });
        message.ack();
      } catch (error) {
        const detail = `后台 AI 处理失败：${error?.message || error}`;
        console.error('[BackgroundBackend] queue AI job failed', jobId, error);
        if (message.attempts < 3) {
          await stub.fetch('https://internal/__internal/jobs/requeue', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) }).catch(() => {});
          message.retry({ delaySeconds: Math.min(30, 2 ** message.attempts) });
        } else {
          await stub.fetch('https://internal/__internal/jobs/complete', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, error: detail }) }).catch(() => {});
          message.ack();
        }
      }
    }
  },

  BackgroundBackend
};
