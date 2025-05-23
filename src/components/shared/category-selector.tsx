
"use client";
import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from '@/hooks/use-app-store';
import type { Category } from '@/lib/types';
import { useTranslations } from '@/contexts/language-context';

interface CategorySelectorProps {
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function CategorySelector({ value, onChange, placeholder }: CategorySelectorProps) {
  const { categories, isLoading } = useAppStore(); // Get isLoading state
  const { t } = useTranslations();
  const defaultPlaceholder = placeholder || t('selectCategoryPlaceholder');

  if (isLoading) {
    return (
      <Select disabled>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t('loadingCategoriesPlaceholder')} />
        </SelectTrigger>
      </Select>
    );
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={defaultPlaceholder} />
      </SelectTrigger>
      <SelectContent>
        {categories.map((category: Category) => (
          <SelectItem key={category.id} value={category.id}>
            <div className="flex items-center gap-2">
              <category.icon className="h-4 w-4" />
              {category.name}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
