import { DENSITIES } from '@cueplusplus/tokens';
import { DropdownMenu, IconButton } from '@cueplusplus/ui';
import { useTheme } from '@cueplusplus/ui/system';
import { Palette } from 'lucide-react';
import { COPY } from '../copy.ts';
import { THEME_NAMES } from '../theme.ts';

const MODES = ['dark', 'light', 'system'] as const;

/** The appearance menu (DA3): the theme, the density and the mode, each kept in local storage by the provider. */
export function AppearanceMenu() {
  const { theme, setTheme, density, setDensity, mode, setMode } = useTheme();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger render={<IconButton icon={Palette} aria-label={COPY.appearance} />} />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Theme</DropdownMenu.Label>
          {THEME_NAMES.map((name) => (
            <DropdownMenu.CheckboxItem key={name} checked={theme === name} onCheckedChange={() => setTheme(name)}>
              {name}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>Density</DropdownMenu.Label>
          {DENSITIES.map((level) => (
            <DropdownMenu.CheckboxItem
              key={level}
              checked={density === level}
              onCheckedChange={() => setDensity(level)}
            >
              {level}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>Mode</DropdownMenu.Label>
          {MODES.map((each) => (
            <DropdownMenu.CheckboxItem key={each} checked={mode === each} onCheckedChange={() => setMode(each)}>
              {each}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
