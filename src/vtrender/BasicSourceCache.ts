import Point from '@mapbox/point-geometry';
import {EXTENT} from '../data/extent.ts';
import {create as createSource} from '../source/source.ts';
import {TileCache} from '../tile/tile_cache.ts';
import {Tile} from '../tile/tile.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {Evented} from '../util/evented.ts';

import type {SourceSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Context} from '../webgl/context.ts';
import type {Dispatcher} from '../util/dispatcher.ts';

type ManagedTile = Tile & {
    cache: BasicSourceCache;
    loadedPromise?: Promise<void>;
    _isDud?: boolean;
    left?: number;
    top?: number;
};

/**
 * Owns the explicit tile set used by {@link BasicRenderer}.
 *
 * MapLibre's map renderer uses `TileManager` for viewport-driven loading. WeatherEarth supplies
 * an explicit set of tiles instead, so this cache keeps the public tile lifecycle while
 * retaining the `sourceCaches`/`findLoadedParent` names used by the existing adapter.
 */
class BasicSourceCache extends Evented {
    readonly id: string;
    readonly _source: any;
    readonly _tilesInUse: Record<string, ManagedTile> = {};
    readonly _tileCache: TileCache;
    currentlyRenderingTiles: ManagedTile[] = [];
    used = true;
    style: any;
    map: any;

    constructor(id: string, sourceOptions: SourceSpecification, dispatcher: Dispatcher) {
        super();
        this.id = id;
        this._source = createSource(id, sourceOptions, dispatcher, this);
        this._tileCache = new TileCache(100, (tile: ManagedTile) => this._source.unloadTile?.(tile));
    }

    /** Attaches the source to the renderer map. */
    onAdd(map: any): void {
        this.map = map;
        this._source.map = map;
        this._source.onAdd?.(map);
    }

    /** Detaches the source and releases all tiles. */
    onRemove(map: any): void {
        this.clearTiles();
        this._source.onRemove?.(map);
    }

    /** Releases every tile held by this explicit renderer. */
    clearTiles(): void {
        for (const tile of Object.values(this._tilesInUse)) {
            this._source.abortTile?.(tile);
            this._source.unloadTile?.(tile);
        }
        this._tileCache.reset();
        this.currentlyRenderingTiles = [];
        for (const key of Object.keys(this._tilesInUse)) delete this._tilesInUse[key];
    }

    /** Returns the source specification object. */
    getSource(): any {
        return this._source;
    }

    /** Returns the currently requested tile coordinates. */
    getVisibleCoordinates(symbolLayer?: boolean): OverscaledTileID[] {
        const tiles = this.currentlyRenderingTiles.filter(tile => tile.isRenderable(Boolean(symbolLayer)));
        return tiles.map(tile => tile.tileID);
    }

    /** Returns IDs in the shape expected by MapLibre debug and placement code. */
    getRenderableIds(symbolLayer?: boolean): string[] {
        return this.getVisibleCoordinates(symbolLayer).map(tileID => tileID.key);
    }

    /** Acquires a tile and starts its source request exactly once. */
    acquireTile(tileID: OverscaledTileID, size: number): ManagedTile {
        let tile = this._tilesInUse[tileID.key] ?? this._tileCache.getAndRemove(tileID) as ManagedTile;
        if (!tile) tile = new Tile(tileID.wrapped(), size) as ManagedTile;

        tile.uses++;
        tile.cache = this;
        this._tilesInUse[tileID.key] = tile;
        if (tile.loadedPromise) return tile;

        tile.loadedPromise = Promise.resolve(this._source.loadTile(tile)).then(() => {
            tile.state = 'loaded';
        }).catch((error) => {
            tile._isDud = true;
            tile.state = 'errored';
            throw error;
        });
        return tile;
    }

    /** Gets a tile that is currently retained by the explicit renderer. */
    getTile(tileID: OverscaledTileID): ManagedTile | undefined {
        return this._tilesInUse[tileID.key];
    }

    /** Gets a tile by its key or tile ID. */
    getTileByID(tileID: OverscaledTileID | string): ManagedTile | undefined {
        return typeof tileID === 'string' ? this._tilesInUse[tileID] : this.getTile(tileID);
    }

    /** Finds the nearest loaded ancestor used for raster fallback. */
    findLoadedParent(tileID: OverscaledTileID, minCoveringZoom: number = 0): ManagedTile | null {
        for (let zoom = tileID.overscaledZ - 1; zoom >= minCoveringZoom; zoom--) {
            const parentID = tileID.scaledTo(zoom);
            const parent = this._tilesInUse[parentID.key] ?? this._tileCache.get(parentID) as ManagedTile;
            if (parent?.hasData()) return parent;
        }
        return null;
    }

    /** Returns the loaded tile under the legacy sibling lookup name. */
    findLoadedSibling(tileID: OverscaledTileID): ManagedTile | null {
        const tile = this._tilesInUse[tileID.key] ?? this._tileCache.get(tileID) as ManagedTile;
        return tile?.hasData() ? tile : null;
    }

    /** Uploads the currently rendered tiles into the WebGL context. */
    prepare(context: Context): void {
        for (const tile of this.currentlyRenderingTiles) {
            tile.upload(context);
            tile.prepare(this.style?.imageManager);
        }
    }

    /** Releases one explicit tile reference and retains loaded data in the bounded cache. */
    releaseTile(tile: ManagedTile): void {
        tile.uses = Math.max(0, tile.uses - 1);
        if (tile.uses > 0) return;
        delete this._tilesInUse[tile.tileID.key];
        if (tile.hasData() || tile._isDud) {
            this._tileCache.add(tile.tileID, tile, undefined);
            return;
        }
        this._source.abortTile?.(tile);
        this._source.unloadTile?.(tile);
    }

    /** Reports source readiness to the legacy style promise. */
    loaded(): boolean {
        return Boolean(this._source.loaded?.());
    }

    /** Forces in-use tiles to be requested again after a style update. */
    invalidateAllLoadedTiles(): void {
        for (const tile of Object.values(this._tilesInUse)) {
            if (!tile._isDud) tile.loadedPromise = undefined;
        }
    }

    /** Returns the source serialization. */
    serialize(): any {
        return this._source.serialize();
    }

    /** Releases tiles held only for symbol fading. */
    releaseSymbolFadeTiles(): void {
        for (const tile of Object.values(this._tilesInUse)) {
            if (tile.holdingForFade()) this.releaseTile(tile);
        }
    }

    /** Computes query geometry for the explicit tile set. */
    tilesIn(options: {lng: number; lat: number; tileZ: number}): any[] {
        const scale = 2 ** options.tileZ;
        const x = ((options.lng + 180) / 360) * scale;
        const sin = Math.sin(options.lat * Math.PI / 180);
        const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
        return Object.values(this._tilesInUse).filter(tile => tile.hasData()).map(tile => ({
            tile,
            tileID: tile.tileID,
            queryGeometry: [[Point.convert([
                (x - tile.tileID.canonical.x) * EXTENT,
                (y - tile.tileID.canonical.y) * EXTENT
            ])]],
            scale: 1
        }));
    }

    reload(): void {}
    pause(): void {}
    resume(): void {}
    setDependencies(): void {}
}

export default BasicSourceCache;
