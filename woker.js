// Cloudflare Worker 入口（Turnstile + 相册聚合：最多 10 张，2 秒超时 flush）
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/verify") {
      if (request.method === "GET") return renderVerifyPage(url, env);
      if (request.method === "POST") return handleVerifySubmit(request, env);
    }

    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 先尝试 flush 超时的媒体组（>2 秒未追加）
    await flushExpiredMediaGroups(env, Date.now());

    if (msg.chat && msg.chat.type === "private") {
      await handlePrivateMessage(msg, env, ctx);
      return new Response("OK");
    }

    const supergroupId = Number(env.SUPERGROUP_ID);
    if (msg.chat && Number(msg.chat.id) === supergroupId) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await markThreadClosed(msg.message_thread_id, env);
        return new Response("OK");
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await markThreadReopened(msg.message_thread_id, env);
        return new Response("OK");
      }
      if (msg.message_thread_id) {
        await handleTopicMessage(msg, env, ctx);
        return new Response("OK");
      }
    }

    return new Response("OK");
  },
};

// 私聊 -> 话题
async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  if (msg.text && msg.text.trim().toLowerCase().startsWith("/start")) return;

  // Turnstile 验证
  if (env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY) {
    const verified = await isVerified(userId, env);
    if (!verified) {
      const token = crypto.randomUUID();
      await env.TOPIC_MAP.put(`verify:${token}`, JSON.stringify({ uid: userId }), { expirationTtl: 900 });
      const base = env.PUBLIC_BASE;
      if (base) {
        const link = `${base.replace(/\/$/, "")}/verify?token=${token}`;
        const verifyText = [
          "⚠️ 检测到这是你第一次使用，请先完成人机验证：",
          `🔗 <a href="${link}">点击前往</a>`,
          "",
          "请在网页中看到“验证成功，请回到 Telegram 继续对话”提示后，",
          "再回到这里继续发消息，否则会一直重复要求验证。"
        ].join("\n");
        await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: verifyText,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
      return;
    }
  }

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。",
    });
    return;
  }
  if (!rec) rec = await createAndStoreTopic(msg.from, key, env);

  // 相册聚合：用户 -> 话题
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
    return;
  }

  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id,
  });

  if (!res.ok && isThreadMissingError(res)) {
    const newRec = await createAndStoreTopic(msg.from, key, env);
    await tgCall(env, "forwardMessage", {
      chat_id: env.SUPERGROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id,
      message_thread_id: newRec.thread_id,
    });
  }
}

// 话题 -> 私聊
async function handleTopicMessage(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const botId = Number(env.BOT_ID || 0);
  if (msg.from && Number(msg.from.id) === botId) return;

  const userId = await findUserByThread(threadId, env);
  if (!userId) return;

  // 相册聚合：话题 -> 用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: null });
    return;
  }

  const res = await tgCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id,
  });
  if (!res.ok) {
    const res2 = await tgCall(env, "forwardMessage", {
      chat_id: userId,
      from_chat_id: env.SUPERGROUP_ID,
      message_id: msg.message_id,
    });
    console.log("forwardMessage fallback result", { ok: res2.ok, error_code: res2.error_code, description: res2.description });
  }
}

// 创建话题
async function createAndStoreTopic(from, key, env) {
  const title = buildTopicTitle(from);
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  return rec;
}

// 话题标题：昵称 + @username
function buildTopicTitle(from) {
  const first = from.first_name || "";
  const last = from.last_name || "";
  const nick = `${first} ${last}`.trim();
  if (from.username) {
    const at = "@" + from.username;
    return (nick ? `${nick} ${at}` : at).slice(0, 128);
  }
  return (nick || "User").slice(0, 128);
}

// Telegram API
async function tgCall(env, method, body) {
  const base = env.API_BASE || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await resp.json();
  } catch {
    return { ok: false, description: "invalid json from telegram" };
  }
}

