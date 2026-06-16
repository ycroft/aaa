import type { Dimension } from "../../types";

/** Canonical order of judge dimensions. Used as the picker's full set
 *  AND as the rendering order in RubricView — two semantically distinct
 *  uses that happen to share the same ordered list. Single source of
 *  truth so adding/removing a dimension only touches one file. */
export const ALL_DIMENSIONS: Dimension[] = [
  "context",
  "tools",
  "alignment",
  "safety",
];
