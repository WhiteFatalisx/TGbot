// Cloudflare Worker 入口（相册聚合：最多 10 张，2 秒超时 flush）
// =========================
// 违禁词正则审核系统
// =========================

// 是否开启审核
const ENABLE_CONTENT_FILTER = true;

// 管理员白名单（不会被拦截）
const ADMIN_IDS = [
];

// =========================
// 黑名单（管理员手动维护）
// =========================
// 命令（仅管理员可用）：
//   /ban <用户ID> [备注]    加入黑名单（自动关闭该用户关联的话题）
//   /unban <用户ID>         移出黑名单（自动重新打开该话题）
//   /banlist                查看黑名单
//   /chat <用户ID> [消息]   主动给指定用户发起对话
//   /find [用户ID]          查询用户的话题与黑名单状态
// /ban、/unban、/banlist 可用位置：日志群（LOG_CHAT_ID）、与机器人的私聊、超群话题内
// 话题内直接发送 /ban、/unban 即作用于该话题对应的用户，无需输入 ID；
// 日志群中回复一条违规通知消息发送 /ban，也可直接拉黑该用户。
// /chat 可用位置：日志群、与机器人的私聊
//   - 只带 ID：为该用户创建（或复用已有）话题，之后在话题内发消息即可；
//   - 带消息内容：立即把该消息发给用户，并在话题内留档。
//   注意：Telegram 限制机器人无法主动联系从未给机器人发过消息的用户。
// /find 可用位置：日志群、与机器人的私聊、超群话题内（话题内可不带 ID，直接查当前用户）
// 黑名单存于 KV（键前缀 blacklist:），被拉黑用户的私聊消息将被静默忽略。
// /ban 时若该用户已有关联话题，会自动 closeForumTopic 封锁话题；
// /unban 时自动 reopenForumTopic 解除封锁；若话题此前被手动删除，则用原标题重建并重新绑定。
//
// 安全：setWebhook 时传入 secret_token，并在环境变量 WEBHOOK_SECRET 配置相同值，
// Worker 会校验 X-Telegram-Bot-Api-Secret-Token 请求头，丢弃伪造的更新请求。

const BLACKLIST_PREFIX = "blacklist:";

function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}

async function isBlacklisted(uid, env) {
  return Boolean(await env.TOPIC_MAP.get(`${BLACKLIST_PREFIX}${uid}`));
}

async function blacklistUser(uid, admin, reason, env) {
  const rec = {
    uid: Number(uid),
    reason: reason || "",
    by: admin ? (admin.username ? `@${admin.username}` : admin.first_name || String(admin.id)) : "",
    at: new Date().toISOString(),
  };
  await env.TOPIC_MAP.put(`${BLACKLIST_PREFIX}${uid}`, JSON.stringify(rec));
}

async function unblacklistUser(uid, env) {
  await env.TOPIC_MAP.delete(`${BLACKLIST_PREFIX}${uid}`);
}

async function listBlacklist(env) {
  const items = [];
  for (const name of await listKeysWithPrefix(BLACKLIST_PREFIX, env)) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec) items.push(rec);
  }
  items.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return items;
}

function formatBlacklistRow(rec) {
  const parts = [`用户ID: ${rec.uid}`];
  if (rec.reason) parts.push(`备注: ${rec.reason}`);
  if (rec.by) parts.push(`操作人: ${rec.by}`);
  if (rec.at) parts.push(`时间: ${rec.at.replace("T", " ").slice(0, 16)} UTC`);
  return "• " + parts.join(" | ");
}

