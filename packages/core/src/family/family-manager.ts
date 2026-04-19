import yaml from "js-yaml";
import { generateId } from "@nichijou/shared";
import type { Family, FamilyMember } from "@nichijou/shared";
import type { StorageManager } from "../storage/storage.js";

export class FamilyManager {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  getFamily(): Family | null {
    const content = this.storage.readText("family/family.yaml");
    if (!content) return null;
    return yaml.load(content) as Family;
  }

  createFamily(input: { name: string; homeCity?: string; homeAdcode?: string }): Family {
    const family: Family = {
      id: generateId("fam"),
      name: input.name,
      createdAt: new Date().toISOString(),
      homeCity: input.homeCity,
      homeAdcode: input.homeAdcode,
    };
    this.storage.writeText("family/family.yaml", yaml.dump(family));
    return family;
  }

  updateFamily(patch: Partial<Family>): Family {
    const family = this.getFamily();
    if (!family) throw new Error("No family exists. Create a family first.");
    const next: Family = {
      ...family,
      ...patch,
      id: family.id,
      createdAt: family.createdAt,
    };
    this.storage.writeText("family/family.yaml", yaml.dump(next));
    return next;
  }

  getMembers(): FamilyMember[] {
    const content = this.storage.readText("family/members.yaml");
    if (!content) return [];
    const data = yaml.load(content) as { members?: FamilyMember[] };
    return data?.members ?? [];
  }

  getMember(memberId: string): FamilyMember | null {
    return this.getMembers().find((m) => m.id === memberId) ?? null;
  }

  getMemberByChannel(channel: string, channelUserId: string): FamilyMember | null {
    return this.getMembers().find((m) => m.channelBindings[channel] === channelUserId) ?? null;
  }

  addMember(name: string, role?: "admin" | "member"): FamilyMember {
    const family = this.getFamily();
    if (!family) throw new Error("No family exists. Create a family first.");

    const members = this.getMembers();
    const assignedRole = role ?? (members.length === 0 ? "admin" : "member");

    const member: FamilyMember = {
      id: generateId("mem"),
      familyId: family.id,
      name,
      channelBindings: {},
      primaryChannel: "wechat",
      role: assignedRole,
      wechatNotifyEnabled: true,
    };

    members.push(member);
    this.saveMembers(members);

    const profileTemplate = `# ${name}

## 基本信息
- 角色: ${assignedRole === "admin" ? "管理员" : "成员"}
- 昵称/别名: （如：妈妈、爸爸、小明等，用逗号分隔多个昵称）
- 偏好称呼: （最常使用的称呼方式）

## 生活习惯
（待填写）

## 饮食偏好
（待填写）

## AI 观察笔记
`;
    this.storage.writeMemberProfile(member.id, profileTemplate);
    return member;
  }

  updateMember(memberId: string, patch: Partial<FamilyMember>): FamilyMember {
    const members = this.getMembers();
    const idx = members.findIndex((m) => m.id === memberId);
    if (idx < 0) throw new Error(`Member not found: ${memberId}`);
    members[idx] = { ...members[idx]!, ...patch };
    this.saveMembers(members);
    return members[idx]!;
  }

  bindChannel(memberId: string, channel: string, channelUserId: string): void {
    const members = this.getMembers();
    const member = members.find((m) => m.id === memberId);
    if (!member) throw new Error(`Member not found: ${memberId}`);
    member.channelBindings[channel] = channelUserId;
    member.primaryChannel = channel;
    this.saveMembers(members);
  }

  deleteMember(memberId: string): void {
    const members = this.getMembers();
    const idx = members.findIndex((m) => m.id === memberId);
    if (idx < 0) throw new Error(`Member not found: ${memberId}`);
    members.splice(idx, 1);
    this.saveMembers(members);
    this.storage.deleteFile(`family/members/${memberId}.md`);
  }

  generateInviteCode(): string {
    return generateId().slice(0, 8).toUpperCase();
  }

  private saveMembers(members: FamilyMember[]): void {
    this.storage.writeText("family/members.yaml", yaml.dump({ members }));
  }
}
