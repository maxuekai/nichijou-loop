import type { ToolDefinition } from "@nichijou/shared";
import type { FamilyManager } from "../family/family-manager.js";
import type { StorageManager } from "../storage/storage.js";

// 解析成员档案中的昵称信息
function parseAliasesFromProfile(profile: string): string[] {
  const aliases: string[] = [];
  
  // 从档案中提取"昵称/别名"字段的信息
  const aliasMatch = profile.match(/[-•]\s*昵称[\/别名]*\s*[:：]\s*([^\n\r]+)/i);
  if (aliasMatch && aliasMatch[1] && aliasMatch[1].trim() !== "（如：妈妈、爸爸、小明等，用逗号分隔多个昵称）") {
    const aliasText = aliasMatch[1].trim();
    // 按逗号、分号或中文顿号分割
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

export function createFamilyTools(
  familyManager: FamilyManager,
  storage: StorageManager,
): ToolDefinition[] {
  return [
    {
      name: "get_family_info",
      description: "获取当前家庭信息和所有成员列表",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const family = familyManager.getFamily();
        const members = familyManager.getMembers();
        return {
          content: JSON.stringify({ family, members }, null, 2),
        };
      },
    },
    {
      name: "get_member_profile",
      description: "读取某个家庭成员的档案（包含习惯、偏好、AI 观察笔记等）",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "成员 ID" },
        },
        required: ["memberId"],
      },
      execute: async (params) => {
        const profile = storage.readMemberProfile(params.memberId as string);
        if (!profile) return { content: "成员档案不存在", isError: true };
        return { content: profile };
      },
    },
    {
      name: "update_member_profile",
      description: "更新家庭成员的档案信息（按 section 追加或替换）。section 是 Markdown 的 ## 标题",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "成员 ID" },
          section: { type: "string", description: "要更新的 section 标题，如 '生活习惯'" },
          content: { type: "string", description: "新内容" },
          mode: { type: "string", enum: ["append", "replace"], description: "追加还是替换" },
        },
        required: ["memberId", "section", "content"],
      },
      execute: async (params) => {
        const memberId = params.memberId as string;
        const section = params.section as string;
        const newContent = params.content as string;
        const mode = (params.mode as string) ?? "append";

        let profile = storage.readMemberProfile(memberId);
        if (!profile) return { content: "成员档案不存在", isError: true };

        const sectionHeader = `## ${section}`;
        const sectionIdx = profile.indexOf(sectionHeader);

        if (sectionIdx < 0) {
          profile += `\n${sectionHeader}\n${newContent}\n`;
        } else {
          const nextSectionMatch = profile.slice(sectionIdx + sectionHeader.length).match(/\n## /);
          const sectionEnd = nextSectionMatch
            ? sectionIdx + sectionHeader.length + nextSectionMatch.index!
            : profile.length;

          if (mode === "replace") {
            profile =
              profile.slice(0, sectionIdx) +
              `${sectionHeader}\n${newContent}\n` +
              profile.slice(sectionEnd);
          } else {
            const insertPos = sectionEnd;
            profile =
              profile.slice(0, insertPos) +
              `${newContent}\n` +
              profile.slice(insertPos);
          }
        }

        storage.writeMemberProfile(memberId, profile);
        return { content: `已更新 ${section}` };
      },
    },
    {
      name: "resolve_member",
      description: "通过姓名、昵称或ID查找家庭成员，返回标准化的成员信息。支持模糊匹配，处理歧义情况。",
      parameters: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "要查找的成员姓名、昵称或ID" 
          },
        },
        required: ["query"],
      },
      execute: async (params) => {
        const query = (params.query as string).trim();
        if (!query) {
          return { content: "查询内容不能为空", isError: true };
        }

        const matches = findMembersByQuery(query, familyManager, storage);

        if (matches.length === 0) {
          return { 
            content: `未找到匹配"${query}"的成员。请检查姓名或昵称是否正确。`,
            isError: true 
          };
        }

        if (matches.length === 1) {
          const { member, matchType, matchValue } = matches[0];
          const displayName = member.preferredName || member.name;
          
          let matchDescription = "";
          switch (matchType) {
            case "id":
              matchDescription = "通过ID匹配";
              break;
            case "name":
              matchDescription = "通过姓名匹配";
              break;
            case "preferred":
              matchDescription = "通过偏好称呼匹配";
              break;
            case "alias":
              matchDescription = `通过昵称"${matchValue}"匹配`;
              break;
          }

          return {
            content: `找到成员: ${displayName} (ID: ${member.id})\n匹配方式: ${matchDescription}`,
          };
        }

        // 多个匹配的情况
        let resultText = `找到多个匹配"${query}"的成员，请指定具体是哪一个：\n\n`;
        matches.forEach((match, index) => {
          const { member, matchType, matchValue } = match;
          const displayName = member.preferredName || member.name;
          
          let matchInfo = "";
          switch (matchType) {
            case "name":
              matchInfo = "姓名匹配";
              break;
            case "preferred":
              matchInfo = "偏好称呼匹配";
              break;
            case "alias":
              matchInfo = `昵称"${matchValue}"`;
              break;
          }
          
          resultText += `${index + 1}. ${displayName} (${matchInfo}) - ID: ${member.id}\n`;
        });

        resultText += "\n请说明你要找的是第几个成员，或提供更准确的姓名/昵称。";

        return {
          content: resultText,
        };
      },
    },
  ];
}
