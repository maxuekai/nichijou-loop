import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { createIconWrapper } from "./Icon";

const ChevronIcon = createIconWrapper(ChevronDownIcon);
const CheckMarkIcon = createIconWrapper(CheckIcon);

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  align?: "left" | "right";
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function getEnabledIndex(options: SelectOption[], startIndex: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  let index = startIndex;
  for (let i = 0; i < options.length; i += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  disabled = false,
  className,
  buttonClassName,
  menuClassName,
  align = "left",
}: SelectProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value]);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    const initialIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : getEnabledIndex(options, -1, 1);
    setHighlightedIndex(initialIndex);
  }, [open, options, selectedIndex]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const next = getEnabledIndex(options, highlightedIndex, event.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) setHighlightedIndex(next);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && highlightedIndex >= 0) {
        commit(highlightedIndex);
      } else {
        setOpen(true);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={cx("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={cx(
          "flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-left text-sm text-stone-800 shadow-sm transition-colors",
          "hover:border-amber-400 hover:bg-amber-50/30 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500",
          "disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400 disabled:hover:border-stone-300",
          buttonClassName,
        )}
      >
        <span className={cx("truncate", !selected && "text-stone-400")}>{selected?.label ?? placeholder}</span>
        <ChevronIcon
          size="md"
          className={cx("text-stone-400 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          id={`${id}-listbox`}
          role="listbox"
          className={cx(
            "absolute z-50 mt-2 max-h-64 min-w-full overflow-auto rounded-xl border border-stone-200 bg-white p-1.5 shadow-xl shadow-stone-900/10",
            align === "right" ? "right-0" : "left-0",
            menuClassName,
          )}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <button
                key={`${option.value}-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
                onClick={() => commit(index)}
                className={cx(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  isHighlighted ? "bg-amber-50 text-amber-900" : "text-stone-700 hover:bg-stone-50",
                  isSelected && "font-medium text-stone-900",
                  option.disabled && "cursor-not-allowed text-stone-300 hover:bg-transparent",
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <CheckMarkIcon size="sm" className="text-amber-600" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
