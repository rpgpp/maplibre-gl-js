import {EXTENT} from '../data/extent.ts';
import {Evented} from '../util/evented.ts';
import {mat4} from 'gl-matrix';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {RequestManager} from '../util/request_manager.ts';
import {MercatorTransform, type MercatorTransform as Transform} from '../geo/projection/mercator_transform.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import BasicPainter from './BasicPainter.ts';
import BasicStyle from './BasicStyle.ts';
import {now} from '../util/time_control.ts';
import {Formatted, ResolvedImage} from '@maplibre/maplibre-gl-style-spec';
import {toEvaluationFeature} from '../data/evaluation_feature.ts';
import {transformText} from '../symbol/transform_text.ts';
import {evaluateVariableOffset, INVALID_TEXT_OFFSET} from '../style/style_layer/variable_text_anchor.ts';
import ONE_EM from '../symbol/one_em.ts';
import {getOverlapMode} from '../style/style_layer/overlap_mode.ts';

import type {FrameRenderData} from '../render/frame_render_context.ts';
import type BasicSourceCache from './BasicSourceCache.ts';
import type {AllLayoutProperties, AllPaintProperties} from '@maplibre/maplibre-gl-style-spec';

const DEFAULT_RESOLUTION = 256;
const OFFSCREEN_CANV_SIZE = 1024;

export type BasicRendererTextMode = 'maplibre' | 'external' | 'external-symbol';

export type BasicRendererColor = {
    r: number;
    g: number;
    b: number;
    a: number;
};

export type BasicRendererGlyphBitmap = {
    width: number;
    height: number;
    data: Uint8Array;
};

export type BasicRendererGlyphMetrics = {
    width: number;
    height: number;
    left: number;
    top: number;
    advance: number;
    isDoubleResolution?: boolean;
};

export type BasicRendererGlyph = {
    id: number;
    bitmap: BasicRendererGlyphBitmap;
    metrics: BasicRendererGlyphMetrics;
};

export type BasicRendererGlyphResponse = Record<
    string,
    Record<number, BasicRendererGlyph | null>
>;

export type BasicRendererTextSymbol = {
    source: string;
    layerId: string;
    layerOrder: number;
    tile: {z: number; x: number; y: number};
    featureId?: string | number;
    featureIndex: number;
    symbolIndex: number;
    crossTileId: string | number;
    /**
     * WeatherEarth: true when crossTileId fell back to a tile-local key
     * (no cross-tile index id and no feature id). External renderers should
     * merge such candidates by text + position to avoid duplicate labels
     * from parent/child tiles.
     */
    crossTileIdLocal?: boolean;
    text: string;
    position: [number, number];
    placement: 'point' | 'line' | 'line-center';
    fontStack: string[];
    fontStackKey: string;
    fontSize: number;
    /**
     * WeatherEarth: text-size evaluated at the next integer zoom level, so
     * external renderers can interpolate font size at a fractional camera
     * zoom the same way MapLibre does per frame. Equals fontSize when the
     * style's text-size does not depend on zoom.
     */
    fontSizeNext?: number;
    lineHeight: number;
    color: BasicRendererColor;
    opacity: number;
    haloColor: BasicRendererColor;
    haloWidth: number;
    anchor: string;
    offset: [number, number];
    padding: number;
    allowOverlap: boolean;
    ignorePlacement: boolean;
    sortKey?: number;
    /**
     * WeatherEarth: tile-space anchor y when the layer uses
     * symbol-z-order: viewport-y. External renderers can use it as a
     * collision/draw ordering key (larger y = lower on screen = on top).
     */
    zOrderY?: number;
    /** Per-visible-glyph geographic anchors for line text. */
    lineGlyphPositions?: Array<[number, number]>;
    /** Whether line text should be kept in a readable screen direction. */
    textKeepUpright?: boolean;
};

export type BasicRendererSymbol = BasicRendererTextSymbol & {
    letterSpacing: number;
    textRotate: number;
    iconImage?: string;
    iconSize: number;
    iconOffset: [number, number];
    iconAnchor: string;
    iconColor: BasicRendererColor;
    iconOpacity: number;
    iconRotate: number;
    iconPadding: number;
    iconAllowOverlap: boolean;
    iconIgnorePlacement: boolean;
    /** WeatherEarth: icon-text-fit mode; non-'none' scales the icon to the text box. */
    iconTextFit?: string;
    /** WeatherEarth: icon-text-fit-padding in px, [top, right, bottom, left]. */
    iconTextFitPadding?: [number, number, number, number];
};

export type BasicRendererSpriteEntry = {
    x: number;
    y: number;
    width: number;
    height: number;
    pixelRatio?: number;
    sdf?: boolean;
    /** Transparent pixels reserved around this entry in the returned atlas. */
    padding?: number;
};

export type BasicRendererSpriteImage = {
    width: number;
    height: number;
    arrayBufferView: Uint8Array;
};

export type BasicRendererSprite = {
    image: BasicRendererSpriteImage;
    data: Record<string, BasicRendererSpriteEntry>;
};

export type BasicRendererRenderResult = {
    textSymbols: BasicRendererTextSymbol[];
    symbolCandidates?: BasicRendererSymbol[];
};

export type BasicRendererRenderCallback = (
    error: string | null,
    result?: BasicRendererRenderResult
) => void;

export type BasicRendererOptions = {
    style: any;
    transformRequest?: any;
    textMode?: BasicRendererTextMode;
};

/**
 * One source tile of an explicit render request, placed on the imaginary canvas the renderer
 * draws into before copying regions of it out to each consumer.
 */
export type BasicRendererTileSpec = {
    source: string;
    z: number;
    x: number;
    y: number;
    left: number;
    top: number;
    size: number;
};

/** The region of the imaginary canvas one consumer copies out, in canvas and destination pixels. */
export type BasicRendererDrawSpec = {
    destLeft: number;
    destTop: number;
    srcLeft: number;
    srcTop: number;
    width: number;
    height: number;
};

/** A consumer of a pending render, resolved with the result once every tile it needs is loaded. */
export type BasicRendererConsumer = {
    ctx: CanvasRenderingContext2D;
    drawSpec: BasicRendererDrawSpec;
    tilesSpec: BasicRendererTileSpec[];
    next: BasicRendererRenderCallback;
};

/**
 * Handle returned by {@link BasicRenderer.renderTiles}, to be handed back to
 * {@link BasicRenderer.releaseRender} once the drawn region leaves the screen.
 */
export type BasicRendererRenderRef = {
    renderId: number;
    consumer: BasicRendererConsumer;
    tiles: any[];
    tileSetID: string;
};

function toExternalColor(color: any): BasicRendererColor {
    const alpha = Number(color?.a ?? 0);
    if (!(alpha > 0)) return {r: 0, g: 0, b: 0, a: 0};
    return {
        r: Number(color.r ?? 0) / alpha,
        g: Number(color.g ?? 0) / alpha,
        b: Number(color.b ?? 0) / alpha,
        a: alpha
    };
}

function tileAnchorToLngLat(tileId: any, anchorX: number, anchorY: number): [number, number] {
    const canonical = tileId.canonical;
    const scale = Math.pow(2, canonical.z);
    const worldX = (canonical.x + anchorX / EXTENT) / scale;
    const worldY = (canonical.y + anchorY / EXTENT) / scale;
    const longitude = worldX * 360 - 180;
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI;
    return [longitude, latitude];
}

