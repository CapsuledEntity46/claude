import { ITEMS, type ItemDef } from '../combat/items';

/**
 * Item icons with a graceful fallback.
 *
 * The UI uses emoji for item icons, which looks good — but only where a colour
 * emoji font is installed. On systems without one (common on minimal Linux
 * setups, and in headless browsers) every icon renders as a "tofu" box, which
 * makes the hotbar unreadable. So probe once at startup and fall back to short
 * letter codes if emoji are unavailable.
 */

let cachedSupport: boolean | null = null;

/**
 * Detects a colour emoji font by drawing a strongly-coloured emoji and looking
 * for pixels whose channels differ. Monochrome text and tofu boxes are grey, so
 * any genuinely coloured pixel means a real emoji glyph was rendered.
 */
export function supportsColorEmoji(): boolean {
  if (cachedSupport !== null) return cachedSupport;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      cachedSupport = false;
      return cachedSupport;
    }

    ctx.clearRect(0, 0, 24, 24);
    ctx.font = '20px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000000';
    ctx.fillText('\u{1F7E9}', 0, 0); // green square emoji

    const { data } = ctx.getImageData(0, 0, 24, 24);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue; // ignore near-transparent pixels
      if (Math.abs(data[i] - data[i + 1]) > 24 || Math.abs(data[i + 1] - data[i + 2]) > 24) {
        cachedSupport = true;
        return cachedSupport;
      }
    }
    cachedSupport = false;
  } catch {
    cachedSupport = false;
  }
  return cachedSupport;
}

/** Candidate codes for a name, shortest first. */
function candidates(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = name.replace(/[^A-Za-z]/g, '');
  const out: string[] = [];
  if (words.length >= 2) {
    out.push(words.map((w) => w[0]!).join('').toUpperCase().slice(0, 3));
  }
  out.push(letters.slice(0, 2).toUpperCase());
  out.push(letters.slice(0, 3).toUpperCase());
  // Last resort: first two letters plus the final letter, e.g. Shortbow -> SHW.
  if (letters.length > 3) out.push((letters.slice(0, 2) + letters.slice(-1)).toUpperCase());
  out.push(letters.slice(0, 4).toUpperCase());
  return out;
}

/**
 * Every item gets a unique code, resolving collisions by trying longer forms.
 * Without this, Shortsword and Shortbow both render as "SH" and the hotbar lies
 * to the player about what they are holding.
 *
 * Built eagerly over the whole registry so codes are stable and do not depend on
 * the order in which items happen to be displayed.
 */
const codes = ((): Map<string, string> => {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  for (const def of ITEMS.values()) {
    let chosen = candidates(def.name).find((c) => c.length > 0 && !taken.has(c));
    if (!chosen) {
      const base = def.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'IT';
      let n = 2;
      while (taken.has(`${base}${n}`)) n++;
      chosen = `${base}${n}`;
    }
    assigned.set(def.id, chosen);
    taken.add(chosen);
  }
  return assigned;
})();

function codeFor(def: ItemDef): string {
  return codes.get(def.id) ?? def.name.slice(0, 2).toUpperCase();
}

/** Short unique letter code for an item, used when emoji are unavailable. */
export function letterCode(def: ItemDef): string {
  return codeFor(def);
}

/** The icon to display for an item, respecting emoji availability. */
export function itemGlyph(def: ItemDef): string {
  return supportsColorEmoji() ? def.glyph : codeFor(def);
}

/**
 * Writes an item's icon into a node, sizing it down when the fallback letter
 * code is used so it fits the same slot.
 */
export function applyGlyph(node: HTMLElement, def: ItemDef): void {
  node.textContent = itemGlyph(def);
  node.classList.toggle('glyph-text', !supportsColorEmoji());
}
