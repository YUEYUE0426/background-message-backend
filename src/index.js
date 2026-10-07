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

function checkAuth(request, env) {
  if (!env.BACKEND_TOKEN) return true;

  const auth = request.headers.get('Authorization') || '';

  return auth === `Bearer ${env.BACKEND_TOKEN}`;
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

  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (
      url.pathname === '/v1/push/register' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();

      data.subscriptions = (data.subscriptions || [])
        .filter(
          item =>
            item.endpoint !==
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

      data.pendingMessages = [];

      await this.save(data);

      return json({
        ok: true,
        messages
      });
    }

    if (
      url.pathname === '/v1/push/test' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();

      await sendToAll(
        this.env,
        data.subscriptions || [],
        {
          title: body.title || '后台通知',
          body: body.body || '后台通知测试成功',
          url: body.url || './'
        }
      );

      return json({ ok: true });
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

      data.aiConfig = {
        provider: String(
          ai.provider || 'newapi'
        ),
        url: String(ai.url).trim(),
        key: String(ai.key).trim(),
        model: String(ai.model).trim()
      };

      await this.save(data);

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
            chat.autoReply?.enabled
        )
        .map(chat => {
          return (
            Number(
              chat.autoReply
                .lastTriggerTime ||
                chat.lastUserMessageAt ||
                Date.now()
            ) +
            Math.max(
              5,
              Number(
                chat.autoReply.interval ||
                60
              )
            ) *
              60000
          );
        });

      if (times.length) {
        await this.state.storage.setAlarm(
          Math.min(...times)
        );
      }

      return json({ ok: true });
    }

    if (
      url.pathname === '/v1/proactive/sync' &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const data = await this.load();

      data.proactive =
        body.chats || {};

      await this.save(data);

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
    } catch (error) {
      console.error('[BackgroundBackend] 请求处理失败', error);
      return json(
        {
          error: String(error?.message || error || '后台服务内部错误')
        },
        500
      );
    }
  }

  async alarm() {
    const data = await this.load();
    const now = Date.now();
    let nextAlarm = 0;

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

      const interval =
        Math.max(
          5,
          Number(
            ar.interval || 60
          )
        ) *
        60 *
        1000;

      const last = Math.max(
        Number(
          ar.lastTriggerTime || 0
        ),
        Number(
          chat.lastUserMessageAt || 0
        )
      );

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

              await sendToAll(
                this.env,
                data.subscriptions ||
                  [],
                {
                  title:
                    chat.realName ||
                    '新消息',
                  body:
                    stripForNotification(
                      text
                    ),
                  chatId,
                  chatType:
                    chat.chatType ||
                    'private',
                  url:
                    chat.appUrl ||
                    './'
                }
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

        ar.lastTriggerTime = now;
      }

      const next =
        Number(
          ar.lastTriggerTime ||
            chat.lastUserMessageAt ||
            now
        ) + interval;

      if (
        !nextAlarm ||
        next < nextAlarm
      ) {
        nextAlarm = next;
      }
    }

    await this.save(data);

    if (nextAlarm) {
      await this.state.storage.setAlarm(
        nextAlarm
      );
    }
  }
}

function normalizeAIEndpoint(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) throw new Error('AI API 地址为空');

  const base = raw.replace(/\/+$/, '');

  // 兼容三种常见填写方式：
  // 1. https://example.com
  // 2. https://example.com/v1
  // 3. https://example.com/v1/chat/completions
  if (/\/chat\/completions$/i.test(base)) {
    return base;
  }

  if (/\/v1$/i.test(base)) {
    return `${base}/chat/completions`;
  }

  return `${base}/v1/chat/completions`;
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

  const endpoint = normalizeAIEndpoint(aiConfig.url);
  const payload = {
    ...(requestBody || {}),
    model:
      requestBody?.model ||
      aiConfig.model,
    stream: false
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.key}`
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error(
      `无法连接 AI API：${error?.message || error}`
    );
  }

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `AI ${response.status}: ${responseText || response.statusText}`
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `AI 返回的不是有效 JSON：${responseText.slice(0, 300)}`
    );
  }
}

function stripForNotification(text) {
  return String(text || '')
    .replace(
      /<thinking>[\s\S]*?<\/thinking>/gi,
      ''
    )
    .replace(
      /\[[^\]]*\]/g,
      ''
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .slice(0, 180) ||
    '收到一条新消息';
}

async function sendToAll(
  env,
  subscriptions,
  payload
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

      valid.push(item);
    } catch (error) {
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

    return stub.fetch(
      new Request(request, {
        body:
          request.method === 'POST'
            ? JSON.stringify(
                incoming
              )
            : undefined
      })
    );
  },

  BackgroundBackend
};
