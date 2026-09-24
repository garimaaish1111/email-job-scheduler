"use client";

import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  variant?: "filled" | "underline";
}

export function Input({
  label,
  error,
  variant = "filled",
  className,
  id,
  ...rest
}: InputProps) {
  const inputId = id ?? rest.name;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm text-ink-soft">
          {label}
        </label>
      )}
      <input
        id={inputId}
        {...rest}
        className={cn(
          "w-full text-sm text-ink transition-colors",
          variant === "filled" &&
            "rounded-lg bg-surface-muted px-4 py-3 focus:ring-2 focus:ring-brand/30",
          variant === "underline" &&
            "border-b border-line bg-transparent px-1 py-2 focus:border-brand",
          error && "ring-2 ring-danger-ink/30",
          className
        )}
      />
      {error && <p className="mt-1 text-xs text-danger-ink">{error}</p>}
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className, id, ...rest }: TextareaProps) {
  const areaId = id ?? rest.name;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={areaId} className="mb-1.5 block text-sm text-ink-soft">
          {label}
        </label>
      )}
      <textarea
        id={areaId}
        {...rest}
        className={cn(
          "w-full resize-none rounded-lg bg-surface-muted px-4 py-3 text-sm text-ink",
          "focus:ring-2 focus:ring-brand/30",
          error && "ring-2 ring-danger-ink/30",
          className
        )}
      />
      {error && <p className="mt-1 text-xs text-danger-ink">{error}</p>}
    </div>
  );
}
