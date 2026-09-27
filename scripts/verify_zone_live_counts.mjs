// Быстрый счёт дерева должен совпадать с исходным расчётом каждой зоны.
import assert from "node:assert/strict";
import { countElementsByZones, countElementsInZone } from "../app/static/v2/zone-live-count.js";

const rect = (x, y, width = 100) => [[x, y], [x + width, y], [x + width, y + 100], [x, y + 100]];
const zones = [];
for (let crane = 1; crane <= 12; crane++) {
  zones.push({ id: crane, category: "Кран", levels: [] });
  for (let stand = 0; stand < 3; stand++) {
    zones.push({ id: crane * 100 + stand, category: "Стоянка", parent_zone_id: crane,
      levels: [0, 3000, 6000].map((elevation_mm) => ({ elevation_mm,
        outline: rect(crane * 400 + stand * 100, 0) })) });
  }
}
// На одном ярусе две стоянки пересекаются: обе версии должны считать изделие спорным.
zones.find((zone) => zone.id === 102).levels[1].outline = rect(500, 0);
const elements = Array.from({ length: 1000 }, (_, index) => ({
  id: index + 1, x: 400 + index % 36 * 100 + 50, y: 25 + index % 3 * 25,
  elevation_mm: [0, 3000, 6000, null][index % 4],
  element_type: index % 5 ? "Колонна" : "Ригель",
}));
const overrides = { "1": { crane_zone_id: 2, stance_zone_id: 200 },
  "2": { crane_zone_id: null, stance_zone_id: null } };
const fast = countElementsByZones(zones, elements, overrides);
for (const zone of zones) assert.equal(fast.get(zone.id),
  countElementsInZone(zone, elements, zones, overrides), `зона ${zone.id}`);
console.log(`PASS: быстрый счёт совпадает с исходным для ${zones.length} зон и ${elements.length} изделий`);