function sampleLineAtDistance(
    line: Array<[number, number]>,
    anchor: [number, number],
    anchorSegment: number,
    signedDistance: number
): [number, number] | undefined {
    if (line.length < 2 || anchorSegment < 0 || anchorSegment >= line.length - 1) return undefined;
    if (signedDistance === 0) return anchor;

    const direction = signedDistance > 0 ? 1 : -1;
    let remaining = Math.abs(signedDistance);
    let current = anchor;
    let index = direction > 0 ? anchorSegment + 1 : anchorSegment;
    while (index >= 0 && index < line.length) {
        const next = line[index];
        const dx = next[0] - current[0];
        const dy = next[1] - current[1];
        const length = Math.hypot(dx, dy);
        if (length > 0 && remaining <= length) {
            const t = remaining / length;
            return [current[0] + dx * t, current[1] + dy * t];
        }
        remaining -= length;
        current = next;
        index += direction;
    }
    return undefined;
}

class BasicRenderer extends Evented {
    _canvas: HTMLCanvasElement;
    transform: Transform;
    _initStyle: any;
    _style: BasicStyle;
    style: BasicStyle;
    painter: BasicPainter;
    _pendingRenders: Map<any, any>;
    _nextRenderId: number;
    _configId: number;
    _queuedConfigChanges: any[];
    _tmpMat4f64b: Float32Array;
    _tmpMat4f64: Float64Array;
    _tmpMat4f32: Float32Array;
    _gl: WebGL2RenderingContext;
    _requestManager: RequestManager;
    _terrain: any;
    _camera: {transform: Transform};
    _container: HTMLElement;
    _ownerWindow: Window;
    _missingStyleImageResolver: any;
    _collectResourceTiming: boolean;
    _refreshExpiredTiles = false;
    showCollisionBoxes = false;
    _placementDirty: boolean;
    _crossSourceCollisions: true;
    _crossFadingFactor = 1;
    _posMatrixCache = {};
    _textMode: BasicRendererTextMode;
    renderText = true;
    renderIcons = true;
    constructor(options: BasicRendererOptions) {
        super();
        if (options.textMode !== undefined && options.textMode !== 'maplibre'
            && options.textMode !== 'external' && options.textMode !== 'external-symbol') {
            throw new Error(`Unsupported BasicRenderer textMode: ${options.textMode}`);
        }
        this._textMode = options.textMode ?? 'maplibre';
        this._ownerWindow = window;
        this._crossSourceCollisions = true;
        this._requestManager = new RequestManager(options.transformRequest);
        this._missingStyleImageResolver = null;
        this._collectResourceTiming = false;
        this._canvas = document.createElement('canvas');
        this._canvas.style.imageRendering = 'pixelated';
        this._canvas.addEventListener(
            'webglcontextlost',
            () => console.log('webglcontextlost'),
            false
        );
        this._canvas.addEventListener(
            'webglcontextrestored',
            () => this._createGlContext(),
            false
        );
        this._canvas.width = OFFSCREEN_CANV_SIZE;
        this._canvas.height = OFFSCREEN_CANV_SIZE;

        const transform :any= new MercatorTransform();
        transform.resize(OFFSCREEN_CANV_SIZE, OFFSCREEN_CANV_SIZE);

        const that = this;
        transform.calculatePosMatrix2 = transform.calculatePosMatrix;
        transform.calculatePosMatrix = (tileID) => {
            if (tileID.posMatrix)
                return tileID.posMatrix;
            const posMatrixKey = tileID.key;
            if (that._posMatrixCache[posMatrixKey]) {
                return that._posMatrixCache[posMatrixKey];
            }
            return transform.calculatePosMatrix2(tileID);
        };
        transform.clone2 = transform.clone;
        transform.clone = ()=>{
            const newTransform = transform.clone2();
            newTransform.calculatePosMatrix2 = transform.calculatePosMatrix2;
            newTransform.calculatePosMatrix = transform.calculatePosMatrix;
            return newTransform;
        };

        this.transform = transform;

        this._initStyle = options.style;
        const s1 = options.style; // Object.assign({}, options.style, {});
        this._camera = {transform};
        this._style = new BasicStyle(s1, this, {
            crossSourceCollisions: this._crossSourceCollisions,
            // External text consumers need the exact fontstack PBF glyphs instead
            // of locally generated CJK glyphs.
            localIdeographFontFamily: this._textMode !== 'maplibre' ? false : 'sans-serif',
            externalText: this._textMode !== 'maplibre',
        });

        this._style.setEventedParent(this, {style: this._style});
        this._style.on('style.load', (e) => this._onReady());
        this._createGlContext();
        this.painter.resize(OFFSCREEN_CANV_SIZE, OFFSCREEN_CANV_SIZE,1);
        this.painter.transform = this.transform;
        this._pendingRenders = new Map(); // tileSetID => render state
        this._nextRenderId = 0; // each new render state created has a unique renderId in addition to its tileSetID, which isn't unique
        this._configId = 0; // for use with async config changes..see setXYZ methods below
        this._queuedConfigChanges = [];

        this.style = this._style;
    }

    getPixelRatio(): number {
        return 1;
    }

    /** Exposes the terrain slot expected by the shared Style and Painter code. */
    get terrain() :any {
        return this._terrain;
    }

    /**
     * Returns glyph PBF data through the style's existing request and CPU cache.
     * Missing glyphs are reported as null so external renderers can fall back.
     */
    async getGlyphs(stacks: Record<string, number[]>): Promise<BasicRendererGlyphResponse> {
        const requests = Object.fromEntries(Object.entries(stacks).map(([stack, ids]) => [
            stack,
            {default: ids.map(id => String.fromCodePoint(id))}
        ]));
        const glyphs = await this._style.glyphManager.getGlyphs(requests);
        const result: BasicRendererGlyphResponse = {};
        for (const [stack, variants] of Object.entries(glyphs)) {
            result[stack] = {};
            for (const [id, glyph] of Object.entries(variants.default ?? {})) {
                result[stack][id.codePointAt(0) ?? 0] = glyph && {
                    id: glyph.id,
                    bitmap: glyph.bitmap.clone(),
                    metrics: glyph.metrics
                };
            }
        }
        return result;
    }

