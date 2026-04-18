import { ComponentProps, ForwardedRef, forwardRef } from "react";

// 简单的className合并工具函数
function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

export type IconSize = "sm" | "md" | "lg";

interface IconProps extends Omit<ComponentProps<"svg">, "size"> {
  size?: IconSize;
  className?: string;
}

const sizeClasses: Record<IconSize, string> = {
  sm: "w-3 h-3",
  md: "w-4 h-4", 
  lg: "w-5 h-5",
};

/**
 * 统一的Icon组件基础包装器
 * 提供标准化的尺寸、样式和行为
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(
  ({ size = "md", className, children, ...props }, ref: ForwardedRef<SVGSVGElement>) => {
    return (
      <svg
        ref={ref}
        className={cn(
          sizeClasses[size],
          "flex-shrink-0", // 防止图标在flex容器中被压缩
          className
        )}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {children}
      </svg>
    );
  }
);

Icon.displayName = "Icon";

/**
 * Heroicons图标的高阶组件包装器
 * 用于统一Heroicons图标的样式
 */
export function createIconWrapper<P extends ComponentProps<"svg">>(
  HeroIcon: React.ComponentType<P>
) {
  return forwardRef<SVGSVGElement, IconProps & Omit<P, keyof IconProps>>(
    ({ size = "md", className, ...props }, ref) => {
      return (
        <HeroIcon
          ref={ref}
          className={cn(
            sizeClasses[size],
            "flex-shrink-0",
            className
          )}
          strokeWidth={1.75}
          {...(props as P)}
        />
      );
    }
  );
}

// 常用的样式工具类
export const iconStyles = {
  // 交互状态样式
  interactive: "cursor-pointer transition-colors",
  hover: {
    primary: "hover:text-amber-600",
    danger: "hover:text-red-500", 
    success: "hover:text-green-500",
    muted: "hover:text-stone-600",
  },
  // 颜色预设
  colors: {
    primary: "text-amber-600",
    danger: "text-red-500",
    success: "text-green-500", 
    warning: "text-yellow-500",
    muted: "text-stone-400",
    default: "text-stone-600",
  },
  // 按钮中的图标样式
  button: {
    leading: "mr-1.5", // 图标在按钮文字前
    trailing: "ml-1.5", // 图标在按钮文字后
    only: "", // 仅图标按钮
  },
} as const;

export default Icon;