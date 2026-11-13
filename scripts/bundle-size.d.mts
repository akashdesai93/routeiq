// Types for bundle-size.mjs, so the tests can import it. The script itself is plain JavaScript.
type Sizes = Record<string, number>
interface Budget {
  ceiling: Sizes
  growthPerPr: Sizes
  alertAt: number
}
type AssetFile = { name: string; kind: string; upFront: boolean; size: number; gzip: number }
export const MEASURES: Readonly<Record<string, string>>
export function baseName(file: string): string
export function mapboxNamesIn(mapboxEsmDir: string): Set<string>
export function upFrontNames(html: string): Set<string>
export function measureAssets(assetsDir: string, mapboxNames: Set<string>): AssetFile[]
export function total(files: AssetFile[], key: string, field?: 'size' | 'gzip'): number
export function measuredSizes(files: AssetFile[]): Sizes
export function budgetProblems(budget: unknown): string[]
export function ceilingRows(sizes: Sizes, budget: Budget): { key: string; label: string; size: number; ceiling: number; used: number; over: boolean }[]
export function growthReport(baseSizes: Sizes, prSizes: Sizes, budget: Budget): Record<string, { base: number; pr: number; limit: number }>
export function headroomReport(sizes: Sizes, budget: Budget): Record<string, unknown> & { alertAt: number }