    /**
     * Builds one external sprite atlas from the images already loaded by the
     * style. Returning the original RGBA bytes avoids an extra canvas color and
     * alpha conversion before an external renderer uploads the texture.
     */
    async getSprite(): Promise<BasicRendererSprite | undefined> {
        if (!this._style.imageManager.isLoaded()) {
            await new Promise<void>((resolve) => {
                const subscription = this._style.on('data', () => {
                    if (!this._style.imageManager.isLoaded()) return;
                    subscription.unsubscribe();
                    resolve();
                });
            });
        }

        const imageManager = this._style.imageManager;
        const images = imageManager?.images as Record<string, any>;
        const sourceEntries = Object.keys(images ?? {}).map((id) => {
            // Materialize on-demand sprite regions as RGBAImage once, using the
            // same extraction path as MapLibre's own image atlas.
            return [id, imageManager.getImage(id)] as [string, any];
        }).filter(([, image]: [string, any]) => {
            const source = image?.data;
            return source && source.width > 0 && source.height > 0;
        });
        if (sourceEntries.length === 0) return undefined;

        const padding = 1;
        const totalArea = sourceEntries.reduce((sum, [, image]: [string, any]) => {
            const source = image.data;
            return sum + (source.width + padding * 2) * (source.height + padding * 2);
        }, 0);
        const maximumWidth = sourceEntries.reduce((maximum, [, image]: [string, any]) => {
            const source = image.data;
            return Math.max(maximum, source.width + padding * 2);
        }, 1);
        let atlasWidth = 1;
        const targetWidth = Math.max(maximumWidth, Math.ceil(Math.sqrt(totalArea)));
        while (atlasWidth < targetWidth) atlasWidth *= 2;

        let cursorX = 0;
        let cursorY = 0;
        let rowHeight = 0;
        let usedWidth = 1;
        let usedHeight = 1;
        const placements: Array<{id: string; image: any; x: number; y: number}> = [];
        for (const [id, image] of sourceEntries) {
            const source = image.data;
            const paddedWidth = source.width + padding * 2;
            const paddedHeight = source.height + padding * 2;
            if (cursorX > 0 && cursorX + paddedWidth > atlasWidth) {
                cursorX = 0;
                cursorY += rowHeight;
                rowHeight = 0;
            }
            placements.push({id, image, x: cursorX + padding, y: cursorY + padding});
            cursorX += paddedWidth;
            rowHeight = Math.max(rowHeight, paddedHeight);
            usedWidth = Math.max(usedWidth, cursorX);
            usedHeight = Math.max(usedHeight, cursorY + paddedHeight);
        }

        const width = Math.min(atlasWidth, usedWidth);
        const height = usedHeight;
        const atlas = new Uint8Array(width * height * 4);
        const data: Record<string, BasicRendererSpriteEntry> = {};
        for (const placement of placements) {
            const {id, image, x, y} = placement;
            const rgbaImage = image.data;
            const spriteWidth = rgbaImage.width;
            const spriteHeight = rgbaImage.height;
            const rowLength = spriteWidth * 4;
            for (let row = 0; row < spriteHeight; row++) {
                const sourceOffset = row * rowLength;
                const destinationOffset = ((y + row) * width + x) * 4;
                atlas.set(
                    rgbaImage.data.subarray(sourceOffset, sourceOffset + rowLength),
                    destinationOffset
                );
            }
            data[id] = {
                x,
                y,
                width: spriteWidth,
                height: spriteHeight,
                pixelRatio: image.pixelRatio,
                sdf: image.sdf,
                padding
            };
        }
        return {
            image: {width, height, arrayBufferView: atlas},
            data
        };
    }

    /** Kept for callers that switch projections; the offscreen renderer always draws in Mercator. */
    migrateProjection(newTransform: any, cameraHelper: any): void {
        // this.transform = newTransform;
        // newTransform.calculatePosMatrix = (tileID: any) => tileID.posMatrix
        // newTransform.resize(OFFSCREEN_CANV_SIZE, OFFSCREEN_CANV_SIZE)
        // newTransform._helper['_pixelsToGLUnits'] = [2 / OFFSCREEN_CANV_SIZE, -2 / OFFSCREEN_CANV_SIZE]
        // newTransform.apply(this.transform);
    }

    setTerrain(terrain: any): void { this._terrain = terrain; }
    getTerrain(): any { return this._terrain; }

    _getMapId(): number {
        return 1;
    }

    _onReady(): void {
        this._style.update(new EvaluationParameters(16));
    }

    _calculatePosMatrix(transX: number, transY: number, tileSize: number): Float32Array {
    /*
      The returned matrix, M, is designed to be used as:
        X_gl_coords = M * X_mvt_data_coords
      where X_gl_coords are in the range [-1,1]
      and X_mvt_data_coords are in the range [0,Extent], or rather they are nearly
      within that range, they actually go outside it by about 10% to let polygons/lines
      span across tile boundaries.
      The translate/scale functions here could probably be ditched in favour of
      the mat4 versions, but I found it easier to do the multiplies myself.
    */
        //     this.pixelsToGLUnits = [2 / width, -2 / height];
        // this._constrain();
        // this._calcMatrices();

        var translate = (a, v) => {
            this._tmpMat4f64b = this._tmpMat4f64b || new Float32Array(16);
            mat4.identity(this._tmpMat4f64b);
            mat4.translate(this._tmpMat4f64b, this._tmpMat4f64b, v);
            mat4.multiply(a, this._tmpMat4f64b, a);
        };
        var scale = (a, v) => {
            this._tmpMat4f64b = this._tmpMat4f64b || new Float32Array(16);
            mat4.identity(this._tmpMat4f64b);
            mat4.scale(this._tmpMat4f64b, this._tmpMat4f64b, v);
            mat4.multiply(a, this._tmpMat4f64b, a);
        };

        this._tmpMat4f64 = this._tmpMat4f64 || new Float64Array(16); // reuse each time for GC's benefit
        // eslint-disable-next-line no-warning-comments
        this._tmpMat4f32 = new Float32Array(16); // TODO(optimization): may want to use a pool for this rather than a new one each time

        // The main calculation...
        // @ts-ignore
        mat4.identity(this._tmpMat4f64);
        const factor = tileSize / OFFSCREEN_CANV_SIZE;

        // scale(this._tmpMat4f64, [(1 / EXTENT) * factor, (-1 / EXTENT) * factor, 1]);
        // translate(this._tmpMat4f64, [
        //   -1 + (1 * transX) / OFFSCREEN_CANV_SIZE,
        //   1 - (1 * transY) / OFFSCREEN_CANV_SIZE,
        //   0,
        // ])

        {
            scale(this._tmpMat4f64, [2 / EXTENT * factor, -2 / EXTENT * factor, 1]);
            translate(this._tmpMat4f64, [-1 + 2 * transX / OFFSCREEN_CANV_SIZE, 1 - 2 * transY / OFFSCREEN_CANV_SIZE, 0]);
        }
        this._tmpMat4f32.set(this._tmpMat4f64);
        return this._tmpMat4f32;
    }

    _createGlContext(): void {

        const attributes = {
            failIfMajorPerformanceCaveat: false,
            preserveDrawingBuffer: false,
            alpha: true,
            stencil: true,
            depth: true,
            //isSupported.webGLContextAttributes
        };

        this._gl = this._canvas.getContext('webgl2', attributes);
        if (!this._gl) {
            throw new Error('BasicRenderer requires WebGL2');
        }
        this.painter = new BasicPainter(this._gl);
        this.painter.renderText = this._textMode === 'maplibre';
        this.painter.renderIcons = this._textMode !== 'external-symbol';
        this.painter.style = this._style;
    }

    _evaluateStyleValue(value: any, feature: any, canonical: any): any {
        return value && typeof value.evaluate === 'function'
            ? value.evaluate(feature, {}, canonical, this._style._availableImages)
            : value;
    }

    _getTextOffset(layer: any, feature: any, canonical: any, anchor: string, fontSize: number): [number, number] {
        const layout = layer.layout;
        const radialOffset = Number(this._evaluateStyleValue(layout.get('text-radial-offset'), feature, canonical) ?? 0);
        let offset: [number, number];
        if (radialOffset !== 0) {
            offset = evaluateVariableOffset(anchor as any, [radialOffset * ONE_EM, INVALID_TEXT_OFFSET]);
        } else {
            const textOffset = this._evaluateStyleValue(layout.get('text-offset'), feature, canonical) ?? [0, 0];
            offset = [Number(textOffset[0] ?? 0) * ONE_EM, Number(textOffset[1] ?? 0) * ONE_EM];
        }
        return [offset[0] / ONE_EM * fontSize, offset[1] / ONE_EM * fontSize];
    }

