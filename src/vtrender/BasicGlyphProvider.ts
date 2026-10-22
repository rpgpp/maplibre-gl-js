import {GlyphManager} from '../render/glyph_manager.ts';
import type {GlyphMap, GlyphRequests, StyleGlyph} from '../style/style_glyph.ts';
import {RequestManager, type RequestTransformFunction} from '../util/request_manager.ts';

export type BasicGlyphProviderOptions = {
    glyphs: string;
    transformRequest?: RequestTransformFunction;
    localIdeographFontFamily?: string | false;
    allowMissingGlyphs?: boolean;
};

type LegacyGlyphRequests = Record<string, number[]>;
type LegacyGlyphResponse = Record<string, Record<number, StyleGlyph | null>>;

/**
 * Loads glyph PBF ranges through MapLibre's CPU glyph cache.
 *
 * The provider never creates a WebGL context, so it can be injected into WeatherEarth's WebGPU
 * symbol path without introducing a hidden legacy renderer. Missing local glyphs use MapLibre's
 * CPU TinySDF rasterizer.
 */
class BasicGlyphProvider {
    private readonly glyphManager: GlyphManager;
    private destroyed = false;

    constructor(options: BasicGlyphProviderOptions) {
        if (!options?.glyphs) throw new Error('BasicGlyphProvider glyphs URL is required');
        const requestManager = new RequestManager(options.transformRequest);
        this.glyphManager = new GlyphManager(requestManager, options.localIdeographFontFamily ?? false);
        this.glyphManager.allowMissingGlyphs = options.allowMissingGlyphs ?? true;
        this.glyphManager.setURL(options.glyphs);
    }

    /** Returns glyphs in either the current nested MapLibre shape or the legacy flat shape. */
    async getGlyphs(requests: LegacyGlyphRequests | GlyphRequests): Promise<LegacyGlyphResponse | GlyphMap> {
        if (this.destroyed) throw new Error('BasicGlyphProvider was destroyed');
        if (!this.isLegacyRequest(requests)) return this.glyphManager.getGlyphs(requests);

        const normalized: GlyphRequests = {};
        for (const [stack, ids] of Object.entries(requests)) {
            normalized[stack] = {default: ids.map(id => String.fromCodePoint(id))};
        }
        const glyphs = await this.glyphManager.getGlyphs(normalized);
        const result: LegacyGlyphResponse = {};
        for (const [stack, variants] of Object.entries(glyphs)) {
            result[stack] = {};
            for (const [id, glyph] of Object.entries(variants.default ?? {})) {
                result[stack][id.codePointAt(0) ?? 0] = glyph;
            }
        }
        return result;
    }

    /** Releases CPU glyph caches and rejects future requests. */
    destroy(): void {
        this.destroyed = true;
        this.glyphManager.destroy();
    }

    /** Reports whether the provider has been disposed. */
    isDestroyed(): boolean {
        return this.destroyed;
    }

    private isLegacyRequest(requests: LegacyGlyphRequests | GlyphRequests): requests is LegacyGlyphRequests {
        const first = Object.values(requests)[0];
        return Array.isArray(first);
    }
}

export default BasicGlyphProvider;
