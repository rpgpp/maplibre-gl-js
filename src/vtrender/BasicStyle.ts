import {AlphaImage} from '../util/image.ts';
import {Style} from '../style/style.ts';
import {SPEC_SOURCE_TYPES, validateStyle} from '../style/validate_style.ts';
import BasicSourceCache from './BasicSourceCache.ts';

/**
 * Style implementation for explicit tile rendering.
 *
 * The standard style owns `tileManagers`; this adapter also exposes the historical `sourceCaches`
 * alias so WeatherEarth can keep its tile request and raster fallback code independent of the
 * MapLibre version used by the host application.
 */
class BasicStyle extends Style {
    loadedPromise: Promise<void>;
    externalText = false;
    sourceRef = 0;

    constructor(style: any, map: any, options: any = {}) {
        super(map, options);
        this.externalText = options.externalText ?? false;
        this.glyphManager.allowMissingGlyphs = this.externalText;
        this.loadedPromise = new Promise<void>((resolve, reject) => {
            const resolveWhenSourcesAreLoaded = () => {
                if (!this._loaded || Object.values(this.tileManagers).some((source) => !source.loaded())) return;
                resolve();
            };
            this.on('style.load', resolveWhenSourcesAreLoaded);
            this.on('data', (event: any) => {
                if (event?.sourceDataType === 'content' && event.isSourceLoaded) {
                    resolveWhenSourcesAreLoaded();
                }
            });
            this.once('error', (event: any) => reject(event?.error ?? event));
        });

        if (typeof style === 'string') this.loadURL(style);
        else this.loadJSON(style);
    }

    /** Backward-compatible name used by WeatherEarth's MapLibre adapter. */
    get sourceCaches(): Record<string, BasicSourceCache> {
        return this.tileManagers as unknown as Record<string, BasicSourceCache>;
    }

    /** Returns image IDs in the shape used by style expression evaluation. */
    get _availableImages(): string[] {
        return this.imageManager.listImages();
    }

    /** Loads worker glyphs while preserving missing glyphs for external text consumers. */
    async getGlyphs(mapId: string | number, params: any): Promise<any> {
        const glyphs = await super.getGlyphs(mapId, params);
        if (!this.externalText) return glyphs;

        for (const stack of Object.keys(params.stacks ?? {})) {
            const variants = params.stacks[stack];
            const ids = Array.isArray(variants) ? variants : Object.values(variants).flat();
            const stackGlyphs = glyphs[stack] ?? (glyphs[stack] = {default: {}});
            const defaultGlyphs = stackGlyphs.default ?? (stackGlyphs.default = {});
            for (const id of ids as string[]) {
                if (defaultGlyphs[id]) continue;
                const codePoint = id.codePointAt(0) ?? 0;
                const advance = /\p{Mark}/u.test(id) ? 0 : codePoint > 0xffff ? 12 : 24;
                defaultGlyphs[id] = {
                    id: codePoint,
                    bitmap: new AlphaImage({width: 0, height: 0}),
                    metrics: {width: advance, height: 24, left: 0, top: 18, advance}
                };
            }
        }
        return glyphs;
    }

    /** Adds an explicit source cache without constructing a viewport TileManager. */
    addSource(id: string, source: any = {}, options: any = {}): void {
        this._checkLoaded();
        if (this.sourceCaches[id]) throw new Error(`Source "${id}" already exists.`);
        if (!source.type) throw new Error(`The type property must be defined for source "${id}".`);

        if (SPEC_SOURCE_TYPES.has(source.type) && this._validate(validateStyle.source, `sources.${id}`, source, null, options)) return;

        this.sourceRef++;
        const sourceCache = new BasicSourceCache(id, source, this.dispatcher);
        sourceCache.style = this;
        sourceCache.setEventedParent(this, () => ({
            isSourceLoaded: sourceCache.loaded(),
            source: sourceCache.serialize(),
            sourceId: id
        }));
        sourceCache.onAdd(this.map);
        this.tileManagers[id] = sourceCache as any;
        this._changed = true;
    }

    /** Supplies the cache factory name used by older integration code. */
    _createSourceCache(id: string, source: any): BasicSourceCache {
        return new BasicSourceCache(id, source, this.dispatcher);
    }

    /** Updates visibility for a set of style layers. */
    setLayers(visibleLayerNames: string[]): void[] {
        return Object.keys(this._layers).map((layerName) => this.setLayoutProperty(
            layerName,
            'visibility',
            visibleLayerNames.includes(layerName) ? 'visible' : 'none'
        ) as unknown as void);
    }
}

export default BasicStyle;