    _getTranslate(paint: any, property: 'text-translate' | 'icon-translate'): [number, number] {
        const translate = paint.get(property) ?? [0, 0];
        return [Number(translate[0]) || 0, Number(translate[1]) || 0];
    }

    _getPadding(value: any): number {
        const values = value?.values ?? value;
        if (Array.isArray(values)) {
            return Math.max(0, ...values.map(item => Number(item) || 0));
        }
        return Math.max(0, Number(values) || 0);
    }

    _getLineGlyphPositions(
        tile: any,
        bucket: any,
        symbol: any,
        fontSize: number,
        keepUpright: boolean,
        maxAngle: number
    ): Array<[number, number]> | undefined {
        const placedSymbolIndices = [
            symbol.centerJustifiedTextSymbolIndex,
            symbol.leftJustifiedTextSymbolIndex,
            symbol.rightJustifiedTextSymbolIndex
        ];
        const placedSymbolIndex = placedSymbolIndices.find((index) => {
            if (!(index >= 0)) return false;
            const placed = bucket.text?.placedSymbolArray?.get(index);
            return placed && placed.numGlyphs > 0 && placed.lineLength > 1;
        });
        if (placedSymbolIndex === undefined) return undefined;

        const placed = bucket.text.placedSymbolArray.get(placedSymbolIndex);
        const line: Array<[number, number]> = [];
        for (let index = 0; index < placed.lineLength; index++) {
            const vertexIndex = placed.lineStartIndex + index;
            line.push([
                bucket.lineVertexArray.getx(vertexIndex),
                bucket.lineVertexArray.gety(vertexIndex)
            ]);
        }
        const anchor: [number, number] = [placed.anchorX, placed.anchorY];
        const fontScale = fontSize / ONE_EM;
        const toTileDistance = (glyphIndex: number, flip: boolean) => {
            const glyphOffset = bucket.glyphOffsetArray.getoffsetX(
                placed.glyphStartIndex + glyphIndex
            ) * fontScale;
            const lineOffset = placed.lineOffsetX * fontScale;
            const pixelDistance = flip
                ? -(glyphOffset - lineOffset)
                : glyphOffset + lineOffset;
            return pixelDistance * bucket.tilePixelRatio;
        };
        const getTilePoint = (glyphIndex: number, flip: boolean) => sampleLineAtDistance(
            line,
            anchor,
            placed.segment,
            toTileDistance(glyphIndex, flip)
        );

        let flip = false;
        if (keepUpright && placed.numGlyphs > 1) {
            const first = getTilePoint(0, false);
            const last = getTilePoint(placed.numGlyphs - 1, false);
            if (first && last) {
                const deltaX = last[0] - first[0];
                const deltaY = last[1] - first[1];
                // Keep the baseline angle inside MapLibre's readable
                // [-90deg, 90deg] range. Even a nearly vertical line must use
                // its horizontal direction here: choosing top-to-bottom for a
                // line that leans left produces an upside-down angle slightly
                // greater than 90deg. Only a perfectly vertical line is
                // ambiguous, so prefer top-to-bottom in that case.
                flip = deltaX !== 0 ? deltaX < 0 : deltaY < 0;
            }
        }

        const tilePoints: Array<[number, number]> = [];
        for (let glyphIndex = 0; glyphIndex < placed.numGlyphs; glyphIndex++) {
            const tilePoint = getTilePoint(glyphIndex, flip);
            if (!tilePoint) return undefined;
            tilePoints.push(tilePoint);
        }

        // text-max-angle: reject line text when the direction change between
        // adjacent glyph anchors exceeds the limit, matching MapLibre's curved
        // placement check at sharp bends. Computed in tile space to avoid
        // latitude distortion; the angle between consecutive anchor segments
        // approximates MapLibre's per-glyph-width curvature window.
        if (maxAngle > 0 && tilePoints.length > 2) {
            let previousAngle: number | undefined;
            for (let index = 1; index < tilePoints.length; index++) {
                const deltaX = tilePoints[index][0] - tilePoints[index - 1][0];
                const deltaY = tilePoints[index][1] - tilePoints[index - 1][1];
                if (deltaX === 0 && deltaY === 0) continue;
                const angle = Math.atan2(deltaY, deltaX);
                if (previousAngle !== undefined) {
                    let delta = Math.abs(angle - previousAngle) % (Math.PI * 2);
                    if (delta > Math.PI) delta = Math.PI * 2 - delta;
                    if (delta > maxAngle) return undefined;
                }
                previousAngle = angle;
            }
        }

        return tilePoints.map((point) =>
            tileAnchorToLngLat(tile.tileID, point[0], point[1])
        );
    }