// 管理员命令入口。返回 true 表示该消息已作为命令处理，不再走普通转发流程。
async function handleAdminCommand(msg, env) {
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return false;

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase(); // 兼容 /ban@MyBot 形式
  const args = parts.slice(1);
  const chatId = msg.chat.id;
  const supergroupId = Number(env.SUPERGROUP_ID);
  const logChatId = Number(env.LOG_CHAT_ID);

  const isBanCmd = cmd === "/ban" || cmd === "/blacklist";
  const isUnbanCmd = cmd === "/unban" || cmd === "/unblacklist";
  const isListCmd = cmd === "/banlist" || cmd === "/blacklists";
  const isChatCmd = cmd === "/chat" || cmd === "/msg";
  const isFindCmd = cmd === "/find";
  if (!isBanCmd && !isUnbanCmd && !isListCmd && !isChatCmd && !isFindCmd) return false;

  // ---------- 话题内：直接作用于该话题绑定的用户 ----------
  if (Number(chatId) === supergroupId && msg.message_thread_id) {
    if (isChatCmd) {
      // 话题内本身就是与用户的对话，/chat 仅支持在日志群或私聊发起
      await tgCall(env, "sendMessage", {
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: "当前话题已是与用户的对话。如需主动联系其他用户，请在日志群或机器人私聊中使用：/chat <用户ID> [消息内容]",
      });
      return true;
    }
    if (isFindCmd) {
      // 话题内 /find 不带 ID 即查询当前话题的用户
      const uid = await findUserByThread(msg.message_thread_id, env);
      await handleFindCommand(msg, args, env, uid);
      return true;
    }
    const uid = await findUserByThread(msg.message_thread_id, env);
    if (!uid) {
      await tgCall(env, "sendMessage", {
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: "未找到该话题对应的用户。",
      });
      return true;
    }
    if (isBanCmd) {
      await blacklistUser(uid, msg.from, args.join(" "), env);
      await tgCall(env, "sendMessage", {
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: `⛔ 已将用户 ${uid} 加入黑名单，其后续私聊将被忽略，话题即将关闭。`,
      });
      const topic = await closeTopicForUser(uid, env);
      if (topic && !topic.closeRes.ok) {
        await tgCall(env, "sendMessage", {
          chat_id: chatId,
          message_thread_id: msg.message_thread_id,
          text: `⚠️ 话题关闭失败（${topic.closeRes.description || "未知错误"}），请检查机器人的“管理话题”权限。`,
        });
      }
    } else if (isUnbanCmd) {
      await unblacklistUser(uid, env);
      let reopen = null;
      let reopenErr = null;
      try {
        reopen = await reopenTopicForUser(uid, env);
      } catch (e) {
        reopenErr = e;
      }
      if (reopen && reopen.recreated) {
        await tgCall(env, "sendMessage", {
          chat_id: chatId,
          message_thread_id: msg.message_thread_id,
          text: `✅ 已将用户 ${uid} 移出黑名单。原话题已被删除，已用原标题重建话题「${reopen.rec.title}」。`,
        });
      } else {
        const extra = reopenErr
          ? `（⚠️ 重新打开话题失败：${reopenErr.message}）`
          : reopen && reopen.reopened
            ? "，话题已重新打开"
            : "";
        await tgCall(env, "sendMessage", {
          chat_id: chatId,
          message_thread_id: msg.message_thread_id,
          text: `✅ 已将用户 ${uid} 移出黑名单${extra}。`,
        });
      }
    } else {
      await tgCall(env, "sendMessage", {
        chat_id: chatId,
        message_thread_id: msg.message_thread_id,
        text: "请使用 /banlist 在日志群查看黑名单。",
      });
    }
    return true;
  }

  // ---------- 日志群 / 私聊 ----------
  if (Number(chatId) === logChatId || msg.chat.type === "private") {
    if (isListCmd || (isBanCmd && args.length === 0 && !msg.reply_to_message)) {
      const items = await listBlacklist(env);
      const body = items.length ? items.map(formatBlacklistRow).join("\n") : "（黑名单为空）";
      await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text: `📋 黑名单（共 ${items.length} 人）\n\n${body}`,
      });
      return true;
    }

    // 主动给已知 ID 的用户发起对话
    if (isChatCmd) {
      await handleChatCommand(msg, args, env);
      return true;
    }

    // 查询用户话题 / 黑名单状态
    if (isFindCmd) {
      await handleFindCommand(msg, args, env, null);
      return true;
    }

    if (isBanCmd || isUnbanCmd) {
      let targetId = null;
      let reason = "";

      if (args.length && /^\d+$/.test(args[0])) {
        targetId = Number(args[0]);
        reason = args.slice(1).join(" ");
      } else if (msg.reply_to_message) {
        // 回复违规通知消息，无需手动输入 ID
        const m = (msg.reply_to_message.text || "").match(/用户ID[:：]\s*(\d+)/);
        if (m) targetId = Number(m[1]);
        reason = args.join(" ");
      }

      if (!targetId) {
        await tgCall(env, "sendMessage", {
          chat_id: chatId,
          text:
            "用法：\n" +
            "/ban <用户ID> [备注] — 加入黑名单\n" +
            "/unban <用户ID> — 移出黑名单\n" +
            "/banlist — 查看黑名单\n" +
            "/chat <用户ID> [消息内容] — 主动给该用户发起对话\n" +
            "/find <用户ID> — 查询用户的话题与黑名单状态\n\n" +
            "也可以直接回复一条违规通知消息发送 /ban。",
        });
        return true;
      }

      if (isBanCmd && isAdmin(targetId)) {
        await tgCall(env, "sendMessage", { chat_id: chatId, text: "⚠️ 不能将管理员加入黑名单。" });
        return true;
      }

      if (isBanCmd) {
        await blacklistUser(targetId, msg.from, reason, env);
        const topic = await closeTopicForUser(targetId, env);
        const topicNote = topic
          ? topic.closeRes.ok
            ? `其话题「${topic.rec.title}」已关闭封锁。`
            : `⚠️ 其话题「${topic.rec.title}」关闭失败（${topic.closeRes.description || "未知错误"}），请检查机器人的“管理话题”权限。`
          : "该用户暂无关联话题。";
        await tgCall(env, "sendMessage", {
          chat_id: chatId,
          text: `⛔ 已将用户 ${targetId} 加入黑名单${reason ? `，备注: ${reason}` : ""}。其后续私聊将被静默忽略。${topicNote}`,
        });
      } else {
        await unblacklistUser(targetId, env);
        let reopen = null;
        let reopenErr = null;
        try {
          reopen = await reopenTopicForUser(targetId, env);
        } catch (e) {
          reopenErr = e;
        }
        let topicNote;
        if (reopenErr) topicNote = `⚠️ 恢复话题失败：${reopenErr.message}`;
        else if (!reopen) topicNote = "该用户暂无关联话题，待其下次发消息时自动创建。";
        else if (reopen.recreated) topicNote = `原话题已被删除，已用原标题重建话题「${reopen.rec.title}」并重新绑定。`;
        else if (reopen.reopened) topicNote = `话题「${reopen.rec.title}」已重新打开。`;
        else topicNote = "";
        await tgCall(env, "sendMessage", { chat_id: chatId, text: `✅ 已将用户 ${targetId} 移出黑名单。${topicNote}` });
      }
      return true;
    }
  }

  return false;
}

