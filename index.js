// tools-mode —— 运行时收放工具（2026-11-15）
//
// 为什么：工具描述是每轮固定前缀，29k。收掉不用的，schema 就不进上下文，每轮都省。
// 怎么做：给模型一个 set_tools_mode 工具，三档——
//   soft  软糯：闲聊够用（聊 + QQ 发消息 + 读记忆）
//   ling  灵熙：常用包（读写/执行/网络/家里/状态）
//   genius 天才：全放回
// 机制：ctx.tools.restrict({ allow }) 在 agent 作用域上收放；restrict 的 disposer 恢复。
// 注意：restrict 的 allow 里不能出现 scope-local 名字，所以 set_tools_mode 全局注册。

const MODES = {
  // 软糯：能聊天、能往 QQ 发、能读记忆、能翻旧账
  soft: [
    'set_tools_mode',
    'tool_dir',
    'load_tools',
    'web_search',
    'web_fetch',
    'read',
    'session_search',
    'ask_user_question',
    'present',
    'mcp__family__family_room_say',
    'mcp__family__family_play_say',
    'mcp__family__family_call',
    'mcp__family__family_room_read',
  ],
  // 手：聊天分身档，只给「传消息 + 读少量资料」用
  hand: [
    'set_tools_mode', 'tool_dir', 'load_tools',
    'read', 'session_search',
    // 读群/读消息
    'mcp__snowluma__qq_status', 'mcp__snowluma__qq_list_groups',
    'mcp__snowluma__qq_get_group_members', 'mcp__snowluma__qq_get_group_history',
    'mcp__snowluma__qq_get_unread_messages', 'mcp__snowluma__qq_get_recent_messages',
    'mcp__snowluma__qq_get_message_detail', 'mcp__snowluma__qq_mark_read',
    // 发消息
    'mcp__snowluma__qq_send_group_message', 'mcp__snowluma__qq_send_private_message',
    'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_reply',
    'mcp__snowluma__qq_send_poke', 'mcp__snowluma__qq_send_sticker',
    // 家里
    'mcp__family__family_room_say', 'mcp__family__family_room_read',
  ],
  // 灵：常用包
  ling: [
    'set_tools_mode',
    'tool_dir',
    'load_tools',
    'session_search',
    'read', 'write', 'edit', 'glob', 'grep',
    'pwsh',
    'web_search', 'web_fetch',
    'ask_user_question', 'todo_write', 'skill', 'working_directory',
    'present',
    'mcp__family__family_room_say', 'mcp__family__family_play_say',
    'mcp__family__family_call', 'mcp__family__family_room_read', 'mcp__family__family_room_who',
  ],
};

// 工具目录：名字 → 一句话（只覆盖常用；没覆盖的就是「切档或 find-tool 查」）
// 柜子外要贴标签：光写「有」没用，得写「喊哪个词」
const HINTS = {
  set_tools_mode: '切档（soft/ling/genius）',
  tool_dir: '看当前档有什么工具',
  read: '读文件',
  write: '写文件（整篇）',
  edit: '局部改文件',
  glob: '按名字找文件',
  grep: '按内容搜文件',
  pwsh: '跑命令/脚本',
  web_search: '搜网页',
  web_fetch: '抓一个网页',
  session_search: '翻历史会话',
  ask_user_question: '问他',
  present: '交付文件卡片',
  todo_write: '列待办',
  skill: '加载技能',
  working_directory: '换工作目录',
  subagent: '派子代理',
};

/** 每个 agent 的收放状态 */
const state = new Map(); // agentId -> { restrict: (()=>void) | null, mode: string }

export const inject = ['tools'];