    _collectSymbols(tilesSpec: BasicRendererTileSpec[], tiles: any[]): BasicRendererSymbol[] {
        if (this._textMode === 'maplibre') return [];

        const result: BasicRendererSymbol[] = [];
        const seen = new Set<string>();
        const layerIds = this._style._order;

        for (let layerOrder = layerIds.length - 1; layerOrder >= 0; layerOrder--) {
            const layerId = layerIds[layerOrder];
            const layer: any = this._style._layers[layerId];
            if (!layer || layer.type !== 'symbol' || layer.isHidden(this.transform.zoom)) continue;

            for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
                const tileSpec = tilesSpec[tileIndex];
                if (tileSpec.source !== layer.source) continue;

                const tile = tiles[tileIndex];
                const bucket: any = tile.getBucket(layer);
                const featureIndex = tile.latestFeatureIndex;
                if (!bucket || !featureIndex || !bucket.symbolInstances?.length) continue;

                const vectorTileLayers = featureIndex.loadVTLayers();
                const sourceLayerName = featureIndex.sourceLayerCoder.decode(bucket.sourceLayerIndex);
                const sourceLayer = vectorTileLayers[sourceLayerName];
                if (!sourceLayer) continue;

                const canonical = tile.tileID.canonical;
                for (let symbolIndex = 0; symbolIndex < bucket.symbolInstances.length; symbolIndex++) {
                    const symbol = bucket.symbolInstances.get(symbolIndex);

                    const vectorTileFeature = sourceLayer.feature(symbol.featureIndex);
                    // WeatherEarth: prefer the cross-tile index id, then the
                    // feature id (stable across parent/child tiles); the
                    // tile-local fallback is flagged so external renderers can
                    // merge duplicates by text + position.
                    const featureId = vectorTileFeature.id;
                    const hasExactCrossTileId = Boolean(symbol.crossTileID)
                        || (featureId !== undefined && featureId !== null);
                    const crossTileId = symbol.crossTileID
                        || (hasExactCrossTileId ? `feature/${featureId}` : `${canonical.z}/${canonical.x}/${canonical.y}/${symbolIndex}`);
                    const uniqueKey = `${layer.source}/${layerId}/${crossTileId}`;
                    if (seen.has(uniqueKey)) continue;

                    const feature = toEvaluationFeature(vectorTileFeature, true);
                    const resolvedText = layer.getValueAndResolveTokens(
                        'text-field', feature, canonical, this._style._availableImages
                    );
                    const formattedText = resolvedText == null
                        ? null
                        : Formatted.factory(resolvedText);
                    const text = formattedText
                        ? transformText(formattedText, layer, feature).toString()
                        : '';
                    const resolvedIcon = layer.getValueAndResolveTokens(
                        'icon-image', feature, canonical, this._style._availableImages
                    );
                    const icon = resolvedIcon == null
                        ? null
                        : resolvedIcon instanceof ResolvedImage
                            ? resolvedIcon
                            : ResolvedImage.fromString(resolvedIcon);
                    const iconImage = icon?.name || undefined;

                    const layout = layer.layout;
                    const paint = layer.paint;
                    const variableAnchors = layout.get('text-variable-anchor');
                    const placedAnchor = this._style.placement?.variableOffsets?.[crossTileId]?.anchor;
                    const anchor = placedAnchor ?? (variableAnchors?.length
                        ? variableAnchors[0]
                        : this._evaluateStyleValue(layout.get('text-anchor'), feature, canonical) ?? 'center'
                    );
                    const fontSize = Number(this._evaluateStyleValue(layout.get('text-size'), feature, canonical) ?? 16);
                    // WeatherEarth: evaluate text-size once more at the next
                    // integer zoom. MapLibre re-evaluates it every frame at the
                    // fractional camera zoom; the external renderer instead
                    // interpolates between fontSize and fontSizeNext in its
                    // vertex shader, which avoids re-shaping glyphs per frame.
                    let fontSizeNext = fontSize;
                    const textSizeValue = layout.get('text-size');
                    const textSizeProperty = textSizeValue?.property;
                    if (textSizeProperty && typeof textSizeProperty.evaluate === 'function') {
                        const nextParameters = new EvaluationParameters(Math.min(canonical.z + 1, 24));
                        const evaluatedNext = Number(textSizeProperty.evaluate(
                            textSizeValue.value,
                            nextParameters,
                            feature,
                            {},
                            canonical,
                            this._style._availableImages
                        ));
                        if (Number.isFinite(evaluatedNext) && evaluatedNext > 0) {
                            fontSizeNext = evaluatedNext;
                        }
                    }
                    const lineHeight = Number(layout.get('text-line-height') ?? 1.2) * fontSize;
                    const evaluatedFontStack = this._evaluateStyleValue(layout.get('text-font'), feature, canonical) ?? ['sans-serif'];
                    const fontStack = Array.isArray(evaluatedFontStack)
                        ? evaluatedFontStack.map(String)
                        : [String(evaluatedFontStack)];
                    const sortKeyValue = this._evaluateStyleValue(layout.get('symbol-sort-key'), feature, canonical);
                    const sortKey = Number(sortKeyValue);
                    // viewport-y: expose the tile-space anchor y so external
                    // renderers can order collision/drawing like MapLibre
                    // (lower on screen wins). 'auto' leaves ordering to
                    // symbol-sort-key.
                    const symbolZOrder = String(layout.get('symbol-z-order') ?? 'auto');
                    const zOrderY = symbolZOrder === 'viewport-y'
                        ? Number(symbol.anchorY)
                        : undefined;
                    const placement = layout.get('symbol-placement') ?? 'point';
                    const textAlongLine = placement !== 'point'
                        && layout.get('text-rotation-alignment') !== 'viewport';
                    const textKeepUpright = Boolean(layout.get('text-keep-upright'));
                    // MapLibre default is 45deg; symbols bending more than this
                    // between adjacent glyphs are rejected (sharp curves).
                    const textMaxAngle = Number(layout.get('text-max-angle') ?? 45)
                        * Math.PI / 180;
                    const textOverlapMode = getOverlapMode(layout, 'text-overlap', 'text-allow-overlap');
                    const iconOverlapMode = getOverlapMode(layout, 'icon-overlap', 'icon-allow-overlap');
                    const opacity = Number(paint.get('text-opacity').evaluate(feature, {}, canonical) ?? 1);
                    const iconOpacity = Number(paint.get('icon-opacity').evaluate(feature, {}, canonical) ?? 1);
                    const hasText = Boolean(text) && opacity > 0;
                    const hasIcon = Boolean(iconImage) && iconOpacity > 0;
                    if (!hasText && !hasIcon) continue;

                    // icon-text-fit scales the icon quad around the text box;
                    // the external renderer knows the text metrics, so only
                    // the mode and padding need to cross the boundary.
                    const iconTextFit = hasIcon && hasText
                        ? String(this._evaluateStyleValue(layout.get('icon-text-fit'), feature, canonical) ?? 'none')
                        : 'none';
                    const rawFitPadding = this._evaluateStyleValue(layout.get('icon-text-fit-padding'), feature, canonical);
                    const fitPaddingValues = rawFitPadding?.values ?? rawFitPadding;
                    const iconTextFitPadding: [number, number, number, number] = Array.isArray(fitPaddingValues)
                        ? [0, 1, 2, 3].map((index) => Number(fitPaddingValues[index]) || 0) as [number, number, number, number]
                        : [0, 0, 0, 0];

                    const lineGlyphPositions = textAlongLine
                        ? this._getLineGlyphPositions(
                            tile,
                            bucket,
                            symbol,
                            fontSize,
                            textKeepUpright,
                            textMaxAngle
                        )
                        : undefined;
                    const textTranslate = this._getTranslate(paint, 'text-translate');
                    const rawTextOffset = this._getTextOffset(layer, feature, canonical, anchor, fontSize);
                    const textOffset: [number, number] = [
                        // Line glyph anchors already include placed.lineOffsetX,
                        // which is the evaluated text-offset.x in glyph units.
                        // Keep paint translation in screen pixels without applying
                        // the layout offset a second time in the external renderer.
                        (lineGlyphPositions ? 0 : rawTextOffset[0]) + textTranslate[0],
                        rawTextOffset[1] + textTranslate[1]
                    ];
                    const iconSize = Number(this._evaluateStyleValue(layout.get('icon-size'), feature, canonical) ?? 1);
                    const rawIconOffset = this._evaluateStyleValue(layout.get('icon-offset'), feature, canonical) ?? [0, 0];
                    const iconTranslate = this._getTranslate(paint, 'icon-translate');
                    const iconOffset: [number, number] = [
                        (Number(rawIconOffset[0]) || 0) * iconSize + iconTranslate[0],
                        (Number(rawIconOffset[1]) || 0) * iconSize + iconTranslate[1]
                    ];

                    seen.add(uniqueKey);
                    result.push({
                        source: layer.source,
                        layerId,
                        layerOrder,
                        tile: {z: canonical.z, x: canonical.x, y: canonical.y},
                        featureId: vectorTileFeature.id,
                        featureIndex: symbol.featureIndex,
                        symbolIndex,
                        crossTileId,
                        crossTileIdLocal: hasExactCrossTileId ? undefined : true,
                        text,
                        position: tileAnchorToLngLat(tile.tileID, symbol.anchorX, symbol.anchorY),
                        placement,
                        fontStack,
                        fontStackKey: fontStack.join(','),
                        fontSize,
                        fontSizeNext,
                        lineHeight,
                        color: toExternalColor(paint.get('text-color').evaluate(feature, {}, canonical)),
                        opacity,
                        haloColor: toExternalColor(paint.get('text-halo-color').evaluate(feature, {}, canonical)),
                        haloWidth: Number(paint.get('text-halo-width').evaluate(feature, {}, canonical) ?? 0),
                        letterSpacing: Number(this._evaluateStyleValue(
                            layout.get('text-letter-spacing'), feature, canonical
                        ) ?? 0) * fontSize,
                        textRotate: placement === 'point'
                            ? Number(this._evaluateStyleValue(layout.get('text-rotate'), feature, canonical) ?? 0)
                            : 0,
                        anchor,
                        offset: textOffset,
                        padding: Number(layout.get('text-padding') ?? 0),
                        allowOverlap: textOverlapMode === 'always',
                        ignorePlacement: Boolean(layout.get('text-ignore-placement')),
                        iconImage,
                        iconSize,
                        iconOffset,
                        iconAnchor: String(this._evaluateStyleValue(layout.get('icon-anchor'), feature, canonical) ?? 'center'),
                        iconColor: toExternalColor(paint.get('icon-color').evaluate(feature, {}, canonical)),
                        iconOpacity,
                        iconRotate: Number(this._evaluateStyleValue(layout.get('icon-rotate'), feature, canonical) ?? 0),
                        iconPadding: this._getPadding(this._evaluateStyleValue(
                            layout.get('icon-padding'), feature, canonical
                        )),
                        iconAllowOverlap: iconOverlapMode === 'always',
                        iconIgnorePlacement: Boolean(layout.get('icon-ignore-placement')),
                        textKeepUpright,
                        ...(lineGlyphPositions ? {lineGlyphPositions} : {}),
                        ...(Number.isFinite(sortKey) ? {sortKey} : {}),
                        ...(zOrderY !== undefined && Number.isFinite(zOrderY) ? {zOrderY} : {}),
                        ...(iconTextFit !== 'none' ? {iconTextFit, iconTextFitPadding} : {})
                    });
                }
            }
        }