// /chat <用户ID> [消息内容]：主动给已知 ID 的用户发起对话
async function handleChatCommand(msg, args, env) {
  const chatId = msg.chat.id;

  if (!args.length || !/^\d+$/.test(args[0])) {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text:
        "用法：/chat <用户ID> [消息内容]\n\n" +
        "只带 ID：为该用户创建（或复用已有）话题，之后在该话题内发消息即可；\n" +
        "带消息内容：立即把该消息发给用户，并在话题内留档。\n\n" +
        "注意：若对方从未给机器人发过消息（未 start），Telegram 将禁止机器人主动发送。",
    });
    return;
  }

  const targetId = Number(args[0]);
  const outText = args.slice(1).join(" ").trim();

  if (isAdmin(targetId)) {
    await tgCall(env, "sendMessage", { chat_id: chatId, text: "⚠️ 对方是管理员，无需通过 /chat 发起对话。" });
    return;
  }

  if (await isBlacklisted(targetId, env)) {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ 用户 ${targetId} 在黑名单中，如需对话请先执行 /unban ${targetId}。`,
    });
    return;
  }

  const key = `user:${targetId}`;
  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  let created = false;

  if (!rec) {
    try {
      rec = await createProactiveTopic(targetId, env);
      created = true;
    } catch (e) {
      await tgCall(env, "sendMessage", { chat_id: chatId, text: `❌ 创建话题失败：${e.message}` });
      return;
    }
  }

  if (!outText) {
    const closedNote = rec.closed ? "\n⚠️ 该话题此前被管理员关闭，用户回复会被拦截，需先在超群内重新开启话题。" : "";
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: created
        ? `✅ 已为用户 ${targetId} 创建话题「${rec.title}」，在该话题内发送消息即可与其对话。${closedNote}`
        : `✅ 用户 ${targetId} 已有话题「${rec.title}」，在该话题内发送消息即可与其对话。${closedNote}`,
    });
    return;
  }

  const res = await tgCall(env, "sendMessage", { chat_id: targetId, text: outText });

  if (res.ok) {
    // 话题内留档（BOT_ID 已配置时机器人自己的消息不会被重复转发）
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: rec.thread_id,
      text: `📤 主动发送给用户 ${targetId}：\n${outText}`,
    });
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ 消息已发送给用户 ${targetId}，后续可在话题「${rec.title}」内继续对话。`,
    });
  } else {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text:
        `❌ 发送失败（${res.error_code || ""} ${res.description || ""}）。\n` +
        "常见原因：对方从未给机器人发过消息（Telegram 禁止机器人主动联系此类用户）、ID 有误，或对方已停用机器人。",
    });
  }
}

