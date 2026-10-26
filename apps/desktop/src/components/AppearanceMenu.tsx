import { DENSITIES } from '@cueplusplus/tokens';
import { DropdownMenu, IconButton } from '@cueplusplus/ui';
import { type FontName, useTheme } from '@cueplusplus/ui/system';
import { Palette } from 'lucide-react';
import { COPY } from '../copy.ts';
import { type AppTheme, LOOKS, rememberSoftFace, SOFT_FACES, softFace, THEME_NAMES } from '../theme.ts';

const MODES = ['dark', 'light', 'system'] as const;

/**
 * The appearance menu (DA3): the theme, the density and the mode, each kept in local storage by the provider. A theme
 * is picked with its look (`theme.ts`, `LOOKS`), so soft brings its set, pairing and pack, and cue and terminal put
 * theirs back. Under soft, the typeface is the person's to choose (the owner, 2026-10-26: "I would have it
 * configurable… I like both"): Inter or SF Pro, remembered apart from the theme, so picking soft again
 * brings back the one chosen.
 */
export function AppearanceMenu() {
  const { theme, setTheme, setStyleSet, font, setFont, setPaint, density, setDensity, mode, setMode } = useTheme();
  const pick = (name: AppTheme) => {
    const look = LOOKS[name];
    setTheme(name);
    setStyleSet(look.styleSet);
    setFont(name === 'soft' ? softFace() : look.font);
    setPaint(look.paint);
  };
  const pickFace = (face: FontName) => {
    rememberSoftFace(face);
    setFont(face);
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger render={<IconButton icon={Palette} aria-label={COPY.appearance} />} />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Theme</DropdownMenu.Label>
          {THEME_NAMES.map((name) => (
            <DropdownMenu.CheckboxItem key={name} checked={theme === name} onCheckedChange={() => pick(name)}>
              {name}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Group>
        {theme === 'soft' ? (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.Label>Typeface</DropdownMenu.Label>
              {SOFT_FACES.map((face) => (
                <DropdownMenu.CheckboxItem
                  key={face.font}
                  checked={font === face.font}
                  onCheckedChange={() => pickFace(face.font)}
                >
                  {face.label}
                </DropdownMenu.CheckboxItem>
              ))}
            </DropdownMenu.Group>
          </>
        ) : null}
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
