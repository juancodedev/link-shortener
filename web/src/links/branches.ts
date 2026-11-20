import { useEffect, useState } from "react";
import { BRANCHES_EVENT, type Branch, type Business } from "../legacy";

/**
 * Branches that can be chosen in a picker: switched on, and not inside a
 * switched-off business. The businesses card still lists everything, so an
 * inactive one can be switched back on.
 *
 * A port of the legacy `pickableBranches` in src/handlers/dashboard.ts, which
 * the comments filter still uses there. Same rules on both sides: change them
 * together.
 */
export function pickableBranches(branches: Branch[], businesses: Business[]): Branch[] {
  const off = new Set(businesses.filter((b) => b.is_active === false).map((b) => b.id));
  return branches.filter((l) => l.is_active !== false && !off.has(l.business_id ?? ""));
}

export type BranchOption = { label: string; value: string };

const label = (b: Branch) => (b.business_name ? `${b.business_name} — ` : "") + b.name;

/**
 * A link's branch picker: Unassigned, then every pickable branch.
 *
 * The link's own branch is always offered. When the branches list has not
 * loaded (or failed), or the branch was switched off, it is kept, named and
 * marked, until someone picks another: a picker that wrongly read
 * "Unassigned" would detach the link with one Save.
 */
export function branchOptions(current: string, all: Branch[], businesses: Business[]): BranchOption[] {
  const branches = pickableBranches(all, businesses);
  const options: BranchOption[] = [{ label: "Unassigned", value: "" }];
  branches.forEach((b) => options.push({ label: label(b), value: b.id }));
  if (current && !branches.some((b) => b.id === current)) {
    const known = all.find((b) => b.id === current);
    options.push({ label: known ? `${label(known)} (inactive)` : "Current branch", value: current });
  }
  return options;
}

export type BranchList = { all: Branch[]; businesses: Business[] };

const read = (): BranchList => ({ all: window.__branches ?? [], businesses: window.__businesses ?? [] });

/**
 * The tenant's branches and businesses. The legacy loadBranches owns the
 * lists (the Businesses section edits them) and announces each reload with
 * `brancheschange`; the pickers follow.
 */
export function useBranches(): BranchList {
  const [list, setList] = useState(read);
  useEffect(() => {
    const onChange = () => setList(read());
    window.addEventListener(BRANCHES_EVENT, onChange);
    // A reload that landed between the first render and this subscription.
    onChange();
    return () => window.removeEventListener(BRANCHES_EVENT, onChange);
  }, []);
  return list;
}
