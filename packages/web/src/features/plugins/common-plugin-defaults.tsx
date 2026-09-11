/**
 * The common configuration scope's **default plugin set** editor (admin only).
 *
 * This is the list a newly created Agent is seeded with when whoever creates it picks nothing
 * (core reads `<root>/common/plugins.toml`; the server serves it on `/api/common/plugins`). It
 * belongs to the data root rather than to any Project or Agent, which is why its home is the
 * plugins area while the common scope is selected.
 *
 * The editor reuses the create dialog's plugin picker rather than offering a second list, so a
 * name is picked by the same rows, with the same search and the same bulk controls.
 *
 * `unknownPlugins` is the server's answer to "which of these names has the library dropped": a
 * name left behind by a library change is reported rather than filtered, because silently
 * dropping it would make the next save lose it without anyone seeing it happen. Saving sends only
 * the names that still resolve — the server refuses the rest with a 400 — so the strip says so.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { apiErrorText } from "../../lib/api-error";
import { toneStrip } from "../../lib/tone";
import { Button } from "../../components/ui/button";
import { InfoPopover } from "../../components/ui/info-popover";
import { Skeleton } from "../../components/ui/skeleton";
import { toastError, toastSuccess } from "../../components/ui/toast";
import { PluginPicker, pluginPickItems } from "./plugin-picker";
import type { PickableItem } from "../skills/skill-pick-list";

export function CommonPluginDefaults() {
  /** The library's plugins (the picker's rows), or null until the read succeeds. */
  const [library, setLibrary] = useState<PickableItem[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  /** The stored set's names the library no longer carries (reported, never silently dropped on read). */
  const [unknown, setUnknown] = useState<string[]>([]);
  /** The editor's selection: null until the stored set arrives, so the picker never flashes empty. */
  const [selected, setSelected] = useState<string[] | null>(null);
  /** The set as it was last read/written — what "dirty" is measured against. */
  const savedRef = useRef<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.getCommonPlugins();
      // Only the names the library still carries go into the picker: the rest cannot be re-sent
      // (the server refuses an unknown name), and leaving them in the selection would make the
      // Save button an error the user cannot clear from the picker.
      const known = res.defaultPlugins.filter((name) => !res.unknownPlugins.includes(name));
      setSelected(known);
      savedRef.current = known;
      setUnknown(res.unknownPlugins);
    } catch (e) {
      setLoadError(apiErrorText(e));
    }
  }, []);

  useEffect(() => {
    // The library is read once alongside the set: a failed read must not keep the editor from
    // showing (and saving) the configured names — the picker then offers nothing.
    let cancelled = false;
    void api
      .getPluginLibrary()
      .then((res) => {
        if (!cancelled) setLibrary(pluginPickItems(res.groups.flatMap((g) => g.plugins)));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLibraryError(apiErrorText(e));
      });
    void load();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Whether saving would change anything. A stale name counts as a change on its own: the picker
   * cannot show it (a name the library dropped has no row), so the stored set and the pending one
   * only look alike until the save drops it — and a set that is *nothing but* stale names would
   * otherwise leave the Save button disabled with no way to clear them.
   */
  const dirty =
    selected !== null &&
    (unknown.length > 0 ||
      savedRef.current === null ||
      selected.length !== savedRef.current.length ||
      selected.some((name, i) => name !== savedRef.current?.[i]));

  const save = async () => {
    if (selected === null) return;
    setBusy(true);
    try {
      const res = await api.putCommonPlugins({ defaultPlugins: selected });
      setSelected(res.defaultPlugins);
      savedRef.current = res.defaultPlugins;
      setUnknown(res.unknownPlugins);
      toastSuccess(S.plugins.defaultsSaved);
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-md border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        {S.plugins.defaultsTitle}
        <InfoPopover label={S.plugins.defaultsTitle}>{S.plugins.defaultsDesc}</InfoPopover>
      </h2>
      {loadError !== null ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
          <Button size="sm" onClick={() => void load()}>
            {S.common.retry}
          </Button>
        </div>
      ) : (
        <>
          {/* A name the library dropped is reported here, and the editor keeps working: the
              valid part is still editable, and the save below drops the stale names (the server
              refuses them, so they could not be written back anyway). */}
          {unknown.length > 0 && (
            <p className={`mt-3 rounded-md border px-3 py-2 text-xs ${toneStrip.attention}`}>
              {S.plugins.defaultsUnknown(unknown)}
            </p>
          )}
          <div className="mt-3">
            {selected === null ? (
              <Skeleton className="h-8 w-56" />
            ) : (
              <PluginPicker
                label={S.agent.createPlugins}
                placeholder={S.plugins.defaultsPlaceholder}
                pickedLabel={S.agent.createPluginsPicked}
                selected={selected}
                onSelectedChange={(updater) =>
                  setSelected((prev) => (prev === null ? prev : updater(prev)))
                }
                library={library}
                libraryError={libraryError}
                disabled={busy}
                open={pickerOpen}
                setOpen={setPickerOpen}
              />
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {S.common.save}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
