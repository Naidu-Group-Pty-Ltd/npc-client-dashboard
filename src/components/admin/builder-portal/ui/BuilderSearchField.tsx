import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';

/**
 * The search control used by the Organisations, Portal users and Organisation
 * surfaces.
 *
 * Display-only: it owns no state and does no filtering. The value and the
 * change handler belong to the page, so all three surfaces continue to share
 * the one search term exactly as before.
 */
export interface BuilderSearchFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  label: string;
}

export function BuilderSearchField({ value, onValueChange, placeholder, label }: BuilderSearchFieldProps) {
  return (
    <SearchInput
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      aria-label={label}
      containerClassName="w-full sm:max-w-sm"
      className="h-9"
    />
  );
}