// /find [用户ID]：查询用户的话题与黑名单状态；话题内不带 ID 时查询当前话题用户
async function handleFindCommand(msg, args, env, threadUid) {
  const chatId = msg.chat.id;

  let targetId = null;
  if (args.length && /^\d+$/.test(args[0])) targetId = Number(args[0]);
  else if (threadUid) targetId = threadUid;

  if (!targetId) {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: "用法：/find <用户ID>\n（在话题内可不带 ID，直接查询该话题对应的用户）",
    });
    return;
  }

  const lines = [`🔍 用户 ${targetId}`];

  const rec = await env.TOPIC_MAP.get(`user:${targetId}`, { type: "json" });
  if (rec) {
    lines.push(`话题：${rec.title || "无标题"}（${rec.closed ? "已关闭" : "开放中"}）`);
    const link = topicDeepLink(env.SUPERGROUP_ID, rec.thread_id);
    if (link) lines.push(`直达：${link}`);
  } else {
    lines.push("话题：无关联话题（可能从未发起过对话）");
  }

  const bl = await env.TOPIC_MAP.get(`${BLACKLIST_PREFIX}${targetId}`, { type: "json" });
  if (bl) {
    const parts = ["黑名单：是"];
    if (bl.reason) parts.push(`备注: ${bl.reason}`);
    if (bl.by) parts.push(`操作人: ${bl.by}`);
    if (bl.at) parts.push(`时间: ${bl.at.replace("T", " ").slice(0, 16)} UTC`);
    lines.push(parts.join("，"));
  } else {
    lines.push("黑名单：否");
  }

  // 尽量补充当前资料（用户与机器人有过交互时才能取到）
  const info = await tgCall(env, "getChat", { chat_id: targetId });
  if (info.ok && info.result && info.result.type === "private") {
    const name = [info.result.first_name, info.result.last_name].filter(Boolean).join(" ");
    if (name) lines.push(`昵称：${name}`);
    if (info.result.username) lines.push(`用户名：@${info.result.username}`);
  }

  await tgCall(env, "sendMessage", { chat_id: chatId, text: lines.join("\n") });
}

// 私有超群的话题直达链接（SUPERGROUP_ID 需为 -100 开头）
function topicDeepLink(supergroupId, threadId) {
  const s = String(Number(supergroupId) || "");
  if (!s.startsWith("-100") || !threadId) return null;
  return `https://t.me/c/${s.slice(4)}/${threadId}`;
}

