import { pickableBranches, type Branch, type Business } from "../branches/store";

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

/** The lists a row's picker is built from (the branches store's, ../branches). */
export type BranchList = { all: Branch[]; businesses: Business[] };