        return result;
    }

    /* For the following 3 methods the return value depends on the flag exec:
      + when exec=true, the function returns a promise that resolves once the
      requested change has taken effect. If the value of the promise is true it
      means that this config change was the most recent change, when false it
      means another config change was requested after this one, and that the other
      one has also taken effect.
      + when exec=false, instead of returning a promise, a function is returned
      and that function must be called in order to get the promise as described above.
      This is useful for when you want to debounce a number of config changes and
      separate the enquing of changes from the actual execution of the changes. */
    setPaintProperty(layer: string, prop: string, val: any, exec: boolean = true): Promise<boolean> | (() => Promise<boolean>) {
        this._queuedConfigChanges.push(() =>
            this._style.setPaintProperty(layer, prop as keyof AllPaintProperties, val)
        );
        return exec
            ? this._processConfigQueue(++this._configId)
            : () => this._processConfigQueue(++this._configId);
    }

    setLayoutProperty(layer: string, prop: string, val: any, exec: boolean = true): Promise<boolean> | (() => Promise<boolean>) {
        this._queuedConfigChanges.push(() =>
            this._style.setLayoutProperty(layer, prop as keyof AllLayoutProperties, val)
        );
        return exec
            ? this._processConfigQueue(++this._configId)
            : () => this._processConfigQueue(++this._configId);
    }

    setFilter(layer: string, filter: any, exec: boolean = true): Promise<boolean> | (() => Promise<boolean>) {
    // https://www.mapbox.com/mapbox-gl-js/style-spec/#types-filter
        this._queuedConfigChanges.push(() => this._style.setFilter(layer, filter));
        return exec
            ? this._processConfigQueue(++this._configId)
            : () => this._processConfigQueue(++this._configId);
    }

    _processConfigQueue(calledByConfigId: number): Promise<boolean> {
    // only the most recently submitted configId is allowed to actually
    // trigger the changes, and will resolve to true. All the others will
    // resolve to false.

        return this._style.loadedPromise.then(() => {
            if (this._configId !== calledByConfigId) {
                return false;
            }
            this._cancelAllPendingRenders();
            while (this._queuedConfigChanges.length) {
                this._queuedConfigChanges.shift()();
            }
            this._style.update(new EvaluationParameters(16));
            // @ts-ignore
            this.fire('configChanged');
            return true;
        });
    }

    // =============

    getLayersVisible(zoom?: number, source?: string): string[] {
    // if zoom is provided will filter by min/max zoom as well as by layer visibility
    // and if source (string) is provided only style layers from that source will be returned.
        const layerStylesheetFromLayer = (layer) =>
            layer?._eventedParent.stylesheet.layers.find((x) => x.id === layer.id);

        //return Object.keys(this._style._layers);
        // Get rid of filtering for now

        // .filter(
        //   (lyr) => this._style.getLayoutProperty(lyr, "visibility") === "visible"
        // )
        return Object.keys(this._style._layers).filter((lyr) => {
            const layerStylesheet = layerStylesheetFromLayer(this._style._layers[lyr]);
            return (
                (!zoom ||
          (layerStylesheet &&
            (layerStylesheet.minzoom_ === undefined ||
              zoom >= layerStylesheet.minzoom_) &&
            (layerStylesheet.maxzoom_ === undefined ||
              zoom <= layerStylesheet.maxzoom_))) &&
        (!source || (layerStylesheet && layerStylesheet.source === source))
            );
        });
    }

    getLayerOriginalFilter(layerName: string): any {
        const layer = this._initStyle.layers.find((lyr) => lyr.id === layerName);
        return layer?.filter;
    }

    getLayerOriginalPaint(layerName: string): any {
        const layer = this._initStyle.layers.find((lyr) => lyr.id === layerName);
        return layer?.paint;
    }

    getLayerOriginalLayout(layerName: string): any {
        const layer = this._initStyle.layers.find((lyr) => lyr.id === layerName);
        return layer?.layout;
    }

    getVisibleSources(zoom?: number): string[] {
    // list of sources with style layers that are visible, optionaly using the zoom to refine the visibility
        return Object.keys(this._style.sourceCaches).filter(
            (s) => this.getLayersVisible(this.painter._filterForZoom, s).length > 0
        );
    }

    filterForZoom(zoom: number): void {
        if (zoom === this.painter._filterForZoom) {
            return;
        }
        this.painter._filterForZoom = zoom;
        // don't cancel pending render because it may renders tiles with different zoom at the same time.
        // this._cancelAllPendingRenders();
        return;
    }

    _cancelAllPendingRenders(): void {
        this._pendingRenders.forEach(s => this._finishRender(s.tileSetID, s.renderId, 'canceled'));
        this._pendingRenders.clear();
        Object.values(this._style.sourceCaches).forEach((s: any) => s.invalidateAllLoadedTiles());
    }

    _finishRender(tileSetID: string, renderId: number, err: string | null): void {
    // each consumer must call releaseRender at some point, either before this is called or after.
    // regardless of whether or not there was an error.

        const state = this._pendingRenders.get(tileSetID);
        if (!state || state.renderId !== renderId) {
            return; // render for this tile has been canceled, or superceded.
        }

        while (state.consumers.length) {
            state.consumers.shift().next(err);
        }
        this._pendingRenders.delete(tileSetID);
    }

    _canonicalizeSpec(
        tilesSpec: BasicRendererTileSpec[],
        drawSpec: BasicRendererDrawSpec
    ): {tilesSpec: BasicRendererTileSpec[]; drawSpec: BasicRendererDrawSpec} {
    // we define the origin as the minimum left and top values mentioned in tileSpec/drawSpec
    // and adjust all the top/left values to use this reference.  This cannonicalization means
    // we can spot tile sets that are the same except for a gobal translation.

        const minLeft = tilesSpec
            .map((s) => s.left)
            .reduce((a, b) => Math.min(a, b), Infinity);
        const minTop = tilesSpec
            .map((s) => s.top)
            .reduce((a, b) => Math.min(a, b), Infinity);

        return {
            tilesSpec: tilesSpec.map((s) => ({
                source: s.source,
                z: s.z,
                x: s.x,
                y: s.y,
                top: s.top - minTop,
                left: s.left - minLeft,
                size: s.size,
            })),
            drawSpec: {
                srcLeft: drawSpec.srcLeft - minLeft,
                srcTop: drawSpec.srcTop - minTop,
                width: drawSpec.width,
                height: drawSpec.height,
                destLeft: drawSpec.destLeft,
                destTop: drawSpec.destTop,
            },
        };
    }

    _tileSpecToString(tilesSpec: BasicRendererTileSpec[]): string {
    // this is basically a stable JSON.stringify..could proably optimize this a bit if we really cared.
        return tilesSpec
            .map(
                (s) => `${s.source} ${s.z} ${s.x} ${s.y} ${s.left} ${s.top} ${s.size}`
            )
            .sort()
            .join(' ');
    }

    releaseRender(renderRef: BasicRendererRenderRef): void {
    // call this when the rendered thing is no longer on screen (it could happen long after the render finishes, or before it finishes).
        const state = this._pendingRenders.get(renderRef.tileSetID);
        renderRef.tiles.forEach((t) => t.cache.releaseTile(t));

        if (!state || state.renderId !== renderRef.renderId) {
            return; // tile was already rendered
        }

        renderRef.consumer.next('canceled');
        const idx = state.consumers.indexOf(renderRef.consumer);
        (idx !== -1) && state.consumers.splice(idx, 1);

        // if there are no consumers left then clean-up the render
        (state.consumers.length === 0) && this._finishRender(state.tileSetID, renderRef.renderId, 'fully-canceled');

    }

    renderTiles(
        ctx: CanvasRenderingContext2D,
        drawSpec: BasicRendererDrawSpec,
        tilesSpec: BasicRendererTileSpec[],
        next: BasicRendererRenderCallback
    ): BasicRendererRenderRef {
        // drawSpec has {destLeft,destTop,srcLeft,srcTop,width,height}
        // tilesSpec is an array of: {sourceName,z,x,y,left,top,size}
        // The tilesSpec defines how a selection of source tiles are rendered to an
        // imaginary canvas, and then drawSpec states what to copy from that imaginary canvas
        // to the real ctx.
        // the returned token must be passed to releaseRender at some point

        // note that each consumer adds an extra use++ to each source tile of relevance.

        // it is recomended that the caller use .getVisibleSources to limit the list of entries in
        // tilesSpec when appropriate. We don't re-do that filtering work here.

        // any requests that have the same tileSetID can be coallesced into a single _pendingRender

        ({drawSpec, tilesSpec} = this._canonicalizeSpec(tilesSpec, drawSpec));
        // console.log("renderTiles", drawSpec, tilesSpec);

        const tileSetID = this._tileSpecToString(tilesSpec);
        const consumer = {ctx, drawSpec, tilesSpec, next};

        // See if the tile set is already pending render, if so we don't need to do much...
        let state = this._pendingRenders.get(tileSetID);
        if (state) {
            state.tiles.forEach((t) => t.uses++);
            state.consumers.push(consumer);
            return {
                renderId: state.renderId,
                consumer,
                tiles: state.tiles,
                tileSetID,
            };
        }

        // Ok, well we need to create a new pending render (which may include creating & loading new tiles)...
        const renderId = ++this._nextRenderId;
        state = {
            tileSetID,
            renderId,
            tiles: tilesSpec.map((s) => {
                const tileID = new OverscaledTileID(s.z, 0, s.z, s.x, s.y);
                const sourceCaches: any = this._style.sourceCaches[s.source];
                return sourceCaches.acquireTile(tileID, s.size); // includes .uses++
            }),
            consumers: [consumer],
        };
        this._pendingRenders.set(tileSetID, state);
        // once all the tiles are loaded we can then execute the pending render...
        const badTileIdxs = [];
        Promise.all(
            state.tiles.map((t, ii) => {
                return t.loadedPromise.catch((err) => {
                    badTileIdxs.push(ii);
                });
            })
        )
            .catch((err) => {
            //console.log("Caught error!");
                this._finishRender(tileSetID, renderId, err); // will delete the pendingRender so the next promise's initial check will fail
            })
            .then(() => {
            //console.log("Handler");
                state = this._pendingRenders.get(tileSetID);
                if (!state || state.renderId !== renderId) {
                    return; // render for this tileGroupID has been canceled, or superceded.
                }
                const err = badTileIdxs.length
                    ? `${badTileIdxs.length} of ${tilesSpec.length} tiles not available`
                    : null;

                // special case the condition where there are no tiles requested/available
                if (tilesSpec.length - badTileIdxs.length === 0) {
                    // this assumes globalCompositeOperation = 'copy', need to do something else otherwise
                    state.consumers.forEach((c) =>
                        c.ctx.clearRect(
                            drawSpec.destLeft,
                            drawSpec.destTop,
                            drawSpec.width,
                            drawSpec.height
                        )
                    );
                    this._finishRender(tileSetID, renderId, err);
                    return;
                }

                // setup the list of currentlyRenderingTiles for each source
                Object.values(this._style.sourceCaches).forEach(
                    (c: any) => (c.currentlyRenderingTiles = [])
                );
                tilesSpec.forEach((s, ii) => {
                    if (badTileIdxs.includes(ii)) {
                        return;
                    }
                    const t = state.tiles[ii];
                    t.tileSize = s.size;
                    t.left = s.left;
                    t.top = s.top;
                    const mySource1 = this._style.sourceCaches[s.source];
                    const mySource = mySource1;
                    mySource.currentlyRenderingTiles.push(t);
                });

                // Work out the bounding box containing all src regions
                const xSrcMin = state.consumers
                    .map((c) => c.drawSpec.srcLeft)
                    .reduce((a, b) => Math.min(a, b), Infinity);
                const ySrcMin = state.consumers
                    .map((c) => c.drawSpec.srcTop)
                    .reduce((a, b) => Math.min(a, b), Infinity);
                const xSrcMax = state.consumers
                    .map((c) => c.drawSpec.srcLeft + c.drawSpec.width)
                    .reduce((a, b) => Math.max(a, b), -Infinity);
                const ySrcMax = state.consumers
                    .map((c) => c.drawSpec.srcTop + c.drawSpec.height)
                    .reduce((a, b) => Math.max(a, b), -Infinity);
                // iterate over OFFSCREEN_CANV_SIZE x OFFSCREEN_CANV_SIZE blocks of that bounding box
                for (let xx = xSrcMin; xx < xSrcMax; xx += OFFSCREEN_CANV_SIZE) {
                    for (let yy = ySrcMin; yy < ySrcMax; yy += OFFSCREEN_CANV_SIZE) {
                        // for the section of the imaginary canvas at (xx,yy) and of
                        // size OFFSCREEN_CANV_SIZE x OFFSCREEN_CANV_SIZE, find the list
                        // of relevant consumers.
                        const relevantConsumers = state.consumers.filter(
                            (c) =>
                                c.drawSpec.srcLeft + c.drawSpec.width > xx &&
                    c.drawSpec.srcLeft < xx + OFFSCREEN_CANV_SIZE &&
                    c.drawSpec.srcTop + c.drawSpec.height > yy &&
                    c.drawSpec.srcTop < yy + OFFSCREEN_CANV_SIZE
                        );

                        if (relevantConsumers.length === 0) {
                            continue;
                        }

                        state.tiles.forEach(
                            (t) => {
                                const posMatrix = this._calculatePosMatrix(
                                    t.left - xx,
                                    t.top - yy,
                                    t.tileSize
                                );
                                t.tileID.posMatrix = posMatrix;
                                this._posMatrixCache[t.tileID.key] = posMatrix;
                            }
                        );

                        this.transform.setZoom(tilesSpec[0].z);

                        const fadeDuration = 0;
                        const zoom = this.transform.zoom;
                        const currentTime = now();
                        this.style.zoomHistory.update(zoom, currentTime);

                        const parameters = new EvaluationParameters(zoom, {
                            now: currentTime,
                            fadeDuration,
                            zoomHistory: this.style.zoomHistory,
                            transition: this.style.getTransition()
                        });
                        let crossFading = false;

                        const factor = parameters.crossFadingFactor();
                        if (factor !== 1 || factor !== this._crossFadingFactor) {
                            crossFading = true;
                            this._crossFadingFactor = factor;
                        }

                        const showCollisionBoxes = false;

                        // update zoom level
                        // only one tile will be supply to renderTiles function
                        // so we use the first tile's zoom level
                        this._style.update(parameters);

                        const isGlobeRendering = this.style.projection?.transitionState > 0;
                        const globeRenderingChanged = this.style.projection?.transitionState > 0 !== isGlobeRendering;

                        this._placementDirty = this.style && this.style._updatePlacement(
                            this.transform,
                            showCollisionBoxes,
                            fadeDuration,
                            this._crossSourceCollisions,
                            globeRenderingChanged);

                        // this.painter.transform.zoom = tilesSpec[0].z;
                        this.transform._helper._cameraToCenterDistance = 1;

                        const projection = this.style.projection;
                        const frameData: FrameRenderData = {
                            showTileBoundaries: false,
                            showOverdrawInspector: false,
                            showPadding: false,
                            rotating: false,
                            zooming: false,
                            moving: false,
                            fadeDuration,
                            symbolFadeChange: this.style.placement?.symbolFadeChange(now()) ?? 0,
                            variableOffsets: this.style.placement?.variableOffsets ?? {},
                            anisotropicFilterPitch: 20,
                            projectionTransition: projection?.transitionState ?? 0,
                            isRenderingGlobe: false,
                            projectionShaderVariant: projection ? {
                                name: projection.shaderVariantName,
                                define: projection.shaderDefine,
                                prelude: projection.shaderPreludeCode
                            } : undefined,
                            useSubdivision: projection?.useSubdivision ?? false,
                            pixelRatio: 1,
                            light: this.style.light?.getEvaluated(),
                            sky: this.style.sky?.getEvaluated()
                        };
                        this.painter.setBaseState();
                        this.painter.render(this._style, this.transform, frameData);

                        if(!this._placementDirty){
                            this.style._releaseSymbolFadeTiles();
                        }
                        this._posMatrixCache = {};

                        relevantConsumers.forEach((c) => {
                            const srcLeft = Math.max(0, c.drawSpec.srcLeft - xx) | 0;
                            const srcRight =
                                Math.min(
                                    OFFSCREEN_CANV_SIZE,
                                    c.drawSpec.srcLeft + c.drawSpec.width - xx
                                ) | 0;
                            const srcTop = Math.max(0, c.drawSpec.srcTop - yy) | 0;
                            const srcBottom =
                                Math.min(
                                    OFFSCREEN_CANV_SIZE,
                                    c.drawSpec.srcTop + c.drawSpec.height - yy
                                ) | 0;
                            const destLeft =
                                c.drawSpec.destLeft +
                    (c.drawSpec.srcLeft < xx ? xx - c.drawSpec.srcLeft : 0);
                            const destTop =
                                c.drawSpec.destTop +
                    (c.drawSpec.srcTop < yy ? yy - c.drawSpec.srcTop : 0);
                            const width = srcRight - srcLeft;
                            const height = srcBottom - srcTop;
                            c.ctx.drawImage(
                                this._canvas,
                                srcLeft,
                                srcTop,
                                width,
                                height,
                                destLeft,
                                destTop,
                                width,
                                height
                            );
                        });
                    } // yy
                } // xx

                const symbolCandidates = this._collectSymbols(tilesSpec, state.tiles);
                const renderResult: BasicRendererRenderResult | undefined = this._textMode !== 'maplibre'
                    ? {
                        textSymbols: symbolCandidates.filter(symbol =>
                            Boolean(symbol.text) && symbol.opacity > 0
                        ),
                        symbolCandidates
                    }
                    : undefined;
                while (state.consumers.length) {
                    state.consumers.shift().next(err, renderResult);
                }
                this._pendingRenders.delete(tileSetID);
                Object.values(this._style.sourceCaches).forEach(
                    (c: any) => (c.currentlyRenderingTiles = [])
                );
            });

        return {
            renderId: state.renderId,
            consumer,
            tiles: state.tiles,
            tileSetID,
        };
    }

    // queryRenderedFeatures(opts) {
    //     if (!opts.source) throw new Error('source option is required');

    //     const layers = {};
    //     this.getLayersVisible(opts.renderedZoom, opts.source).forEach(
    //         (lyr) => (layers[lyr] = this._style._layers[lyr])
    //     );

    //     // needs reworking
    //     const featuresByRenderLayer = queryRenderedFeatures(
    //         this._style.sourceCaches[opts.source],
    //         layers,
    //         opts,
    //         [],
    //         opts.tileZ,
    //         // @ts-ignore
    //         0
    //     );

    //     const featuresBySourceLayer = {};
    //     Object.keys(featuresByRenderLayer).forEach((renderLayerName) =>
    //         featuresByRenderLayer[renderLayerName].map((renderLayerFeatures) => {
    //             const lyr = (featuresBySourceLayer[
    //                 renderLayerFeatures.layer['source-layer']
    //             ] =
    //       featuresBySourceLayer[renderLayerFeatures.layer['source-layer']] ||
    //       []);
    //             lyr.push(renderLayerFeatures._vectorTileFeature.properties);
    //         })
    //     );
    //     return featuresBySourceLayer;
    // }

    showCanvasForDebug(): void {
        document.body.appendChild(this._canvas);
        this._canvas.style.position = 'fixed';
        this._canvas.style.bottom = '0px';
        this._canvas.style.right = '0px';
        this._canvas.style.background = '#ccc';
        this._canvas.style.opacity = '0.7';
        this._canvas.style.transform = 'scale(0.5) translate(502px,502px)';
    }
    destroyDebugCanvas(): void {
        this._canvas.parentElement && document.body.removeChild(this._canvas);
    }

    /** Releases the offscreen WebGL renderer, style sources, and pending tile consumers. */
    destroy(): void {
        this._cancelAllPendingRenders();
        this._style?.destroy();
        this.painter?.destroy();
        this._gl?.getExtension('WEBGL_lose_context')?.loseContext?.();
        this._canvas.width = 1;
        this._canvas.height = 1;
    }
}

export default BasicRenderer;
