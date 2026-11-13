// Keep logical image tiles in row-major order, but allow their sinograms to
// wrap at a different column count when small leaves make the atlas too tall.
export function packAtlas(grid: number, bins: number, angles: number, limit: number) {
  const tiles = grid * grid;
  const maxColumns = Math.floor(limit / bins);
  const maxRows = Math.floor(limit / angles);
  if (maxColumns < 1 || maxRows < 1 || tiles > maxColumns * maxRows) {
    throw new Error(`These ${tiles} local sinograms cannot fit within the GPU's ${limit} × ${limit} texture limit. Reduce resolution or angles, or increase the leaf size.`);
  }
  let columns = grid;
  if (grid > maxColumns || grid > maxRows) {
    const minimumColumns = Math.ceil(tiles / maxRows);
    const balancedColumns = Math.round(Math.sqrt(tiles * angles / bins));
    columns = Math.max(minimumColumns, Math.min(maxColumns, tiles, balancedColumns));
  }
  const rows = Math.ceil(tiles / columns);
  return { columns, width: columns * bins, height: rows * angles };
}
