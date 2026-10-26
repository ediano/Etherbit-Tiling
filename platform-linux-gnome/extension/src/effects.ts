// effects.ts — cantos arredondados dos atores de janela (Clutter shader), só GNOME.
//
// Wayland proíbe um processo EXTERNO (o daemon) de desenhar sobre janelas alheias — mas a extensão
// roda DENTRO do Mutter e pode anexar um `Clutter.ShaderEffect` ao `Meta.WindowActor`. O shader é um
// SDF de retângulo arredondado que zera o alfa fora do raio. Tudo é DEFENSIVO: se o shader não
// compilar/marshalar numa versão do Shell, a janela renderiza normal (nunca quebra a sessão).
// No KDE isto depende do efeito NATIVO de cantos do KWin — um KWin *Script* não instancia shaders
// (ver ADR 0019).

import Clutter from 'gi://Clutter';

const EFFECT_NAME = 'etherbit-rounded';

/// SDF de retângulo arredondado: alfa = 0 fora do raio, com antialias de ~1px na borda.
const SHADER = `
uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float radius;
void main() {
  vec2 size = vec2(width, height);
  vec2 uv = cogl_tex_coord_in[0].st;
  vec4 texel = texture2D(tex, uv);
  vec2 p = uv * size - size * 0.5;
  vec2 q = abs(p) - size * 0.5 + vec2(radius);
  float dist = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  float alpha = 1.0 - smoothstep(0.0, 1.5, dist);
  cogl_color_out = texel * cogl_color_in * alpha;
}
`;

/// Handler `notify::size` por ator com efeito: a alocação após `move_resize_frame` é assíncrona, então
/// os uniforms lidos no apply ficariam com o tamanho ANTIGO (ADR 0067). Seguimos o tamanho real.
const sizeHandlers = new WeakMap<Clutter.Actor, number>();

function updateSize(actor: Clutter.Actor, effect: Clutter.ShaderEffect): void {
  const [w, h] = actor.get_size();
  if (w > 0 && h > 0) {
    effect.set_uniform_value('width', w);
    effect.set_uniform_value('height', h);
  }
}

/// Anexa (idempotente) o efeito de cantos arredondados ao ator, com `radius` px. O tamanho é mantido
/// em dia pelo `notify::size` do próprio ator. Nunca lança.
export function applyRoundedCorners(actor: Clutter.Actor, radius: number): void {
  try {
    // Tamanho do ator ANTES de anexar. Uma janela recém-criada ainda mede 0×0; anexar a
    // OffscreenEffect (base do ShaderEffect) montaria um framebuffer 0×0 →
    // `cogl_framebuffer_set_viewport: width>0 && height>0`. Aborta; o relayout seguinte reaplica.
    const [w, h] = actor.get_size();
    if (w <= 0 || h <= 0) {
      return;
    }
    let effect = actor.get_effect(EFFECT_NAME) as Clutter.ShaderEffect | null;
    if (!effect) {
      // shader_type tem default FRAGMENT (Cogl.ShaderType) — não precisamos passá-lo.
      effect = new Clutter.ShaderEffect();
      effect.set_shader_source(SHADER);
      actor.add_effect_with_name(EFFECT_NAME, effect);
      effect.set_uniform_value('tex', 0);
      const fx = effect;
      sizeHandlers.set(
        actor,
        actor.connect('notify::size', () => {
          try {
            updateSize(actor, fx);
          } catch {
            // ator em destruição — ignora.
          }
        }),
      );
    }
    updateSize(actor, effect);
    effect.set_uniform_value('radius', radius);
  } catch (error) {
    console.error(`Etherbit Tiling: cantos arredondados indisponíveis: ${error}`);
  }
}

/// Remove o efeito do ator (toggle desligado ou desativando a extensão). Nunca lança.
export function clearRoundedCorners(actor: Clutter.Actor): void {
  try {
    const handler = sizeHandlers.get(actor);
    if (handler) {
      actor.disconnect(handler);
      sizeHandlers.delete(actor);
    }
    if (actor.get_effect(EFFECT_NAME)) {
      actor.remove_effect_by_name(EFFECT_NAME);
    }
  } catch {
    // sem efeito / ator inválido — nada a fazer.
  }
}

/// `true` se a janela desenha a própria moldura com sombra (CSD: GTK4/libadwaita, Chromium...): o
/// buffer é maior que o frame. Essas janelas já arredondam os cantos, e o SDF sobre o ator inteiro
/// recortaria a SOMBRA, não a borda visível — por isso o efeito não se aplica a elas.
export function hasClientShadow(
  frame: { width: number; height: number },
  buffer: { width: number; height: number },
): boolean {
  return buffer.width > frame.width || buffer.height > frame.height;
}