// =========================
// 强化违禁词规则（低误伤版）
// =========================

// 通用分隔符
const SEP = `(?:[_\\-.·•*~|,/\\\\]|\\u200b|\\u200c|\\u200d|\\ufeff)*`;

const BANNED_RULES = [

  // =========================
  // 赌博
  // =========================
  {
    name: "赌博",
    pattern: new RegExp(
      [
        `赌${SEP}博`,
        `博${SEP}彩`,
        `赌${SEP}盘`,
        `赌${SEP}钱`,
        `开${SEP}奖`,
        `六${SEP}合${SEP}彩`,
        `百${SEP}家${SEP}乐`,
        `澳${SEP}门${SEP}赌${SEP}场`,
        `线${SEP}上${SEP}赌${SEP}场`,
        `体${SEP}彩`,
        `福${SEP}彩`,
        `刷${SEP}流${SEP}水`,
        `洗${SEP}码`,
        `上${SEP}分`,
        `下${SEP}分`,
        `代${SEP}充`,
        `跑${SEP}码`,
        `庄${SEP}家`,
        `赌${SEP}狗`,
        `盘${SEP}口`,
        `\\bcasino\\b`,
        `\\bbet\\b`,
        `\\bbet365\\b`,
        `\\bsportsbook\\b`,
        `\\bgambling\\b`,
      ].join("|"),
      "iu"
    ),
  },

  // =========================
  // 加密货币
  // =========================
  {
    name: "加密货币",
    pattern: new RegExp(
      [
        `比${SEP}特${SEP}币`,
        `虚${SEP}拟${SEP}币`,
        `数${SEP}字${SEP}货${SEP}币`,
        `加${SEP}密${SEP}货${SEP}币`,
        `区${SEP}块${SEP}链`,
        `搬${SEP}砖`,
        `搬${SEP}砖${SEP}套${SEP}利`,
        `量${SEP}化${SEP}交${SEP}易`,
        `跟${SEP}单`,
        `带${SEP}单`,
        `合${SEP}约`,
        `跑${SEP}U`,
        `U${SEP}商`,
        `冷${SEP}钱${SEP}包`,
        `热${SEP}钱${SEP}包`,
        `空${SEP}投`,
        `发${SEP}币`,
        `发${SEP}空${SEP}投`,
        `\\bbtc\\b`,
        `\\beth\\b`,
        `\\busdt\\b`,
        `\\btrx\\b`,
        `\\bbnb\\b`,
        `\\bbitcoin\\b`, 
        `\\bethereum\\b`,
        `\\bsolana\\b`,
        `\\bwallet\\b`,
        `\\bweb3\\b`,
        `\\bcoinbase\\b`,
        `\\bbinance\\b`,
        `\\bokx\\b`,
        `\\bbybit\\b`,
        `\\bmetamask\\b`,
        `\\b\\d+(?:\\.\\d+)?\\s*(?:u|usdt|usdc)\\b`,
      ].join("|"),
      "iu"
    ),
  },

  // =========================
  // 色情
  // =========================
  {
    name: "色情",
    pattern: new RegExp(
      [
        `约${SEP}炮`,
        `一${SEP}夜${SEP}情`,
        `援${SEP}交`,
        `嫖${SEP}娼`,
        `找${SEP}小${SEP}姐`,
        `上${SEP}门${SEP}服${SEP}务`,
        `裸${SEP}聊`,
        `脱${SEP}衣${SEP}直${SEP}播`,
        `性${SEP}服${SEP}务`,
        `做${SEP}爱`,
        `性${SEP}交`,
        `黄${SEP}网`,
        `色${SEP}网`,
        `成${SEP}人${SEP}网`,
        `成${SEP}人${SEP}视${SEP}频`,
        `A${SEP}片`,
        `真${SEP}人${SEP}秀`,
        `\\bporn\\b`,
        `\\bescort\\b`,
        `\\bnude\\b`,
        `\\bonlyfans\\b`,
        `\\bsex\\b`,
        `\\bxxx\\b`,
      ].join("|"),
      "iu"
    ),
  },

  // =========================
  // 广告 / 引流
  // =========================
  {
    name: "广告",
    pattern: new RegExp(
      [
        `加${SEP}[v微威V]`,
        `微${SEP}信`,
        `联${SEP}系${SEP}客${SEP}服`,
        `推${SEP}广`,
        `(?:低|高)${SEP}价`,
        `引${SEP}流`,
        `导${SEP}流`,
        `拉${SEP}人`,
        `代${SEP}发`,
        `群${SEP}发`,
        `私${SEP}聊`,
        `兼${SEP}职`,
        `诚${SEP}招${SEP}代${SEP}理`,
        `代${SEP}理`,
        `会${SEP}员`,
        `自${SEP}助`,
        `获${SEP}客`,
        `精${SEP}准${SEP}引${SEP}流`,
        `爆${SEP}粉`,
        `涨${SEP}粉`,
        `增${SEP}粉`,
        `私${SEP}域`,
        `裂${SEP}变`,
        `客${SEP}源`,
        `客${SEP}户${SEP}资${SEP}源`,
        `脚${SEP}本`,
        `同${SEP}城`,
        `大${SEP}奖`,
        `无${SEP}门${SEP}槛`,
        `通${SEP}知${SEP}频${SEP}道`,
        `号${SEP}段${SEP}批${SEP}发`,
        `账${SEP}号${SEP}批${SEP}发`,
        `海${SEP}外${SEP}号${SEP}码`,
        `接${SEP}码`,
        `接${SEP}码${SEP}平${SEP}台`,
        `卖${SEP}号`,
        `买${SEP}号`,
        `老${SEP}号`,
        `成${SEP}品${SEP}号`,
        `协${SEP}议${SEP}号`,
        `镜${SEP}像${SEP}站`,
        `镜${SEP}花`,
        `出${SEP}hao`,
        `月${SEP}卡`,
        `全${SEP}国`,
        `每${SEP}日${SEP}不`,
        `t\\.me\\/`,
        `telegram`,
        `bot`,
        `discord`,
        `wechat`,
        `whatsapp`,
        `line`,
        `bot`,
      ].join("|"),
      "iu"
    ),
  },

  // =========================
  // 诈骗 / 黑产
  // =========================
  {
    name: "诈骗",
    pattern: new RegExp(
      [
        `刷${SEP}单`,
        `跑${SEP}分`,
        `洗${SEP}钱`,
        `黑${SEP}产`,
        `灰${SEP}产`,
        `四${SEP}件${SEP}套`,
        `卡${SEP}商`,
        `料${SEP}子`,
        `接${SEP}码`,
        `验${SEP}证${SEP}码${SEP}平${SEP}台`,
        `银${SEP}行${SEP}卡${SEP}出${SEP}售`,
        `代${SEP}收`,
        `代${SEP}开`,
        `骗${SEP}局`,
        `钓${SEP}鱼${SEP}网${SEP}站`,
        `跑${SEP}路`,
        `洗${SEP}白`,
        `黑${SEP}卡`,
        `黑${SEP}号`,
        `黑${SEP}料`,
        `实名${SEP}卡`,
        `\\bscam\\b`,
        `\\bfraud\\b`,
        `\\bfake\\b`,
        `\\bphishing\\b`,
      ].join("|"),
      "iu"
    ),
  },

  // =========================
  // 毒品
  // =========================
  {
    name: "毒品",
    pattern: new RegExp(
      [
        `冰${SEP}毒`,
        `海${SEP}洛${SEP}因`,
        `可${SEP}卡${SEP}因`,
        `摇${SEP}头${SEP}丸`,
        `k${SEP}粉`,
        `大${SEP}麻`,
        `麻${SEP}古`,
        `笑${SEP}气`,
        `白${SEP}粉`,
        `毒${SEP}品`,
        `冰${SEP}壶`,
        `麻${SEP}醉${SEP}药`,
        `\\bcocaine\\b`,
        `\\bheroin\\b`,
        `\\bmeth\\b`,
        `\\bweed\\b`,
        `\\bdrug\\b`,
      ].join("|"),
      "iu"
    ),
  },
];

