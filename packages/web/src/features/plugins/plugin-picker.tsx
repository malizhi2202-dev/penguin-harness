/**
 * The plugin picker, shared by the create-Agent dialog and the common scope's default-plugin-set
 * editor: a form-variant trigger over the shared multi-select `SkillPickList`.
 *
 * A row is a plugin's manifest, which carries the same fields a Skill's metadata does (name,
 * descriptions, icon, version), so a plugin is a pickable row like any other — a plugin without
 * an icon.svg draws the puzzle piece rather than the book. The library is flattened out of its
 * groups because the picker is a flat searchable list: the grouping the library page renders
 * carries no meaning here.
 *
 * Ownership of the selection stays with the caller (`onSelectedChange` is the `useState` setter),
 * because both hosts need the picked names for their own submit body. The bulk actions take the
 * update in the functional form the hosts already used, so a click can never be computed against
 * a stale array.
 */
import type { ReactNode } from "react";
import type { PluginItem } from "@prismshadow/penguin-server/api";
import { S } from "../../lib/strings";
import { FieldError, FieldHint, FieldLabel } from "../../components/ui/field";
import { FormPicker } from "../../components/ui/form-picker";
import { PLUGIN_ICON } from "../../components/ui/icons";
import { SkillPickList } from "../skills/skill-pick-list";
import type { PickableItem } from "../skills/skill-pick-list";
import { addSkillNames, removeSkillNames, toggleSkillName } from "../skills/skill-selection";

/** The library's plugins as picker rows (see SkillPickList's `fallbackIcon`). */
export function pluginPickItems(plugins: readonly PluginItem[]): PickableItem[] {
  return plugins.map((plugin) => ({ ...plugin, fallbackIcon: PLUGIN_ICON }));
}

export function PluginPicker({
  label,
  placeholder,
  pickedLabel,
  selected,
  onSelectedChange,
  library,
  libraryError,
  hint,
  emptyHint = S.agent.createPluginsEmpty,
  disabled = false,
  open,
  setOpen,
}: {
  /** The field's label. */
  label: string;
  /** The trigger's text while nothing is selected. */
  placeholder: string;
  /** The trigger's text once something is selected. */
  pickedLabel: (count: number) => string;
  selected: string[];
  /** The `useState` setter's functional form only: the hosts' bulk actions compute from the latest array, never a stale one. */
  onSelectedChange: (updater: (prev: string[]) => string[]) => void;
  /** The library's plugins, or null until a fetch succeeds. */
  library: PickableItem[] | null;
  /** A failed library read, shown in place of the hint below the field. */
  libraryError: string | null;
  /** The field's own explanation; omit it when the section's `InfoPopover` already carries the semantics. */
  hint?: ReactNode;
  emptyHint?: string;
  disabled?: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <FormPicker
        open={open}
        setOpen={setOpen}
        label={selected.length === 0 ? placeholder : pickedLabel(selected.length)}
        muted={selected.length === 0}
        title={label}
        ariaLabel={label}
        disabled={disabled}
        menuClass="w-[26rem]"
      >
        <SkillPickList
          skills={library ?? []}
          selected={selected}
          onToggle={(pluginName) => onSelectedChange((prev) => toggleSkillName(prev, pluginName))}
          onSelectAll={(names) => onSelectedChange((prev) => addSkillNames(prev, names))}
          onSelectNone={(names) => onSelectedChange((prev) => removeSkillNames(prev, names))}
          emptyHint={library === null ? S.common.loading : emptyHint}
          searchPlaceholder={S.plugins.searchPlaceholder}
        />
      </FormPicker>
      {libraryError ? (
        <FieldError>{libraryError}</FieldError>
      ) : hint !== undefined ? (
        <FieldHint>{hint}</FieldHint>
      ) : null}
    </div>
  );
}
