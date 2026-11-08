import { useEffect, useState } from "preact/hooks";
import type { ModelCatalog, RubricRow } from "./types";
import { useSession } from "../state/session";

const FALLBACK: ModelCatalog = { models: [{ provider: "decisions", model: "gpt-6-luna", validated: true, input_per_million: 0.125, output_per_million: 0.5, verified_on: "" }], default: { provider: "decisions", model: "gpt-6-luna" } };

/** The published rubric versions a request or a schedule can run (newest version first within a rubric). Without them the form still works for routing. */
export function usePublishedRubrics(): RubricRow[] {
  const { api } = useSession();
  const [rows, setRows] = useState<RubricRow[]>([]);
  useEffect(() => {
    api("rubrics.list", { limit: 50, query: "", status: "" }).then(
      (r) => setRows(r.rows.filter((x) => x.status === "PUBLISHED").sort((a, b) => (a.rubric_id === b.rubric_id ? b.version - a.version : a.rubric_id < b.rubric_id ? -1 : 1))),
      () => undefined,
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}

/**
 * The closed list of (API, model) pairs, with prices, comes from the server: the same list the executor enforces. `settled` turns true when the answer
 * arrived (or failed and the built-in pair stays), so a form never picks the fallback default while the real one is still on its way.
 */
export function useModelCatalog(): ModelCatalog & { settled: boolean } {
  const { api } = useSession();
  const [state, setState] = useState<{ catalog: ModelCatalog; settled: boolean }>({ catalog: FALLBACK, settled: false });
  useEffect(() => {
    api("executions.models", {}).then(
      (catalog) => setState({ catalog, settled: true }),
      () => setState({ catalog: FALLBACK, settled: true }),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state.catalog, settled: state.settled };
}