// 提取消息文本
function extractMessageText(msg) {
  let text = [
    msg.text || "",
    msg.caption || "",
  ];

  // inline keyboard
  if (msg.reply_markup?.inline_keyboard) {
    for (const row of msg.reply_markup.inline_keyboard) {
      for (const btn of row) {
        if (btn.text) text.push(btn.text);
      }
    }
  }

  return text.join("\n").trim();
}

// 审核消息
function checkMessageContent(msg) {
  if (!ENABLE_CONTENT_FILTER) {
    return null;
  }

  // 管理员跳过
  if (
    msg.from &&
    ADMIN_IDS.includes(Number(msg.from.id))
  ) {
    return null;
  }

  const text = extractMessageText(msg);

  if (!text) {
    return null;
  }

  // 统一格式
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, "")

  for (const rule of BANNED_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        hit: true,
        rule: rule.name,
        content: text,
      };
    }
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK");

    // Webhook 来源校验：setWebhook 时需传入相同的 secret_token（见文件头说明）
    if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 管理员命令（黑名单管理）优先处理
    if (msg.text && msg.from && isAdmin(msg.from.id)) {
      const handled = await handleAdminCommand(msg, env);
      if (handled) return new Response("OK");
    }

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


  // 黑名单用户：静默忽略
  if (await isBlacklisted(userId, env)) {
    console.log("blocked blacklisted user", { userId });
    return;
  }


  // =========================
  // 内容审核
  // =========================

  const check = checkMessageContent(msg);

  if (check) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text:
        "⚠️ 你的消息包含违禁内容，已被系统拦截。\n\n" +
        `命中规则：${check.rule}`,
    });

    console.log("blocked private message", {
      userId,
      rule: check.rule,
      content: check.content,
    });

    await tgCall(env, "sendMessage", {
      chat_id: env.LOG_CHAT_ID,
      text:
        "🚨 检测到违禁内容\n\n" +
        `方向: 用户 -> 话题\n` +
        `用户ID: ${msg.from?.id}\n` +
        `用户名: @${msg.from?.username || "无"}\n` +
        `命中规则: ${check.rule}\n\n` +
        `内容:\n${check.content}\n\n` +
        `💡 回复此消息并发送 /ban 可将该用户加入黑名单`,
    });

    return;
  }

  let rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。",
    });
    return;
  }
  if (!rec) rec = await createAndStoreTopic(msg.from, userId, env);

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
    const newRec = await createAndStoreTopic(msg.from, userId, env);
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

  // =========================
  // 内容审核
  // =========================

  const check = checkMessageContent(msg);

  if (check) {
    await tgCall(env, "sendMessage", {
      chat_id: msg.chat.id,
      message_thread_id: threadId,
      text:
        "⚠️ 检测到违禁内容，消息未发送。\n\n" +
        `命中规则：${check.rule}`,
    });

    console.log("blocked topic message", {
      threadId,
      rule: check.rule,
      content: check.content,
    });

    await tgCall(env, "sendMessage", {
      chat_id: env.LOG_CHAT_ID,
      text:
        "🚨 检测到违禁内容\n\n" +
        `方向: 管理员 -> 用户\n` +
        `用户ID: ${msg.from?.id}\n` +
        `用户名: @${msg.from?.username || "无"}\n` +
        `命中规则: ${check.rule}\n\n` +
        `内容:\n${check.content}`,
    });




    return;
  }


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

