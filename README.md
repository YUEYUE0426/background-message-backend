# Background Message Backend

用于移动应用后台消息、主动消息和 Web Push 通知的 Cloudflare Worker 后台服务。

## 功能

- 后台 AI 消息
- 主动消息定时任务
- Web Push 系统通知
- Durable Object 数据存储
- 每个用户使用自己的 Cloudflare Worker
- AI API 设置由前端应用管理，并同步到用户自己的 Worker

## 部署

推荐方式：先在 GitHub 上 **Fork** 本仓库，再到 Cloudflare 的 Workers & Pages 中选择 Import a repository，连接**你自己账号下**的这份 Fork。这样作者发布新版本后，你可以在自己的 Fork 页面点击 **Sync fork** 自行决定何时更新，Cloudflare 会随之自动重新部署。

在连接之前，先创建 Queue：`uwu-ai-jobs`（见下文）。

部署完成后，需要在 Cloudflare Worker 的 Settings → Variables and Secrets 中设置：

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `BACKEND_TOKEN`（Secret，必填）

`BACKEND_TOKEN` 是访问 Worker API 的必填认证密钥。没有配置时，Worker 会拒绝所有受保护的 API 请求；不要将它提交到 GitHub。建议使用至少 32 字符的随机值，并只保存在 Cloudflare Secret 与自己的「后台访问 Token」栏位。

### 普通 AI 回覆的背景处理

普通回覆现由 Cloudflare Queue 在服务器端生成；不要只部署 `src/index.js`，必须同时配置 Queue：

```sh
npx wrangler queues create uwu-ai-jobs
npx wrangler deploy
```

`wrangler.toml` 已配置生产者与消费者绑定。若 Queue 已存在，跳过创建命令即可。部署后，前端也必须更新为配套版本，因为它会调用 `/v1/ai/submit` 和 `/v1/ai/jobs/{id}`。旧版前端仍可使用同步 `/v1/ai` 路由。

首次测试请保持 Cloudflare 后台模式，注册 Web Push 通知，然后发送一条普通消息。Worker 应很快返回任务已接收；之后可切换应用到后台。AI 完成时 Worker 会保存回复并发送 Push，回去时会同步未读消息。

如果切到后台的动作发生在 Worker 确认任务已接收之前，iOS 仍可能中断最初的提交请求；请先等到出现「后台已接收回复任务」提示再切换。服务器收到任务后，后续生成不依赖网页保持运行。

请不要把任何 Secret 或敏感信息提交到公开 GitHub 仓库。

## AI API

AI API 地址、API Key 和模型由前端应用管理。

启用后台服务后，当前 AI 配置会同步到用户自己的 Worker，用于网页关闭或应用进入后台后的定时 AI 任务。

AI Key 只应存储在自己控制的 Cloudflare Worker 中。

## 使用

部署完成后会获得一个 Worker URL，例如：

`https://background-message-backend.example.workers.dev`

将该 URL 填入应用的 Cloudflare 后台消息服务设置。

## 安全

请只将本项目部署到自己控制的 Cloudflare 帐号。

不要在 GitHub 中提交：

- AI API Key
- VAPID 私钥
- Cloudflare API Token
- 其他密码或访问令牌

## 隐私说明

- 本项目不会把你的聊天内容、AI Key、推送订阅等数据发送给作者。Worker 对外只会做两件事：调用你自己设置的 AI 服务商，以及通过 Web Push 向你的设备发送通知。
- `BACKEND_TOKEN` 相当于总钥匙：拿到它的人可以读取尚未同步的回复、修改 Worker 里的 AI 设置。请使用至少 32 字符的随机值，不要分享、截图或提交到 GitHub；一旦泄露，请立即在 Cloudflare 里更换并在应用里同步修改。
- 不要公开你的 Worker 地址：即使没有 Token，被拒绝的请求也会占用 Cloudflare 免费额度。
- 应用导出的备份文件包含 AI Key 和后台 Token（明文），请妥善保管。
- 若想清除云端数据，删除该 Worker（及其 Durable Object）即可。

