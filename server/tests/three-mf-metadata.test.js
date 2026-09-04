const { parseSliceInfo, parseGcodeHeader } = require('../lib/three-mf-metadata');

describe('Bambu 3MF metadata parsing', () => {
  test('reads duration and weight from slice_info.config', () => {
    const xml = `<?xml version="1.0"?><config><plate>
      <metadata key="prediction" value="57300"/>
      <metadata key="weight" value="354.27"/>
    </plate></config>`;
    expect(parseSliceInfo(xml)).toEqual({ est_print_secs: 57300, material_grams: 354.27 });
  });

  test('falls back to Bambu G-code comments', () => {
    const header = `; model printing time: 15h 36m 18s; total estimated time: 15h 55m 0s
; total filament weight [g] : 354.27`;
    expect(parseGcodeHeader(header)).toEqual({ est_print_secs: 56178, material_grams: 354.27 });
  });
});
