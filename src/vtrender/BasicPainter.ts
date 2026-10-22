import {Painter} from '../render/painter.ts';

class BasicPainter extends Painter {
    _filterForZoom: number;
    declare style: any;
    declare width: number;
    declare height: number;
    declare context: any;
    constructor(gl: WebGL2RenderingContext) {
        super(gl);
        this._filterForZoom = 15;
    }
    resize(width: number, height: number, pixelRatio: number) {
        super.resize(width, height, pixelRatio);
    }

    // renderLayer(painter, sourceCache, layer, coords) {
    //     if(layer.type !== 'line')return
    //     super.renderLayer(painter,sourceCache,layer,coords)
    // }

    // renderLayer(painter, sourceCache, layer, coords) {
    //   let layerStylesheet = layerStylesheetFromLayer(layer);
    //   if (
    //     layerStylesheet &&
    //     layerStylesheet.minzoom_ &&
    //     coords[0].overscaledZ < layerStylesheet.minzoom_
    //   )
    //     return;
    //   if (
    //     layerStylesheet &&
    //     layerStylesheet.maxzoom_ &&
    //     coords[0].overscaledZ >= layerStylesheet.maxzoom_
    //   )
    //     return;
    //   super.renderLayer(painter, sourceCache, layer, coords);
    // }
}

export default BasicPainter;
