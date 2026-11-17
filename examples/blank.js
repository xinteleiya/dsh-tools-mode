// dsh-tools-mode · 白板版（示例，随便改）
//
// 干什么：运行时收放模型手里的工具，省掉每轮的固定前缀。
// 原理：ctx.tools.restrict({ allow }) —— 被收掉的工具从请求里消失，不是没权限。
//
// 怎么用：
//   1. 把本文件放进你的插件目录（或 add 本仓库）
//   2. 在插件配置里挂到宿主
//   3. 自己改下面 MODES，加/减档位
//
// 注意：
//   - 切档会重建前缀缓存（一次代价），别频繁切
//   - 新注册的工具对老会话不可见（要新会话）
//   - 默认档建议留全量（genius），日常再切

/**
 * 档位定义：名字 → 允许的工具列表
 * allow 里的名字就是工具名（见 tool schema 的 name 字段）
 */
const MODES = {
  // 示例档：聊天用（只留读记忆、读文件、搜）
  chat: {
    label: '聊天',
    allow: ['read', 'grep', 'glob', 'ls', 'web_search', 'web_fetch'],
  },
  // 示例档：日常（聊天 + 写 + 跑）
  daily: {
    label: '日常',
    allow: ['read', 'grep', 'glob', 'ls', 'write', 'edit', 'bash', 'web_search', 'web_fetch'],
  },
  // 全量档：不 restrict，全给
  full: {
    label: '全量',
    allow: null,
  },
};

const DEFAULT_MODE = 'full';

export default (ctx) => {
  let mode = DEFAULT_MODE;

  const apply = () => {
    const def = MODES[mode];
    if (!def || !Array.isArray(def.allow)) {
      ctx.tools.restrict(null); // 全量
      return;
    }
    ctx.tools.restrict({ allow: def.allow });
  };

  ctx.tools.register('set_tools_mode', {
    description: '切换工具档位（收放模型手里的工具）。可选档位见 MODES。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: Object.keys(MODES).join(' / ') },
      },
      required: ['mode'],
    },
    execute: async (args) => {
      if (!MODES[args.mode]) return { ok: false, error: '没有这个档位：' + args.mode };
      mode = args.mode;
      apply();
      return { ok: true, mode, label: MODES[mode].label };
    },
  });

  apply();
};
