import type { ToolDefinition } from "@nichijou/shared";
import type { Gateway } from "../gateway/gateway.js";
import type { FamilyManager } from "../family/family-manager.js";
import type { StorageManager } from "../storage/storage.js";

// 辅助函数：从成员档案中解析昵称信息
function parseAliasesFromProfile(profile: string): string[] {
  const aliases: string[] = [];
  
  const aliasMatch = profile.match(/[-•]\s*昵称[\/别名]*\s*[:：]\s*([^\n\r]+)/i);
  if (aliasMatch && aliasMatch[1] && aliasMatch[1].trim() !== "（如：妈妈、爸爸、小明等，用逗号分隔多个昵称）") {
    const aliasText = aliasMatch[1].trim();
    aliases.push(...aliasText.split(/[,，;；、]\s*/).filter(alias => alias.trim()));
  }

  return aliases;
}

// 查找匹配的成员（支持姓名、昵称、ID）
function findMembersByQuery(query: string, familyManager: FamilyManager, storage: StorageManager) {
  const members = familyManager.getMembers();
  const matches: Array<{
    member: any;
    matchType: "id" | "name" | "alias" | "preferred";
    matchValue: string;
  }> = [];

  const queryLower = query.toLowerCase().trim();

  for (const member of members) {
    // 精确ID匹配
    if (member.id === query) {
      matches.push({ member, matchType: "id", matchValue: member.id });
      continue;
    }

    // 姓名匹配（精确和模糊）
    if (member.name.toLowerCase() === queryLower || member.name.toLowerCase().includes(queryLower)) {
      matches.push({ member, matchType: "name", matchValue: member.name });
      continue;
    }

    // 偏好称呼匹配
    if (member.preferredName && member.preferredName.toLowerCase() === queryLower) {
      matches.push({ member, matchType: "preferred", matchValue: member.preferredName });
      continue;
    }

    // 从档案中解析的昵称匹配
    const profile = storage.readMemberProfile(member.id);
    if (profile) {
      const profileAliases = parseAliasesFromProfile(profile);
      for (const alias of profileAliases) {
        if (alias.toLowerCase() === queryLower || alias.toLowerCase().includes(queryLower)) {
          matches.push({ member, matchType: "alias", matchValue: alias });
          break;
        }
      }
    }

    // FamilyMember.aliases 字段匹配
    if (member.aliases) {
      for (const alias of member.aliases) {
        if (alias.toLowerCase() === queryLower || alias.toLowerCase().includes(queryLower)) {
          matches.push({ member, matchType: "alias", matchValue: alias });
          break;
        }
      }
    }
  }

  return matches;
}

export function createMessageTools(
  gateway: Gateway,
  familyManager: FamilyManager,
  storage: StorageManager,
  clearSessionFn: (memberId: string) => void,
  getCurrentMemberId?: () => string | undefined,
): ToolDefinition[] {
  return [
    {
      name: "send_message",
      description:
        "给家庭成员发送一条微信消息。支持通过成员ID、姓名或昵称指定目标成员。适用于主动通知、提醒结果转发、跨成员传话等场景。",
      parameters: {
        type: "object",
        properties: {
          target: { 
            type: "string", 
            description: "目标成员ID、姓名或昵称（推荐先用resolve_member工具获取准确的ID）" 
          },
          message: { type: "string", description: "消息内容" },
        },
        required: ["target", "message"],
      },
      execute: async (params) => {
        const target = (params.target as string).trim();
        const message = (params.message as string).trim();
        
        if (!target || !message) {
          return { content: "目标成员和消息内容不能为空", isError: true };
        }

        // 防误发保护：检查是否试图给自己发消息
        const currentMemberId = getCurrentMemberId?.();
        if (currentMemberId && target === currentMemberId) {
          return { 
            content: "无法给自己发送消息，请检查目标成员是否正确。", 
            isError: true 
          };
        }

        let targetMemberId = target;
        let targetMember = familyManager.getMember(target);
        
        // 如果不是有效的memberID，尝试通过姓名/昵称解析
        if (!targetMember) {
          const matches = findMembersByQuery(target, familyManager, storage);
          
          if (matches.length === 0) {
            return { 
              content: `未找到匹配"${target}"的成员。请检查姓名、昵称或ID是否正确，或使用resolve_member工具查找准确信息。`,
              isError: true 
            };
          }
          
          if (matches.length > 1) {
            let resultText = `找到多个匹配"${target}"的成员，请使用具体的成员ID：\n\n`;
            matches.forEach((match, index) => {
              const displayName = match.member.preferredName || match.member.name;
              resultText += `${index + 1}. ${displayName} - ID: ${match.member.id}\n`;
            });
            resultText += "\n请重新指定准确的成员ID。";
            
            return { content: resultText, isError: true };
          }
          
          // 唯一匹配，使用找到的成员
          const match = matches[0];
          targetMemberId = match.member.id;
          targetMember = match.member;
          
          // 再次检查防误发保护
          if (currentMemberId && targetMemberId === currentMemberId) {
            return { 
              content: "检测到您试图给自己发消息，已取消发送。", 
              isError: true 
            };
          }
        }

        try {
          await gateway.sendToMember(targetMemberId, message);
          
          const displayName = targetMember?.preferredName || targetMember?.name || targetMemberId;
          return { 
            content: `消息已成功发送给 ${displayName} (ID: ${targetMemberId})` 
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `发送失败: ${msg}`, isError: true };
        }
      },
    },
    {
      name: "clear_context",
      description:
        "清除指定成员的对话上下文记忆。当成员档案有重大更新、对话出现混乱、或需要重新开始对话时使用。",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "成员 ID" },
        },
        required: ["memberId"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        if (!memberId) {
          return { content: "memberId 不能为空", isError: true };
        }
        clearSessionFn(memberId);
        return { content: `已清除成员 ${memberId} 的对话上下文，下次对话将开始全新会话` };
      },
    },
  ];
}
