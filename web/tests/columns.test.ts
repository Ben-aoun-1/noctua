import { describe, expect, it } from "vitest"
import { columnsOf, type Finding } from "../src/components/FindingsPane.tsx"

/**
 * The findings table's header, which is not ours to choose: the model names its own fields per run,
 * so the columns are whatever the findings turned out to carry. The pane has room for five inside a
 * third of the screen, and dropping the wrong two is the difference between a table an accountant
 * reads and one they scroll.
 *
 * Nothing is dropped from the *export*, which carries every field of every finding. These rules are
 * about the view alone.
 */

const rows = (...data: Record<string, unknown>[]): Finding[] =>
  data.map((d, i) => ({ data: d, step: i + 1 }))

describe("columnsOf", () => {
  it("shows every field, in the order the model first used it", () => {
    expect(columnsOf(rows({ legal_name: "A", registry_status: "Active" }))).toEqual([
      "legal_name",
      "registry_status",
    ])
  })

  it("takes the union across rows, so a field only one row carries still gets a column", () => {
    expect(columnsOf(rows({ legal_name: "A" }, { legal_name: "B", vat_number: "GB1" }))).toEqual([
      "legal_name",
      "vat_number",
    ])
  })

  it("has no columns for a run that confirmed nothing", () => {
    expect(columnsOf([])).toEqual([])
  })

  // A field that reads the same on every row describes the *run*, not the row.
  it("drops a field that says the same thing on every row", () => {
    const findings = rows({ kind: "vendor", legal_name: "A" }, { kind: "vendor", legal_name: "B" })
    expect(columnsOf(findings)).toEqual(["legal_name"])
  })

  it("keeps a repeated field that is one of the ones read first", () => {
    // One vendor's dossier repeats its legal_name on every row, and that is the first thing anyone
    // reads — not noise.
    const findings = rows({ legal_name: "Monzo", filing: "AR" }, { legal_name: "Monzo", filing: "CS" })
    expect(columnsOf(findings)).toEqual(["legal_name", "filing"])
  })

  it("still tables a run whose findings are genuinely all one value", () => {
    const findings = rows({ note: "same" }, { note: "same" })
    expect(columnsOf(findings)).toEqual(["note"])
  })

  // A row that simply does not carry the field reads as blank, which is a different claim.
  it("does not call a field repeated when one row is missing it", () => {
    const findings = rows({ status: "Active", n: "1" }, { n: "2" })
    expect(columnsOf(findings)).toEqual(["status", "n"])
  })

  it("caps the table at five columns", () => {
    const wide = rows({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7" })
    expect(columnsOf(wide)).toHaveLength(5)
  })

  it("spends the five on the fields an accountant checks first", () => {
    const wide = rows({
      note: "n",
      legal_name: "Monzo Bank Limited",
      company_number: "09446231",
      address: "Broadwalk House",
      vat_number: "GB1",
      registry_status: "Active",
      vat_valid: "unknown",
    })
    // The preferred fields take the cap, and the row is still drawn in the model's own order.
    expect(columnsOf(wide)).toEqual([
      "legal_name",
      "company_number",
      "vat_number",
      "registry_status",
      "vat_valid",
    ])
  })

  /** `source` is the widest thing a finding carries, and the receipt under the row shows it. */
  it("drops source before anything else it could drop", () => {
    const wide = rows({ source: "https://example.com/company/09446231", a: "1", b: "2", c: "3", d: "4", e: "5" })
    expect(columnsOf(wide)).not.toContain("source")
    expect(columnsOf(wide)).toEqual(["a", "b", "c", "d", "e"])
  })

  it("gives source a column when there is room for it", () => {
    expect(columnsOf(rows({ a: "1", source: "https://example.com/" }))).toEqual(["a", "source"])
  })

  /**
   * The receipt is the step the fact was read on, which is a property of the finding rather than a
   * field of it — the pane pins its own column for that. A model that happens to name a field
   * `step` is naming a field, and it is tabled like any other.
   */
  it("takes no column from the receipt, and none for it", () => {
    expect(columnsOf(rows({ legal_name: "A" }, { legal_name: "B" }))).toEqual(["legal_name"])
    expect(columnsOf(rows({ step: "one" }, { step: "two" }))).toEqual(["step"])
  })
})
