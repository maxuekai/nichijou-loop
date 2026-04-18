# 图标使用规范

本项目使用 [Heroicons](https://heroicons.com/) 作为统一图标库，通过自定义 Icon 组件提供标准化的图标使用方式。

## 基础使用

### 导入图标

```tsx
import { TrashIcon, PencilIcon } from "@heroicons/react/24/outline";
import { createIconWrapper } from "../../components/ui/Icon";

// 创建包装过的图标组件
const DeleteIcon = createIconWrapper(TrashIcon);
const EditIcon = createIconWrapper(PencilIcon);
```

### 使用图标

```tsx
// 基础使用
<DeleteIcon size="md" />

// 带样式类
<EditIcon size="sm" className="text-blue-500" />

// 使用预定义样式
<DeleteIcon size="md" className={iconStyles.colors.danger} />

// 自定义图标（如微信）
<WeChatIcon size="md" className="text-green-600" />
```

## 尺寸规范

| 尺寸 | 类名 | 像素 | 使用场景 |
|-----|-----|------|---------|
| `sm` | `w-3 h-3` | 12px | 辅助图标、小按钮内图标 |
| `md` | `w-4 h-4` | 16px | 常用图标、列表项图标 |
| `lg` | `w-5 h-5` | 20px | 强调图标、标题旁图标 |

### 使用示例

```tsx
// 小图标（12px）- 用于紧密排列的按钮
<ChevronIcon size="sm" className="ml-auto opacity-40" />

// 中等图标（16px）- 最常用尺寸
<DeleteIcon size="md" className="text-red-500" />

// 大图标（20px）- 用于强调或独立展示
<StatusIcon size="lg" className="text-green-600" />
```

## 样式规范

### 线宽规范

所有图标统一使用 `strokeWidth={1.75}`，已在 `createIconWrapper` 中自动设置。

### 颜色规范

使用 `currentColor` 配合 TailwindCSS 颜色类：

```tsx
// 使用预定义颜色
<EditIcon className={iconStyles.colors.primary} />   // text-amber-600
<DeleteIcon className={iconStyles.colors.danger} />  // text-red-500
<InfoIcon className={iconStyles.colors.muted} />     // text-stone-400

// 直接使用 Tailwind 类
<SearchIcon className="text-blue-500" />
<WarningIcon className="text-yellow-600" />
```

### 交互状态

```tsx
// 带 hover 效果的按钮图标
<DeleteIcon 
  className={`${iconStyles.colors.muted} ${iconStyles.hover.danger} ${iconStyles.interactive}`}
/>

// 等价于
<DeleteIcon className="text-stone-400 hover:text-red-500 cursor-pointer transition-colors" />
```

## 间距规范

### 图标与文字间距

```tsx
// 图标在文字前面
<div className="flex items-center gap-1.5">
  <EditIcon size="sm" />
  <span>编辑</span>
</div>

// 图标在文字后面  
<div className="flex items-center gap-2">
  <span>删除</span>
  <DeleteIcon size="md" />
</div>
```

### 按钮中的图标

```tsx
// 图标+文字按钮
<button className="flex items-center gap-1.5 px-3 py-2">
  <SettingsIcon size="sm" />
  设置
</button>

// 仅图标按钮
<button className="p-2 rounded-lg">
  <DeleteIcon size="md" />
</button>
```

## 常用图标映射

| 用途 | Heroicons 图标 | 组件名示例 |
|-----|---------------|-----------|
| 删除 | `TrashIcon` | `DeleteIcon` |
| 编辑 | `PencilIcon` | `EditIcon` |
| 设置 | `CogIcon` | `SettingsIcon` |
| 关闭 | `XMarkIcon` | `CloseIcon` |
| 展开/折叠 | `ChevronDownIcon` | `ChevronIcon` |
| 搜索 | `MagnifyingGlassIcon` | `SearchIcon` |
| 工具 | `WrenchScrewdriverIcon` | `ToolsIcon` |
| 管家/用户 | `UserIcon` | `ButlerIcon` |
| 信息 | `InformationCircleIcon` | `InfoIcon` |
| 警告 | `ExclamationTriangleIcon` | `WarningIcon` |
| 外链 | `ArrowTopRightOnSquareIcon` | `ExternalLinkIcon` |
| 微信 | 自定义SVG | `WeChatIcon` |

## 自定义图标

对于特定品牌或Heroicons中不包含的图标，可以创建自定义图标组件：

```tsx
// 微信自定义图标示例
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
```

### 自定义图标原则

1. **保持一致性**：遵循相同的尺寸规范和className结构
2. **语义化**：使用有意义的组件名称  
3. **可复用**：支持size和className参数
4. **品牌准确**：使用官方品牌色彩和设计（如微信绿色#07C160）
5. **视觉还原**：准确还原品牌logo的视觉特征

## 最佳实践

### 1. 命名约定

```tsx
// 推荐：语义化命名
const DeleteIcon = createIconWrapper(TrashIcon);
const EditIcon = createIconWrapper(PencilIcon);

// 避免：直接使用 Heroicons 名称
const TrashIcon = createIconWrapper(TrashIcon); // ❌ 混淆
```

### 2. 尺寸选择

```tsx
// ✅ 根据上下文选择合适尺寸
<button className="p-1">
  <CloseIcon size="sm" />  {/* 小按钮用 sm */}
</button>

<div className="flex items-center gap-2">
  <StatusIcon size="md" />  {/* 列表项用 md */}
  <span>状态正常</span>
</div>

// ❌ 避免随意使用大尺寸
<CloseIcon size="lg" />  {/* 关闭按钮不需要 lg */}
```

### 3. 颜色语义

```tsx
// ✅ 符合语义的颜色
<DeleteIcon className="text-red-500" />      {/* 删除用红色 */}
<SuccessIcon className="text-green-500" />   {/* 成功用绿色 */}
<WarningIcon className="text-yellow-500" />  {/* 警告用黄色 */}

// ❌ 避免语义冲突
<DeleteIcon className="text-green-500" />    {/* 删除不应该用绿色 */}
```

### 4. 性能优化

```tsx
// ✅ 按需导入图标
import { TrashIcon, PencilIcon } from "@heroicons/react/24/outline";

// ❌ 避免全量导入
import * as HeroIcons from "@heroicons/react/24/outline";  // 会增大 bundle 体积
```

## 项目中的实际应用

项目已完成32个手写SVG图标的替换，涉及以下文件：

- `AdminLayout.tsx` - 15个导航图标（包含1个自定义微信图标）
- `MembersPage.tsx` - 11个操作图标  
- `PluginsPage.tsx` - 2个界面图标
- `ToolsPage.tsx` - 2个工具图标（已更新为扳手图标）
- `LogsPage.tsx` - 1个展开图标
- `WeChatPage.tsx` - 1个删除图标

### 特殊图标说明

- **工具图标**：使用`WrenchScrewdriverIcon`替代搜索图标，更符合"工具"语义
- **管家图标**：使用`UserIcon`代表AI管家/助手角色  
- **微信图标**：使用自定义微信官方logo SVG（绿色气泡+双白点设计），高度还原品牌特征

所有图标均遵循本规范进行统一化处理。