// 创建话题（同时写入 thread:<id> -> uid 反向索引）
async function createAndStoreTopic(from, uid, env) {
  const title = buildTopicTitle(from);
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(`user:${uid}`, JSON.stringify(rec));
  await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(uid));
  return rec;
}

// 主动发起对话时创建话题：尽量用 getChat 拿到对方资料作为标题，拿不到则用 ID
async function createProactiveTopic(uid, env) {
  let title = `用户 ${uid}`;
  const info = await tgCall(env, "getChat", { chat_id: uid });
  if (info.ok && info.result && info.result.type === "private") {
    const t = buildTopicTitle({
      first_name: info.result.first_name || "",
      last_name: info.result.last_name || "",
      username: info.result.username || "",
    });
    if (t && t !== "User") title = t;
  }
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(`user:${uid}`, JSON.stringify(rec));
  await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(uid));
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
  const hit = await findUserRecordByThread(threadId, env);
  if (!hit || hit.rec.closed) return;
  hit.rec.closed = true;
  await env.TOPIC_MAP.put(hit.key, JSON.stringify(hit.rec));
}
async function markThreadReopened(threadId, env) {
  const hit = await findUserRecordByThread(threadId, env);
  if (!hit || !hit.rec.closed) return;
  hit.rec.closed = false;
  await env.TOPIC_MAP.put(hit.key, JSON.stringify(hit.rec));
}

