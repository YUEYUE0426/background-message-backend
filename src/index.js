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

export class BackgroundBackend {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async load() {
    return (
      (await this.state.storage.get('data')) || {
        subscriptions: [],
        chats: {},
        proactive: {},
        pendingMessages: [],
        aiConfig: null
      }
    );
  }

  async save(data) {
    await this.state.storage.put('data', data);
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
      const data = await this.load();
      data.aiJobs = data.aiJobs || {};
      if (data.aiJobs[body.jobId]) return json({ ok: true, existing: true });
      for (const [id, job] of Object.entries(data.aiJobs)) {
        if (Date.now() - Number(job.createdAt || 0) > 7 * 24 * 60 * 60 * 1000) delete data.aiJobs[id];
      }
      const retained = Object.entries(data.aiJobs).sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0));
      for (const [id] of retained.slice(100)) delete data.aiJobs[id];
      data.aiJobs[body.jobId] = { status: 'queued', createdAt: Date.now(), aiConfig: body.aiConfig,
        requestBody: body.requestBody, chatId: body.chatId || '', chatType: body.chatType || 'private',
        chatName: String(body.chatName || data.chats?.[body.chatId]?.remarkName || data.chats?.[body.chatId]?.realName || '').slice(0, 120),
        chatStatusRegex: String(body.chatStatusRegex || data.chats?.[body.chatId]?.statusRegex || '').slice(0, 500), appUrl: body.appUrl || './' };
      await this.save(data);
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/read' && request.method === 'GET') {
      const data = await this.load();
      const job = data.aiJobs?.[url.searchParams.get('jobId')];
      return job ? json({ ok: true, job }) : json({ error: 'Job not found' }, 404);
    }

    if (url.pathname === '/__internal/jobs/claim' && request.method === 'POST') {
      const body = await request.json();
      const data = await this.load();
      const job = data.aiJobs?.[body.jobId];
      if (!job || (job.status !== 'queued' && !(job.status === 'processing' && Date.now() - Number(job.startedAt || 0) > 14 * 60 * 1000))) return json({ ok: false });
      job.status = 'processing';
      job.startedAt = Date.now();
      await this.save(data);
      return json({ ok: true, job });
    }

    if (url.pathname === '/__internal/jobs/requeue' && request.method === 'POST') {
      const body = await request.json();
      const data = await this.load();
      const job = data.aiJobs?.[body.jobId];
      if (job?.status === 'processing') { job.status = 'queued'; delete job.startedAt; await this.save(data); }
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/complete' && request.method === 'POST') {
      const body = await request.json();
      const data = await this.load();
      data.aiJobs = data.aiJobs || {};
      const job = data.aiJobs[body.jobId];
      if (!job) return json({ error: 'Job not found' }, 404);
      let savedBeforePush = false;
      job.status = body.error ? 'failed' : 'completed';
      job.updatedAt = Date.now();
      if (body.error) job.error = String(body.error).slice(0, 1500);
      else {
        job.response = body.response;
        const content = body.response?.choices?.[0]?.message?.content;
        if (content) {
          data.pendingMessages = data.pendingMessages || [];
          data.pendingMessages.push({ id: body.jobId, chatId: job.chatId, chatType: job.chatType,
            role: 'assistant', content: String(content), timestamp: job.updatedAt });
          if (data.pendingMessages.length > 100) data.pendingMessages = data.pendingMessages.slice(-100);
          // Persist the reply before sending Push so opening the app from the
          // notification can immediately pull the completed message.
          await this.save(data);
          savedBeforePush = true;
          const notificationMessages = splitNotificationMessages(content, job.chatStatusRegex || data.chats?.[job.chatId]?.statusRegex || '');
          const title = job.chatName || data.chats?.[job.chatId]?.remarkName || data.chats?.[job.chatId]?.realName || '新消息';
          const subscriptionEndpointsBefore = JSON.stringify((data.subscriptions || []).map(item => item.subscription?.endpoint || item.endpoint || ''));
          for (let index = 0; index < notificationMessages.length; index++) {
            if (index > 0) await new Promise(resolve => setTimeout(resolve, 350));
            data.subscriptions = await sendToAll(this.env, data.subscriptions || [], {
              title,
              body: notificationMessages[index],
              tag: `uwu-${job.jobId || body.jobId}-${index}`,
              url: job.appUrl,
              chatId: job.chatId, chatType: job.chatType
            });
          }
          const subscriptionEndpointsAfter = JSON.stringify((data.subscriptions || []).map(item => item.subscription?.endpoint || item.endpoint || ''));
          // The reply was already persisted. Write again only when expired push
          // subscriptions were removed while delivering the notification.
          if (subscriptionEndpointsBefore !== subscriptionEndpointsAfter) await this.save(data);
        }
      }
      if (!savedBeforePush) await this.save(data);
      return json({ ok: true });
    }

    if (url.pathname === '/__internal/jobs/ack' && request.method === 'POST') {
      const body = await request.json();
      const data = await this.load();
      const pendingMessages = data.pendingMessages || [];
      const remainingMessages = pendingMessages.filter(item => item.id !== body.jobId);
      if (remainingMessages.length !== pendingMessages.length) {
        data.pendingMessages = remainingMessages;
        await this.save(data);
      }
      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/push/register' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();

      data.subscriptions = (data.subscriptions || [])
        .filter(
          item =>
            (item.subscription?.endpoint || item.endpoint) !==
            body.subscription?.endpoint
        );

      if (body.subscription) {
        data.subscriptions.push({
          subscription: body.subscription,
          appUrl: body.appUrl || './',
          timezone: body.timezone || 'UTC'
        });
      }

      await this.save(data);

      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/messages/pull' &&
      request.method === 'GET'
    ) {
      const data = await this.load();
      const messages = data.pendingMessages || [];

      return json({
        ok: true,
        messages
      });
    }

    if (url.pathname === '/v1/messages/ack' && request.method === 'POST') {
      const body = await request.json();
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (ids.size) {
        const data = await this.load();
        const pendingMessages = data.pendingMessages || [];
        const remainingMessages = pendingMessages.filter(item => !ids.has(String(item.id)));
        if (remainingMessages.length !== pendingMessages.length) {
          data.pendingMessages = remainingMessages;
          await this.save(data);
        }
      }
      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/push/test' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();
      if (!(data.subscriptions || []).length) return json({ error: '这台设备还没有注册后台通知' }, 400);
      const subscriptionEndpointsBefore = JSON.stringify((data.subscriptions || []).map(item => item.subscription?.endpoint || item.endpoint || ''));
      const pushStats = { sent: 0, failed: 0, errors: [] };
      data.subscriptions = await sendToAll(
        this.env,
        data.subscriptions || [],
        {
          title: body.title || '后台通知',
          body: body.body || '后台通知测试成功',
          url: body.url || './'
        },
        pushStats
      );

      const subscriptionEndpointsAfter = JSON.stringify((data.subscriptions || []).map(item => item.subscription?.endpoint || item.endpoint || ''));
      if (subscriptionEndpointsBefore !== subscriptionEndpointsAfter) await this.save(data);

      if (!pushStats.sent) return json({
        error: `推送发送失败（失败数：${pushStats.failed}）`,
        failures: pushStats.errors.slice(0, 5)
      }, 502);

      return json({ ok: true, sent: pushStats.sent, subscriptions: data.subscriptions.length });
    }

    // 保存当前应用中的 AI API 设置。
    if (
      url.pathname === '/v1/ai/config' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();
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

      if (JSON.stringify(data.aiConfig) !== JSON.stringify(nextAiConfig)) {
        data.aiConfig = nextAiConfig;
        await this.save(data);
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
      const data = await this.load();

      if (
        body.aiConfig?.url &&
        body.aiConfig?.key &&
        body.aiConfig?.model
      ) {
        data.aiConfig = {
          provider: String(
            body.aiConfig.provider || 'newapi'
          ),
          url: String(body.aiConfig.url).trim(),
          key: String(body.aiConfig.key).trim(),
          model: String(body.aiConfig.model).trim()
        };
      }

      data.chats = data.chats || {};

      data.chats[body.chatId] = {
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
        requestBody:
          body.requestBody || null,
        autoReply:
          body.autoReply || {
            enabled: false
          },
        lastUserMessageAt: Date.now(),
        appUrl:
          body.appUrl || './'
      };

      await this.save(data);

      const times = Object.values(
        data.chats
      )
        .filter(
          chat =>
            chat.autoReply?.enabled && chat.requestBody
        )
        .map(chat => {
          const lastActivityAt = latestTimestamp(
            chat.autoReply.lastTriggerTime,
            chat.lastUserMessageAt
          ) || Date.now();
          return lastActivityAt + autoReplyIntervalMs(chat.autoReply.interval);
        });

      await this.setAlarmIfChanged(times.length ? Math.min(...times) : null);

      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/proactive/sync' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();

      const proactiveSettings = body.chats || {};
      if (JSON.stringify(data.proactive || {}) !== JSON.stringify(proactiveSettings)) {
        data.proactive = proactiveSettings;
        await this.save(data);
      }

      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/ai' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();

      // 每次请求都同步最新的 API 设置，支持用户随时切换 API。
      if (
        body.aiConfig?.url &&
        body.aiConfig?.key &&
        body.aiConfig?.model
      ) {
        data.aiConfig = {
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

        await this.save(data);
      }

      if (
        !data.aiConfig?.url ||
        !data.aiConfig?.key ||
        !data.aiConfig?.model
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
        data.aiConfig,
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
    const data = await this.load();
    const now = Date.now();
    let nextAlarm = 0;
    let stateChanged = false;

    for (
      const [chatId, chat] of Object.entries(
        data.chats || {}
      )
    ) {
      const ar = chat.autoReply;

      if (
        !ar ||
        !ar.enabled ||
        !chat.requestBody
      ) {
        continue;
      }

      const interval = autoReplyIntervalMs(ar.interval);

      const last = latestTimestamp(ar.lastTriggerTime, chat.lastUserMessageAt) || now;

      const dueAt =
        last + interval;

      if (dueAt <= now) {
        try {
          if (
            !data.aiConfig?.url ||
            !data.aiConfig?.key ||
            !data.aiConfig?.model
          ) {
            console.warn(
              '[BackgroundBackend] 未配置 AI API，跳过主动消息'
            );
          } else {
            const body =
              JSON.parse(
                JSON.stringify(
                  chat.requestBody
                )
              );

            body.stream = false;

            if (
              !Array.isArray(
                body.messages
              )
            ) {
              continue;
            }

            body.messages.push({
              role: 'user',
              content:
                `[系统通知：我已经有一段时间没有和你互动了，请以${chat.realName || '角色'}的身份主动延续之前的对话、发起新话题，或对时间流逝做出反应。]`
            });

            const response =
              await callAI(
                data.aiConfig,
                body
              );

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

              chat.requestBody = body;

              chat.autoReply.lastTriggerTime =
                now;

              data.pendingMessages =
                data.pendingMessages || [];

              data.pendingMessages.push({
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
              });

              if (
                data.pendingMessages
                  .length > 100
              ) {
                data.pendingMessages =
                  data.pendingMessages.slice(
                    -100
                  );
              }

              const notificationMessages = splitNotificationMessages(text, chat.statusRegex || '');
              for (let index = 0; index < notificationMessages.length; index++) {
                if (index > 0) await new Promise(resolve => setTimeout(resolve, 350));
                data.subscriptions = await sendToAll(this.env, data.subscriptions || [], {
                  title: chat.remarkName || chat.realName || '新消息',
                  body: notificationMessages[index],
                  tag: `uwu-${chatId}-${now}-${index}`,
                  chatId,
                  chatType: chat.chatType || 'private',
                  url: chat.appUrl || './'
                });
              }
            }
          }
        } catch (error) {
          console.error(
            '[BackgroundBackend] 主动消息失败',
            chatId,
            error
          );
        }

        ar.lastTriggerTime = now;
        stateChanged = true;
      }

      // Use the same latest activity timestamp as dueAt. Using only the older
      // lastTriggerTime here can schedule an already-expired alarm repeatedly.
      const next = (latestTimestamp(ar.lastTriggerTime, chat.lastUserMessageAt) || now) + interval;

      if (
        !nextAlarm ||
        next < nextAlarm
      ) {
        nextAlarm = next;
      }
    }

    if (stateChanged) await this.save(data);
    await this.setAlarmIfChanged(nextAlarm || null);
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