function isThreadMissingError(res) {
  if (!res || res.ok) return false;
  const desc = (res.description || "").toUpperCase();
  return (
    desc.includes("MESSAGE THREAD NOT FOUND") ||
    desc.includes("MESSAGE_THREAD_NOT_FOUND") ||
    desc.includes("THREAD_NOT_FOUND") ||
    desc.includes("TOPIC_NOT_FOUND") ||
    desc.includes("FORUM_TOPIC_NOT_FOUND")
  );
}

async function markThreadClosed(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = true;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      break;
    }
  }
}
async function markThreadReopened(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      rec.closed = false;
      await env.TOPIC_MAP.put(name, JSON.stringify(rec));
      break;
    }
  }
}

// Turnstile 状态
async function isVerified(uid, env) {
  const flag = await env.TOPIC_MAP.get(`verified:${uid}`);
  return Boolean(flag);
}

// 按 thread_id 反查用户
async function findUserByThread(threadId, env) {
  const list = await env.TOPIC_MAP.list({ prefix: "user:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) return Number(name.slice("user:".length));
  }
  return null;
}

const TELEGRAM_FALLBACK_URL = "https://t.me";
const VERIFY_STATUS_THEME = {
  info: { accent: "#3460ff", accentLight: "rgba(52,96,255,0.14)", icon: "🛡️" },
  success: { accent: "#16a34a", accentLight: "rgba(22,163,74,0.15)", icon: "✅" },
  error: { accent: "#ef4444", accentLight: "rgba(239,68,68,0.18)", icon: "⚠️" },
};

function renderVerifyView({ status = "info", title, description = "", content = "", actions = [], includeTurnstile = false, icon, statusCode = 200 }) {
  const theme = VERIFY_STATUS_THEME[status] || VERIFY_STATUS_THEME.info;
  const resolvedIcon = icon === null ? "" : icon || theme.icon || "";
  const iconHtml = resolvedIcon ? `<div class="badge">${resolvedIcon}</div>` : "";
  const actionHtml = actions.length
    ? `<div class="actions">${actions
        .map(({ label, href = "#", primary = true, external }) => {
          const target = external ? ' target="_blank" rel="noopener noreferrer"' : "";
          return `<a class="action${primary ? " primary" : ""}" href="${href}"${target}>${label}</a>`;
        })
        .join("")}</div>`
    : "";
  const script = includeTurnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : "";
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  ${script}
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #f5f7fb;
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
      color: #1f2125;
    }
    .card {
      width: min(460px, 92vw);
      background: #fff;
      border-radius: 20px;
      padding: 32px 30px;
      box-shadow: 0 32px 70px rgba(15,23,42,0.12);
      text-align: center;
      border: 1px solid rgba(15,23,42,0.05);
    }
    .badge {
      width: 56px;
      height: 56px;
      margin: 0 auto 16px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      background: var(--accent-light);
      color: var(--accent);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 12px;
    }
    .tip {
      margin: 0 0 22px;
      color: #64748b;
      font-size: 14px;
      line-height: 1.5;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    button {
      border: none;
      border-radius: 12px;
      padding: 13px;
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      background: var(--accent);
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(15,23,42,0.16);
    }
    button:active { transform: translateY(1px); }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 4px;
    }
    .action {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      padding: 12px 18px;
      border-radius: 12px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid transparent;
      color: var(--accent);
      background: rgba(52,96,255,0.08);
    }
    .action.primary {
      color: #fff;
      background: var(--accent);
      border-color: var(--accent);
      box-shadow: 0 10px 22px rgba(15,23,42,0.16);
    }
    .muted {
      font-size: 13px;
      color: #94a3b8;
      margin: 0;
    }
    @media (min-width: 520px) {
      .actions { flex-direction: row; justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="card" style="--accent:${theme.accent};--accent-light:${theme.accentLight};">
    ${iconHtml}
    <h1>${title}</h1>
    ${description ? `<p class="tip">${description}</p>` : ""}
    ${content}
    ${actionHtml}
  </div>
</body>
</html>`;
  return new Response(html, { status: statusCode, headers: { "content-type": "text/html; charset=utf-8" } });
}

// Turnstile 页面
function renderVerifyPage(url, env) {
  const token = url.searchParams.get("token") || "";
  const sitekey = env.TURNSTILE_SITEKEY;
  if (!sitekey || !token) {
    return renderVerifyView({
      status: "error",
      title: "验证链接无效",
      description: "链接缺少必要参数，请返回 Telegram 重新点击最新的验证按钮。",
      actions: [{ label: "返回 Telegram", href: TELEGRAM_FALLBACK_URL, external: true }],
      statusCode: 400,
    });
  }
  const formHtml = `<form method="POST" action="/verify">
      <div class="cf-turnstile" data-sitekey="${sitekey}"></div>
      <input type="hidden" name="token" value="${token}" />
      <button type="submit">提交验证</button>
      <p class="tip">验证通过后请切回 Telegram 与机器人继续对话。</p>
    </form>`;
  return renderVerifyView({
    status: "info",
    title: "请完成人机验证",
    description: "为了保护社群安全，请完成下面的人机验证。",
    content: formHtml,
    includeTurnstile: true,
    icon: "🛡️",
  });
}

// Turnstile 提交
async function handleVerifySubmit(request, env) {
  const form = await request.formData();
  const respToken = form.get("cf-turnstile-response");
  const token = form.get("token");
  const retryActions = token
    ? [
        { label: "重新验证", href: `/verify?token=${encodeURIComponent(token)}` },
        { label: "返回 Telegram", href: TELEGRAM_FALLBACK_URL, primary: false, external: true },
      ]
    : [{ label: "返回 Telegram", href: TELEGRAM_FALLBACK_URL, external: true }];
  if (!respToken || !token) {
    return renderVerifyView({
      status: "error",
      title: "缺少验证信息",
      description: "请求参数不完整，请刷新页面或重新回到 Telegram 获取验证链接。",
      actions: retryActions,
      statusCode: 400,
    });
  }

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: respToken }),
  });
  const data = await verifyRes.json();
  if (!data.success) {
    const errors = Array.isArray(data["error-codes"]) && data["error-codes"].length ? data["error-codes"].join(", ") : "";
    const detail = errors ? `<p class="muted">错误代码：${errors}</p>` : "";
    return renderVerifyView({
      status: "error",
      title: "人机验证未通过",
      description: "Turnstile 未能确认你是合法用户，请重新开启验证或稍后再试。",
      content: detail,
      actions: retryActions,
      statusCode: 400,
    });
  }

  const record = await env.TOPIC_MAP.get(`verify:${token}`, { type: "json" });
  if (!record || !record.uid) {
    return renderVerifyView({
      status: "error",
      title: "验证已过期",
      description: "验证记录不存在或已超时，请回到 Telegram 重新获取新的验证链接。",
      actions: [{ label: "返回 Telegram", href: TELEGRAM_FALLBACK_URL, external: true }],
      statusCode: 410,
    });
  }

  await env.TOPIC_MAP.put(`verified:${record.uid}`, "1");
  await env.TOPIC_MAP.delete(`verify:${token}`);
  console.log("verified-set", { uid: record.uid });

  try {
    await tgCall(env, "sendMessage", { chat_id: record.uid, text: "✅ 人机验证成功，请等待几秒数据库异地回调再和机器人的私聊继续发送消息，否则会触发无限验证。" });
  } catch {}

  return renderVerifyView({
    status: "success",
    title: "验证成功",
    description: "系统已记录你的验证结果，稍候即可恢复与机器人的对话。",
    content: '<p class="tip">请先等待 3~5 秒再回到 Telegram 发送下一条消息，然后手动关闭此页面即可。</p>',
  });
}

// ---------------- 媒体组批量发送：攒到 10 张，或 2 秒未追加则发送 ----------------
async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
  const groupId = msg.media_group_id;
  const key = `mg:${direction}:${groupId}`;
  const now = Date.now();

  const item = extractMedia(msg, direction, msg.chat.id, msg.message_id);
  if (!item) {
    console.log("media group item unsupported, fallback single", { groupId });
    return direction === "p2t"
      ? tgCall(env, "forwardMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: threadId })
      : tgCall(env, "copyMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id });
  }

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (!rec) rec = { direction, targetChat, threadId, items: [], last_ts: now };

  rec.items.push(item);
  rec.last_ts = now;
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: 60 });
  console.log("media group buffered", { key, count: rec.items.length });
  scheduleMediaGroupFlush(ctx, env, key, now);

  // 满 10 张立即发送
  if (rec.items.length >= 10) {
    await flushMediaGroup(rec, env, key);
    await env.TOPIC_MAP.delete(key);
  }
}

function extractMedia(msg, direction, fromChatId, messageId) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: best.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  }
  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  return null;
}

// 遍历所有 mg:*，超过 2 秒未追加就发送
async function flushExpiredMediaGroups(env, now) {
  const list = await env.TOPIC_MAP.list({ prefix: "mg:" });
  for (const { name } of list.keys) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (!rec || !rec.items || !rec.items.length) {
      await env.TOPIC_MAP.delete(name);
      continue;
    }
    if (now - (rec.last_ts || 0) > 2000) { // 2秒未追加，认为该组结束
      await flushMediaGroup(rec, env, name);
      await env.TOPIC_MAP.delete(name);
    }
  }
}

async function flushMediaGroup(rec, env, key) {
  if (rec.items.length === 1) {
    // 单条，用普通 copy/forward
    const it = rec.items[0];
    if (rec.direction === "p2t") {
      await tgCall(env, "forwardMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
        message_thread_id: rec.threadId,
      });
    } else {
      await tgCall(env, "copyMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
      });
    }
    console.log("flushMediaGroup single", { key });
    return;
  }

  if (rec.direction === "p2t") {
    await forwardMediaGroupToTopic(rec, env);
  } else {
    await sendMediaGroupToUser(rec, env);
  }
  console.log("flushMediaGroup batch forwarded", { key, count: rec.items.length, direction: rec.direction });
}

function scheduleMediaGroupFlush(ctx, env, key, expectedTs) {
  if (!ctx || typeof ctx.waitUntil !== "function") return;
  ctx.waitUntil(
    (async () => {
      await delay(2100);
      const rec = await env.TOPIC_MAP.get(key, { type: "json" });
      if (!rec || !rec.items || !rec.items.length) return;
      if ((rec.last_ts || 0) !== expectedTs) return;
      await flushMediaGroup(rec, env, key);
      await env.TOPIC_MAP.delete(key);
    })()
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forwardMediaGroupToTopic(rec, env) {
  const fromChatId = rec.items[0].from_chat_id;
  const sameSource = rec.items.every((it) => it.from_chat_id === fromChatId);
  if (sameSource) {
    const res = await tgCall(env, "forwardMessages", {
      chat_id: rec.targetChat,
      from_chat_id: fromChatId,
      message_thread_id: rec.threadId,
      message_ids: rec.items.map((it) => it.message_id),
    });
    if (res.ok) return;
    console.log("forwardMessages failed, fallback to single forwards", { error_code: res.error_code, description: res.description });
  }
  for (const it of rec.items) {
    await tgCall(env, "forwardMessage", {
      chat_id: rec.targetChat,
      from_chat_id: it.from_chat_id,
      message_id: it.message_id,
      message_thread_id: rec.threadId,
    });
  }
}

async function sendMediaGroupToUser(rec, env) {
  const media = rec.items.map((it, idx) => ({
    type: it.type,
    media: it.file_id,
    caption: idx === 0 ? it.caption : undefined,
  }));
  const res = await tgCall(env, "sendMediaGroup", {
    chat_id: rec.targetChat,
    media,
  });
  if (res.ok) return;

  console.log("sendMediaGroup to user failed, fallback to copy", { error_code: res.error_code, description: res.description });
  for (const it of rec.items) {
    const copyRes = await tgCall(env, "copyMessage", {
      chat_id: rec.targetChat,
      from_chat_id: it.from_chat_id,
      message_id: it.message_id,
    });
    if (!copyRes.ok) {
      await tgCall(env, "forwardMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
      });
    }
  }
}
