import { NavLink, Outlet } from "react-router-dom";
import {
  Squares2X2Icon,
  HomeIcon, 
  UserIcon,
  UsersIcon,
  BellIcon,
  ChatBubbleLeftEllipsisIcon,
  DocumentTextIcon,
  PuzzlePieceIcon,
  CpuChipIcon,
  WrenchScrewdriverIcon,
  ShieldCheckIcon,
  ArrowTopRightOnSquareIcon,
} from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件，统一样式
const OverviewIcon = createIconWrapper(Squares2X2Icon);
const FamilyIcon = createIconWrapper(HomeIcon);
const ButlerIcon = createIconWrapper(UserIcon);
const MembersIcon = createIconWrapper(UsersIcon);
const RemindersIcon = createIconWrapper(BellIcon);
const ChatIcon = createIconWrapper(ChatBubbleLeftEllipsisIcon);
const LogsIcon = createIconWrapper(DocumentTextIcon);
const PluginsIcon = createIconWrapper(PuzzlePieceIcon);
const ModelsIcon = createIconWrapper(CpuChipIcon);
const ToolsIcon = createIconWrapper(WrenchScrewdriverIcon);
const StatusIcon = createIconWrapper(ShieldCheckIcon);
const BoardIcon = createIconWrapper(Squares2X2Icon);
const ExternalLinkIcon = createIconWrapper(ArrowTopRightOnSquareIcon);

// 微信自定义图标组件
const WeChatIcon = ({ size = "md", className = "" }: { size?: "sm" | "md" | "lg"; className?: string }) => {
  const sizeClass = size === "sm" ? "w-3 h-3" : size === "lg" ? "w-5 h-5" : "w-4 h-4";
  return (
    <svg className={`${sizeClass} flex-shrink-0 ${className}`} viewBox="0 0 24 24" fill="none">
      {/* 微信绿色对话气泡 */}
      <path 
        d="M12 2C6.48 2 2 6.48 2 12c0 2.89 1.24 5.49 3.22 7.31L4 22l3.5-1.5C9.16 21.45 10.54 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" 
        fill="#07C160"
      />
      {/* 两个白色小圆点（眼睛） */}
      <circle cx="9" cy="11" r="1.2" fill="white" />
      <circle cx="15" cy="11" r="1.2" fill="white" />
    </svg>
  );
};

const NAV_GROUPS = [
  {
    title: "管理",
    items: [
      {
        to: "/admin",
        label: "概览",
        end: true,
        icon: <OverviewIcon size="md" />,
      },
      {
        to: "/admin/family",
        label: "家庭",
        icon: <FamilyIcon size="md" />,
      },
      {
        to: "/admin/soul",
        label: "管家",
        icon: <ButlerIcon size="md" />,
      },
      {
        to: "/admin/members",
        label: "成员",
        icon: <MembersIcon size="md" />,
      },
      {
        to: "/admin/reminders",
        label: "提醒",
        icon: <RemindersIcon size="md" />,
      },
    ],
  },
  {
    title: "通道",
    items: [
      {
        to: "/admin/wechat",
        label: "微信",
        icon: <WeChatIcon size="md" />,
      },
      {
        to: "/admin/chat",
        label: "对话",
        icon: <ChatIcon size="md" />,
      },
    ],
  },
  {
    title: "系统",
    items: [
      {
        to: "/admin/logs",
        label: "日志",
        icon: <LogsIcon size="md" />,
      },
      {
        to: "/admin/plugins",
        label: "插件",
        icon: <PluginsIcon size="md" />,
      },
      {
        to: "/admin/models",
        label: "模型",
        icon: <ModelsIcon size="md" />,
      },
      {
        to: "/admin/tools",
        label: "工具",
        icon: <ToolsIcon size="md" />,
      },
      {
        to: "/admin/status",
        label: "状态",
        icon: <StatusIcon size="md" />,
      },
    ],
  },
];

const GITHUB_URL = "https://github.com/maxuekai/nichijou-loop";

export function AdminLayout() {
  return (
    <div className="min-h-screen bg-stone-50 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-stone-200 flex flex-col fixed inset-y-0 left-0 z-20">
        {/* Logo */}
        <div className="h-14 flex items-center gap-2.5 px-5 border-b border-stone-100 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg bg-stone-50 flex items-center justify-center overflow-hidden">
            <img src="/logo-192.png" alt="" className="w-full h-full object-contain" />
          </div>
          <div>
            <p className="text-sm font-bold text-stone-800 leading-tight">Nichijou Loop</p>
            <p className="text-[10px] text-stone-400 leading-tight">家庭 AI 管家</p>
          </div>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-auto py-3 px-3 space-y-5">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-wider px-2 mb-1.5">
                {group.title}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                        isActive
                          ? "bg-amber-50 text-amber-700 font-medium"
                          : "text-stone-600 hover:text-stone-800 hover:bg-stone-50"
                      }`
                    }
                  >
                    <span className="flex-shrink-0 opacity-70">{item.icon}</span>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom links */}
        <div className="border-t border-stone-100 p-3 space-y-0.5 flex-shrink-0">
          <a
            href="/board"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-stone-600 hover:text-stone-800 hover:bg-stone-50 transition-colors"
          >
            <BoardIcon size="md" className="opacity-70" />
            看板
            <ExternalLinkIcon size="sm" className="ml-auto opacity-40" />
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-stone-600 hover:text-stone-800 hover:bg-stone-50 transition-colors"
          >
            <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
            <ExternalLinkIcon size="sm" className="ml-auto opacity-40" />
          </a>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 ml-56">
        <div className="max-w-6xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