// /ban 配套：关闭用户关联的话题（封锁后用户无法再通过该话题对话）
async function closeTopicForUser(uid, env) {
  const key = `user:${uid}`;
  const rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (!rec) return null;

  const closeRes = await tgCall(env, "closeForumTopic", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: rec.thread_id,
  });
  rec.closed = true;
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  return { rec, closeRes };
}

// /unban 配套：重新打开用户关联的话题；话题已被手动删除时用原标题重建并重新绑定。
async function reopenTopicForUser(uid, env) {
  const key = `user:${uid}`;
  const rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (!rec) return null;

  if (!rec.closed) return { rec, recreated: false, reopened: false };

  const res = await tgCall(env, "reopenForumTopic", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: rec.thread_id,
  });
  // 记录未标记但话题其实已被手动删除，退回重建
  if (!res.ok && isThreadMissingError(res)) return recreateTopicForUser(uid, env);
  rec.closed = false;
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  return { rec, recreated: false, reopened: res.ok };
}

async function recreateTopicForUser(uid, env) {
  const key = `user:${uid}`;
  const rec = await env.TOPIC_MAP.get(key, { type: "json" });
  if (!rec) return null;

  const title = rec.title || `用户 ${uid}`;
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  await env.TOPIC_MAP.delete(`thread:${rec.thread_id}`);
  rec.thread_id = res.result.message_thread_id;
  rec.closed = false;
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(uid));
  return { rec, recreated: true, reopened: false };
}

// 遍历指定前缀的所有 KV 键（list 单次最多返回 1000 条，需跟随游标）
async function listKeysWithPrefix(prefix, env) {
  const names = [];
  let cursor;
  do {
    const page = cursor ? await env.TOPIC_MAP.list({ prefix, cursor }) : await env.TOPIC_MAP.list({ prefix });
    for (const { name } of page.keys) names.push(name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

// 按 thread_id 反查用户记录：优先走 thread:<id> -> uid 反向索引（O(1)），
// 索引未命中（如历史数据）时回退全量扫描并回填索引
async function findUserRecordByThread(threadId, env) {
  const indexKey = `thread:${threadId}`;
  const indexedUid = await env.TOPIC_MAP.get(indexKey);
  if (indexedUid) {
    const key = `user:${indexedUid}`;
    const rec = await env.TOPIC_MAP.get(key, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      return { uid: Number(indexedUid), key, rec };
    }
  }
  for (const name of await listKeysWithPrefix("user:", env)) {
    const rec = await env.TOPIC_MAP.get(name, { type: "json" });
    if (rec && Number(rec.thread_id) === Number(threadId)) {
      const uid = Number(name.slice("user:".length));
      await env.TOPIC_MAP.put(indexKey, String(uid));
      return { uid, key: name, rec };
    }
  }
  return null;
}

// 按 thread_id 反查用户
async function findUserByThread(threadId, env) {
  const hit = await findUserRecordByThread(threadId, env);
  return hit ? hit.uid : null;
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
  for (const name of await listKeysWithPrefix("mg:", env)) {
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
