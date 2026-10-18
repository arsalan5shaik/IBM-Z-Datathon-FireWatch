/**
 * Fading layer visibility. Instead of flipping `visibility`, layers transition their (non
 * data-driven) opacity using MapLibre's own paint transitions, and are hidden only once the
 * fade-out finishes — hidden layers cost nothing to draw and are not clickable.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { OPACITY, type OpacityCtx } from './layers';
import { MOTION, motionOn } from './motion';

interface LayerFade {
  on: boolean;
  token: number;
}

export class LayerFader {
  private state = new Map<string, LayerFade>();
  private ctx: OpacityCtx;

  constructor(private readonly map: MapLibreMap, ctx: OpacityCtx) {
    this.ctx = { ...ctx };
  }

  private apply(id: string, fade: number, duration: number) {
    for (const spec of OPACITY[id] ?? []) {
      this.map.setPaintProperty(id, `${spec.prop}-transition` as never, { duration, delay: 0 } as never);
      this.map.setPaintProperty(id, spec.prop as never, spec.value(fade, this.ctx) as never);
    }
  }

  isOn(id: string) {
    const st = this.state.get(id);
    return st ? st.on : this.map.getLayer(id) ? this.map.getLayoutProperty(id, 'visibility') !== 'none' : false;
  }

  /** Show or hide layers with a fade. `immediate` skips the animation (first sync, reduced motion). */
  set(ids: readonly string[], on: boolean, { immediate = false }: { immediate?: boolean } = {}) {
    const animate = !immediate && motionOn();
    for (const id of ids) {
      if (!this.map.getLayer(id)) continue;
      const prev = this.state.get(id);
      const visible = this.map.getLayoutProperty(id, 'visibility') !== 'none';
      if (prev && prev.on === on && (on ? visible : true)) continue;
      const token = (prev?.token ?? 0) + 1;
      this.state.set(id, { on, token });
      if (!OPACITY[id] || !animate) {
        if (OPACITY[id]) this.apply(id, on ? 1 : 0, 0);
        this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        continue;
      }
      if (on) {
        if (!visible) {
          // Start transparent, then transition up once that frame has been applied.
          this.apply(id, 0, 0);
          this.map.setLayoutProperty(id, 'visibility', 'visible');
        }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (this.state.get(id)?.token === token) this.apply(id, 1, MOTION.fade);
          }),
        );
      } else {
        this.apply(id, 0, MOTION.fade);
        setTimeout(() => {
          if (this.state.get(id)?.token === token && this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
        }, MOTION.fade + 40);
      }
    }
  }

  /** Context change (risk opacity, statewide LOD): re-apply opacity for visible layers. */
  update(ctx: Partial<OpacityCtx>, ids: readonly string[], duration: number = MOTION.base) {
    this.ctx = { ...this.ctx, ...ctx };
    for (const id of ids) if (this.map.getLayer(id) && this.isOn(id)) this.apply(id, 1, motionOn() ? duration : 0);
  }

  get context(): OpacityCtx {
    return this.ctx;
  }
}