export function apply(ctx, config = {}) {
  // 记下每个 agent 的 ctx（restrict 要在它自己的 scope 上调）
  // 默认档**保持 genius**——有的 agent 有多个子会话（每个都要全量工具），
  // 靠 mcp__snowluma 那组约 50 个 QQ 工具吃饭；默认 ling 会把她们的手全收掉、回不了群。
  // 日常档由主会话按需要切，别在默认值上一刀切。
  ctx.on('agent/created', ({ agent }) => {
    if (agent && agent.id) state.set(agent.id, { restrict: null, mode: 'genius', ctx: agent.ctx });
  });

  const disposeTool = ctx.tools.register({
    name: 'set_tools_mode',
    description: '切换工具档位（省工具描述 token）。记这一句就够：**要干活就切 ling（灵熙）**；聊完想省就切回 soft（软糯）。genius（天才）是给重活的，日常用不上，别切。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['soft', 'ling', 'genius'], description: '目标档位' },
      },
      required: ['mode'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          allowedCount: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const agentId = exec && exec.agent && exec.agent.id;
      let st = agentId ? state.get(agentId) : null;
      // 兜底：插件加载前就存在的会话没有 agent/created 记录，用插件自己的 ctx 试
      const actx = (st && st.ctx) || ctx;
      const mode = String(args && args.mode || '');
      if (!MODES[mode] && mode !== 'genius') throw new Error(`未知档位：${mode}`);
      if (!st) { st = { restrict: null, mode: 'genius', ctx: actx }; if (agentId) state.set(agentId, st); }

      // 先放回旧的
      if (st.restrict) { try { st.restrict(); } catch {} st.restrict = null; }
      // 切档时清掉 load_tools 临时加载的（档位变了，额外工具不该跟着走）
      st.extra = new Set();

      let allowedCount = 0;
      if (mode !== 'genius') {
        const allow = MODES[mode];
        st.restrict = actx.tools.restrict({ allow });
        allowedCount = allow.length;
      }
      st.mode = mode;
      return { ok: true, mode, allowedCount };
    },
  });

  const disposeDir = ctx.tools.register({
    name: 'tool_dir',
    description: '列当前档位能用的工具（名字 + 一句话，按常用排）。找不到工具、或不确定手里的档有没有某个能力时，先看它。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { mode: { type: 'string' }, count: { type: 'number' }, tools: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: `档位：${value.mode}（${value.count} 个）\n${value.tools}` }],
    },
    execute: async (_args, exec) => {
      const agentId = exec && exec.agent && exec.agent.id;
      const st = agentId ? state.get(agentId) : null;
      const mode = st ? st.mode : 'genius';
      const names = mode === 'genius'
        ? Object.keys(HINTS)
        : (MODES[mode] || []).filter((n) => n in HINTS || true);
      // 常用在前：HINTS 的键顺序就是常用序；名单外的名字缀在后面
      const ordered = [...names].sort((a, b) => {
        const ia = Object.keys(HINTS).indexOf(a); const ib = Object.keys(HINTS).indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
      const tools = ordered.map((n) => `${n} — ${HINTS[n] || '（不常用；要细节切天才或 find-tool 查）'}`).join('\n');
      return { mode, count: ordered.length, tools };
    },
  });

  const disposeLoad = ctx.tools.register({
    name: 'load_tools',
    description: '按名加载工具（一次批量放行，工具表只变一次）。低档里临时要用档外工具时用：load_tools(["session_search"])。别一个个取，一次取够。',
    parameters: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, description: '工具名数组' } },
      required: ['names'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, mode: { type: 'string' }, added: { type: 'array', items: { type: 'string' } }, allowedCount: { type: 'number' } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const agentId = exec && exec.agent && exec.agent.id;
      let st = agentId ? state.get(agentId) : null;
      const actx = (st && st.ctx) || ctx;
      if (!st) { st = { restrict: null, mode: 'genius', extra: new Set(), ctx: actx }; if (agentId) state.set(agentId, st); }
      if (!st.extra) st.extra = new Set();
      const names = (args && Array.isArray(args.names) ? args.names : []).filter((n) => typeof n === 'string' && n.trim());
      for (const n of names) st.extra.add(n.trim());
      if (st.mode !== 'genius') {
        if (st.restrict) { try { st.restrict(); } catch {} st.restrict = null; }
        const allow = [...(MODES[st.mode] || []), ...st.extra];
        st.restrict = actx.tools.restrict({ allow });
      }
      return { ok: true, mode: st.mode, added: names, allowedCount: st.mode === 'genius' ? 0 : (MODES[st.mode] || []).length + st.extra.size };
    },
  });

  return () => {
    try { disposeTool(); } catch {}
    try { disposeDir(); } catch {}
    try { disposeLoad(); } catch {}
    for (const st of state.values()) { try { if (st.restrict) st.restrict(); } catch {} }
    state.clear();
  };
}