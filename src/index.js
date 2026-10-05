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

  const base = String(
    aiConfig.url
  ).replace(/\/$/, '');

  const response = await fetch(
    `${base}/v1/chat/completions`,
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

  if (!response.ok) {
    throw new Error(
      `AI ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
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

export default {
  async fetch(request, env) {
    if (
      request.method === 'OPTIONS'
    ) {
      return new Response('', {
        headers: CORS
      });
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

    const url =
      new URL(request.url);

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
